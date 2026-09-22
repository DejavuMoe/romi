#!/usr/bin/env python3
"""Analytical scale benchmark for romi.

Seeds a deterministic large-history DuckDB fixture with the benchmark-only
`romi-bench` Rust tool, starts the real release Hub, and measures the product's
actual history endpoints:

  * metric, ping, and combined windows at 1 h, 6 h, 24 h, 7 d, 30 d, 90 d;
  * p50/p95/p99/max, response rows, payload bytes, reader concurrency;
  * ingestion while analytical readers run, including writer-queue and
    group-commit counters and final traffic correctness;
  * backup, restore, and maintenance timing on disposable benchmark databases.

Only the standard library is used here. The fixture runs inside DuckDB through
the server crate's benchmark feature; no production HTTP endpoint or arbitrary
SQL surface is added.

Examples:
    python3 scripts/bench_analytics.py seed --db /tmp/romi-big.db --nodes 100 --days 7
    python3 scripts/bench_analytics.py query --db /tmp/romi-big.db --fixture-json /tmp/romi-big.json
    python3 scripts/bench_analytics.py ingest --db /tmp/romi-big.db --fixture-json /tmp/romi-big.json --ingest-rate 100
    python3 scripts/bench_analytics.py scale --db /tmp/romi-big.db --fixture-json /tmp/romi-big.json
"""
import argparse
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
from bench import Hub, Socket  # noqa: E402  (reuse the harness's WebSocket client)

MAX_CHUNK = 8 * 1024 * 1024  # must not exceed api::MAX_CHUNK
MAX_RESTORE = 256 * 1024 * 1024  # must equal db::MAX_ARCHIVE


# ---- small helpers ----

def run(command, cwd=ROOT, check=True, capture=True):
    return subprocess.run(
        [str(p) for p in command], cwd=str(cwd), text=True,
        capture_output=capture, check=check)


def percentile(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    at = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * q))))
    return ordered[at]


def summary(values):
    if not values:
        return {'n': 0, 'p50': 0.0, 'p95': 0.0, 'p99': 0.0, 'max': 0.0}
    return {
        'n': len(values),
        'p50': round(percentile(values, 0.50), 3),
        'p95': round(percentile(values, 0.95), 3),
        'p99': round(percentile(values, 0.99), 3),
        'max': round(max(values), 3),
    }


def dir_bytes(path):
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def process_stats(pid):
    out = {'rss_kb': 0, 'cpu_seconds': 0.0}
    try:
        text = Path(f'/proc/{pid}/status').read_text()
        match = re.search(r'VmRSS:\s+(\d+) kB', text)
        if match:
            out['rss_kb'] = int(match.group(1))
        fields = Path(f'/proc/{pid}/stat').read_text().split()
        ticks = os.sysconf('SC_CLK_TCK')
        out['cpu_seconds'] = (int(fields[13]) + int(fields[14])) / ticks
    except (OSError, IndexError, ValueError):
        pass
    return out


def machine_metadata():
    cpu = ''
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('model name'):
                cpu = line.split(':', 1)[1].strip()
                break
    except OSError:
        pass
    mem_kb = 0
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemTotal:'):
                mem_kb = int(line.split()[1])
                break
    except (OSError, IndexError, ValueError):
        pass
    return {
        'cpu_model': cpu,
        'logical_cpus': os.cpu_count(),
        'mem_total_kb': mem_kb,
        'kernel': platform.release(),
        'os': platform.platform(),
        'python': platform.python_version(),
    }


def duckdb_crate_version():
    try:
        text = (ROOT / 'server' / 'Cargo.lock').read_text()
        for block in text.split('[[package]]'):
            if 'name = "duckdb"' in block:
                match = re.search(r'version = "([^"]+)"', block)
                if match:
                    return match.group(1)
    except OSError:
        pass
    return 'unknown'


def git_sha():
    try:
        return run(['git', 'rev-parse', 'HEAD']).stdout.strip()
    except subprocess.CalledProcessError:
        return 'unknown'


# ---- Hub/API helpers ----

class Api:
    """Authenticated, thread-safe-enough API client for one Hub."""

    def __init__(self, hub, password=None):
        self.hub = hub
        self.cookie = ''
        self.password = password or hub.password() or ''
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.jar),
        )
        self.request('/api/me')
        if self.password:
            self.request('/api/auth/login', {'username': 'admin', 'password': self.password})
        self.cookie = self._monitor_cookie()

    def _monitor_cookie(self):
        for cookie in self.jar:
            if cookie.name == 'monitor_session':
                return f'{cookie.name}={cookie.value}'
        return ''

    def request(self, path, data=None, headers=None, timeout=120):
        request = urllib.request.Request(self.hub.url + path, headers=headers or {})
        if data is not None:
            request.add_header('Content-Type', 'application/json')
            request.data = json.dumps(data).encode()
        # The opener is shared by request threads only for JSON control paths;
        # history threads call `raw` with the Cookie header directly.
        with self.opener.open(request, timeout=timeout) as response:
            return response.status, response.read()

    def json(self, path, data=None, headers=None, timeout=120):
        status, body = self.request(path, data, headers, timeout)
        return status, json.loads(body)

    def raw(self, path, timeout=120):
        request = urllib.request.Request(self.hub.url + path)
        if self.cookie:
            request.add_header('Cookie', self.cookie)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()


def wait_hub(hub, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if hub.process.poll() is not None:
            raise RuntimeError(f'hub exited:\n{(hub.work / "hub.log").read_text()}')
        try:
            urllib.request.urlopen(hub.url + '/api/me', timeout=2).read()
            return
        except (OSError, urllib.error.URLError):
            time.sleep(0.2)
    raise RuntimeError('hub never answered')


def start_hub(args, db, work, memory=None):
    work.mkdir(parents=True, exist_ok=True)
    hub = Hub((Path(args.bin_dir) / 'romi-hub').resolve(), work)
    hub.database = Path(db)
    hub.start(memory=memory if memory is not None else args.memory, threads=args.db_threads)
    wait_hub(hub)
    return hub


def db_stats(api):
    _, body = api.json('/api/db')
    return body


# ---- fixture ----

def bench_binary(args):
    if args.bench_bin:
        return Path(args.bench_bin).resolve()
    candidate = (Path(args.bin_dir) / 'romi-bench').resolve()
    if candidate.exists():
        return candidate
    # The tool is feature-gated so it never ships in the release package.
    env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / 'target'))
    subprocess.run([
        'cargo', 'build', '--locked', '--release', '--features', 'bench',
        '--bin', 'romi-bench', '--manifest-path', str(ROOT / 'server' / 'Cargo.toml'),
    ], cwd=ROOT, env=env, check=True)
    return Path(ROOT / 'target' / 'release' / 'romi-bench')


def seed_fixture(args, db, work):
    tool = bench_binary(args)
    command = [
        str(tool), 'seed', '--db', str(db), '--nodes', str(args.nodes),
        '--days', str(args.days), '--metric-interval', str(args.metric_interval),
        '--probes', str(args.probes), '--probe-interval', str(args.probe_interval),
        '--loss-rate', str(args.loss_rate), '--latency-min', str(args.latency_min),
        '--latency-max', str(args.latency_max), '--seed', str(args.seed),
        '--traffic-gb-per-day', str(args.traffic_gb_per_day), '--order', args.order,
        '--admin-password', args.admin_password,
        '--chunk-rows', str(args.chunk_rows),
        '--memory', args.seed_memory, '--threads', str(args.seed_threads),
        '--temp', str(work / 'seed-tmp'), '--force',
    ]
    done = run(command)
    return json.loads(done.stdout)


def load_fixture(args):
    if args.fixture_json:
        return json.loads(Path(args.fixture_json).read_text())
    return None


# ---- history query benchmarks ----

def parse_history(body):
    value = json.loads(body)
    metrics = value.get('metrics') or []
    ping = value.get('ping') or []
    probes = value.get('probes') or {}
    loss = value.get('loss') or {}
    return {
        'rows': len(metrics) + len(ping),
        'metric_rows': len(metrics),
        'ping_rows': len(ping),
        'probes': len(probes),
        'loss_keys': len(loss),
    }


def query_worker(api, barrier, stop, results, errors, combos, nodes, iterations, worker_index):
    """One persistent reader: every combination gets `iterations` samples.

    Nodes and windows are varied per sample so the measurements cover different
    data, not one hot query repeated. Results carry their series/window tag so
    the caller can build a distribution for every product query.
    """
    try:
        barrier.wait(timeout=30)
    except threading.BrokenBarrierError:
        return
    for round_number in range(iterations):
        if stop.is_set():
            return
        for combo_index, (series, hours) in enumerate(combos):
            node = 1 + ((combo_index * 7 + round_number * 13 + worker_index * 17) % nodes)
            path = f'/api/nodes/{node}/metrics?hours={hours}'
            if series != 'both':
                path += f'&series={series}'
            started = time.perf_counter()
            status, body = api.raw(path)
            elapsed = (time.perf_counter() - started) * 1000
            if status != 200:
                errors.append({'status': status, 'series': series, 'hours': hours,
                               'body': body[:200].decode(errors='replace')})
                continue
            try:
                counts = parse_history(body)
            except (ValueError, TypeError) as error:
                errors.append({'status': status, 'error': str(error), 'series': series,
                               'hours': hours})
                continue
            results.append({
                'series': series, 'hours': hours, 'ms': elapsed, 'bytes': len(body),
                **counts,
            })


def measure_queries(api, args, hub, series_list, windows, readers_list):
    combos = [(series, hours) for series in series_list for hours in windows]
    measurements = {}
    for readers in readers_list:
        # Warm every path before timing this concurrency level.
        for index, (series, hours) in enumerate(combos):
            node = 1 + ((index * 7 + len(measurements) * 13) % args.nodes)
            path = f'/api/nodes/{node}/metrics?hours={hours}'
            if series != 'both':
                path += f'&series={series}'
            api.raw(path)
        results = []
        errors = []
        barrier = threading.Barrier(readers)
        stop = threading.Event()
        threads = [
            threading.Thread(
                name=f'reader-{readers}-{i}', target=query_worker,
                args=(api, barrier, stop, results, errors, combos, args.nodes,
                      args.query_iterations, i),
            )
            for i in range(readers)
        ]
        before = process_stats(hub.process.pid)
        started = time.monotonic()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=600)
        elapsed = time.monotonic() - started
        stop.set()
        after = process_stats(hub.process.pid)
        groups = {}
        for row in results:
            key = f'{row["series"]}:{row["hours"]}'
            groups.setdefault(key, []).append(row)
        per_window = {}
        for key, rows in sorted(groups.items()):
            per_window[key] = {
                'latency_ms': summary([r['ms'] for r in rows]),
                'bytes': summary([r['bytes'] for r in rows]),
                'rows': summary([float(r['rows']) for r in rows]),
                'metric_rows': summary([float(r['metric_rows']) for r in rows]),
                'ping_rows': summary([float(r['ping_rows']) for r in rows]),
                'probes': summary([float(r['probes']) for r in rows]),
                'loss_keys': summary([float(r['loss_keys']) for r in rows]),
            }
        measurements[str(readers)] = {
            'readers': readers,
            'elapsed_s': round(elapsed, 3),
            'requests': len(results),
            'errors': errors,
            'response_ms': summary([r['ms'] for r in results]),
            'groups': per_window,
            'process': {'before': before, 'after': after},
            'db_stats_after': db_stats(api),
        }
    return measurements


# ---- ingestion under analytics ----

def total_booked(api, node_ids):
    _, body = api.json('/api/nodes')
    total = 0
    for node in body['nodes']:
        if node['id'] in node_ids:
            total += node.get('total_rx', 0)
    return total


def ingest_scenario(api, args, hub, fixture):
    node_ids = list(range(1, min(args.nodes, args.ingest_agents) + 1))
    per_report = int((args.ingest_agents / args.ingest_rate) * 1_000_000) if args.ingest_rate else 0
    interval = args.ingest_agents / args.ingest_rate if args.ingest_rate else 0
    before_stats = db_stats(api)
    baseline_total = total_booked(api, node_ids)

    agents = [Socket('127.0.0.1', hub.port, f'bench-token-{node}') for node in node_ids]
    process_before = process_stats(hub.process.pid)
    sent = [0] * len(agents)
    window = [0] * len(agents)
    stop = threading.Event()
    queue_peak = [0]
    queue_samples = []
    api_latencies = {'nodes': [], 'me': []}

    def report(index, agent):
        counters = 0
        while not stop.is_set():
            counters += per_report
            message = json.dumps({'jsonrpc': '2.0', 'method': 'report', 'params': {
                'boot_id': 'bench-analytics', 'cpu': 12.5, 'mem_used': 1_000_000,
                'swap_used': 0, 'disk_used': 2_000_000, 'net_rx_total': counters,
                'net_tx_total': counters, 'net_rx': 1_000, 'net_tx': 2_000,
                'tcp': 10, 'udp': 5, 'procs': 100, 'uptime': counters,
                'mem_total': 8_589_934_592, 'swap_total': 0,
                'disk_total': 107_374_182_400, 'load': [0.1, 0.2, 0.3]}})
            try:
                agent.text(message)
            except OSError:
                return
            sent[index] += 1
            window[index] += 1
            time.sleep(interval)

    history_stop = threading.Event()
    history_latencies = []
    history_errors = []
    history_combos = [(series, hours) for series in ('metrics', 'ping', 'both')
                      for hours in (args.ingest_history_windows or [24])]

    def history_reader():
        i = 0
        while not history_stop.is_set():
            series, hours = history_combos[i % len(history_combos)]
            i += 1
            node = 1 + (hash((threading.current_thread().name, i)) % args.nodes)
            path = f'/api/nodes/{node}/metrics?hours={hours}'
            if series != 'both':
                path += f'&series={series}'
            started = time.perf_counter()
            status, body = api.raw(path)
            elapsed = (time.perf_counter() - started) * 1000
            if status == 200:
                history_latencies.append(elapsed)
            else:
                history_errors.append({'status': status, 'series': series, 'hours': hours, 'body': body[:120].decode(errors='replace')})
            time.sleep(0.02)

    def watcher():
        while not stop.is_set():
            stats = db_stats(api)
            depth = stats.get('queue', {}).get('queued_ops_current', 0)
            queue_peak[0] = max(queue_peak[0], depth)
            queue_samples.append(depth)
            for key, path in (('nodes', '/api/nodes'), ('me', '/api/me')):
                started = time.perf_counter()
                status, _ = api.raw(path)
                if status == 200:
                    api_latencies[key].append((time.perf_counter() - started) * 1000)
            time.sleep(0.2)

    threads = [threading.Thread(target=report, args=(i, agents[i])) for i in range(len(agents))]
    for thread in threads:
        thread.start()
    history_threads = [
        threading.Thread(target=history_reader) for _ in range(args.analytics_readers)
    ] if args.analytics_readers else []
    for thread in history_threads:
        thread.start()
    watcher_thread = threading.Thread(target=watcher)
    watcher_thread.start()

    # Warm-up, then reset offered counters so the offered rate describes steady
    # state rather than the ramp. Correctness still uses the full `sent` counts.
    time.sleep(2.0)
    for i in range(len(window)):
        window[i] = 0

    started = time.monotonic()
    time.sleep(args.ingest_seconds)
    elapsed = time.monotonic() - started
    stop.set()
    history_stop.set()
    for thread in threads + history_threads:
        thread.join(timeout=10)
    watcher_thread.join(timeout=5)

    # Final correctness is based on the whole observed run: first report per
    # agent only realigns the seeded baseline, every later report books its delta.
    expected = sum(max(0, count - 1) * per_report for count in sent)
    drain_started = time.monotonic()
    booked = 0
    while time.monotonic() - drain_started < 60:
        booked = total_booked(api, node_ids) - baseline_total
        if booked >= expected:
            break
        time.sleep(0.2)
    drain = time.monotonic() - drain_started
    after_stats = db_stats(api)
    for agent in agents:
        agent.close()

    queue_delta = {
        key: after_stats.get('queue', {}).get(key, 0) - before_stats.get('queue', {}).get(key, 0)
        for key in (
            'accepted_ops_total', 'committed_ops_total', 'refused_ops_total',
            'failed_ops_total', 'batch_transactions_total', 'batch_ops_total',
        )
    }
    return {
        'rate_target': args.ingest_rate,
        'agents': len(agents),
        'interval_s': interval,
        'per_report_bytes': per_report,
        'measured_s': round(elapsed, 3),
        'offered_reports': sum(window),
        'offered_per_second': round(sum(window) / elapsed, 1),
        'total_reports_sent': sum(sent),
        'committed_bytes': booked,
        'expected_bytes': expected,
        'exact': booked >= expected,
        'drain_s': round(drain, 3),
        'peak_queue': queue_peak[0],
        'queue_samples': summary([float(v) for v in queue_samples]),
        'writer_queue_delta': queue_delta,
        'writer_queue_after': after_stats.get('queue', {}),
        'history_latency_ms': summary(history_latencies),
        'history_errors': history_errors,
        'light_api_ms': {key: summary(values) for key, values in api_latencies.items()},
        'process': {'before': process_before, 'after': process_stats(hub.process.pid)},
        'storage': {'size': after_stats.get('size', 0), 'wal': after_stats.get('wal', 0),
                    'temp_bytes': dir_bytes(after_stats.get('temp_directory', ''))},
    }


# ---- backup / restore / maintenance ----

def authenticated_upload(api, path, archive):
    total = len(archive)
    offset = 0
    started = time.monotonic()
    while offset < total:
        piece = archive[offset:offset + MAX_CHUNK]
        request = urllib.request.Request(
            api.hub.url + f'/api/db/restore?offset={offset}&total={total}',
            data=piece, method='POST')
        if api.cookie:
            request.add_header('Cookie', api.cookie)
        request.add_header('Content-Type', 'application/octet-stream')
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                status = response.status
                body = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            body = error.read()
        if status not in (200, 201):
            raise RuntimeError(f'restore chunk failed: {status} {body[:200]!r}')
        parsed = json.loads(body)
        if parsed.get('received') is not None:
            offset = parsed['received']
        else:
            offset += len(piece)
    return time.monotonic() - started


def scale_scenario(args, hub, api, fixture):
    result = {}
    maintenance_started = time.monotonic()
    try:
        status, body = api.json('/api/db/maintenance', {}, timeout=1800)
        result['maintenance'] = {
            'status': status,
            'seconds': round(time.monotonic() - maintenance_started, 3),
            'report': body,
        }
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
        result['maintenance'] = {'status': None, 'error': str(error),
                                 'seconds': round(time.monotonic() - maintenance_started, 3)}

    archive_path = Path(args.work_dir) / 'bench.backup.tar.gz'
    request = urllib.request.Request(hub.url + '/api/db/backup')
    if api.cookie:
        request.add_header('Cookie', api.cookie)
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=3600) as response, archive_path.open('wb') as handle:
        shutil.copyfileobj(response, handle, length=1024 * 1024)
    backup_seconds = time.monotonic() - started
    archive = archive_path.read_bytes()
    result['backup'] = {
        'seconds': round(backup_seconds, 3),
        'bytes': len(archive),
        'sha256': hashlib.sha256(archive).hexdigest(),
        'limit_bytes': MAX_RESTORE,
        'within_restore_limit': len(archive) <= MAX_RESTORE,
    }

    # Restore only when the archive is inside the product's declared limit.
    if args.skip_restore or len(archive) > MAX_RESTORE:
        result['restore'] = {'skipped': True, 'reason': 'restore disabled or archive over MAX_RESTORE'}
    else:
        restore_dir = Path(args.work_dir) / 'restore-target'
        shutil.rmtree(restore_dir, ignore_errors=True)
        restore_db = restore_dir / 'restored.duckdb'
        restore_hub = start_hub(args, restore_db, restore_dir, memory=args.memory)
        try:
            restore_api = Api(restore_hub)
            restore_seconds = authenticated_upload(restore_api, str(archive_path), archive)
            # Restore replaces the session table with an empty one, so the
            # pre-restore admin cookie is gone; authenticate again for stats.
            restore_api = Api(restore_hub, args.admin_password)
            _, stats = restore_api.json('/api/db')
            result['restore'] = {
                'seconds': round(restore_seconds, 3),
                'stats': stats,
                'expected_rows': restore_expected_rows(archive, fixture),
            }
        finally:
            restore_hub.stop()
    archive_path.unlink(missing_ok=True)
    result['maintenance']['db_stats_after'] = db_stats(api)
    return result


def restore_expected_rows(archive, fixture):
    try:
        with tarfile.open(fileobj=__import__('io').BytesIO(archive), mode='r:gz') as tar:
            member = tar.extractfile('manifest.json')
            if member is None:
                return {}
            return json.loads(member.read()).get('tables', {})
    except (tarfile.TarError, ValueError, AttributeError):
        return {}


# ---- CLI ----

def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['seed', 'query', 'ingest', 'scale', 'all'], nargs='?', default='all')
    parser.add_argument('--bin-dir', type=Path, default=ROOT / 'target' / 'release')
    parser.add_argument('--bench-bin', type=Path)
    parser.add_argument('--db', type=Path)
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--fixture-json', type=Path)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--admin-password', default='romi-bench-password')
    parser.add_argument('--nodes', type=int, default=100)
    parser.add_argument('--days', type=float, default=7)
    parser.add_argument('--metric-interval', type=int, default=60)
    parser.add_argument('--probes', type=int, default=2)
    parser.add_argument('--probe-interval', type=int, default=60)
    parser.add_argument('--loss-rate', type=float, default=0.01)
    parser.add_argument('--latency-min', type=int, default=5)
    parser.add_argument('--latency-max', type=int, default=250)
    parser.add_argument('--traffic-gb-per-day', type=float, default=10.0)
    parser.add_argument('--order', choices=['time', 'node', 'none'], default='time')
    parser.add_argument('--chunk-rows', type=int, default=2_000_000)
    parser.add_argument('--seed-memory', default='4GB')
    parser.add_argument('--seed-threads', type=int, default=4)
    parser.add_argument('--memory', default=None)
    parser.add_argument('--db-threads', type=int, default=None)
    parser.add_argument('--windows', default='1,6,24,168,720,2160')
    parser.add_argument('--series', default='metrics,ping,both')
    parser.add_argument('--query-iterations', type=int, default=3,
                        help='samples per series/window per persistent reader')
    parser.add_argument('--readers', default='1,2,3,4,6')
    parser.add_argument('--ingest-rate', type=float, default=0)
    parser.add_argument('--ingest-seconds', type=float, default=15)
    parser.add_argument('--ingest-agents', type=int, default=50)
    parser.add_argument('--analytics-readers', type=int, default=2)
    parser.add_argument('--ingest-history-windows', default='24,720')
    parser.add_argument('--skip-restore', action='store_true')
    parser.add_argument('--out', type=Path)
    return parser


def windows_list(text):
    return [int(v) for v in text.split(',') if v.strip()]


def main():
    args = build_parser().parse_args()
    work = (args.work_dir or Path(tempfile.mkdtemp(prefix='romi-analytics-'))).resolve()
    work.mkdir(parents=True, exist_ok=True)
    db = (args.db or (work / 'bench.duckdb')).resolve()
    fixture = load_fixture(args)
    result = {
        'generated_at': time.time(),
        'git_sha': git_sha(),
        'command': ' '.join(sys.argv),
        'machine': machine_metadata(),
        'duckdb_crate': duckdb_crate_version(),
        'mode': args.mode,
    }

    admin_password = args.admin_password
    if fixture and fixture.get('admin_password'):
        admin_password = fixture['admin_password']
    args.admin_password = admin_password
    if args.mode == 'seed' or (args.mode == 'all' and not args.db):
        fixture = seed_fixture(args, db, work)
        result['fixture'] = fixture
        if args.out:
            args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
        print(json.dumps(result, indent=2, sort_keys=True))
        if args.mode == 'seed':
            return
    elif fixture is None:
        fixture = {'db': str(db), 'config': {}}

    hub = None
    try:
        hub = start_hub(args, db, work, memory=args.memory)
        api = Api(hub, admin_password)
        result['hub'] = {
            'binary': str(Path(args.bin_dir) / 'romi-hub'),
            'db': str(db),
            'db_stats': db_stats(api),
        }
        if args.mode in ('query', 'all'):
            result['queries'] = measure_queries(
                api, args, hub, args.series.split(','), windows_list(args.windows),
                windows_list(args.readers))
        if args.mode in ('ingest', 'all'):
            if args.ingest_rate > 0:
                result['ingest'] = ingest_scenario(api, args, hub, fixture)
            else:
                result['ingest'] = {'skipped': True, 'reason': '--ingest-rate not set'}
        if args.mode in ('scale', 'all'):
            result['scale'] = scale_scenario(args, hub, api, fixture)
    finally:
        if hub is not None:
            hub.stop()

    text = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
