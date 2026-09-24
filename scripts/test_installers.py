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
        for file in ('install.sh', f'romi-{component}.service.in', f'romi-{component}.openrc.in'):
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
            'download': f'/agent/v{version}/x86_64-unknown-linux-gnu',
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
                if self.path.split('?')[0] == '/api/agent/distribution':
                    if not fixture.serve_metadata:
                        self._bytes(404, b'not found', 'text/plain')
                    else:
                        body = json.dumps(fixture.metadata, sort_keys=True).encode()
                        self._bytes(200, body, 'application/json')
                elif self.path == f'/agent/v{fixture.version}/x86_64-unknown-linux-gnu':
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

    def test_openrc_installs_unprivileged_services_and_keeps_tokens_out_of_argv(self):
        release = FixtureRelease(self.base, 'hub')
        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--init', 'openrc')
        hub_unit = self.prefix / 'etc/init.d/romi-hub'
        self.assertEqual(hub_unit.stat().st_mode & 0o777, 0o755)
        self.assertIn('command_user="romi:romi"', hub_unit.read_text())
        self.assertNotIn('--themes', hub_unit.read_text())
        subprocess.run(['sh', '-n', str(hub_unit)], check=True)
        binary = f'#!/bin/sh\necho "romi-agent {VERSION}"\n'.encode()
        agent_root = self.base / 'agent-host'
        with LocalHub(VERSION, binary) as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(agent_root),
                        '--server', hub.url, '--token-stdin', '--init', 'openrc', input='test-token\n')
        unit = agent_root / 'etc/init.d/romi-agent'
        self.assertIn('command_user="romi-agent:romi-agent"', unit.read_text())
        self.assertIn('supervise-daemon', unit.read_text())
        self.assertNotIn('test-token', unit.read_text())
        self.assertEqual((agent_root / 'etc/romi/agent.env').stat().st_mode & 0o777, 0o600)
        subprocess.run(['sh', '-n', str(unit)], check=True)

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
        release = FixtureRelease(self.base, 'hub', '0.1.0')
        state_marker = self.prefix / 'var/lib/romi/keep-me'
        state_marker.parent.mkdir(parents=True)
        state_marker.write_text('existing state')

        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        current = self.prefix / 'opt/romi/hub/current'
        self.assertTrue(current.is_symlink())
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        release_dir = self.prefix / 'opt/romi/hub/releases/0.1.0'
        self.assertTrue((release_dir / 'romi-hub').is_file())
        self.assertTrue((release_dir / 'romi-agent').is_file())
        self.assertEqual(oct(release_dir.stat().st_mode & 0o777), '0o755')
        self.assertEqual(oct((release_dir / 'romi-hub').stat().st_mode & 0o777), '0o755')
        self.assertEqual(state_marker.read_text(), 'existing state')
        self.assertFalse((self.prefix / 'var/lib/romi/romi.duckdb').exists())
        spill = self.prefix / 'var/lib/romi/tmp'
        self.assertEqual(spill.stat().st_mode & 0o777, 0o700)

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
        self.assertNotIn('--themes', unit)
        self.assertIn('--site ${ROMI_SITE}', unit)
        self.assertNotIn('ROMI_TOKEN', unit)
        hub_env = (self.prefix / 'etc/romi/hub.env').read_text()
        self.assertIn('ROMI_SITE=https://hub.example.com', hub_env)

        # Upgrade: old binary remains, state and database are not in the release dir.
        upgraded = FixtureRelease(self.base, 'hub', version='0.2.0')
        run_checked('sh', str(upgraded.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')
        self.assertTrue((self.prefix / 'opt/romi/hub/releases/0.1.0/romi-hub').is_file())
        self.assertEqual(state_marker.read_text(), 'existing state')
        self.assertEqual(spill.stat().st_mode & 0o777, 0o700)

        # Re-running the same version is idempotent.
        run_checked('sh', str(upgraded.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')

        # A same-version reinstall repairs stale local distribution metadata
        # from an interrupted or externally damaged state without touching the
        # immutable release or mutable database directory.
        distribution = self.prefix / 'var/lib/romi/distribution/0.2.0'
        (distribution / 'distribution.json').write_text('{"format":1,"version":"stale"}\n')
        run_checked('sh', str(upgraded.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        repaired = json.loads((distribution / 'distribution.json').read_text())
        repaired_agent = (distribution / 'romi-agent').read_bytes()
        self.assertEqual(repaired['version'], '0.2.0')
        self.assertEqual(repaired['sha256'], sha256(repaired_agent))
        self.assertEqual(repaired['size'], len(repaired_agent))
        self.assertEqual(state_marker.read_text(), 'existing state')

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

    def test_hub_failed_upgrade_preserves_previous_release_and_state(self):
        release = FixtureRelease(self.base, 'hub', '0.1.0')
        state_marker = self.prefix / 'var/lib/romi/keep-me'
        state_marker.parent.mkdir(parents=True)
        state_marker.write_text('existing state')
        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        current = self.prefix / 'opt/romi/hub/current'
        self.assertEqual(os.readlink(current), 'releases/0.1.0')

        # A new release whose Hub identity check fails must not create a version
        # directory, move current, or touch mutable state.
        bad = FixtureRelease(self.base, 'hub', version='0.2.0')
        bad_hub = bad.root / 'bin/romi-hub'
        bad_hub.write_text('#!/bin/sh\nexit 1\n')
        bad_hub.chmod(0o755)
        result = run('sh', str(bad.install), '--root-prefix', str(self.prefix),
                     '--site', 'https://hub.example.com', '--no-start')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        self.assertFalse((self.prefix / 'opt/romi/hub/releases/0.2.0').exists())
        self.assertEqual(state_marker.read_text(), 'existing state')

        # A release-candidate archive is intentionally refused by the native
        # Hub installer; it must not be confused with a public release.
        candidate = FixtureRelease(self.base, 'hub', version='0.3.0')
        candidate_json = json.loads((candidate.root / 'release.json').read_text())
        candidate_json['kind'] = 'release-candidate'
        (candidate.root / 'release.json').write_text(json.dumps(candidate_json))
        result = run('sh', str(candidate.install), '--root-prefix', str(self.prefix),
                     '--site', 'https://hub.example.com', '--no-start')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('candidate', result.stderr.lower())
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        self.assertFalse((self.prefix / 'opt/romi/hub/releases/0.3.0').exists())

    def test_agent_installer_installs_serves_and_upgrades(self):
        binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.1.0'
        with LocalHub('0.1.0', binary) as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub.url + '/', '--token-stdin', '--interval', '7',
                        '--iface', 'eth1,-eth0', input='permanent-token\n')
        env = (self.prefix / 'etc/romi/agent.env').read_text()
        self.assertIn('ROMI_SERVER=http://127.0.0.1:%d' % hub.port, env)
        self.assertIn('ROMI_TOKEN=permanent-token', env)
        self.assertIn('ROMI_INTERVAL=7', env)
        self.assertIn('ROMI_IFACE=eth1,-eth0', env)
        self.assertEqual(oct((self.prefix / 'etc/romi/agent.env').stat().st_mode & 0o777), '0o600')
        unit = (self.prefix / 'etc/systemd/system/romi-agent.service').read_text()
        self.assertNotIn('permanent-token', unit)
        self.assertNotIn('--token', unit)
        current = self.prefix / 'opt/romi/agent/current'
        self.assertEqual(os.readlink(current), 'releases/0.1.0')
        metadata = json.loads((self.prefix / 'opt/romi/agent/releases/0.1.0/release.json').read_text())
        self.assertEqual(metadata['version'], '0.1.0')
        self.assertEqual(metadata['sha256'], sha256((self.prefix / 'opt/romi/agent/releases/0.1.0/romi-agent').read_bytes()))

        # A newer release replaces the current symlink but leaves the old one.
        binary2 = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.2.0'
        with LocalHub('0.2.0', binary2) as hub2:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub2.url, '--token-stdin', input='second-token\n')
        self.assertEqual(os.readlink(current), 'releases/0.2.0')
        self.assertTrue((self.prefix / 'opt/romi/agent/releases/0.1.0/romi-agent').is_file())
        upgraded_env = (self.prefix / 'etc/romi/agent.env').read_text()
        self.assertIn('ROMI_TOKEN=second-token', upgraded_env)
        self.assertIn('ROMI_IFACE=eth1,-eth0', upgraded_env)

        # Ordinary upgrades preserve a manually selected interface policy. An
        # explicit empty --iface is the operator's way to return to defaults.
        with LocalHub('0.2.0', binary2) as hub3:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub3.url, '--token-stdin', '--iface', '',
                        input='third-token\n')
        cleared_env = (self.prefix / 'etc/romi/agent.env').read_text()
        self.assertIn('ROMI_IFACE=\n', cleared_env)

    def test_hub_and_agent_coexist_on_one_host(self):
        # The Hub's own machine is monitored like any other, so both installers
        # run against the same root. They shared /opt/romi/current until each was
        # given its own subtree: installing the Agent pointed that one symlink at
        # the Agent release, and the Hub ran whatever it found there at its next
        # restart. A differing version made it worse -- the Hub installer refused
        # outright, because the Agent already owned the version directory.
        release = FixtureRelease(self.base, 'hub')
        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        hub_current = self.prefix / 'opt/romi/hub/current'
        hub_binary = (hub_current / 'romi-hub').resolve()
        self.assertTrue(hub_binary.is_file())

        agent_binary = b'#!/bin/sh\n[ "${1:-}" = "--version" ] && echo "romi-agent %s"\n' % b'0.9.9'
        with LocalHub('0.9.9', agent_binary) as hub:
            run_checked('sh', str(AGENT_INSTALL), '--root-prefix', str(self.prefix),
                        '--server', hub.url, '--token-stdin', input='coexisting-token\n')

        # Each component resolves through its own symlink, at its own version.
        self.assertEqual(os.readlink(hub_current), f'releases/{VERSION}')
        self.assertTrue((hub_current / 'romi-hub').is_file())
        agent_current = self.prefix / 'opt/romi/agent/current'
        self.assertEqual(os.readlink(agent_current), 'releases/0.9.9')
        self.assertTrue((agent_current / 'romi-agent').is_file())

        # The shared configuration directory keeps the stricter mode, and each
        # environment file keeps its own.
        etc = self.prefix / 'etc/romi'
        self.assertEqual(oct(etc.stat().st_mode & 0o777), '0o750')
        self.assertEqual(oct((etc / 'hub.env').stat().st_mode & 0o777), '0o640')
        self.assertEqual(oct((etc / 'agent.env').stat().st_mode & 0o777), '0o600')

        # Reinstalling the Hub afterwards still succeeds and leaves the Agent
        # pointing where it was.
        run_checked('sh', str(release.install), '--root-prefix', str(self.prefix),
                    '--site', 'https://hub.example.com', '--no-start')
        self.assertEqual(os.readlink(agent_current), 'releases/0.9.9')
        self.assertEqual(os.readlink(hub_current), f'releases/{VERSION}')

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
            'download': '/agent/v0.1.0/x86_64-unknown-linux-gnu',
        }
        with LocalHub('0.1.0', binary, metadata=metadata) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((rejection_prefix / 'opt/romi/agent/releases/0.1.0').exists())
        self.assertFalse((rejection_prefix / 'opt/romi/agent/current').exists())

        # Truncated binary: metadata promises more bytes than the server sends.
        metadata = {
            'format': 1, 'project': 'romi', 'kind': 'agent-distribution',
            'version': '0.1.0', 'target': GNU_TARGET, 'architecture': 'x86_64',
            'filename': 'romi-agent', 'sha256': sha256(binary), 'size': len(binary) + 10,
            'download': '/agent/v0.1.0/x86_64-unknown-linux-gnu',
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

        # An Agent binary that cannot execute at all is refused before state
        # is written; this is distinct from a runnable binary with the wrong
        # reported version.
        broken = b'#!/bin/sh\nexit 1\n'
        with LocalHub('0.1.0', broken) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', input='token\n')
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((rejection_prefix / 'opt/romi/agent/releases/0.1.0').exists())
        self.assertFalse((rejection_prefix / 'opt/romi/agent/current').exists())

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

        # Interface policies are persisted in an EnvironmentFile, so reject
        # whitespace and shell-sensitive names rather than writing ambiguous
        # systemd syntax.
        with LocalHub('0.1.0', binary) as hub:
            result = run('sh', str(AGENT_INSTALL), '--root-prefix', str(rejection_prefix),
                         '--server', hub.url, '--token-stdin', '--iface', 'eth0 eth1',
                         input='token\n')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('--iface', result.stderr)

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
            output = result.stdout + result.stderr
            # systemd-analyze verify walks the host's unit directories and can
            # report unrelated host units (for example a root-only runtime
            # fragment or a distro unit using a newer key). Only diagnostics
            # that name this generated unit can indicate a real change in the
            # unit contract.
            relevant = '\n'.join(
                line for line in output.splitlines()
                if str(unit) in line or unit.name in line
            )
            self.assertNotRegex(
                relevant,
                r'Failed to|Bad unit file setting|Unknown key name',
                f'{unit}\n{output}',
            )


if __name__ == '__main__':
    unittest.main(verbosity=2)
