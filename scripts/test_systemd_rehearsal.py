#!/usr/bin/env python3
"""Focused regression tests for the real-systemd release rehearsal driver.

These tests are intentionally offline: they cover the lifecycle split, the
contract-file permission checks, the fixed-port probe, and the ownership marker
validation without installing anything or requiring root.
"""
from __future__ import annotations

import inspect
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import systemd_rehearsal as rehearsal  # noqa: E402


def make_rehearsal() -> rehearsal.Rehearsal:
    return rehearsal.Rehearsal(
        ROOT / "dist" / "release",
        rehearsal.DEFAULT_SITE,
        Path(tempfile.gettempdir()) / "romi-rehearsal-test-work",
        False,
    )


class PreflightTests(unittest.TestCase):
    def _preflight_component(self):
        component = make_rehearsal()
        return component

    def test_preflight_rejects_existing_service_user(self):
        component = self._preflight_component()
        running = subprocess.CompletedProcess(["systemctl"], 0, "running", "")
        with mock.patch.object(rehearsal, "systemctl", return_value=running), \
                mock.patch.object(rehearsal.shutil, "which", return_value="/usr/bin/systemctl"), \
                mock.patch.object(rehearsal.os, "geteuid", return_value=0), \
                mock.patch.object(rehearsal.os.path, "lexists", return_value=False), \
                mock.patch.object(
                    rehearsal, "user_exists",
                    side_effect=lambda name: name == rehearsal.HUB_USER,
                ):
            with self.assertRaisesRegex(rehearsal.RehearsalError, "service user .* already exists"):
                component.preflight()

    def test_preflight_rejects_existing_product_path(self):
        component = self._preflight_component()
        running = subprocess.CompletedProcess(["systemctl"], 0, "running", "")
        product_path = rehearsal.CLAIMED_PATHS[0]
        with mock.patch.object(rehearsal, "systemctl", return_value=running), \
                mock.patch.object(rehearsal.shutil, "which", return_value="/usr/bin/systemctl"), \
                mock.patch.object(rehearsal.os, "geteuid", return_value=0), \
                mock.patch.object(
                    rehearsal.os.path, "lexists",
                    side_effect=lambda path: Path(path) == product_path,
                ):
            with self.assertRaisesRegex(rehearsal.RehearsalError, "already exists"):
                component.preflight()


class ContractFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="romi-contract-file-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "hub.env"
        self.path.write_text("ROMI_SITE=https://hub.romi.test\n", encoding="utf-8")

    def test_exact_0640_group_read_contract_is_accepted(self):
        self.path.chmod(0o640)
        status = rehearsal.expect_contract_file(self.path, 0o640, os.getuid(), os.getgid())
        self.assertEqual(status.st_uid, os.getuid())

    def test_group_writable_is_rejected(self):
        self.path.chmod(0o660)
        with self.assertRaisesRegex(rehearsal.RehearsalError, "group writable"):
            rehearsal.expect_contract_file(self.path, 0o640, os.getuid(), os.getgid())

    def test_other_accessible_is_rejected(self):
        self.path.chmod(0o644)
        with self.assertRaisesRegex(rehearsal.RehearsalError, "accessible by other users"):
            rehearsal.expect_contract_file(self.path, 0o640, os.getuid(), os.getgid())

    def test_wrong_exact_contract_mode_is_rejected(self):
        self.path.chmod(0o600)
        with self.assertRaisesRegex(rehearsal.RehearsalError, "expected 640"):
            rehearsal.expect_contract_file(self.path, 0o640, os.getuid(), os.getgid())


class ServiceIdSplitTests(unittest.TestCase):
    def test_hub_refresh_does_not_require_agent_account_before_install(self):
        component = make_rehearsal()
        seen: list[tuple[str, str]] = []

        def lookup_user(name):
            seen.append(("user", name))
            if name == rehearsal.HUB_USER:
                return mock.Mock(pw_uid=2001)
            raise KeyError(name)

        def lookup_group(name):
            seen.append(("group", name))
            if name == rehearsal.HUB_USER:
                return mock.Mock(gr_gid=2002)
            raise KeyError(name)

        with mock.patch.object(rehearsal.pwd, "getpwnam", side_effect=lookup_user), \
                mock.patch.object(rehearsal.grp, "getgrnam", side_effect=lookup_group):
            component.refresh_hub_service_ids()

        self.assertEqual((component.hub_uid, component.hub_gid), (2001, 2002))
        self.assertEqual(seen, [("user", rehearsal.HUB_USER), ("group", rehearsal.HUB_USER)])

    def test_agent_refresh_requires_agent_account_after_install(self):
        component = make_rehearsal()
        with mock.patch.object(rehearsal.pwd, "getpwnam", side_effect=KeyError(rehearsal.AGENT_USER)), \
                mock.patch.object(rehearsal.grp, "getgrnam", side_effect=KeyError(rehearsal.AGENT_USER)):
            with self.assertRaisesRegex(rehearsal.RehearsalError, "Agent service account"):
                component.refresh_agent_service_ids()


class LifecycleOrderTests(unittest.TestCase):
    def test_install_and_verify_order_matches_the_real_lifecycle(self):
        component = make_rehearsal()
        phases = (
            "preflight", "claim_disposable_host", "load_and_verify_release",
            "install_hub_from_archive", "verify_hub_filesystem", "setup_nginx", "bootstrap_lifecycle",
            "direct_provisioning_is_refused", "tls_paths", "websocket_probe",
            "create_permanent_node", "fetch_and_install_agent", "verify_agent_filesystem",
            "wait_for_telemetry", "registration_flow", "idempotent_hub_reinstall",
            "idempotent_agent_reinstall", "hub_restart_cycle", "systemd_analysis",
        )
        calls: list[str] = []
        for phase in phases:
            method = mock.create_autospec(
                getattr(component, phase),
                side_effect=lambda *args, phase=phase, **kwargs: calls.append(phase),
            )
            setattr(component, phase, method)

        def create_node():
            calls.append("create_permanent_node")
            component.permanent_token = "test-issued-token"
            component.permanent_node_id = 42

        component.create_permanent_node.side_effect = create_node

        component.run_all()

        self.assertEqual(calls, list(phases))
        component.fetch_and_install_agent.assert_called_once_with("test-issued-token")
        component.wait_for_telemetry.assert_called_once_with(42)
        self.assertLess(calls.index("claim_disposable_host"), calls.index("install_hub_from_archive"))
        self.assertLess(calls.index("install_hub_from_archive"), calls.index("verify_hub_filesystem"))
        self.assertLess(calls.index("setup_nginx"), calls.index("bootstrap_lifecycle"))
        self.assertLess(calls.index("verify_hub_filesystem"), calls.index("fetch_and_install_agent"))
        self.assertLess(calls.index("fetch_and_install_agent"), calls.index("verify_agent_filesystem"))
        self.assertLess(calls.index("verify_agent_filesystem"), calls.index("wait_for_telemetry"))

    def test_hub_filesystem_check_never_resolves_the_agent_account(self):
        source = inspect.getsource(rehearsal.Rehearsal.verify_hub_filesystem)
        self.assertIn("refresh_hub_service_ids", source)
        self.assertNotIn("refresh_service_ids", source)
        self.assertNotIn("refresh_agent_service_ids", source)
        self.assertNotIn("pwd.getpwnam", source)


class TLSMaterialTests(unittest.TestCase):
    def test_generated_chain_and_secure_session_work_with_strict_verification(self):
        with tempfile.TemporaryDirectory(prefix="romi-tls-test-") as temporary:
            ca, certificate, key = rehearsal.create_tls_material(Path(temporary), "localhost")
            subprocess.run(["openssl", "verify", "-x509_strict", "-CAfile", str(ca), str(certificate)],
                           check=True, capture_output=True)

            class Handler(http.server.BaseHTTPRequestHandler):
                def reply(self, status, login=False):
                    body = b'{"status":"ok"}'
                    self.send_response(status)
                    if login:
                        self.send_header("Set-Cookie", "monitor_session=test-session; Secure; HttpOnly; Path=/")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def do_POST(self):
                    self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    self.reply(200, login=True)

                def do_GET(self):
                    self.reply(200 if self.headers.get("Cookie") == "monitor_session=test-session" else 401)

                def log_message(self, *_args):
                    pass

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certificate, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"https://localhost:{server.server_port}"
                client = rehearsal.HTTPSession(base, cafile=ca)
                self.assertEqual(client.request("POST", "/login", json_body={}).status, 200)
                self.assertTrue(make_rehearsal().health(client))
                insecure = urllib.request.Request(base.replace("https:", "http:") + "/healthz")
                client.jar.add_cookie_header(insecure)
                self.assertIsNone(insecure.get_header("Cookie"))
                with self.assertRaises(rehearsal.RehearsalError):
                    rehearsal.HTTPSession(base).request("GET", "/healthz", timeout=3)
                with self.assertRaises(rehearsal.RehearsalError):
                    rehearsal.HTTPSession(base.replace("localhost", "127.0.0.1"), cafile=ca).request("GET", "/healthz", timeout=3)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_health_timeout_keeps_the_tls_failure_reason(self):
        component = make_rehearsal()
        client = mock.Mock()
        client.request.side_effect = rehearsal.RehearsalError("certificate key usage missing")
        with self.assertRaisesRegex(rehearsal.RehearsalError, "certificate key usage missing"):
            rehearsal.wait_until(lambda: component.health(client), 0.01, "TLS health", interval=0.001)


class TelemetryReadinessTests(unittest.TestCase):
    def test_restart_waits_for_committed_history_not_just_live_telemetry(self):
        component = make_rehearsal()
        component.permanent_node_id = 42
        component.node_metrics = mock.Mock(side_effect=[{"metrics": []}, {"metrics": [{"ts": 120}]}])
        with mock.patch.object(rehearsal.time, "sleep"), \
                mock.patch.object(rehearsal, "systemctl", side_effect=RuntimeError("restart reached")) as control:
            with self.assertRaisesRegex(RuntimeError, "restart reached"):
                component.hub_restart_cycle()
        self.assertEqual(component.node_metrics.call_args_list, [mock.call(42), mock.call(42)])
        control.assert_called_once_with("restart", "romi-hub.service")

    def test_connected_agent_waits_for_its_first_nonempty_report(self):
        for node in (None, {}, {"online": True, "metrics": None},
                     {"online": True, "metrics": {}},
                     {"online": True, "metrics": {"mem_total": 0}},
                     {"online": False, "metrics": {"mem_total": 1024}}):
            self.assertFalse(rehearsal.has_telemetry(node), node)
        self.assertTrue(rehearsal.has_telemetry({"online": True, "metrics": {"mem_total": 1024}}))


class BootstrapTLSTests(unittest.TestCase):
    def test_bootstrap_uses_https_for_login_admin_requests_and_password_rotation(self):
        component = make_rehearsal()
        component.nginx_ca = Path("test-ca.pem")
        client = mock.Mock(spec=rehearsal.HTTPSession)
        client.base = rehearsal.DEFAULT_SITE
        component.tls_admin = client
        headers = rehearsal.Message()
        headers["Set-Cookie"] = "monitor_session=test-session; Secure; HttpOnly"
        ok = rehearsal.HTTPResponse(200, headers, b"{}")
        client.request.side_effect = [ok, ok, ok]
        stale = mock.Mock()
        stale.request.return_value = rehearsal.HTTPResponse(401, rehearsal.Message(), b"")
        fresh = mock.Mock()
        fresh.request.return_value = ok
        secret = "0123456789abcdef01234567"
        with mock.patch.object(rehearsal.Path, "read_text", side_effect=[secret, "unit without a credential"]), \
                mock.patch.object(rehearsal.Path, "exists", return_value=False), \
                mock.patch.object(rehearsal, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                mock.patch.object(rehearsal, "HTTPSession", side_effect=[stale, fresh]) as sessions:
            component.bootstrap_lifecycle()
        client.request.assert_any_call("POST", "/api/auth/login", json_body={"username": "admin", "password": secret})
        client.request.assert_any_call("GET", "/api/db")
        client.request.assert_any_call(
            "PUT",
            "/api/settings",
            json_body={"admin_password": component.new_password, "current_password": secret},
        )
        self.assertEqual(sessions.call_args_list, [mock.call(rehearsal.DEFAULT_SITE, cafile=component.nginx_ca)] * 2)

    def test_direct_provisioning_checks_an_authenticated_caller_without_relaxing_cookie_policy(self):
        component = make_rehearsal()
        component.tls_admin = mock.Mock()
        component.tls_admin.cookie_header.return_value = "monitor_session=test-session"
        component.direct = mock.Mock()
        component.direct.request.return_value = rehearsal.HTTPResponse(403, rehearsal.Message(), b"")
        component.direct_provisioning_is_refused()
        component.direct.request.assert_called_once_with(
            "POST", "/api/nodes", json_body={"name": "direct-refused", "traffic_reset_day": 1},
            headers={"Cookie": "monitor_session=test-session"},
        )


class SystemdVerifyScopingTests(unittest.TestCase):
    def test_failure_naming_the_generated_unit_is_returned(self):
        output = (
            "/etc/systemd/system/romi-hub.service:5: Bad unit file setting.\n"
            "Failed to load /etc/systemd/system/romi-hub.service\n"
        )
        failures = rehearsal.systemd_verify_failures("romi-hub.service", output)
        self.assertEqual(len(failures), 2)

    def test_unrelated_host_unit_diagnostics_are_ignored(self):
        output = (
            "netplan-ovs-cleanup.service: Failed to open "
            "/run/systemd/system/netplan-ovs-cleanup.service: Permission denied\n"
            "/lib/systemd/system/snapd.service:23: Unknown key name 'RestartMode' "
            "in section 'Service', ignoring.\n"
        )
        self.assertEqual(rehearsal.systemd_verify_failures("romi-hub.service", output), [])

    def test_warnings_not_naming_the_unit_are_ignored(self):
        output = "some-other.service: Unknown key name 'Foo' in section 'Service', ignoring.\n"
        self.assertEqual(rehearsal.systemd_verify_failures("romi-agent.service", output), [])


class FixedPortTests(unittest.TestCase):
    def test_occupied_port_is_rejected_with_a_clear_error(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(rehearsal.RehearsalError, "already in use"):
                rehearsal.ensure_free_port(port)

    def test_free_port_is_accepted(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        rehearsal.ensure_free_port(port)


class OwnershipMarkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="romi-ownership-marker-")
        self.addCleanup(self.temporary.cleanup)
        self.marker = Path(self.temporary.name) / "owner.json"

    def _valid_payload(self) -> dict:
        return {
            "format": rehearsal.OWNERSHIP_FORMAT,
            "project": "romi",
            "purpose": "disposable-systemd-rehearsal",
            "pid": 1234,
            "created_at": "2026-01-01T00:00:00Z",
            "claimed_paths": [str(path) for path in rehearsal.CLAIMED_PATHS],
            "claimed_units": [str(path) for path in rehearsal.CLAIMED_UNITS],
            "claimed_users": list(rehearsal.CLAIMED_USERS),
            "claimed_groups": list(rehearsal.CLAIMED_GROUPS),
        }

    def test_valid_marker_is_accepted(self):
        payload = self._valid_payload()
        self.marker.write_text(json.dumps(payload), encoding="utf-8")
        self.marker.chmod(0o600)
        with mock.patch.object(rehearsal, "OWNERSHIP_MARKER", self.marker):
            self.assertEqual(rehearsal.read_ownership_marker(), payload)

    def test_missing_marker_refuses_cleanup(self):
        missing = Path(self.temporary.name) / "missing.json"
        with mock.patch.object(rehearsal, "OWNERSHIP_MARKER", missing):
            with self.assertRaisesRegex(rehearsal.RehearsalError, "refusing to delete any host state"):
                rehearsal.read_ownership_marker()

    def test_unrecognized_claimed_path_is_rejected(self):
        with self.assertRaisesRegex(rehearsal.RehearsalError, "unrecognized"):
            rehearsal.marker_list(
                {"claimed_paths": ["/tmp/not-a-claimed-romi-path"]},
                "claimed_paths",
                rehearsal.CLAIMED_PATHS,
            )

    def test_marker_with_unknown_purpose_is_rejected(self):
        payload = self._valid_payload()
        payload["purpose"] = "something-else"
        self.marker.write_text(json.dumps(payload), encoding="utf-8")
        self.marker.chmod(0o600)
        with mock.patch.object(rehearsal, "OWNERSHIP_MARKER", self.marker):
            with self.assertRaisesRegex(rehearsal.RehearsalError, "not a romi disposable-rehearsal marker"):
                rehearsal.read_ownership_marker()


if __name__ == "__main__":
    unittest.main(verbosity=2)
