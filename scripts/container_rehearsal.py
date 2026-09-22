#!/usr/bin/env python3
"""Compare a least-privilege Docker Agent with the same binary running natively."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time
from types import SimpleNamespace

from bench import Bench

ROOT = Path(__file__).resolve().parents[1]


def check(gnu, musl, output):
    arch = platform.machine()
    version = (ROOT / 'VERSION').read_text().strip()
    output.mkdir(parents=True, exist_ok=True)
    test = Bench(SimpleNamespace(bin_dir=gnu, nodes=2))
    native = None
    container = None
    agent = (musl / 'romi-agent').resolve()
    metadata = json.loads((musl / 'build.json').read_text())
    assert metadata['target'] == arch + '-unknown-linux-musl'
    assert metadata['binaries']['romi-agent'] == hashlib.sha256(agent.read_bytes()).hexdigest()
    image = 'romi-agent:' + version
    try:
        test.hub.start()
        with test.request('/api/auth/login', {'username': 'admin', 'password': test.hub.password()}):
            pass
        tokens = test.create_nodes()
        context = test.work / 'image'
        context.mkdir()
        shutil.copy2(agent, context / 'romi-agent')
        shutil.copy2(ROOT / 'deploy/agent/Dockerfile', context / 'Dockerfile')
        subprocess.run(['docker', 'build', '-t', image, '--build-arg', 'VERSION=' + version,
                        '--build-arg', 'SOURCE_COMMIT=' + metadata['source_commit'], str(context)], check=True)
        config = test.work / 'agent.env'
        config.write_text(f'ROMI_SERVER={test.hub.url}\nROMI_TOKEN={tokens[1]}\nROMI_HOST_ROOT=/host\n')
        config.chmod(0o600)
        container = subprocess.check_output([
            'docker', 'run', '-d', '--network=host', '--pid=host', '--uts=host',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
            '--pids-limit=32', '--memory=64m', '--user=65534:65534',
            '--mount=type=bind,src=/,dst=/host,readonly', '--env-file', str(config), image,
        ], text=True).strip()
        with (test.work / 'agent.log').open('w') as log:
            native = subprocess.Popen([str(agent)], env={
                'PATH': os.environ['PATH'], 'ROMI_SERVER': test.hub.url, 'ROMI_TOKEN': tokens[0],
            }, stdout=log, stderr=log)
            def wait_nodes():
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    with test.request('/api/nodes') as response:
                        nodes = json.load(response)['nodes']
                    if len(nodes) == 2 and all(n['online'] and n.get('metrics') for n in nodes):
                        return sorted(nodes, key=lambda n: n['id'])
                    assert native.poll() is None, 'native Agent exited'
                    time.sleep(0.5)
                raise RuntimeError('Docker/native Agent did not both report')
            nodes = wait_nodes()
            for field in ('hostname', 'os', 'arch', 'cpu_cores', 'mem_total', 'disk_total'):
                assert nodes[0][field] == nodes[1][field], f'host field {field} differs: {nodes[0][field]!r} / {nodes[1][field]!r}'
            assert nodes[1]['mem_total'] > 0 and nodes[1]['disk_total'] > 0
            subprocess.run(['docker', 'restart', container], check=True, stdout=subprocess.DEVNULL)
            time.sleep(2)
            wait_nodes()
            stats = subprocess.check_output(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', container], text=True).strip()
            archive = output / f'romi-agent-v{version}-docker-{arch}.tar.gz'
            raw = test.work / 'agent-image.tar'
            subprocess.run(['docker', 'image', 'save', '-o', str(raw), image], check=True)
            with raw.open('rb') as source, archive.open('wb') as dest:
                with gzip.GzipFile(fileobj=dest, mode='wb', filename='', mtime=0) as zipped:
                    shutil.copyfileobj(source, zipped)
            receipt = dict(format=1, source_commit=metadata['source_commit'], version=version,
                           architecture=arch, binary_sha256=metadata['binaries']['romi-agent'],
                           image= image, archive=archive.name,
                           sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
                           memory_usage=stats, host_fields_match=True, restart='success')
            (output / f'container-{arch}.json').write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps(receipt, indent=2))
    finally:
        if container:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, check=False)
        if native:
            native.terminate()
            native.wait(timeout=10)
        test.hub.stop()
        test.hub.log.close()
        shutil.rmtree(test.work)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gnu', type=Path, required=True)
    parser.add_argument('--musl', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    check(args.gnu.resolve(), args.musl.resolve(), args.output.resolve())
