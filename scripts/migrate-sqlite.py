#!/usr/bin/env python3
"""Export a legacy romi SQLite database as JSONL for the DuckDB importer.

This is the only code in the repository that understands SQLite. It is run by
hand, once, when moving a hub from the SQLite build to the DuckDB build:

    python3 scripts/migrate-sqlite.py --source /var/lib/romi/romi.db --out /tmp/romi-legacy.jsonl
    monitor-hub --import-legacy /tmp/romi-legacy.jsonl --db /var/lib/romi/romi.duckdb

Nothing here writes to the source: it is opened read-only through SQLite's URI
mode, checked with `PRAGMA integrity_check`, and left byte-for-byte alone. The
destination is written as `<out>.partial` and renamed only after the whole export
has finished, so an interrupted run publishes nothing.

Only the reviewed schema version 5 is exported. Older upstream schemas are
refused rather than guessed at: the token column changed meaning twice before
version 5 (a raw agent token, then a digest of one), and a converter that guessed
would either lock every agent out or store a digest as a credential. Upgrade the
old database with the matching older romi build first, then run this.

Sessions are counted but not exported. The importer leaves the table empty, so
every login ends at cutover and the administrator signs in again; carrying a
session across would extend a cookie the operator may already have revoked.
"""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

SCHEMA_VERSION = 5

# Table -> columns, in the order the DuckDB importer expects them. Copied from the
# reviewed schema 5 rather than discovered, so a column that changed meaning is a
# refusal here instead of a silent mis-mapping.
TABLES = {
    'setting': ['key', 'value'],
    'node': [
        'id', 'name', 'token_hash', 'sort', 'public', 'price', 'currency', 'billing_cycle',
        'expires_at', 'remark', 'traffic_limit', 'traffic_mode', 'traffic_reset_day', 'hostname',
        'os', 'kernel', 'arch', 'virt', 'cpu_name', 'cpu_cores', 'mem_total', 'swap_total',
        'disk_total', 'agent_version', 'ip', 'ipv4', 'ipv6', 'country', 'last_seen', 'notify',
        'down_since', 'created_at',
    ],
    'traffic': [
        'node_id', 'boot_id', 'last_rx', 'last_tx', 'total_rx', 'total_tx', 'month_rx', 'month_tx',
        'month_start', 'day_rx', 'day_tx', 'day_start',
    ],
    'ping_task': ['id', 'name', 'target', 'interval'],
    'ping_node': ['task_id', 'node_id'],
    'metric': [
        'node_id', 'ts', 'cpu', 'mem_used', 'swap_used', 'disk_used', 'net_rx', 'net_tx', 'tcp',
        'udp', 'procs',
    ],
    'ping_record': ['node_id', 'task_id', 'ts', 'latency'],
}

# Parent tables first: the importer checks relationships after loading, and a
# report that a child arrived before its parent would be misleading.
ORDER = ['setting', 'node', 'traffic', 'ping_task', 'ping_node', 'metric', 'ping_record']
# Read in one pass but written in ORDER; metric and ping_record are the large ones.
BATCH = 2000


def fail(message):
    print(f'error: {message}', file=sys.stderr)
    raise SystemExit(1)


def connect(source):
    if not Path(source).exists():
        fail(f'{source} does not exist')
    # Read-only through the URI so nothing here can modify the operator's file,
    # not even a stray journal recovery.
    connection = sqlite3.connect(f'file:{Path(source).resolve()}?mode=ro', uri=True)
    connection.text_factory = str
    head = Path(source).read_bytes()[:16]
    if not head.startswith(b'SQLite format 3\x00'):
        fail(f'{source} is not a SQLite database')
    return connection


def check_schema(connection, source):
    version = connection.execute('PRAGMA user_version').fetchone()[0]
    if version != SCHEMA_VERSION:
        fail(
            f'{source} is schema {version}; this tool exports schema {SCHEMA_VERSION} only.\n'
            f'       Upgrade it with the matching older romi build first, then run this again.\n'
            f'       Nothing was written.'
        )
    integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
    if integrity != 'ok':
        fail(f'{source} failed its integrity check: {integrity}')
    for table, columns in TABLES.items():
        present = {row[1] for row in connection.execute(f'PRAGMA table_info({table})')}
        if not present:
            fail(f'{source} has no {table} table; it is not a schema {SCHEMA_VERSION} database')
        missing = [c for c in columns if c not in present]
        if missing:
            fail(f'{table} is missing {", ".join(missing)}; not a schema {SCHEMA_VERSION} database')


def export(source, out):
    connection = connect(source)
    check_schema(connection, source)
    counts = {}
    # `partial` rather than `out`: a run that dies half way must not leave
    # something the importer would accept as a complete export.
    partial = Path(f'{out}.partial')
    partial.parent.mkdir(parents=True, exist_ok=True)
    with partial.open('w', encoding='utf-8') as handle:
        for table in ORDER:
            columns = TABLES[table]
            list_ = ', '.join(f'"{c}"' for c in columns)
            cursor = connection.execute(f'SELECT {list_} FROM "{table}"')
            seen = 0
            while True:
                rows = cursor.fetchmany(BATCH)
                if not rows:
                    break
                for row in rows:
                    record = {}
                    for name, value in zip(columns, row):
                        if isinstance(value, (bytes, bytearray, memoryview)):
                            # No column in this schema is a BLOB; one here means
                            # the file is not what its version claims.
                            fail(f'{table}.{name} holds binary data; not a schema {SCHEMA_VERSION} database')
                        record[name] = value
                    handle.write(json.dumps({'table': table, 'row': record}, separators=(',', ':')))
                    handle.write('\n')
                seen += len(rows)
            counts[table] = seen
        # Sessions are deliberately absent from the export.
        sessions = connection.execute('SELECT COUNT(*) FROM session').fetchone()[0]
        handle.write(json.dumps({
            'table': '#export',
            'source_schema': SCHEMA_VERSION,
            'rows': counts,
            'sessions_dropped': sessions,
        }, separators=(',', ':')))
        handle.write('\n')
    connection.close()
    partial.replace(out)
    return counts, sessions


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, type=Path, help='the legacy SQLite database (never modified)')
    parser.add_argument('--out', required=True, type=Path, help='where to write the JSONL export')
    args = parser.parse_args()
    counts, sessions = export(args.source, args.out)
    total = sum(counts.values())
    print(f'exported {total} rows to {args.out}')
    for table in ORDER:
        print(f'  {table}: {counts[table]}')
    print(f'  session: {sessions} (not exported; every login ends at cutover)')
    print()
    print('next:')
    print(f'  monitor-hub --import-legacy {args.out} --db <new duckdb path>')
    print(f'{args.source} was not modified.')


if __name__ == '__main__':
    main()
