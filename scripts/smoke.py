#!/usr/bin/env python3
"""Local process smoke test; temporary credentials/data, no system installation."""
import argparse
import hashlib
import http.cookiejar
import json
import os
import platform
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', action='store_true')
    parser.add_argument('--bin-dir', type=Path, help='verify extracted package binaries')
    args = parser.parse_args()
    binaries = args.bin_dir.resolve() if args.bin_dir else ROOT / 'target' / ('release' if args.release else 'debug')
    processes = []
    version = (ROOT / 'VERSION').read_text().strip()
    architecture = platform.machine()
    target = os.environ.get('ROMI_RELEASE_TARGET', architecture + '-unknown-linux-gnu')
    for name in ['romi-hub', 'romi-agent']:
        got = subprocess.run(
            [str(binaries / name), '--version'], capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
        assert got == f'{name} {version}', f'{name}: expected version {version}, got {got!r}'
    if args.bin_dir:
        assert not (binaries / 'romi-bench').exists(), 'benchmark-only binary must not be packaged'
    with tempfile.TemporaryDirectory(prefix='romi-smoke-') as directory:
        work = Path(directory)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        client = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        # Distribution/health checks need no cookies and must not consult a
        # developer proxy environment either.
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, data=None, headers=None, method=None):
            req = urllib.request.Request(base + path, headers=headers or {},
                                         data=None if data is None else json.dumps(data).encode(), method=method)
            if data is not None:
                req.add_header('Content-Type', 'application/json')
            return client.open(req, timeout=3)

        def nodes():
            with request('/api/nodes') as response:
                return json.load(response)["nodes"]

        def wait_for(check, message):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                assert processes[0].poll() is None, 'server exited; smoke failed'
                try:
                    result = check()
                    if result:
                        return result
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.2)
            raise AssertionError(message)

        with (work / 'server.log').open('w+') as log, (work / 'agent.log').open('w+') as agent_log:
            try:
                processes.append(subprocess.Popen([
                    str(binaries / 'romi-hub'), '--listen', f'127.0.0.1:{port}',
                    '--db', str(work / 'romi.db'),
                ], cwd=work, stdout=log, stderr=log))
                wait_for(lambda: re.search(r'Emergency password: (\S+)', (work / 'server.log').read_text()),
                         'server did not initialize')
                password = re.search(r'Emergency password: (\S+)', (work / 'server.log').read_text())[1]
                wait_for(lambda: request('/api/me').status == 200, 'server did not listen')
                for route, local in [('/', 'web/dist/index.html'), ('/admin/', 'admin/dist/index.html')]:
                    with request(route) as response:
                        html = response.read()
                    assert html == (ROOT / local).read_bytes(), f'{route}: wrong frontend'
                    assets = re.findall(rb'(?:src|href)="([^\"]+\.(?:js|css))"', html)
                    assert assets, f'{route}: no built assets'
                    for asset in assets:
                        path = asset.decode()
                        with request(path) as response:
                            assert response.status == 200
                            assert 'text/html' not in response.headers.get('Content-Type', '')
                for route in ['/install.sh', '/agent/x86_64', '/agent/aarch64',
                              f'/agent/v{version}/{target}', '/api/agent/distribution']:
                    try:
                        request(route)
                        raise AssertionError(f'{route}: distribution must be disabled')
                    except urllib.error.HTTPError as error:
                        assert error.code == 503
                with request('/healthz') as response:
                    assert response.status == 200
                    assert json.load(response) == {'status': 'ok'}
                with request('/api/me') as response:
                    me = json.load(response)
                assert me['public_page'] is False
                try:
                    request('/api/nodes')
                    raise AssertionError('anonymous node access should be closed')
                except urllib.error.HTTPError as error:
                    assert error.code == 401
                with request('/api/auth/login', {'username': 'admin', 'password': password}) as response:
                    assert json.load(response)['ok']
                with request('/api/db') as response:
                    storage = json.load(response)
                assert storage['engine'] == 'v1.5.5', storage['engine']
                assert isinstance(storage.get('queue'), dict), 'writer queue diagnostics must be exposed'
                # Simulate the trusted HTTPS proxy only on this temporary loopback server.
                with request('/api/nodes', {'name': 'romi-smoke', 'traffic_reset_day': 1},
                             {'Host': 'romi.test', 'X-Forwarded-Proto': 'https'}) as response:
                    issued = json.load(response)
                    node_id, token = issued['id'], issued['token']
                    assert response.headers['Cache-Control'] == 'no-store'
                node = next(node for node in nodes() if node['id'] == node_id)
                assert node['public'] is True
                assert 'token' not in node and 'token_hash' not in node
                # The storage-level assertion that the node's credential is stored
                # as a digest lives in the server's own tests
                # (`db::tests::tokens_are_hashed_and_rotation_retires_the_old_one`).
                # It cannot be made from here: DuckDB permits one read-write
                # process per file, so a second process -- this script -- may not
                # open the hub's live database at all, and asking the hub to expose
                # it over HTTP would be a debugging endpoint this project does not
                # have. What is checked here is the on-disk identity and the lock.
                path = work / 'romi.db'
                with path.open('rb') as database:
                    assert database.read(12)[8:12] == b'DUCK', 'the hub must write a DuckDB database'
                assert (work / 'romi.db.lock').exists(), 'the lock file is what refuses a second hub'

                # One hub per database file, enforced across processes: DuckDB
                # itself refuses a second read-write process, and the hub refuses
                # it with an explanation rather than a raw engine error.
                second = subprocess.run(
                    [str(binaries / 'romi-hub'), '--listen', '127.0.0.1:0', '--db', str(path)],
                    cwd=work, capture_output=True, text=True, timeout=30,
                )
                assert second.returncode != 0, 'a second hub on one database must not start'
                assert '已被另一个' in second.stderr, second.stderr
                env = dict(os.environ, ROMI_SERVER=base, ROMI_TOKEN=token)
                agent = subprocess.Popen([str(binaries / 'romi-agent')], cwd=work, env=env,
                                         stdout=agent_log, stderr=agent_log)
                processes.append(agent)
                wait_for(lambda: any(n['online'] and n.get('metrics') and n['metrics'].get('mem_total', 0) > 0
                                     for n in nodes()), 'agent did not report live metrics')
                assert agent.poll() is None, 'agent exited'
                assert any(n.get('agent_version') == version for n in nodes()), \
                    f'agent must report romi version {version}'
                # Rotation hands back a long-lived node credential, so it is
                # behind the same https-domain entry check as creating one.
                rotate = f'/api/nodes/{node_id}/token'
                try:
                    request(rotate, {}).close()
                    raise AssertionError('rotation must refuse a plain-http entry point')
                except urllib.error.HTTPError as refused:
                    assert refused.code == 403, refused.code
                with request(rotate, {}, {'Host': 'romi.test', 'X-Forwarded-Proto': 'https'}) as response:
                    fresh = json.load(response)['token']
                    assert fresh != token
                wait_for(lambda: all(not n['online'] for n in nodes()), 'rotation did not disconnect old agent')
                agent.terminate()
                agent.wait(timeout=5)
                env['ROMI_TOKEN'] = fresh
                replacement = subprocess.Popen([str(binaries / 'romi-agent')], cwd=work, env=env, stdout=agent_log, stderr=agent_log)
                processes.append(replacement)
                wait_for(lambda: any(n['online'] and n.get('metrics') for n in nodes()), 'fresh token did not connect')
                replacement.terminate()
                replacement.wait(timeout=5)
                wait_for(lambda: all(not n['online'] for n in nodes()), 'agent disconnect not reflected')
                for route, method in [('/api/themes/default/update', 'POST'), ('/api/themes/default', 'DELETE'), ('/api/themes?offset=0&total=1', 'POST')]:
                    try:
                        request(route, {}, method=method)
                        raise AssertionError('custom themes should be refused')
                    except urllib.error.HTTPError as error:
                        assert error.code == 404

                # With a validated distribution configured, the Hub serves the
                # installer, metadata, and exact versioned binary bytes from
                # memory. It never fetches GitHub on request.
                agent_bytes = (binaries / 'romi-agent').read_bytes()
                dist_dir = work / 'distribution' / version
                dist_dir.mkdir(parents=True)
                (dist_dir / 'romi-agent').write_bytes(agent_bytes)
                dist_sha = hashlib.sha256(agent_bytes).hexdigest()
                (dist_dir / 'distribution.json').write_text(json.dumps({
                    'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
                    'version': version, 'target': target,
                    'architecture': architecture, 'filename': 'romi-agent',
                    'sha256': dist_sha, 'size': len(agent_bytes),
                }))
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    dist_port = sock.getsockname()[1]
                dist_base = f'http://127.0.0.1:{dist_port}'
                dist_log = (work / 'distribution.log').open('w+')
                processes.append(subprocess.Popen([
                    str(binaries / 'romi-hub'), '--listen', f'127.0.0.1:{dist_port}',
                    '--db', str(work / 'distribution.db'), '--distribution-dir', str(dist_dir),
                ], cwd=work, stdout=dist_log, stderr=dist_log))
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    assert processes[-1].poll() is None, 'distribution hub exited: ' + (work / 'distribution.log').read_text()
                    try:
                        if direct.open(dist_base + '/healthz', timeout=1).status == 200:
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    time.sleep(0.2)
                else:
                    raise AssertionError('distribution hub did not become healthy')
                with direct.open(dist_base + '/install.sh', timeout=3) as response:
                    script = response.read()
                assert b'romi-agent' in script and b'api.github.com' not in script
                assert b'/releases/download/' not in script
                with direct.open(dist_base + '/api/agent/distribution', timeout=3) as response:
                    metadata = json.load(response)
                assert metadata['version'] == version and metadata['architecture'] == architecture
                assert metadata['sha256'] == dist_sha and metadata['size'] == len(agent_bytes)
                assert metadata['download'] == f'/agent/v{version}/{target}'
                with direct.open(dist_base + metadata['download'], timeout=3) as response:
                    served = response.read()
                    assert served == agent_bytes
                    assert response.headers['Content-Length'] == str(len(agent_bytes))
                    assert response.headers['X-Romi-Agent-Sha256'] == dist_sha
                    assert 'immutable' in response.headers['Cache-Control']
                for route in [f'/agent/v{version}/aarch64', '/agent/v9.9.9/x86_64', '/agent/x86_64']:
                    try:
                        direct.open(dist_base + route, timeout=3)
                        raise AssertionError(f'{route}: unknown or mutable Agent route must fail')
                    except urllib.error.HTTPError as error:
                        assert error.code == 404, (route, error.code)
                dist_log.close()
                processes[-1].terminate()
                processes[-1].wait(timeout=5)
                print('PASS: local frontends/assets, disabled upstream downloads, login, node creation, '
                      'private defaults, DuckDB storage, single-writer lock, rotation, agent metrics, '
                      'removed theme endpoints, health, and validated versioned Agent distribution; release binary versions verified')
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()


if __name__ == '__main__':
    main()
