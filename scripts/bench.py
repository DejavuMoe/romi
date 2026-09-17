#!/usr/bin/env python3
"""Storage benchmark for the romi Hub.

Runs the same workload against any build of the Hub and prints one JSON object,
so the SQLite build and the DuckDB build can be compared under identical load:

    make bench
    python3 scripts/bench.py --bin-dir /tmp/romi-baseline/target/release --label sqlite
    python3 scripts/bench.py --bin-dir target/release --label duckdb

`scripts/bench-compare.py` runs both and writes the table in `docs/bench.md`.

What it measures, and how:

* **Ingestion** -- N fake agents speaking the real agent WebSocket protocol,
  reporting at a fixed interval with monotonically increasing kernel counters.
  The hub has no acknowledgement for a report, so throughput is what the agents
  managed to send and *correctness* is checked afterwards by comparing the hub's
  own accumulated totals against what was sent.
* **Commit and queue delay** -- the latency of a small authenticated write
  (`POST /api/nodes`) under that ingest load, and of a small read
  (`GET /api/nodes`). On the DuckDB build these go through the same writer thread
  the reports do, which is exactly what is being measured.
* **History query latency** -- `GET /api/nodes/{id}/metrics?hours=24`, issued
  continuously by `--readers` threads, reported as p50/p95/p99.
* **Process** -- resident set and CPU time from `/proc`, sampled before and after.
* **Storage** -- the database file and its write-ahead log before and after, and
  the size of the binary under test.

History is seeded through the documented offline import path rather than by
writing SQL from here: it needs no privileged interface, and it exercises the
importer on every run.

Requires nothing but the standard library; the WebSocket client is implemented
here so the benchmark has no dependency the repository does not already have.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


# ---- a minimal WebSocket client: enough for the agent protocol ----

class Socket:
    """One agent connection: a masked text frame writer and a reader thread."""

    def __init__(self, host, port, token, path='/api/agent/ws'):
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n'
            f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n'
            f'Authorization: Bearer {token}\r\n\r\n'
        )
        self.sock.sendall(request.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            piece = self.sock.recv(4096)
            if not piece:
                raise AssertionError('the agent handshake was closed')
            head += piece
        status = head.split(b'\r\n', 1)[0]
        if b'101' not in status:
            raise AssertionError(f'agent handshake refused: {status!r}')
        self.alive = True
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()

    def _drain(self):
        """Consumes server frames so the socket buffer cannot fill, answering pings."""
        try:
            while self.alive:
                header = self.sock.recv(2)
                if len(header) < 2:
                    break
                opcode = header[0] & 0x0F
                length = header[1] & 0x7F
                if length == 126:
                    length = struct.unpack('>H', self._read(2))[0]
                elif length == 127:
                    length = struct.unpack('>Q', self._read(8))[0]
                payload = self._read(length)
                if opcode == 0x9:  # ping
                    self._frame(0xA, payload)
        except OSError:
            pass

    def _read(self, n):
        data = b''
        while len(data) < n:
            piece = self.sock.recv(n - len(data))
            if not piece:
                raise OSError('closed')
            data += piece
        return data

    def _frame(self, opcode, payload):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        head = bytes([0x80 | opcode])
        if len(payload) < 126:
            head += bytes([0x80 | len(payload)])
        elif len(payload) < (1 << 16):
            head += bytes([0x80 | 126]) + struct.pack('>H', len(payload))
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', len(payload))
        self.sock.sendall(head + mask + masked)

    def text(self, message):
        self._frame(0x1, message.encode())

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass


# ---- the hub under test ----

class Hub:
    def __init__(self, binary, work, memory=None):
        self.binary = binary
        self.work = work
        self.engine = engine_of(binary)
        self.database = work / 'bench.db'
        self.log = (work / 'hub.log').open('w+')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.process = None

    def seed(self, export, nodes, days, probes):
        """Builds the database offline, before the hub is started.

        Two engines, two ways in, both offline and neither through the hub: the
        DuckDB build is seeded through the documented importer, and the SQLite
        build -- which has no importer, and must not gain one -- is seeded by
        writing the schema-5 file directly with the standard library. The fixture
        is identical either way, which is what makes the two runs comparable.
        """
        if self.engine.startswith('sqlite'):
            return self.seed_sqlite(nodes, days, probes)
        with export.open('w', encoding='utf-8') as handle:
            now = int(time.time())
            step = days * 1_440
            counts = {'setting': 3, 'node': nodes, 'traffic': nodes, 'ping_task': probes,
                      'ping_node': nodes * probes, 'metric': nodes * step,
                      'ping_record': nodes * probes * step}
            for key, value in [('public_page', 'on'), ('site_name', 'bench'), ('retention_days', '30')]:
                handle.write(json.dumps({'table': 'setting', 'row': {'key': key, 'value': value}}) + '\n')
            for node in range(1, nodes + 1):
                handle.write(json.dumps({'table': 'node', 'row': {
                    'id': node, 'name': f'bench-{node}', 'token_hash': tokendigest(node), 'sort': node,
                    'public': True, 'price': 0.0, 'currency': 'USD', 'billing_cycle': 'monthly',
                    'expires_at': None, 'remark': '', 'traffic_limit': 0, 'traffic_mode': 'sum',
                    'traffic_reset_day': 1, 'hostname': f'bench-{node}', 'os': 'Linux', 'kernel': '6.1.0',
                    'arch': 'x86_64', 'virt': 'kvm', 'cpu_name': 'bench', 'cpu_cores': 4,
                    'mem_total': 8_589_934_592, 'swap_total': 0, 'disk_total': 107_374_182_400,
                    'agent_version': 'bench', 'ip': f'198.51.100.{node}', 'ipv4': '', 'ipv6': '',
                    'country': 'JP', 'last_seen': now, 'notify': False, 'down_since': 0,
                    'created_at': now}}) + '\n')
            for node in range(1, nodes + 1):
                handle.write(json.dumps({'table': 'traffic', 'row': {
                    'node_id': node, 'boot_id': 'seed', 'last_rx': 0, 'last_tx': 0,
                    'total_rx': 0, 'total_tx': 0, 'month_rx': 0, 'month_tx': 0, 'month_start': '',
                    'day_rx': 0, 'day_tx': 0, 'day_start': ''}}) + '\n')
            for probe in range(1, probes + 1):
                handle.write(json.dumps({'table': 'ping_task', 'row': {
                    'id': probe, 'name': f'probe-{probe}', 'target': '1.1.1.1:443',
                    'interval': 60}}) + '\n')
            for probe in range(1, probes + 1):
                for node in range(1, nodes + 1):
                    handle.write(json.dumps({'table': 'ping_node', 'row': {
                        'task_id': probe, 'node_id': node}}) + '\n')
            for node in range(1, nodes + 1):
                for minute in range(step):
                    handle.write(json.dumps({'table': 'metric', 'row': {
                        'node_id': node, 'ts': now - minute * 60, 'cpu': float(minute % 100),
                        'mem_used': 1_000_000 + minute, 'swap_used': 0, 'disk_used': 2_000_000,
                        'net_rx': 1_000, 'net_tx': 2_000, 'tcp': 10, 'udp': 5,
                        'procs': 100}}) + '\n')
            for probe in range(1, probes + 1):
                for node in range(1, nodes + 1):
                    for minute in range(step):
                        handle.write(json.dumps({'table': 'ping_record', 'row': {
                            'node_id': node, 'task_id': probe, 'ts': now - minute * 60,
                            'latency': 10 + (minute % 40) if minute % 37 else -1}}) + '\n')
            handle.write(json.dumps({'table': '#export', 'source_schema': 5, 'rows': counts}) + '\n')
        done = subprocess.run(
            [str(self.binary), '--import-legacy', str(export), '--db', str(self.database)],
            capture_output=True, text=True, cwd=self.work)
        if done.returncode != 0:
            raise AssertionError(f'seeding failed:\n{done.stdout}\n{done.stderr}')
        return counts

    def seed_sqlite(self, nodes, days, probes):
        """The same fixture as `seed`, written straight into a legacy-style file."""
        schema = (ROOT / 'scripts' / 'test-legacy-migration.py').read_text()
        start = schema.index('LEGACY_SCHEMA = """') + len('LEGACY_SCHEMA = """')
        schema = schema[start:schema.index('"""', start)]
        connection = sqlite3.connect(self.database)
        connection.executescript(schema)
        now = int(time.time())
        step = days * 1_440
        counts = {'setting': 3, 'node': 0, 'traffic': 0, 'ping_task': 0, 'ping_node': 0,
                  'metric': 0, 'ping_record': 0}
        connection.executemany('INSERT INTO setting VALUES (?, ?)',
                               [('public_page', 'on'), ('site_name', 'bench'), ('retention_days', '30')])
        for node in range(1, nodes + 1):
            connection.execute(
                'INSERT INTO node (id, name, token_hash, sort, public, price, currency, billing_cycle,'
                ' expires_at, remark, traffic_limit, traffic_mode, traffic_reset_day, hostname, os, kernel,'
                ' arch, virt, cpu_name, cpu_cores, mem_total, swap_total, disk_total, agent_version, ip,'
                ' ipv4, ipv6, country, last_seen, notify, down_since, created_at)'
                ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (node, f'bench-{node}', tokendigest(node), node, 1, 0.0, 'USD', 'monthly', None, '', 0,
                 'sum', 1, f'bench-{node}', 'Linux', '6.1.0', 'x86_64', 'kvm', 'bench', 4,
                 8_589_934_592, 0, 107_374_182_400, 'bench', f'198.51.100.{node}', '', '', 'JP', now, 0, 0,
                 now))
            connection.execute('INSERT INTO traffic (node_id) VALUES (?)', (node,))
            connection.executemany('INSERT INTO metric VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                   [(node, now - m * 60, float(m % 100), 1_000_000 + m, 0, 2_000_000,
                                     1_000, 2_000, 10, 5, 100) for m in range(step)])
            counts['node'] += 1
            counts['traffic'] += 1
            counts['metric'] += step
        for probe in range(1, probes + 1):
            connection.execute('INSERT INTO ping_task VALUES (?,?,?,?)',
                               (probe, f'probe-{probe}', '1.1.1.1:443', 60))
            counts['ping_task'] += 1
            for node in range(1, nodes + 1):
                connection.execute('INSERT INTO ping_node VALUES (?,?)', (probe, node))
                counts['ping_node'] += 1
                connection.executemany('INSERT INTO ping_record VALUES (?,?,?,?)',
                                       [(node, probe, now - m * 60, 10 + (m % 40) if m % 37 else -1)
                                        for m in range(step)])
                counts['ping_record'] += step
        connection.commit()
        connection.close()
        return counts

    def start(self, memory=None):
        command = [str(self.binary), '--listen', f'127.0.0.1:{self.port}', '--db', str(self.database)]
        if memory:
            command += ['--db-memory', memory]
        self.process = subprocess.Popen(command, cwd=self.work, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f'the hub exited:\n{(self.work / "hub.log").read_text()}')
            try:
                urllib.request.urlopen(self.url + '/api/me', timeout=2).read()
                return
            except (OSError, urllib.error.URLError):
                time.sleep(0.2)
        raise AssertionError('the hub never answered')

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def password(self):
        text = (self.work / 'hub.log').read_text()
        match = re.search(r'Emergency password: (\S+)', text)
        return match[1] if match else None

    def rss_kb(self):
        try:
            status = Path(f'/proc/{self.process.pid}/status').read_text()
        except OSError:
            return 0
        return int(re.search(r'VmRSS:\s+(\d+) kB', status).group(1))

    def cpu_seconds(self):
        try:
            fields = Path(f'/proc/{self.process.pid}/stat').read_text().split()
        except OSError:
            return 0.0
        ticks = os.sysconf('SC_CLK_TCK')
        return (int(fields[13]) + int(fields[14])) / ticks

    def storage_bytes(self):
        total = 0
        for suffix in ['', '.wal']:
            path = Path(f'{self.database}{suffix}')
            if path.exists():
                total += path.stat().st_size
        return total


def tokendigest(node):
    return hashlib.sha256(f'bench-token-{node}'.encode()).hexdigest()


class Bench:
    def __init__(self, args):
        self.args = args
        self.work = Path(tempfile.mkdtemp(prefix='romi-bench-'))
        self.binary = (args.bin_dir / 'monitor-hub').resolve()
        self.hub = Hub(self.binary, self.work)
        self.client = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(self, path, data=None, headers=None):
        request = urllib.request.Request(
            self.hub.url + path, headers=headers or {},
            data=None if data is None else json.dumps(data).encode())
        if data is not None:
            request.add_header('Content-Type', 'application/json')
        # Generous: a saturated hub answers slowly, and a timeout here would end
        # the run instead of measuring the saturation.
        return self.client.open(request, timeout=60)

    def booked(self):
        """The hub's own sum of lifetime received bytes, over the seeded nodes."""
        with self.request('/api/nodes') as response:
            nodes = json.load(response)['nodes']
        return sum(node.get('total_rx', 0) for node in nodes if node['name'].startswith('bench-'))

    def queue_depth(self):
        """Accepted-but-uncommitted writes, or None on a build that does not report them."""
        try:
            with self.request('/api/db') as response:
                info = json.load(response)
        except (OSError, urllib.error.URLError):
            return None
        queue = info.get('queue')
        return queue.get('queued') if isinstance(queue, dict) else None

    def latency(self, call, samples):
        """p50/p95/p99 of `call`, in milliseconds."""
        taken = []
        for _ in range(samples):
            start = time.perf_counter()
            call()
            taken.append((time.perf_counter() - start) * 1000)
        taken.sort()
        pick = lambda q: taken[min(len(taken) - 1, int(len(taken) * q))]
        return {'p50': round(pick(0.50), 2), 'p95': round(pick(0.95), 2), 'p99': round(pick(0.99), 2),
                'n': len(taken)}

    def run(self):
        args = self.args
        seeded = self.hub.seed(self.work / 'seed.jsonl', args.nodes, args.history_days, args.probes)
        self.hub.start(memory=args.memory)
        password = self.hub.password()
        if password:
            self.request('/api/auth/login', {'password': password})

        # Agents: the real protocol, one connection per node, with counters that
        # climb the way a kernel's do.
        agents = []
        for node in range(1, args.nodes + 1):
            agents.append(Socket('127.0.0.1', self.hub.port, f'bench-token-{node}'))

        sent = [0] * (args.nodes + 1)
        stop = threading.Event()

        def report(node, agent):
            counters = 0
            per_report = int(args.interval * 1_000_000)
            while not stop.is_set():
                # Integers: the hub reads these with `as_i64`, and a JSON float
                # would be treated as "no readable counter" -- which is what the
                # accumulated-vs-sent check below exists to notice.
                counters += per_report
                message = json.dumps({'jsonrpc': '2.0', 'method': 'report', 'params': {
                    'boot_id': 'bench-boot', 'cpu': 12.5, 'mem_used': 1_000_000, 'swap_used': 0,
                    'disk_used': 2_000_000, 'net_rx_total': counters, 'net_tx_total': counters,
                    'net_rx': 1_000, 'net_tx': 2_000, 'tcp': 10, 'udp': 5, 'procs': 100,
                    'uptime': counters, 'mem_total': 8_589_934_592, 'swap_total': 0,
                    'disk_total': 107_374_182_400, 'load': [0.1, 0.2, 0.3]}})
                try:
                    agent.text(message)
                except OSError:
                    return
                sent[node] += 1
                time.sleep(args.interval)

        threads = [threading.Thread(target=report, args=(node, agents[node - 1]), daemon=True)
                   for node in range(1, args.nodes + 1)]
        for thread in threads:
            thread.start()

        # Readers: the heaviest history query the panel issues, continuously.
        reads = []
        read_errors = []

        def read_history(node):
            while not stop.is_set():
                start = time.perf_counter()
                try:
                    self.request(f'/api/nodes/{node}/metrics?hours=24')
                    reads.append((time.perf_counter() - start) * 1000)
                except (OSError, urllib.error.URLError) as error:
                    read_errors.append(str(error))
                time.sleep(0.05)

        reader_threads = [threading.Thread(target=read_history, args=((i % args.nodes) + 1,), daemon=True)
                          for i in range(args.readers)]
        for thread in reader_threads:
            thread.start()

        rss_before, cpu_before = self.hub.rss_kb(), self.hub.cpu_seconds()
        storage_before = self.hub.storage_bytes()
        time.sleep(2)  # let the readers and agents reach a steady state
        booked_before = self.booked()

        # The highest queue depth seen while the load ran, for the DuckDB build,
        # whose `/api/db` reports the accepted-but-uncommitted window. The SQLite
        # build has no such figure, so this is reported as null there rather than
        # compared.
        peak_queue = [0]
        queue = self.queue_depth()
        watching = queue is not None

        def watch_queue():
            while not stop.is_set():
                depth = self.queue_depth()
                if depth is not None and depth > peak_queue[0]:
                    peak_queue[0] = depth
                time.sleep(0.1)

        watcher = threading.Thread(target=watch_queue, daemon=True)
        if watching:
            watcher.start()

        write_latency = self.latency(
            lambda: self.request('/api/nodes', {'name': f'probe-{time.time()}',
                                                'traffic_reset_day': 1},
                                 {'Host': 'bench.test', 'X-Forwarded-Proto': 'https'}),
            args.samples)
        read_latency = self.latency(lambda: self.request('/api/nodes'), args.samples)

        started = time.monotonic()
        time.sleep(args.seconds)
        elapsed = time.monotonic() - started
        stop.set()
        for thread in threads + reader_threads:
            thread.join(timeout=5)
        # Bounded drain: ingestion is asynchronous, so the hub is allowed to
        # finish what it accepted before the totals are compared. How long that
        # takes is part of the result, not something to hide. Quiescence is read
        # from the committed total rather than from the queue depth, so it works
        # on both engines.
        drain_started = time.monotonic()
        settled = 0
        previous = self.booked()
        while time.monotonic() - drain_started < 60:
            time.sleep(0.5)
            current = self.booked()
            settled = settled + 1 if current == previous else 0
            previous = current
            if settled >= 2:
                break
        drained = time.monotonic() - drain_started
        rss_after, cpu_after = self.hub.rss_kb(), self.hub.cpu_seconds()
        storage_after = self.hub.storage_bytes()
        booked_after = self.booked()

        # What the hub actually committed, against what the agents sent. Each
        # agent's first report only sets a baseline, so the expected total is one
        # report less than it sent; a shortfall means telemetry was lost rather
        # than merely queued.
        per_report = int(args.interval * 1_000_000)
        expected = sum(max(0, sent[node] - 1) * per_report for node in range(1, args.nodes + 1))
        booked = booked_after - booked_before

        for agent in agents:
            agent.close()
        self.hub.stop()

        reads.sort()
        pick = lambda q: reads[min(len(reads) - 1, int(len(reads) * q))] if reads else 0
        reports = sum(sent)
        result = {
            'label': args.label,
            'binary': str(self.binary),
            'engine': engine_of(self.binary),
            'binary_bytes': self.binary.stat().st_size,
            'workload': {'nodes': args.nodes, 'interval_s': args.interval, 'history_days': args.history_days,
                         'probes': args.probes, 'readers': args.readers, 'seconds': args.seconds},
            'seeded_rows': seeded,
            'ingest': {
                'reports_offered': reports,
                'offered_per_second': round(reports / elapsed, 1),
                # Committed, from the hub's own counters, divided by the window:
                # the rate the storage engine actually sustained.
                'committed_reports': booked // per_report if per_report else 0,
                'committed_per_second': round(booked / per_report / elapsed, 1) if per_report else 0,
                'uncommitted_after_drain': max(0, (expected - booked) // per_report) if per_report else 0,
                'drain_seconds': round(drained, 2),
                'peak_queue': peak_queue[0] if watching else None,
            },
            'latency_ms': {'write_under_load': write_latency, 'read_under_load': read_latency},
            'history_query_ms': {'p50': round(pick(0.50), 2), 'p95': round(pick(0.95), 2),
                                 'p99': round(pick(0.99), 2), 'n': len(reads),
                                 'errors': len(read_errors)},
            'process': {
                'rss_before_kb': rss_before, 'rss_after_kb': rss_after,
                'cpu_seconds': round(cpu_after - cpu_before, 2),
                'cpu_percent': round((cpu_after - cpu_before) / elapsed * 100, 1),
            },
            'storage': {'before_bytes': storage_before, 'after_bytes': storage_after,
                        'growth_bytes': storage_after - storage_before},
            'accumulated': {'expected_rx': expected, 'booked_rx': booked,
                            'exact': expected == booked},
        }
        return result


def engine_of(binary):
    """The storage engine a build uses, read from its own help output."""
    done = subprocess.run([str(binary), '--help'], capture_output=True, text=True)
    text = done.stdout + done.stderr
    if '--import-legacy' in text:
        return 'duckdb 1.5.5'
    return 'sqlite (rusqlite 0.37)'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bin-dir', type=Path, default=ROOT / 'target' / 'release')
    parser.add_argument('--label', default='duckdb')
    parser.add_argument('--nodes', type=int, default=20)
    parser.add_argument('--interval', type=float, default=2.0, help='seconds between reports per agent')
    parser.add_argument('--history-days', type=int, default=1)
    parser.add_argument('--probes', type=int, default=2)
    parser.add_argument('--readers', type=int, default=4)
    parser.add_argument('--seconds', type=float, default=20.0, help='measured ingest window')
    parser.add_argument('--samples', type=int, default=30, help='probe requests per latency figure')
    parser.add_argument('--memory', default=None, help='--db-memory for the DuckDB build')
    parser.add_argument('--out', type=Path, help='write the JSON result here as well')
    args = parser.parse_args()

    if not (args.bin_dir / 'monitor-hub').exists():
        raise SystemExit(f'{args.bin_dir}/monitor-hub does not exist; run make release first')
    result = Bench(args).run()
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
