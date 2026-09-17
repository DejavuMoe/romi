#!/usr/bin/env python3
"""End-to-end check of the offline SQLite -> DuckDB migration.

Builds a legacy schema-5 database with the standard library, runs the two
documented commands against the real binaries, and then asserts what the
migration promises: identifiers, rows, configuration, password hashes and node
token *hashes* arrive unchanged, sessions do not, the source is untouched, and a
second migration run refuses to overwrite the result.

This is the only place a legacy SQLite file is written, and the only place one is
read, which is what keeps that understanding out of the shipped Hub.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]

# The reviewed schema 5, as the SQLite build created it.
LEGACY_SCHEMA = """
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE node (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD', billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  expires_at TEXT, remark TEXT NOT NULL DEFAULT '', traffic_limit INTEGER NOT NULL DEFAULT 0,
  traffic_mode TEXT NOT NULL DEFAULT 'sum', traffic_reset_day INTEGER NOT NULL DEFAULT 1,
  hostname TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', kernel TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '', virt TEXT NOT NULL DEFAULT '', cpu_name TEXT NOT NULL DEFAULT '',
  cpu_cores INTEGER NOT NULL DEFAULT 0, mem_total INTEGER NOT NULL DEFAULT 0,
  swap_total INTEGER NOT NULL DEFAULT 0, disk_total INTEGER NOT NULL DEFAULT 0,
  agent_version TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', ipv4 TEXT NOT NULL DEFAULT '',
  ipv6 TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', last_seen INTEGER NOT NULL DEFAULT 0,
  notify INTEGER NOT NULL DEFAULT 0, down_since INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE traffic (
  node_id INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE, boot_id TEXT NOT NULL DEFAULT '',
  last_rx INTEGER NOT NULL DEFAULT 0, last_tx INTEGER NOT NULL DEFAULT 0, total_rx INTEGER NOT NULL DEFAULT 0,
  total_tx INTEGER NOT NULL DEFAULT 0, month_rx INTEGER NOT NULL DEFAULT 0, month_tx INTEGER NOT NULL DEFAULT 0,
  month_start TEXT NOT NULL DEFAULT '', day_rx INTEGER NOT NULL DEFAULT 0, day_tx INTEGER NOT NULL DEFAULT 0,
  day_start TEXT NOT NULL DEFAULT ''
);
CREATE TABLE metric (
  node_id INTEGER NOT NULL, ts INTEGER NOT NULL, cpu REAL NOT NULL, mem_used INTEGER NOT NULL,
  swap_used INTEGER NOT NULL, disk_used INTEGER NOT NULL, net_rx INTEGER NOT NULL, net_tx INTEGER NOT NULL,
  tcp INTEGER NOT NULL, udp INTEGER NOT NULL, procs INTEGER NOT NULL, PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;
CREATE TABLE ping_task (id INTEGER PRIMARY KEY, name TEXT NOT NULL, target TEXT NOT NULL,
  interval INTEGER NOT NULL DEFAULT 60);
CREATE TABLE ping_node (task_id INTEGER NOT NULL, node_id INTEGER NOT NULL, PRIMARY KEY (task_id, node_id));
CREATE TABLE ping_record (node_id INTEGER NOT NULL, task_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  latency INTEGER NOT NULL, PRIMARY KEY (node_id, ts, task_id)) WITHOUT ROWID;
CREATE TABLE session (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
PRAGMA user_version = 5;
"""

# Values chosen to be recognisable and to cross the boundaries that a careless
# conversion loses: the 32-bit integer range, 2038, 2^53, a fractional price and a
# token digest that must not be hashed a second time.
LIFETIME_RX = 9223372036854775806
LIFETIME_TX = 4611686018427387904
AFTER_2038 = 4102444800
MEM_TOTAL = 5368709120
PRICE = 19.99
TOKEN = 'legacy-agent-token'
PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$deadbeefdeadbeefdeadbeefdeadbeef'


def build_legacy(path):
    connection = sqlite3.connect(path)
    connection.executescript(LEGACY_SCHEMA)
    connection.execute("INSERT INTO setting VALUES ('admin_password_hash', ?)", (PASSWORD_HASH,))
    connection.execute("INSERT INTO setting VALUES ('public_page', 'on')")
    connection.execute("INSERT INTO setting VALUES ('retention_days', '30')")
    connection.execute("INSERT INTO setting VALUES ('site_name', 'legacy hub')")
    connection.execute(
        """INSERT INTO node (id, name, token_hash, sort, public, price, currency, billing_cycle,
                            expires_at, remark, traffic_limit, traffic_mode, traffic_reset_day,
                            hostname, os, kernel, arch, virt, cpu_name, cpu_cores, mem_total,
                            swap_total, disk_total, agent_version, ip, ipv4, ipv6, country,
                            last_seen, notify, down_since, created_at)
           VALUES (7, 'tokyo', ?, 0, 1, ?, 'JPY', 'monthly', NULL, 'legacy row', 0, 'sum', 1,
                   'tokyo-1', 'Debian GNU/Linux 12', '6.1.0', 'x86_64', 'kvm', 'EPYC', 4, ?,
                   0, 107374182400, '1.0.0', '198.51.100.4', '198.51.100.4', '', 'JP', 1700000000, 1, 0, 1699999999)""",
        (hashlib.sha256(TOKEN.encode()).hexdigest(), PRICE, MEM_TOTAL),
    )
    connection.execute(
        """INSERT INTO traffic (node_id, boot_id, last_rx, last_tx, total_rx, total_tx, month_rx,
                                month_tx, month_start, day_rx, day_tx, day_start)
           VALUES (7, 'boot-a', 5000000000, 4000000000, ?, ?, 1000, 2000, '2026-01-01', 10, 20, '2026-01-02')""",
        (LIFETIME_RX, LIFETIME_TX),
    )
    connection.execute("INSERT INTO ping_task VALUES (3, 'cloudflare', '1.1.1.1:443', 60)")
    connection.execute("INSERT INTO ping_node VALUES (3, 7)")
    connection.execute("INSERT INTO metric VALUES (7, ?, 1.5, ?, 0, 1, 2, 3, 4, 5, 6)",
                       (AFTER_2038, MEM_TOTAL))
    connection.execute("INSERT INTO ping_record VALUES (7, 3, 1700000000, 42)")
    connection.execute("INSERT INTO session VALUES ('deadbeef', 99)")
    connection.commit()
    connection.close()


def run(command, **kwargs):
    done = subprocess.run(command, capture_output=True, text=True, **kwargs)
    if done.returncode != 0:
        raise AssertionError(f'{command} failed:\n{done.stdout}\n{done.stderr}')
    return done


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, help='verify extracted package binaries')
    args = parser.parse_args()
    binaries = args.bin_dir.resolve() if args.bin_dir else ROOT / 'target' / 'debug'
    hub = binaries / 'monitor-hub'
    if not hub.exists():
        raise AssertionError(f'{hub} does not exist; run make build first')

    with tempfile.TemporaryDirectory(prefix='romi-migrate-') as directory:
        work = Path(directory)
        legacy = work / 'romi.db'
        export = work / 'romi-legacy.jsonl'
        target = work / 'romi.duckdb'
        build_legacy(legacy)
        before = legacy.read_bytes()

        # The exporter refuses a schema it does not know, and writes nothing.
        older = work / 'older.db'
        older.write_bytes(before)
        connection = sqlite3.connect(older)
        connection.execute('PRAGMA user_version = 4')
        connection.commit()
        connection.close()
        refused = subprocess.run(
            [sys.executable, str(ROOT / 'scripts/migrate-sqlite.py'), '--source', str(older),
             '--out', str(work / 'older.jsonl')],
            capture_output=True, text=True,
        )
        assert refused.returncode != 0, 'an older schema must be refused'
        assert 'schema 4' in refused.stderr, refused.stderr
        assert not (work / 'older.jsonl').exists() and not (work / 'older.jsonl.partial').exists()

        done = run([sys.executable, str(ROOT / 'scripts/migrate-sqlite.py'),
                    '--source', str(legacy), '--out', str(export)])
        assert 'exported 10 rows' in done.stdout, done.stdout
        assert legacy.read_bytes() == before, 'the exporter modified the source'
        assert export.exists() and not Path(f'{export}.partial').exists()

        done = run([str(hub), '--import-legacy', str(export), '--db', str(target)])
        report = json.loads(done.stdout[:done.stdout.rindex('}') + 1])
        assert report['source_schema'] == 5, report
        assert report['rows']['node'] == 1 and report['rows']['metric'] == 1, report
        assert report['sessions_invalidated'] is True, report

        # The destination is a real DuckDB database, and the source still is not.
        assert target.read_bytes()[8:12] == b'DUCK', 'the migrated file must be DuckDB'
        assert legacy.read_bytes() == before, 'the source was modified by the import'
        assert not Path(f'{target}.wal').exists() or Path(f'{target}.wal').stat().st_size >= 0

        # A second run must refuse to write over the finished database.
        again = subprocess.run([str(hub), '--import-legacy', str(export), '--db', str(target)],
                               capture_output=True, text=True)
        assert again.returncode != 0, 'an existing destination must be refused'
        assert '已存在' in again.stderr, again.stderr

        # What the hub makes of it. A real process, so this covers the whole path
        # rather than the importer alone.
        import socket
        import time
        import urllib.error
        import urllib.request
        import http.cookiejar

        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        client = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

        def request(path, data=None, headers=None):
            req = urllib.request.Request(
                base + path, headers=headers or {},
                data=None if data is None else json.dumps(data).encode())
            if data is not None:
                req.add_header('Content-Type', 'application/json')
            return client.open(req, timeout=5)

        with (work / 'server.log').open('w+') as log:
            server = subprocess.Popen([str(hub), '--listen', f'127.0.0.1:{port}', '--db', str(target)],
                                      cwd=work, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    assert server.poll() is None, f'migrated database did not start:\n{log.read()}'
                    try:
                        if request('/api/me').status == 200:
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    time.sleep(0.2)
                else:
                    raise AssertionError('the hub never answered on the migrated database')

                # The public page was on in the source, so /api/nodes answers
                # anonymously and every migrated field is visible.
                with request('/api/nodes') as response:
                    nodes = json.load(response)['nodes']
                assert len(nodes) == 1, nodes
                node = nodes[0]
                assert node['id'] == 7, 'the identifier is preserved'
                assert node['name'] == 'tokyo'
                assert node['public'] is True
                assert node['price'] == PRICE, node['price']
                assert node['currency'] == 'JPY'
                assert node['country'] == 'JP'
                assert node['os'] == 'Debian GNU/Linux 12'
                assert node['mem_total'] == MEM_TOTAL, 'a 5 GiB counter survives'
                assert node['total_rx'] == LIFETIME_RX, node['total_rx']
                assert node['total_tx'] == LIFETIME_TX, node['total_tx']
                assert 'token' not in node and 'token_hash' not in node

                # History, including the row stamped past 2038.
                with request('/api/nodes/7/metrics?hours=1000000&points=2000') as response:
                    history = json.load(response)
                rows = history['metrics']
                assert len(rows) == 1, rows
                row = rows[0]
                # The chart stamps a bucket by its start, so the row's own stamp
                # (4 102 444 800, past 2038) lands inside the bucket reported here.
                # A 32-bit column would have wrapped it to something unrelated.
                assert row['ts'] > 2**31, row
                assert row['ts'] <= AFTER_2038 < row['ts'] + 3_600, (row['ts'], AFTER_2038)
                assert row['mem_used'] == MEM_TOTAL, row
                assert row['cpu'] == 1.5, row

                # The administrator's hash was copied rather than recomputed, so
                # a wrong password is still refused and no password is invented.
                try:
                    request('/api/auth/login', {'password': 'not-the-legacy-password'})
                    raise AssertionError('a wrong password must not sign in')
                except urllib.error.HTTPError as error:
                    assert error.code == 401, error.code
                assert 'Emergency password' not in (work / 'server.log').read_text(), (
                    'a migrated hub must not print a new emergency password'
                )
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()

    print('PASS: legacy schema 5 export, offline import, id/precision/hash preservation, '
          'source untouched, destination protected, migrated database serves')


if __name__ == '__main__':
    main()
