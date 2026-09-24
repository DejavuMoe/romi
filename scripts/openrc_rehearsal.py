#!/usr/bin/env python3
"""Real OpenRC service lifecycle in a disposable Alpine build container only.

TLS is covered separately by the systemd/Nginx rehearsal. This check uses only
loopback with the same trusted-proxy headers, real installed Hub/Agent processes,
bootstrap rotation, same-version reinstall, restart and persistence.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, timeout=90, **kwargs)


def wait(predicate):
    deadline = time.monotonic() + 40
    last = None
    while time.monotonic() < deadline:
        try:
            if result := predicate():
                return result
        except (OSError, ValueError) as error:
            last = error
        time.sleep(0.25)
    raise RuntimeError(f"OpenRC acceptance timed out: {last}")


def check(binaries, target):
    if os.geteuid() != 0 or not Path('/.dockerenv').is_file() or not Path('/etc/alpine-release').is_file():
        raise SystemExit('requires a disposable root Alpine container')
    for path in ('/opt/romi', '/var/lib/romi', '/etc/romi', '/etc/init.d/romi-hub', '/etc/init.d/romi-agent'):
        if Path(path).exists():
            raise SystemExit(f'refusing existing installation: {path}')
    # The container already has networking. OpenRC supervises the services; it
    # must not try to configure the Docker-managed interface or host kernel.
    Path('/run/openrc').mkdir(exist_ok=True)
    Path('/run/openrc/softlevel').write_text('default\n')
    with Path('/etc/rc.conf').open('a') as config:
        config.write('\nrc_sys="docker"\nrc_provide="net"\n')
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    cookie = ''

    def request(path, data=None):
        headers = {'Host': 'romi.platform.test', 'X-Forwarded-Proto': 'https'}
        if cookie:
            headers['Cookie'] = cookie
        if data is not None:
            headers['Content-Type'] = 'application/json'
        return client.open(urllib.request.Request(
            'http://127.0.0.1:28080' + path, headers=headers,
            data=None if data is None else json.dumps(data).encode(),
            method='PUT' if path == '/api/settings' else None), timeout=5)

    def nodes():
        with request('/api/nodes') as response:
            return json.load(response)['nodes']

    success = False
    try:
        with tempfile.TemporaryDirectory(prefix='romi-openrc-package-') as directory:
            release = Path(directory)
            (release / 'bin').mkdir()
            shutil.copytree(ROOT / 'deploy/hub', release / 'deploy/hub')
            for name in ('romi-hub', 'romi-agent'):
                shutil.copy2(binaries / name, release / 'bin' / name)
            version = (ROOT / 'VERSION').read_text().strip()
            (release / 'VERSION').write_text(version + '\n')
            (release / 'release.json').write_text(json.dumps(dict(
                format=1, project='romi', kind='public-release', component='hub', version=version, target=target)))
            install = ['sh', str(release / 'deploy/hub/install.sh'), '--site', 'https://romi.platform.test', '--init', 'openrc']
            run(*install)
            wait(lambda: request('/healthz').status == 200)
            bootstrap = Path('/var/lib/romi/bootstrap-password')
            assert bootstrap.stat().st_mode & 0o777 == 0o600
            generated = bootstrap.read_text().strip()
            with request('/api/auth/login', {'username': 'admin', 'password': generated}) as response:
                cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            password = secrets.token_urlsafe(24)
            # Replacing a credential is proven with the one being replaced.
            with request('/api/settings', {'admin_password': password, 'current_password': generated}):
                pass
            assert not bootstrap.exists()
            with request('/api/auth/login', {'username': 'admin', 'password': password}) as response:
                cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            with request('/api/nodes', {'name': 'openrc-native'} ) as response:
                token = json.load(response)['token']
            agent_install = ['sh', str(ROOT / 'deploy/agent/install.sh'), '--server', 'http://127.0.0.1:28080', '--token-stdin', '--init', 'openrc']
            run(*agent_install, input=token + '\n', text=True)
            wait(lambda: any(n['online'] and n.get('metrics') for n in nodes()))
            assert Path('/etc/romi/agent.env').stat().st_mode & 0o777 == 0o600
            run(*install)
            run(*agent_install, input=token + '\n', text=True)
            wait(lambda: any(n['online'] and n.get('metrics') for n in nodes()))
            run('rc-service', 'romi-hub', 'restart')
            wait(lambda: any(n['online'] and n.get('metrics') for n in nodes()))
            assert len(nodes()) == 1
            assert not bootstrap.exists()
            success = True
    finally:
        for name in ('romi-agent', 'romi-hub'):
            try:
                result = subprocess.run(['rc-service', name, 'stop'], check=False, timeout=25,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if success and result.returncode:
                    raise RuntimeError(f'{name} failed to stop')
            except subprocess.TimeoutExpired:
                if success:
                    raise
                print(f'WARN: bounded cleanup timed out for {name}')
    print('PASS: real OpenRC Hub/Agent, bootstrap rotation, reinstall, restart persistence and stop')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    check(args.bin_dir.resolve(), args.target)
