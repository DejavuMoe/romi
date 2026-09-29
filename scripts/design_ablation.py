#!/usr/bin/env python3
"""Repeat single-factor Hub ablations on ext4 with the same workload and binary.

Only a --features bench Hub recognizes experiment switches. Nothing disables
authentication, TLS validation, bounds or durable commit semantics. Old/new
baseline runs use this same transport and CPU sampling implementation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
VARIANTS = {
    'full': ({}, []),
    'no-group-commit': ({'ROMI_BENCH_BATCH_OPS': '1'}, []),
    'threads-2': ({}, ['--db-threads', '2']),
    'memory-128': ({}, ['--memory', '128MB']),
    'no-history-readers': ({}, ['--readers', '0']),
    'viewers-20': ({}, ['--viewers', '20']),
    'viewers-no-cache': ({'ROMI_BENCH_NO_SNAPSHOT_CACHE': '1'}, ['--viewers', '20']),
    'viewers-1s': ({'ROMI_BENCH_PUSH_MS': '1000'}, ['--viewers', '20']),
    'staggered': ({}, ['--stagger']),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, required=True)
    parser.add_argument('--baseline-dir', type=Path)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'target/design-ablation/components')
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--variants', default=','.join(VARIANTS))
    parser.add_argument('--nodes', default='100,500')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    scratch = output / 'scratch'
    scratch.mkdir(exist_ok=True)
    candidate = (args.bin_dir / 'romi-hub').resolve()
    binary = candidate.read_bytes()
    assert b'ROMI_BENCH_BATCH_OPS' in binary, 'requires a benchmark-feature Hub'
    report = dict(source_commit=args.source, binary_sha256=hashlib.sha256(binary).hexdigest(),
                  kernel=platform.release(), architecture=platform.machine(),
                  cpu=next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unknown'),
                  scratch_filesystem=subprocess.check_output(['stat', '-f', '-c', '%T', str(scratch)], text=True).strip(),
                  seconds=args.seconds, repeats=args.repeat, runs=[])
    assert report['scratch_filesystem'] != 'tmpfs', 'durable writes must use the ext4 workspace'
    names = args.variants.split(',')
    assert all(name in VARIANTS for name in names)
    scenarios = [(name, args.bin_dir, *VARIANTS[name]) for name in names]
    if args.baseline_dir:
        report['baseline_sha256'] = hashlib.sha256((args.baseline_dir / 'romi-hub').read_bytes()).hexdigest()
    if args.baseline_dir:
        scenarios.insert(0, ('old-baseline', args.baseline_dir, {}, []))
    for repeat in range(1, args.repeat + 1):
        for nodes in map(int, args.nodes.split(',')):
            for name, binaries, overrides, options in scenarios if repeat % 2 else reversed(scenarios):
                stem = f'{name}-{nodes}-{repeat}'
                result_path = output / (stem + '.json')
                result_path.unlink(missing_ok=True)
                env = dict(os.environ, TMPDIR=str(scratch), **overrides)
                command = [sys.executable, str(ROOT / 'scripts/bench.py'), '--bin-dir', str(binaries.resolve()),
                           '--label', name, '--nodes', str(nodes), '--interval', '1', '--seconds', str(args.seconds),
                           '--samples', '10', '--readers', '2', '--out', str(result_path), *options]
                started = time.monotonic()
                with (output / (stem + '.log')).open('w') as log:
                    run = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    try:
                        run.wait(timeout=300)
                    except subprocess.TimeoutExpired:
                        os.killpg(run.pid, signal.SIGTERM)
                        try:
                            run.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(run.pid, signal.SIGKILL)
                            run.wait()
                try:
                    result = json.loads(result_path.read_text())
                except (OSError, ValueError):
                    result = {}
                queue = result.get('writer_queue', {})
                correct = (run.returncode == 0 and result.get('accumulated', {}).get('exact', False)
                           and queue.get('failed_ops_total') == 0 and queue.get('refused_ops_total') == 0
                           and result.get('history_query_ms', {}).get('errors') == 0)
                if name == 'no-group-commit' and run.returncode == 0:
                    assert result['writer_queue']['batch_capacity'] == 1, 'ablation switch did not take effect'
                report['runs'].append(dict(variant=name, nodes=nodes, repeat=repeat, exit_code=run.returncode,
                                           correct=correct, elapsed_seconds=round(time.monotonic()-started, 2), result=result))
                (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps(dict(run=stem, correct=correct, cpu=result.get('process'),
                                      latency=result.get('latency_ms'), live=result.get('live_view'))), flush=True)


if __name__ == '__main__':
    main()
