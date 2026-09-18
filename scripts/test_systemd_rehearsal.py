#!/usr/bin/env python3
"""Focused regression tests for the real-systemd release rehearsal driver.

These tests are intentionally offline: they cover the lifecycle split, the
contract-file permission checks, the fixed-port probe, and the ownership marker
validation without installing anything or requiring root.
"""
from __future__ import annotations

import inspect
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
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
        calls: list[str] = []
        for phase in rehearsal.Rehearsal.REHEARSAL_PHASES:
            setattr(component, phase, lambda phase=phase: calls.append(phase))

        component.run_all()

        self.assertEqual(calls, list(rehearsal.Rehearsal.REHEARSAL_PHASES))
        self.assertLess(calls.index("claim_disposable_host"), calls.index("install_hub_from_archive"))
        self.assertLess(calls.index("install_hub_from_archive"), calls.index("verify_hub_filesystem"))
        self.assertLess(calls.index("verify_hub_filesystem"), calls.index("fetch_and_install_agent"))
        self.assertLess(calls.index("fetch_and_install_agent"), calls.index("verify_agent_filesystem"))
        self.assertLess(calls.index("verify_agent_filesystem"), calls.index("wait_for_telemetry"))

    def test_hub_filesystem_check_never_resolves_the_agent_account(self):
        source = inspect.getsource(rehearsal.Rehearsal.verify_hub_filesystem)
        self.assertIn("refresh_hub_service_ids", source)
        self.assertNotIn("refresh_service_ids", source)
        self.assertNotIn("refresh_agent_service_ids", source)
        self.assertNotIn("pwd.getpwnam", source)


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
