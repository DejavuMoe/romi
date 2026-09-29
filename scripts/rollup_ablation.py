#!/usr/bin/env python3
"""Raw versus hourly DuckDB history, using the production schema/SQL on ext4.

The Python wheel must match the pinned engine (1.5.5). Fixture creation has a
separate 4 GB budget/process; measured query workers reopen with 512 MB. Results
are engine expression timings, not concurrent Hub HTTP latency or Hub RSS.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SQL_SOURCE = ROOT / 'server/src/db/queries.rs'


def sql(name):
    found = re.search(r'pub const ' + name + r': &str = "(.*?)";', SQL_SOURCE.read_text(), re.S)
    assert found, name
    return found.group(1)


def connect(path, memory, threads):
    import duckdb
    assert duckdb.__version__ == '1.5.5'
    return duckdb.connect(str(path), config={'memory_limit': memory, 'threads': threads})


def seed(args, path, now):
    connection = connect(path, '4GB', 4)
    ddl = re.search(r'const DDL: &str = r#"(.*?)"#;', (ROOT / 'server/src/db/schema.rs').read_text(), re.S).group(1)
    # The fixture creates exactly the production constraints; it does not remove
    # keys to obtain flattering resource numbers.
    connection.execute(ddl)
    minutes = args.days * 1440
    start = now - args.days * 86400
    connection.execute(f"INSERT INTO node(id,name,token_hash,created_at) SELECT n, 'node-'||n, 'token-'||n, {start} FROM range(1,{args.nodes+1}) x(n)")
    connection.execute("INSERT INTO traffic(node_id) SELECT id FROM node")
    connection.execute("INSERT INTO ping_task VALUES (1,'one','localhost:80',60),(2,'two','localhost:81',60)")
    connection.execute("INSERT INTO ping_node SELECT task.id,node.id FROM ping_task task CROSS JOIN node")
    started = time.perf_counter()
    # Time-major order resembles arrival on a live Hub, not a pre-clustered best case.
    connection.execute(f"""INSERT INTO metric SELECT n, {start}+t*60, CAST((n+t)%101 AS DOUBLE),
        1000000000+n,0,2000000000+n,1000+t%100,2000+t%100,5,2,40
        FROM range(1,{args.nodes+1}) nodes(n) CROSS JOIN range({minutes}) times(t) ORDER BY t,n""")
    connection.execute(f"""INSERT INTO ping_record SELECT n, p, {start}+t*60,
        CASE WHEN (n+t+p)%100=0 THEN -1 ELSE 20+(n*17+t*7+p)%11 END
        FROM range(1,{args.nodes+1}) nodes(n) CROSS JOIN range({minutes}) times(t)
        CROSS JOIN range(1,3) probes(p) ORDER BY t,n,p""")
    counts = counts_for(connection)
    assert counts['metric'] == args.nodes * minutes
    assert counts['ping_record'] == args.nodes * minutes * 2
    connection.execute('CHECKPOINT')
    connection.close()
    return dict(seconds=time.perf_counter()-started, rows=counts, database_bytes=path.stat().st_size,
                peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def counts_for(connection):
    return {table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            for table in ('metric','metric_hour','ping_record','ping_hour')}


def queries(args, path, now):
    connection = connect(path, '512MB', args.threads)
    results = []
    for hours in (24, 720, args.days*24):
        for series, statement in (('metrics', sql('METRICS_SQL')), ('ping', sql('PING_ROWS_SQL'))):
            elapsed = []
            digests = []
            for i in range(21):
                node = 1 + (i*17) % args.nodes
                started = time.perf_counter()
                rows = connection.execute(statement, [node, now-hours*3600, 3600]).fetchall()
                duration = (time.perf_counter()-started)*1000
                # Hash the complete result, so row counts alone cannot conceal changed values.
                digest = hashlib.sha256(json.dumps(rows, separators=(',',':')).encode()).hexdigest()
                if i:
                    elapsed.append(duration)
                    digests.append(digest)
            elapsed.sort()
            results.append(dict(hours=hours, series=series, samples=len(elapsed),
                                p50_ms=elapsed[10],p95_ms=elapsed[19],p99_ms=elapsed[-1],digests=digests))
    connection.close()
    return dict(threads=args.threads, queries=results, peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def rollup(args, path, now):
    connection = connect(path, '512MB', 2)
    started = time.perf_counter()
    connection.execute('BEGIN')
    for name in ('ROLL_METRICS_SQL','ROLL_PINGS_SQL'):
        connection.execute(sql(name), [now-30*86400,now-365*86400])
    connection.execute('DELETE FROM metric WHERE ts < ?', [now-30*86400])
    connection.execute('DELETE FROM ping_record WHERE ts < ?', [now-30*86400])
    connection.execute('COMMIT')
    connection.execute('CHECKPOINT')
    counts = counts_for(connection)
    connection.close()
    return dict(seconds=time.perf_counter()-started, rows=counts, database_bytes=path.stat().st_size,
                peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, default=ROOT/'target/design-ablation/history')
    parser.add_argument('--nodes', type=int, default=100)
    parser.add_argument('--days', type=int, default=45)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--worker', choices=['seed','queries','rollup'])
    parser.add_argument('--now', type=int)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    work = args.work.resolve()
    assert work.is_relative_to((ROOT/'target').resolve()), 'only disposable target/ fixtures are allowed'
    work.mkdir(parents=True,exist_ok=True)
    path = work/'history.duckdb'
    now = args.now or int(time.time())//3600*3600
    if args.worker:
        print(json.dumps(dict(seed=seed,queries=queries,rollup=rollup)[args.worker](args,path,now)))
        return
    assert not path.exists(), 'choose an empty fixture directory'
    assert subprocess.check_output(['stat','-f','-c','%T',str(work)],text=True).strip() != 'tmpfs'
    report = dict(source=args.source,nodes=args.nodes,days=args.days,now=now,
                  query_sql_sha256=hashlib.sha256(SQL_SOURCE.read_bytes()).hexdigest(),phases={})
    for name,mode,threads in [('seed','seed',2),('raw-2','queries',2),('raw-8','queries',8),
                              ('rollup','rollup',2),('hourly-2','queries',2),('hourly-8','queries',8)]:
        command=[sys.executable,__file__,'--worker',mode,'--work',str(work),'--nodes',str(args.nodes),
                 '--days',str(args.days),'--now',str(now),'--threads',str(threads),'--source',args.source]
        result=subprocess.run(command,text=True,capture_output=True,timeout=900)
        report['phases'][name]=json.loads(result.stdout) if result.returncode==0 else dict(error=result.stderr[-3000:],exit_code=result.returncode)
        (work/'results.json').write_text(json.dumps(report,indent=2)+'\n')
        print(name, json.dumps({k:v for k,v in report['phases'][name].items() if k!='queries'}),flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
    for threads in (2,8):
        before=report['phases'][f'raw-{threads}']['queries']
        after=report['phases'][f'hourly-{threads}']['queries']
        assert [(q['hours'],q['series'],q['digests']) for q in before] == [(q['hours'],q['series'],q['digests']) for q in after]
    report['query_results_identical']=True
    (work/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print('PASS: all sampled production query results identical before/after hourly rollup')


if __name__=='__main__':
    main()
