#!/usr/bin/env python3
"""Deterministic root-prefix installer tests.

No root privilege, real system service, or external network is used. A local
HTTP server stands in for a Hub; every fixture release is temporary and every
production mutation is redirected under a temporary root prefix.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
HUB_INSTALL = ROOT / 'deploy/hub/install.sh'
HUB_UNIT = ROOT / 'deploy/hub/romi-hub.service.in'
AGENT_INSTALL = ROOT / 'deploy/agent/install.sh'
AGENT_UNIT = ROOT / 'deploy/agent/romi-agent.service.in'
GNU_TARGET = 'x86_64-unknown-linux-gnu'
VERSION = (ROOT / 'VERSION').read_text().strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FixtureRelease:
    def __init__(self, base: Path, component: str, version: str = VERSION):
        self.root = base / f'{component}-{version}'
        self.version = version
        self.component = component
        (self.root / 'bin').mkdir(parents=True)
        (self.root / 'deploy' / component).mkdir(parents=True)
        for name, line in (
            ('romi-hub', f'romi-hub {version}'),
            ('romi-agent', f'romi-agent {version}'),
        ):
            binary = self.root / 'bin' / name
            binary.write_text(f'#!/bin/sh\n[ "${{1:-}}" = "--version" ] && echo \'{line}\'\n')
            binary.chmod(0o755)
        (self.root / 'VERSION').write_text(version + '\n')
        (self.root / 'release.json').write_text(json.dumps({
            'format': 1, 'project': 'romi', 'kind': 'public-release',
            'component': component, 'version': version, 'target': GNU_TARGET,
        }))
        source = ROOT / 'deploy' / component
        for file in ('install.sh', f'romi-{component}.service.in'):
            shutil.copy2(source / file, self.root / 'deploy' / component / file)

    @property
    def install(self) -> Path:
        return self.root / 'deploy' / self.component / 'install.sh'


class LocalHub:
    """A loopback HTTP fixture that serves one distribution and one register route."""

    def __init__(self, version: str, binary: bytes, metadata: dict | None = None,
                 register_token: str | None = None, serve_metadata: bool = True):
        self.version = version
        self.binary = binary
        self.serve_metadata = serve_metadata
        self.metadata = metadata or {
            'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
            'version': version, 'target': GNU_TARGET, 'architecture': 'x86_64',
            'filename': 'romi-agent', 'sha256': sha256(binary), 'size': len(binary),
            'download': f'/agent/v{version}/x86_64',
        }
        self.register_token = register_token
        self.server = None
        self.thread = None
        self.port = None

    def __enter__(self):
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _bytes(self, code, body: bytes, content_type: str = 'application/octet-stream'):
                self.send_response(code)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == '/api/agent/distribution':
                    if not fixture.serve_metadata:
                        self._bytes(404, b'not found', 'text/plain')
                    else:
                        body = json.dumps(fixture.metadata, sort_keys=True).encode()
                        self._bytes(200, body, 'application/json')
                elif self.path == f'/agent/v{fixture.version}/x86_64':
                    self._bytes(200, fixture.binary)
                elif self.path.startswith('/api/agent/register'):
                    self._bytes(405, b'method not allowed', 'text/plain')
                else:
                    self._bytes(404, b'not found', 'text/plain')

            def do_POST(self):
                if self.path == '/api/agent/register' and fixture.register_token is not None:
                    length = int(self.headers.get('Content-Length', '0'))
                    self.rfile.read(length)
                    self._bytes(200, fixture.register_token.encode(), 'text/plain')
                else:
                    self._bytes(403, b'registration closed', 'text/plain')

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    @property
    def url(self) -> str:
        return f'http://127.0.0.1:{self.port}'

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def run_checked(*args, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def run(*args, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='romi-installer-test-')
        self.base = Path(self.temporary.name)
        self.prefix = self.base / 'host'

    def tearDown(self):
        self.temporary.cleanup()

    def test_shell_syntax_and_units_present(self):
        for script in (HUB_INSTALL, AGENT_INSTALL):
            subprocess.run(['sh', '-n', str(script)], check=True)
            text = script.read_text()
            self.assertNotIn('curl -k', text, script)
            self.assertNotIn('--insecure', text, script)
            self.assertNotIn('api.github.com', text, script)
            self.assertNotIn('/releases/latest', text, script)
        for unit in (HUB_UNIT, AGENT_UNIT):
            text = unit.read_text()
            self.assertIn('[Service]', text)
            self.assertIn('CapabilityBoundingSet=', text)
        # The Hub-served Agent installer cannot read a sibling unit file, so it
        # embeds the same directives. Keep the fallback and the reviewable
        # template from drifting apart.
        source = AGENT_INSTALL.read_text()
        marker = "cat > \"$_unit_src\" <<'UNIT'\n"
        start = source.index(marker) + len(marker)
        end = source.index('\nUNIT\n', start)
        fallback = [line for line in source[start:end].splitlines() if not line.startswith('#')]
        template = [line for line in AGENT_UNIT.read_text().splitlines() if not line.startswith('#')]
        self.assertEqual(fallback, template)
        shellcheck = shutil.which('shellcheck')
        if shellcheck:
            for script in (HUB_INSTALL, AGENT_INSTALL):
                result = subprocess.run([shellcheck, '-x', str(script)], text=True, capture_output=True)
                if result.returncode != 0:
                    self.fail(f'shellcheck rejected {script}:\n{result.stdout}\n{result.stderr}')

    def test_hub_root_prefix_install_upgrade_and_state_preservation(self):
        release = FixtureRelease(self.base, 'hub')
        state_marker = self.prefix / 'var/lib/romi/keep-me'
        state_marker.parent.mkdir(parents=True)
        state_marker.write_text('existing state')

        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        current = self.prefix / 'opt/romi/current'
        self.assertTrue(current.is_symlink())
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        release_dir = self.prefix / 'opt/romi/releases/0.1.0'
        self.assertTrue((release_dir / 'romi-hub').is_file())
        self.assertTrue((release_dir / 'romi-agent').is_file())
        self.assertEqual(oct(release_dir.stat().st_mode & 0o777), '0o755')
        self.assertEqual(oct((release_dir / 'romi-hub').stat().st_mode & 0o777), '0o755')
        self.assertEqual(state_marker.read_text(), 'existing state')
        self.assertFalse((self.prefix / 'var/lib/romi/romi.duckdb').exists())

        distribution = self.prefix / 'var/lib/romi/distribution/0.1.0'
        metadata = json.loads((distribution / 'distribution.json').read_text())
        agent = (distribution / 'romi-agent').read_bytes()
        self.assertEqual(metadata['version'], '0.1.0')
        self.assertEqual(metadata['architecture'], 'x86_64')
        self.assertEqual(metadata['sha256'], sha256(agent))
        self.assertEqual(metadata['size'], len(agent))
        self.assertEqual(oct((distribution / 'romi-agent').stat().st_mode & 0o777), '0o640')
        self.assertEqual(oct((distribution / 'distribution.json').stat().st_mode & 0o777), '0o640')
        unit = (self.prefix / 'etc/systemd/system/romi-hub.service').read_text()
        self.assertIn(str(current / 'romi-hub'), unit)
        self.assertIn('--bootstrap-password-file', unit)
        self.assertIn('--distribution-dir', unit)
        self.assertIn('--site ${ROMI_SITE}', unit)
        self.assertNotIn('ROMI_TOKEN', unit)
        hub_env = (self.prefix / 'etc/romi/hub.env').read_text()
        self.assertIn('ROMI_SITE=https://hub.example.com', hub_env)

        # Upgrade: old binary remains, state and database are not in the release dir.
        upgraded = FixtureRelease(self.base, 'hub', version='0.2.0')
        run_checked('sh', str(upgraded.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')
        self.assertTrue((self.prefix / 'opt/romi/releases/0.1.0/romi-hub').is_file())
        self.assertEqual(state_marker.read_text(), 'existing state')

        # Re-running the same version is idempotent.
        run_checked('sh', str(upgraded.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')

    def test_hub_rejects_bad_arguments_and_non_root_production(self):
        release = FixtureRelease(self.base, 'hub')
        for site in ['http://hub.example.com', 'https://user@hub.example.com',
                     'https://hub.example.com/path', 'https://hub.example.com?x=1',
                     'https://127.0.0.1', 'https://localhost']:
            result = run('sh', str(release.install), '--root-prefix', str(self.prefix), '--site', site, '--no-start')
            self.assertNotEqual(result.returncode, 0, site)
        result = run('sh', str(release.install), '--root-prefix', str(self.base / 'space dir'),
                     '--site', 'https://hub.example.com', '--no-start')
        self.assertNotEqual(result.returncode, 0)
        if os.geteuid() != 0:
            result = run('sh', str(release.install), '--site', 'https://hub.example.com', '--no-start')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('root', result.stderr.lower())

    def test_agent_installer_installs_serves_and_upgrades(self):
        binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.1.0'
        with LocalHub('0.1.0', binary) as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub.url + '/', '--token-stdin', '--interval', '7',
                        input='permanent-token\n')
        env = (self.prefix / 'etc/romi/agent.env').read_text()
        self.assertIn('ROMI_SERVER=http://127.0.0.1:%d' % hub.port, env)
        self.assertIn('ROMI_TOKEN=permanent-token', env)
        self.assertIn('ROMI_INTERVAL=7', env)
        self.assertEqual(oct((self.prefix / 'etc/romi/agent.env').stat().st_mode & 0o777), '0o600')
        unit = (self.prefix / 'etc/systemd/system/romi-agent.service').read_text()
        self.assertNotIn('permanent-token', unit)
        self.assertNotIn('--token', unit)
        current = self.prefix / 'opt/romi/current'
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        metadata = json.loads((self.prefix / 'opt/romi/releases/0.1.0/release.json').read_text())
        self.assertEqual(metadata['version'], '0.1.0')
        self.assertEqual(metadata['sha256'], sha256((self.prefix / 'opt/romi/releases/0.1.0/romi-agent').read_bytes()))

        # A newer release replaces the current symlink but leaves the old one.
        binary2 = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.2.0'
        with LocalHub('0.2.0', binary2) as hub2:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub2.url, '--token-stdin', input='second-token\n')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')
        self.assertTrue((self.prefix / 'opt/romi/releases/0.1.0/romi-agent').is_file())
        self.assertIn('ROMI_TOKEN=second-token', (self.prefix / 'etc/romi/agent.env').read_text())

    def test_agent_registration_window_and_rejections(self):
        binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.1.0'
        registration_prefix = self.base / 'registration-host'
        with LocalHub('0.1.0', binary, register_token='exchanged-token') as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(registration_prefix),
                        '--server', hub.url, '--register-key', 'short-lived-key')
        env = (registration_prefix / 'etc/romi/agent.env').read_text()
        self.assertIn('ROMI_TOKEN=exchanged-token', env)
        self.assertNotIn('short-lived-key', env)

        rejection_prefix = self.base / 'rejection-host'
        cases = [
            ('http://remote.example.com', None),
            ('https://user@hub.example.com', None),
            ('https://hub.example.com/path', None),
            ('https://hub.example.com?x=1', None),
        ]
        for server, _ in cases:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', server, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0, server)

        # Wrong checksum: no version directory and no current symlink are left.
        metadata = {
            'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
            'version': '0.1.0', 'target': GNU_TARGET, 'architecture': 'x86_64',
            'filename': 'romi-agent', 'sha256': '0' * 64, 'size': len(binary),
            'download': '/agent/v0.1.0/x86_64',
        }
        with LocalHub('0.1.0', binary, metadata=metadata) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((rejection_prefix / 'opt/romi/releases/0.1.0').exists())
        self.assertFalse((rejection_prefix / 'opt/romi/current').exists())

        # Truncated binary: metadata promises more bytes than the server sends.
        metadata = {
            'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
            'version': '0.1.0', 'target': GNU_TARGET, 'architecture': 'x86_64',
            'filename': 'romi-agent', 'sha256': sha256(binary), 'size': len(binary) + 10,
            'download': '/agent/v0.1.0/x86_64',
        }
        with LocalHub('0.1.0', binary, metadata=metadata) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)

        # Wrong reported version: the Hub and binary disagree.
        wrong = b'#!/bin/sh\necho "romi-agent 9.9.9"\n'
        with LocalHub('0.1.0', wrong) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)

        # Unsupported architecture.
        metadata = {
            'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
            'version': '0.1.0', 'target': GNU_TARGET, 'architecture': 'aarch64',
            'filename': 'romi-agent', 'sha256': sha256(binary), 'size': len(binary),
            'download': '/agent/v0.1.0/aarch64',
        }
        with LocalHub('0.1.0', binary, metadata=metadata) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)

        # Missing metadata must fail before anything is written.
        with LocalHub('0.1.0', binary, serve_metadata=False) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)

        # Shell metacharacters in a token are refused rather than evaluated.
        with LocalHub('0.1.0', binary) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='$(touch /tmp/romi-pwned)\n')
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(Path('/tmp/romi-pwned').exists())

    def test_unsupported_init_system_is_refused_when_required(self):
        empty_path = self.base / 'empty-path'
        empty_path.mkdir()
        environment = dict(os.environ, PATH=str(empty_path))
        agent = subprocess.run(
            ['/bin/sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix / 'agent'),
             '--server', 'https://hub.example.com', '--require-systemd', '--token-stdin'],
            input='token\n', text=True, capture_output=True, env=environment,
        )
        self.assertNotEqual(agent.returncode, 0)
        self.assertIn('systemd', agent.stderr.lower())
        hub = subprocess.run(
            ['/bin/sh', str(HUB_INSTALL), '--require-systemd', '--root-prefix', str(self.prefix / 'hub'),
             '--site', 'https://hub.example.com', '--no-start'],
            text=True, capture_output=True, env=environment,
        )
        self.assertNotEqual(hub.returncode, 0)
        self.assertIn('systemd', hub.stderr.lower())

    def test_token_never_appears_in_service_command_line(self):
        binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent 0.1.0"\n'
        with LocalHub('0.1.0', binary) as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub.url, '--token-stdin', input='secret-token-value\n')
        unit = (self.prefix / 'etc/systemd/system/romi-agent.service').read_text()
        self.assertIn('EnvironmentFile=', unit)
        self.assertNotIn('secret-token-value', unit)
        exec_start = next(line for line in unit.splitlines() if line.startswith('ExecStart='))
        self.assertNotIn('TOKEN', exec_start)

    def test_generated_units_pass_systemd_analyze_verify_when_available(self):
        analyze = shutil.which('systemd-analyze')
        if analyze is None:
            self.skipTest('systemd-analyze is not available')
        hub = FixtureRelease(self.base, 'hub')
        run_checked('sh', str(hub.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent 0.1.0"\n'
        agent_prefix = self.base / 'agent-unit-host'
        with LocalHub('0.1.0', binary) as local:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(agent_prefix),
                        '--server', local.url, '--token-stdin', input='token\n')
        for unit in (self.prefix / 'etc/systemd/system/romi-hub.service',
                     agent_prefix / 'etc/systemd/system/romi-agent.service'):
            result = subprocess.run([analyze, 'verify', str(unit)], text=True, capture_output=True)
            # systemd-analyze exits 1 for warnings on some versions but only
            # actual syntax/load failures contain "Failed to".
            self.assertNotIn('Failed to', result.stdout + result.stderr, unit)


if __name__ == '__main__':
    unittest.main(verbosity=2)
