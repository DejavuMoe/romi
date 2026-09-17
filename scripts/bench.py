#!/usr/bin/env python3
"""Storage benchmark for the romi Hub.

Runs a real Agent WebSocket workload against a release build and prints one JSON
object:

    make bench
    python3 scripts/bench.py --bin-dir target/release --label duckdb

What it measures, and how:

* **Ingestion** -- N fake agents speaking the real agent protocol, reporting at a
  fixed interval with monotonically increasing kernel counters. The hub has no
  acknowledgement for a report, so throughput is what the agents managed to send
  and *correctness* is checked afterwards by comparing the hub's own accumulated
  totals against what was sent. No report is dropped to improve the number.
* **Writer queue** -- `/api/db` exposes accepted/committed/refused/failed
  operations, group-commit batch counts and sizes, queue wait and transaction
  time. The benchmark records the peak `queued_ops_current` and the final
  counters, which is how group commit is verified rather than assumed.
* **Commit and queue delay** -- a small authenticated write (`POST /api/nodes`)
  under ingest load, and a small read (`GET /api/nodes`). Both go through the
  same writer thread the reports do.
* **History query latency** -- `GET /api/nodes/{id}/metrics?hours=24`, issued
  continuously by `--readers` threads. This phase removed the offline fixture
  importer, so the query runs against rows produced by the live workload; the
  next phase can add a dedicated analytical seeder. The result reports how many
  requests and errors it saw.
* **Process** -- resident set and CPU time from `/proc`, sampled before and after.
* **Storage** -- the database file and its write-ahead log before and after.

Requires nothing but the standard library; the WebSocket client is implemented
here so the benchmark has no dependency the repository does not already have.
"""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
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
        self.database = work / 'bench.db'
        self.log = (work / 'hub.log').open('w+')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.process = None

    def start(self, memory=None, threads=None):
        command = [str(self.binary), '--listen', f'127.0.0.1:{self.port}', '--db', str(self.database)]
        if memory:
            command += ['--db-memory', memory]
        if threads:
            command += ['--db-threads', str(threads)]
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


class Bench:
    def __init__(self, args):
        self.args = args
        self.work = Path(tempfile.mkdtemp(prefix='romi-bench-'))
        self.binary = (args.bin_dir / 'romi-hub').resolve()
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
        """The hub's own sum of lifetime received bytes, over the benchmark nodes."""
        with self.request('/api/nodes') as response:
            nodes = json.load(response)['nodes']
        return sum(node.get('total_rx', 0) for node in nodes if node['name'].startswith('bench-'))

    def db_stats(self):
        with self.request('/api/db') as response:
            return json.load(response)

    def queue_depth(self):
        """Accepted-but-uncommitted writes, or None on a build that does not report them."""
        try:
            queue = self.db_stats().get('queue')
        except (OSError, urllib.error.URLError):
            return None
        return queue.get('queued_ops_current') if isinstance(queue, dict) else None

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

    def create_nodes(self):
        """Creates the benchmark's nodes through the real provisioning API.

        The previous offline fixture importer was removed in this phase; this
        keeps the workload self-contained without adding a second data path to
        the product.
        """
        tokens = []
        for node in range(1, self.args.nodes + 1):
            with self.request(
                '/api/nodes',
                {'name': f'bench-{node}', 'traffic_reset_day': 1},
                {'Host': 'bench.test', 'X-Forwarded-Proto': 'https'},
            ) as response:
                tokens.append(json.load(response)['token'])
        return tokens

    def run(self):
        args = self.args
        self.hub.start(memory=args.memory)
        password = self.hub.password()
        if password:
            self.request('/api/auth/login', {'password': password})
        tokens = self.create_nodes()
        storage = self.db_stats()
        engine = storage.get('engine', 'unknown')

        # Agents: the real protocol, one connection per node, with counters that
        # climb the way a kernel's do.
        agents = [Socket('127.0.0.1', self.hub.port, token) for token in tokens]

        sent = [0] * (args.nodes + 1)
        window = [0] * (args.nodes + 1)
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
                window[node] += 1
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
        booked_zero = self.booked()
        time.sleep(2)  # let the readers and agents reach a steady state

        # The highest accepted-but-uncommitted depth seen while the load ran,
        # read from `/api/db`.
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

        # The measured window starts here. Offered counters are reset after the
        # warm-up so the rate describes steady-state load rather than the ramp.
        for node in range(1, args.nodes + 1):
            window[node] = 0
        booked_window_start = self.booked()
        started = time.monotonic()
        time.sleep(args.seconds)
        elapsed = time.monotonic() - started
        stop.set()
        # Commits up to the stop line, before the bounded drain below. This is
        # the window throughput; the backlog is what drains afterwards.
        booked_at_stop = self.booked()
        for thread in threads + reader_threads:
            thread.join(timeout=5)
        # What the hub should commit, against what the agents sent. Each agent's
        # first report only sets a baseline, so the expected total is one report
        # less than it sent. Reports are absolute counters, so every sent report
        # has exactly one expected contribution: the hub is correct only when its
        # own total reaches this value. No report is dropped to improve a number.
        per_report = int(args.interval * 1_000_000)
        expected = sum(max(0, sent[node] - 1) * per_report for node in range(1, args.nodes + 1))

        # Bounded drain: ingestion is asynchronous, and the agents may have put
        # their last frames on the wire before stopping. Wait until the hub's own
        # committed total reaches the expected value, or 60 s. How long that takes
        # is part of the result, not something to hide.
        drain_started = time.monotonic()
        while time.monotonic() - drain_started < 60:
            if self.booked() - booked_zero >= expected:
                break
            time.sleep(0.2)
        drained = time.monotonic() - drain_started
        rss_after, cpu_after = self.hub.rss_kb(), self.hub.cpu_seconds()
        storage_after = self.hub.storage_bytes()
        booked_after = self.booked()
        booked = booked_after - booked_zero

        for agent in agents:
            agent.close()
        final_stats = self.db_stats()
        self.hub.stop()

        reads.sort()
        pick = lambda q: reads[min(len(reads) - 1, int(len(reads) * q))] if reads else 0
        reports = sum(window)
        committed_window = max(0, booked_at_stop - booked_window_start) // per_report if per_report else 0
        result = {
            'label': args.label,
            'binary': str(self.binary),
            'engine': engine,
            'binary_bytes': self.binary.stat().st_size,
            'workload': {'nodes': args.nodes, 'interval_s': args.interval, 'readers': args.readers,
                         'seconds': args.seconds, 'target_report_rate': args.rate},
            'nodes_created': args.nodes,
            'ingest': {
                'reports_offered': reports,
                'offered_per_second': round(reports / elapsed, 1),
                # Committed during the same window, from the hub's own counters:
                # the rate the storage engine actually sustained.
                'committed_reports': committed_window,
                'committed_per_second': round(committed_window / elapsed, 1),
                'uncommitted_after_drain': max(0, (expected - booked) // per_report) if per_report else 0,
                'drain_seconds': round(drained, 2),
                'peak_queue': peak_queue[0] if watching else None,
            },
            'latency_ms': {'write_under_load': write_latency, 'read_under_load': read_latency},
            'writer_queue': final_stats.get('queue', {}),
            'history_query_ms': {'p50': round(pick(0.50), 2), 'p95': round(pick(0.95), 2),
                                 'p99': round(pick(0.99), 2), 'n': len(reads),
                                 'errors': len(read_errors),
                                 'note': 'live-ingested rows only; no synthetic history fixture in this phase'},
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bin-dir', type=Path, default=ROOT / 'target' / 'release')
    parser.add_argument('--label', default='duckdb')
    parser.add_argument('--nodes', type=int, default=20)
    parser.add_argument('--interval', type=float, default=2.0, help='seconds between reports per agent')
    parser.add_argument('--rate', type=float, default=None,
                        help='target total reports per second; sets interval = nodes / rate')
    parser.add_argument('--readers', type=int, default=4)
    parser.add_argument('--seconds', type=float, default=20.0, help='measured ingest window')
    parser.add_argument('--samples', type=int, default=30, help='probe requests per latency figure')
    parser.add_argument('--memory', default=None, help='--db-memory for the DuckDB build')
    parser.add_argument('--out', type=Path, help='write the JSON result here as well')
    args = parser.parse_args()
    if args.rate is not None:
        if args.rate <= 0:
            raise SystemExit('--rate must be positive')
        args.interval = args.nodes / args.rate

    if not (args.bin_dir / 'romi-hub').exists():
        raise SystemExit(f'{args.bin_dir}/romi-hub does not exist; run make release first')
    result = Bench(args).run()
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
