#!/usr/bin/env python3
"""Disposable native-service rehearsal for romi on a real systemd host.

This driver exists for manual release rehearsals. It requires root and systemd,
refuses to run on a host that already has a romi installation, and consumes a
release directory that was produced and verified as ``public-release``. It runs
the real Hub installer from the Hub archive, the real Agent installer served by
that Hub, and the same Nginx/TLS-facing paths an operator would use.

It is intentionally not part of normal CI: it mutates /opt, /var/lib, /etc and
systemd. A GitHub-hosted job is disposable. The rehearsal requires
127.0.0.1:28080 to be free, refuses to run where the romi service accounts or
installation paths already exist, and claims the host with an ownership marker
under /run so cleanup only removes state it is allowed to own.
"""
from __future__ import annotations

import argparse
import base64
import grp
import hashlib
import http.cookiejar
import json
import os
import platform
import pwd
import re
import secrets
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.message import Message
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
NATIVE_ARCH = platform.machine()
NATIVE_TARGET = NATIVE_ARCH + "-unknown-linux-gnu"
DEFAULT_SITE = "https://hub.romi.test"
TEST_HOST = "hub.romi.test"
HUB_PORT = 28080
HUB_BASE = f"http://127.0.0.1:{HUB_PORT}"
HUB_USER = "romi"
AGENT_USER = "romi-agent"
HOSTS_MARKER = "# romi systemd rehearsal"
SYSTEMD_VERIFY_FAILURE = re.compile(r"Failed to|Bad unit file setting|Unknown key name")

# The rehearsal deliberately keeps the documented fixed Hub port. Preflight
# proves it is free; the Hub installer and the Nginx proxy_pass both use it.
REHEARSAL_RUNTIME_DIR = Path("/run/romi-systemd-rehearsal")
OWNERSHIP_MARKER = REHEARSAL_RUNTIME_DIR / "owner.json"
OWNERSHIP_FORMAT = 1
CLAIMED_UNITS = (
    Path("/etc/systemd/system/romi-hub.service"),
    Path("/etc/systemd/system/romi-agent.service"),
)
CLAIMED_PATHS = (
    Path("/opt/romi"),
    Path("/var/lib/romi"),
    Path("/etc/romi"),
    Path("/etc/nginx/romi-rehearsal"),
    Path("/etc/nginx/conf.d/romi-rehearsal.conf"),
)
CLAIMED_USERS = (HUB_USER, AGENT_USER)
CLAIMED_GROUPS = (HUB_USER, AGENT_USER)


class RehearsalError(RuntimeError):
    """A native-service rehearsal invariant failed."""


def info(message: str) -> None:
    print(f"[systemd-rehearsal] {message}", flush=True)


def fail(message: str) -> None:
    raise RehearsalError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(
    command: list[str],
    *,
    check: bool = True,
    capture: bool = False,
    input_text: str | None = None,
    env: dict | None = None,
    user: str | None = None,
    group: str | None = None,
    cwd: str | Path | None = None,
) -> subprocess.CompletedProcess:
    rendered = [str(part) for part in command]
    if not capture:
        import shlex

        print(f"+ {shlex.join(rendered)}", flush=True)
    try:
        result = subprocess.run(
            rendered,
            check=False,
            text=True,
            input=input_text,
            capture_output=capture,
            env=env,
            user=user,
            group=group,
            cwd=str(cwd) if cwd is not None else None,
        )
    except OSError as error:
        raise RehearsalError(f"cannot run {rendered[0]}: {error}") from error
    if check and result.returncode != 0:
        detail = ""
        if capture:
            detail = f"\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        raise RehearsalError(f"command failed with exit {result.returncode}: {rendered[0]}{detail}")
    return result


def systemctl(*arguments: str, check: bool = True) -> subprocess.CompletedProcess:
    return run(["systemctl", *arguments], check=check, capture=True)


def systemctl_is_active(unit: str) -> bool:
    return systemctl("is-active", "--quiet", unit, check=False).returncode == 0


def systemd_analyze(*arguments: str, check: bool = False) -> subprocess.CompletedProcess:
    return run(["systemd-analyze", *arguments], check=check, capture=True)


def systemd_verify_failures(unit: str, output: str) -> list[str]:
    """Return only failure diagnostics that name the generated unit.

    ``systemd-analyze verify`` recursively inspects host units, so a disposable
    VM can report unrelated distro-unit warnings. Those must not mask or
    manufacture a verdict about the unit under test.
    """
    return [
        line for line in output.splitlines()
        if unit in line and SYSTEMD_VERIFY_FAILURE.search(line)
    ]


@dataclass
class HTTPResponse:
    status: int
    headers: Message
    body: bytes

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RehearsalError(f"response is not JSON: {error}") from error

    def set_cookies(self) -> list[str]:
        return list(self.headers.get_all("Set-Cookie") or [])


class HTTPSession:
    """Small urllib wrapper with a per-session cookie jar and explicit CA file."""

    def __init__(self, base: str, cafile: Path | None = None):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        handlers: list = [
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self.jar),
        ]
        if cafile is not None:
            context = ssl.create_default_context(cafile=str(cafile))
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self.opener = urllib.request.build_opener(*handlers)

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body=None,
        body: bytes | str | None = None,
        headers: dict | None = None,
        timeout: float = 20.0,
    ) -> HTTPResponse:
        url = self.base + path
        request_headers = dict(headers or {})
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        elif body is not None:
            data = body.encode("utf-8") if isinstance(body, str) else body
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            return HTTPResponse(error.code, error.headers, error.read())
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise RehearsalError(f"{method} {url}: {reason}") from error
        return HTTPResponse(response.status, response.headers, response.read())

    def cookie_header(self) -> str:
        return "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.jar)


def create_tls_material(directory: Path, host: str) -> tuple[Path, Path, Path]:
    """Create a test CA and leaf accepted by Python's strict X.509 verification."""
    ca_key, ca_cert = directory / "ca.key", directory / "ca.crt"
    server_key, server_csr = directory / "server.key", directory / "server.csr"
    server_cert, extension = directory / "server.crt", directory / "server.ext"
    run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
        "-keyout", str(ca_key), "-out", str(ca_cert), "-subj", "/CN=romi rehearsal CA",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-addext", "subjectKeyIdentifier=hash",
    ], capture=True)
    run([
        "openssl", "req", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", str(server_key), "-out", str(server_csr), "-subj", f"/CN={host}",
    ], capture=True)
    extension.write_text(
        f"subjectAltName=DNS:{host}\nbasicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"
        "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n",
        encoding="utf-8",
    )
    run([
        "openssl", "x509", "-req", "-in", str(server_csr), "-CA", str(ca_cert),
        "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(server_cert),
        "-days", "2", "-sha256", "-extfile", str(extension),
    ], capture=True)
    for path, mode in ((ca_key, 0o600), (server_key, 0o600), (ca_cert, 0o644), (server_cert, 0o644)):
        path.chmod(mode)
    return ca_cert, server_cert, server_key


def wait_until(predicate, timeout: float, message: str, interval: float = 0.25):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
        except RehearsalError as error:
            last_error = str(error)
        else:
            if value:
                return value
        time.sleep(interval)
    suffix = f" (last error: {last_error})" if last_error else ""
    raise RehearsalError(f"timed out after {timeout:.0f}s waiting for {message}{suffix}")


def has_telemetry(node: dict | None) -> bool:
    # A connected Agent is online before its first report; metrics is then null.
    metrics = node.get("metrics") if node else None
    return bool(node and node.get("online") and isinstance(metrics, dict) and metrics.get("mem_total"))


def expect_mode(path: Path, mode: int | None = None, uid: int | None = None, gid: int | None = None) -> os.stat_result:
    try:
        status = path.lstat()
    except OSError as error:
        raise RehearsalError(f"cannot stat {path}: {error}") from error
    actual_mode = stat.S_IMODE(status.st_mode)
    if mode is not None and actual_mode != mode:
        raise RehearsalError(f"{path} mode is {actual_mode:o}, expected {mode:o}")
    if uid is not None and status.st_uid != uid:
        raise RehearsalError(f"{path} owner uid is {status.st_uid}, expected {uid}")
    if gid is not None and status.st_gid != gid:
        raise RehearsalError(f"{path} group gid is {status.st_gid}, expected {gid}")
    return status


def user_exists(name: str) -> bool:
    try:
        pwd.getpwnam(name)
    except KeyError:
        return False
    return True


def group_exists(name: str) -> bool:
    try:
        grp.getgrnam(name)
    except KeyError:
        return False
    return True


def expect_contract_file(path: Path, mode: int, uid: int, gid: int) -> os.stat_result:
    """Assert a file's exact contract mode with readable dangerous-bit checks."""
    status = expect_mode(path, None, uid, gid)
    actual_mode = stat.S_IMODE(status.st_mode)
    if actual_mode & 0o020:
        fail(f"{path} is group writable (mode {actual_mode:o}); expected {mode:o}")
    if actual_mode & 0o007:
        fail(f"{path} is accessible by other users (mode {actual_mode:o}); expected {mode:o}")
    if actual_mode != mode:
        fail(f"{path} mode is {actual_mode:o}, expected {mode:o}")
    return status


def ensure_free_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            fail(
                f"127.0.0.1:{port} is already in use ({error}); "
                "this rehearsal requires that fixed port to be free"
            )


def read_ownership_marker() -> dict:
    try:
        status = OWNERSHIP_MARKER.lstat()
    except FileNotFoundError:
        fail(f"ownership marker {OWNERSHIP_MARKER} is missing; refusing to delete any host state")
    except OSError as error:
        fail(f"cannot inspect ownership marker {OWNERSHIP_MARKER}: {error}")
    if not stat.S_ISREG(status.st_mode):
        fail(f"{OWNERSHIP_MARKER} is not a regular file; refusing to delete any host state")
    if os.geteuid() == 0 and status.st_uid != 0:
        fail(f"{OWNERSHIP_MARKER} is not owned by root; refusing to delete any host state")
    if stat.S_IMODE(status.st_mode) & 0o077:
        fail(f"{OWNERSHIP_MARKER} is group/world accessible; refusing to delete any host state")
    try:
        payload = json.loads(OWNERSHIP_MARKER.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read ownership marker {OWNERSHIP_MARKER}: {error}")
    if not isinstance(payload, dict):
        fail(f"{OWNERSHIP_MARKER} does not contain a JSON object; refusing cleanup")
    if (
        payload.get("format") != OWNERSHIP_FORMAT
        or payload.get("project") != "romi"
        or payload.get("purpose") != "disposable-systemd-rehearsal"
    ):
        fail(f"{OWNERSHIP_MARKER} is not a romi disposable-rehearsal marker; refusing cleanup")
    return payload


def marker_list(payload: dict, key: str, allowed: tuple) -> list[str]:
    value = payload.get(key)
    allowed_text = [str(item) for item in allowed]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"ownership marker field {key!r} is not a list of strings; refusing cleanup")
    unknown = [item for item in value if item not in allowed_text]
    if unknown:
        fail(f"ownership marker claims unrecognized {key}: {unknown!r}; refusing cleanup")
    return value


def remove_claimed_path(path: Path) -> None:
    if not os.path.lexists(path):
        return
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            fail(f"{path} is neither a file nor a directory; refusing to remove it")
    except OSError as error:
        raise RehearsalError(f"cannot remove claimed path {path}: {error}") from error


def cleanup_claimed_host_state() -> None:
    """Remove only resources named by a rehearsal ownership marker."""
    if not os.path.lexists(OWNERSHIP_MARKER):
        info("no rehearsal ownership marker; refusing to delete any host state")
        return
    payload = read_ownership_marker()
    claimed_paths = [Path(item) for item in marker_list(payload, "claimed_paths", CLAIMED_PATHS)]
    claimed_units = [Path(item) for item in marker_list(payload, "claimed_units", CLAIMED_UNITS)]
    claimed_users = marker_list(payload, "claimed_users", CLAIMED_USERS)
    claimed_groups = marker_list(payload, "claimed_groups", CLAIMED_GROUPS)
    info(
        "cleaning only disposable rehearsal state claimed by "
        f"pid {payload.get('pid')} at {payload.get('created_at')}"
    )

    run(
        ["systemctl", "disable", "--now", *(path.name for path in claimed_units)],
        check=False,
        capture=True,
    )
    for unit in claimed_units:
        remove_claimed_path(unit)
    systemctl("daemon-reload", check=False)
    for path in claimed_paths:
        remove_claimed_path(path)

    for user in claimed_users:
        if not user_exists(user):
            continue
        result = run(["userdel", user], check=False, capture=True)
        if result.returncode != 0:
            fail(f"cannot delete claimed service user {user}: {result.stderr.strip() or result.stdout.strip()}")
    for group in claimed_groups:
        if not group_exists(group):
            continue
        result = run(["groupdel", group], check=False, capture=True)
        if result.returncode != 0:
            fail(f"cannot delete claimed service group {group}: {result.stderr.strip() or result.stdout.strip()}")

    hosts = Path("/etc/hosts")
    try:
        lines = hosts.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"cannot read {hosts} during cleanup: {error}")
    retained = [line for line in lines if HOSTS_MARKER not in line]
    if retained != lines:
        try:
            hosts.write_text("\n".join(retained) + "\n", encoding="utf-8")
        except OSError as error:
            fail(f"cannot rewrite {hosts} during cleanup: {error}")

    systemctl("stop", "nginx.service", check=False)
    try:
        OWNERSHIP_MARKER.unlink()
    except FileNotFoundError:
        pass
    except OSError as error:
        fail(f"cannot remove ownership marker {OWNERSHIP_MARKER}: {error}")
    try:
        REHEARSAL_RUNTIME_DIR.rmdir()
    except FileNotFoundError:
        pass
    except OSError:
        info(f"left non-empty ownership directory {REHEARSAL_RUNTIME_DIR}")


def expect_symlink(path: Path, target: str) -> None:
    try:
        actual = os.readlink(path)
    except OSError as error:
        raise RehearsalError(f"{path} is not a readable symlink: {error}") from error
    if actual != target:
        raise RehearsalError(f"{path} points at {actual!r}, expected {target!r}")


def extract_archive(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                if not member.isfile():
                    raise RehearsalError(f"{archive.name}: unexpected non-file member {member.name!r}")
                name = PurePosixPath(member.name)
                if name.is_absolute() or ".." in name.parts or "." in name.parts:
                    raise RehearsalError(f"{archive.name}: unsafe member {member.name!r}")
                target = destination.joinpath(*name.parts)
                data = tar.extractfile(member)
                if data is None:
                    raise RehearsalError(f"{archive.name}: unreadable member {member.name!r}")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data.read())
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    except (tarfile.TarError, OSError) as error:
        raise RehearsalError(f"cannot extract {archive}: {error}") from error


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise RehearsalError(f"{path} line is not KEY=VALUE: {line!r}")
        values[key] = value
    return values


class Rehearsal:
    def __init__(self, release_dir: Path, site: str, work: Path, cleanup: bool):
        self.release_dir = release_dir.resolve()
        self.site = site.rstrip("/")
        self.work = work
        self.cleanup_requested = cleanup
        self.manifest: dict = {}
        self.artifacts: dict[str, dict] = {}
        self.version = ""
        self.tag = ""
        self.commit = ""
        self.hub_release: Path | None = None
        self.hub_installer: Path | None = None
        self.agent_install_script: Path | None = None
        self.hub_agent_bytes = b""
        self.bootstrap_secret = ""
        self.new_password = ""
        self.permanent_token = ""
        self.permanent_node_id = 0
        self.registration_key = ""
        self.registered_node_id = 0
        self.nginx_ca: Path | None = None
        self.nginx_conf: Path | None = None
        self.hosts_entry_added = False
        self.host_claimed = False
        self.direct = HTTPSession(HUB_BASE)
        self.tls_admin: HTTPSession | None = None
        self.hub_uid = 0
        self.hub_gid = 0
        self.agent_uid = 0
        self.agent_gid = 0

    # ---- host preconditions -------------------------------------------------

    def preflight(self) -> None:
        if os.geteuid() != 0:
            fail("this rehearsal must run as root because it installs real systemd units")
        if shutil.which("systemctl") is None:
            fail("systemctl is required")
        running = systemctl("is-system-running", check=False)
        status = (running.stdout + running.stderr).strip()
        if status not in ("running", "degraded"):
            fail(f"systemd is not managing this host (state: {status or 'unknown'})")
        for path in (*CLAIMED_PATHS, *CLAIMED_UNITS):
            if os.path.lexists(path):
                fail(f"{path} already exists; this rehearsal requires a fresh disposable host")
        if os.path.lexists(REHEARSAL_RUNTIME_DIR):
            fail(
                f"{REHEARSAL_RUNTIME_DIR} already exists; an incomplete rehearsal may own this host. "
                "Inspect the ownership marker and run --cleanup-only to remove only claimed state."
            )
        for name in CLAIMED_USERS:
            if user_exists(name):
                fail(f"service user {name!r} already exists; this rehearsal requires a fresh disposable host")
        for name in CLAIMED_GROUPS:
            if group_exists(name):
                fail(f"service group {name!r} already exists; this rehearsal requires a fresh disposable host")
        hosts = Path("/etc/hosts")
        try:
            hosts_text = hosts.read_text(encoding="utf-8")
        except OSError as error:
            fail(f"cannot inspect {hosts}: {error}")
        if HOSTS_MARKER in hosts_text:
            fail(f"{hosts} still carries this rehearsal's marker; run cleanup-aware recovery first")
        ensure_free_port(HUB_PORT)
        self.work.mkdir(parents=True, exist_ok=True)

    def claim_disposable_host(self) -> None:
        if self.host_claimed:
            fail("this process already claimed the disposable host")
        try:
            REHEARSAL_RUNTIME_DIR.mkdir(mode=0o700)
        except FileExistsError:
            fail(f"{REHEARSAL_RUNTIME_DIR} appeared after preflight; refusing to claim ownership")
        except OSError as error:
            raise RehearsalError(f"cannot create ownership directory {REHEARSAL_RUNTIME_DIR}: {error}") from error
        # Preflight has just proved these accounts and paths absent, so this
        # marker is the ownership claim for exactly what the installers create.
        payload = {
            "format": OWNERSHIP_FORMAT,
            "project": "romi",
            "purpose": "disposable-systemd-rehearsal",
            "pid": os.getpid(),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "release_dir": str(self.release_dir),
            "site": self.site,
            "claimed_paths": [str(path) for path in CLAIMED_PATHS],
            "claimed_units": [str(path) for path in CLAIMED_UNITS],
            "claimed_users": list(CLAIMED_USERS),
            "claimed_groups": list(CLAIMED_GROUPS),
        }
        try:
            descriptor = os.open(OWNERSHIP_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, sort_keys=True)
                handle.write("\n")
        except OSError as error:
            try:
                REHEARSAL_RUNTIME_DIR.rmdir()
            except OSError:
                pass
            raise RehearsalError(f"cannot write ownership marker {OWNERSHIP_MARKER}: {error}") from error
        self.host_claimed = True
        info(f"claimed disposable host state with {OWNERSHIP_MARKER}")

    def load_and_verify_release(self) -> None:
        manifests = sorted(self.release_dir.glob("romi-release-*.json"))
        if len(manifests) != 1:
            fail(f"expected exactly one public release manifest in {self.release_dir}, found {len(manifests)}")
        try:
            self.manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RehearsalError(f"cannot read {manifests[0]}: {error}") from error
        if self.manifest.get("kind") != "public-release":
            fail(f"rehearsal requires a public-release artifact, got {self.manifest.get('kind')!r}")
        self.version = str(self.manifest.get("version"))
        self.tag = str(self.manifest.get("tag"))
        self.commit = str(self.manifest.get("commit"))
        if self.tag != f"v{self.version}":
            fail(f"manifest tag {self.tag!r} does not match version {self.version!r}")
        repo_version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        if repo_version != self.version:
            fail(f"release version {self.version!r} does not match repository VERSION {repo_version!r}")
        if self.manifest.get("target") != NATIVE_TARGET:
            fail(f"unsupported release target {self.manifest.get('target')!r}")
        artifacts = self.manifest.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) != 2:
            fail("public manifest must contain exactly hub and agent artifacts")
        for artifact in artifacts:
            component = artifact.get("component")
            if component not in ("hub", "agent") or component in self.artifacts:
                fail(f"unexpected or repeated manifest artifact {artifact!r}")
            path = self.release_dir / artifact["filename"]
            if not path.is_file():
                fail(f"missing release artifact {path}")
            if sha256_file(path) != artifact["sha256"] or path.stat().st_size != artifact["size"]:
                fail(f"{path.name} does not match its manifest digest/size")
            self.artifacts[component] = artifact
        # Re-run the canonical verifier with binaries. This is the same command
        # documented for release verification; the local rehearsal tag is gone,
        # so it proves the artifact is self-consistent and executable offline.
        run(
            [
                sys.executable,
                str(ROOT / "scripts" / "release.py"),
                "verify",
                str(self.release_dir),
                "--tag",
                self.tag,
                "--commit",
                self.commit,
                "--run-binaries",
            ],
            env={**os.environ, "ROMI_RELEASE_TARGET": NATIVE_TARGET},
        )

    # ---- hub install --------------------------------------------------------

    def install_hub_from_archive(self) -> None:
        hub_artifact = self.artifacts["hub"]
        extract_archive(self.release_dir / hub_artifact["filename"], self.work / "hub-release")
        self.hub_release = self.work / "hub-release"
        self.hub_installer = self.hub_release / "deploy" / "hub" / "install.sh"
        if not self.hub_installer.is_file():
            fail("Hub archive does not contain deploy/hub/install.sh")
        self.hub_agent_bytes = (self.hub_release / "bin" / "romi-agent").read_bytes()
        info(f"installing Hub {self.version} from {hub_artifact['filename']}")
        run(["sh", str(self.hub_installer), "--site", self.site])
        wait_until(lambda: self.health(self.direct), 45.0, "Hub /healthz after installation")
        if not systemctl_is_active("romi-hub.service"):
            fail("romi-hub.service is not active after a successful health check")

    def health(self, session: HTTPSession) -> bool:
        # wait_until retains the last error; do not hide TLS/HTTP failures behind
        # a generic timeout after an expensive release build.
        response = session.request("GET", "/healthz", timeout=3)
        if response.status != 200 or response.json().get("status") != "ok":
            fail(f"{session.base}/healthz is not healthy (HTTP {response.status})")
        return True

    def refresh_hub_service_ids(self) -> None:
        try:
            self.hub_uid = pwd.getpwnam(HUB_USER).pw_uid
            self.hub_gid = grp.getgrnam(HUB_USER).gr_gid
        except KeyError as error:
            fail(f"Hub service account or group {error.args[0]!r} is missing after Hub installation")

    def refresh_agent_service_ids(self) -> None:
        try:
            self.agent_uid = pwd.getpwnam(AGENT_USER).pw_uid
            self.agent_gid = grp.getgrnam(AGENT_USER).gr_gid
        except KeyError as error:
            fail(f"Agent service account or group {error.args[0]!r} is missing after Agent installation")

    def verify_hub_filesystem(self) -> None:
        self.refresh_hub_service_ids()
        opt = Path("/opt/romi")
        releases = opt / "releases"
        release = releases / self.version
        state = Path("/var/lib/romi")
        etc = Path("/etc/romi")
        distribution = state / "distribution" / self.version
        hub_env = etc / "hub.env"
        bootstrap = state / "bootstrap-password"

        expect_mode(opt, 0o755, 0, 0)
        expect_mode(releases, 0o755, 0, 0)
        expect_mode(release, 0o755, 0, 0)
        expect_mode(release / "romi-hub", 0o755, 0, 0)
        expect_mode(release / "romi-agent", 0o755, 0, 0)
        expect_symlink(opt / "current", f"releases/{self.version}")
        expect_mode(state, 0o750, self.hub_uid, self.hub_gid)
        expect_mode(state / "tmp", 0o700, self.hub_uid, self.hub_gid)
        expect_mode(state / "romi.duckdb", None, self.hub_uid, self.hub_gid)
        expect_mode(distribution, 0o750, 0, self.hub_gid)
        expect_contract_file(distribution / "romi-agent", 0o640, 0, self.hub_gid)
        expect_contract_file(distribution / "distribution.json", 0o640, 0, self.hub_gid)
        expect_contract_file(hub_env, 0o640, 0, self.hub_gid)
        expect_mode(etc, 0o750, 0, self.hub_gid)
        expect_mode(bootstrap, 0o600, self.hub_uid, self.hub_gid)
        unit = Path("/etc/systemd/system/romi-hub.service")
        expect_mode(unit, 0o644, 0, 0)
        for name in ("romi-hub", "romi-agent"):
            if sha256_file(Path("/opt/romi/releases") / self.version / name) != sha256_bytes(
                (self.hub_release / "bin" / name).read_bytes()
            ):
                fail(f"installed {name} differs from the verified Hub archive")
        info("Hub filesystem ownership and modes match the documented native layout")

    def verify_agent_filesystem(self) -> None:
        self.refresh_agent_service_ids()
        if self.agent_uid == 0 or self.agent_gid == 0:
            fail("Agent service account or group resolved to root")
        if self.agent_uid == self.hub_uid or self.agent_gid == self.hub_gid:
            fail("Agent service identity must be distinct from the Hub service identity")
        env_path = Path("/etc/romi/agent.env")
        unit = Path("/etc/systemd/system/romi-agent.service")
        expect_contract_file(env_path, 0o600, 0, 0)
        expect_mode(unit, 0o644, 0, 0)
        expect_symlink(Path("/opt/romi/current"), f"releases/{self.version}")
        installed_agent = Path("/opt/romi/releases") / self.version / "romi-agent"
        expect_mode(installed_agent, 0o755, 0, 0)
        if sha256_file(installed_agent) != sha256_bytes((self.hub_release / "bin" / "romi-agent").read_bytes()):
            fail("installed Agent binary differs from the verified Hub archive")
        info("Agent service account, environment file, unit, and immutable artifact match the contract")

    # ---- bootstrap credential ----------------------------------------------

    def bootstrap_lifecycle(self) -> None:
        if self.tls_admin is None or self.nginx_ca is None:
            fail("TLS must be ready before the bootstrap credential lifecycle")
        client = self.tls_admin
        bootstrap = Path("/var/lib/romi/bootstrap-password")
        secret = bootstrap.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[0-9a-f]{24}", secret):
            fail("bootstrap credential is not the expected high-entropy hex token")
        if len(set(secret)) < 8:
            fail("bootstrap credential does not look random enough")
        self.bootstrap_secret = secret

        journal = run(["journalctl", "-u", "romi-hub.service", "--no-pager", "--output=cat"], capture=True, check=False)
        if secret in (journal.stdout + journal.stderr):
            fail("bootstrap credential leaked into the Hub systemd journal")
        unit_text = Path("/etc/systemd/system/romi-hub.service").read_text(encoding="utf-8")
        if secret in unit_text:
            fail("bootstrap credential leaked into the installed unit")

        login = client.request("POST", "/api/auth/login", json_body={"username": "admin", "password": secret})
        if login.status != 200:
            fail(f"bootstrap credential login returned {login.status}")
        if not self._set_cookie_secure(login):
            fail("bootstrap HTTPS session cookie is missing the Secure flag")
        if client.request("GET", "/api/db").status != 200:
            fail("authenticated HTTPS admin request failed after bootstrap login")

        self.new_password = secrets.token_hex(24)
        changed = client.request(
            "PUT", "/api/settings", json_body={"admin_password": self.new_password}
        )
        if changed.status != 200:
            fail(f"password change returned {changed.status}: {changed.body[:200]!r}")
        wait_until(lambda: not bootstrap.exists(), 5.0, "bootstrap file removal after password change")
        if bootstrap.exists():
            fail("bootstrap credential file still exists after password change")

        stale = HTTPSession(client.base, cafile=self.nginx_ca)
        old_login = stale.request("POST", "/api/auth/login", json_body={"username": "admin", "password": secret})
        if old_login.status != 401:
            fail(f"old bootstrap password still authenticates (HTTP {old_login.status})")
        fresh = HTTPSession(client.base, cafile=self.nginx_ca)
        new_login = fresh.request("POST", "/api/auth/login", json_body={"username": "admin", "password": self.new_password})
        if new_login.status != 200:
            fail(f"new administrator password returned {new_login.status}")
        info("bootstrap secret is private, is absent from the journal, and is deleted after password change")

    def direct_provisioning_is_refused(self) -> None:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        # Deliberately replay the authenticated credential to loopback for this
        # negative test only. A normal CookieJar must not send Secure over HTTP.
        response = self.direct.request(
            "POST", "/api/nodes", json_body={"name": "direct-refused", "traffic_reset_day": 1},
            headers={"Cookie": self.tls_admin.cookie_header()},
        )
        if response.status != 403:
            fail(f"direct loopback provisioning was not refused (HTTP {response.status})")
        info("direct non-proxy provisioning is refused by the configured site/Host expectations")

    # ---- nginx/TLS ----------------------------------------------------------

    def setup_nginx(self) -> None:
        if shutil.which("nginx") is None:
            fail("nginx is required for the TLS rehearsal; install it as disposable test infrastructure")
        if shutil.which("openssl") is None:
            fail("openssl is required to generate the rehearsal CA and certificate")
        hosts = Path("/etc/hosts")
        hosts_text = hosts.read_text(encoding="utf-8")
        wanted = re.compile(rf"^\s*127\.0\.0\.1\s+{re.escape(TEST_HOST)}\b", re.MULTILINE)
        if not wanted.search(hosts_text):
            if TEST_HOST in hosts_text:
                fail(f"/etc/hosts already names {TEST_HOST} without 127.0.0.1; refusing to override it")
            with hosts.open("a", encoding="utf-8") as handle:
                handle.write(f"127.0.0.1 {TEST_HOST} {HOSTS_MARKER}\n")
            self.hosts_entry_added = True

        tls_dir = Path("/etc/nginx/romi-rehearsal")
        if os.path.lexists(tls_dir):
            fail(f"{tls_dir} already exists; refusing to overwrite TLS material")
        tls_dir.mkdir(mode=0o700)
        ca_cert, server_cert, server_key = create_tls_material(tls_dir, TEST_HOST)
        self.nginx_ca = ca_cert

        self.nginx_conf = Path("/etc/nginx/conf.d/romi-rehearsal.conf")
        if os.path.lexists(self.nginx_conf):
            fail(f"{self.nginx_conf} already exists; refusing to overwrite proxy configuration")
        self.nginx_conf.write_text(
            f"""
server {{
    listen 127.0.0.1:443 ssl http2;
    server_name {TEST_HOST};

    ssl_certificate     {server_cert};
    ssl_certificate_key {server_key};

    client_max_body_size 16m;

    location / {{
        proxy_pass http://127.0.0.1:{HUB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }}
}}
""".lstrip(),
            encoding="utf-8",
        )
        run(["nginx", "-t"])
        systemctl("restart", "nginx")
        self.tls_admin = HTTPSession(f"https://{TEST_HOST}", cafile=ca_cert)
        wait_until(lambda: self.health(self.tls_admin), 15.0, "Hub /healthz through the Nginx TLS route")
        info("Nginx TLS reverse proxy is serving the real Hub")

    def _set_cookie_secure(self, response: HTTPResponse) -> bool:
        return any("monitor_session=" in cookie and "Secure" in cookie for cookie in response.set_cookies())

    def tls_paths(self) -> None:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        client = self.tls_admin
        login = client.request("POST", "/api/auth/login", json_body={"username": "admin", "password": self.new_password})
        if login.status != 200:
            fail(f"HTTPS login returned {login.status}")
        if not self._set_cookie_secure(login):
            fail("HTTPS session cookie is missing the Secure flag")
        me = client.request("GET", "/api/me")
        if me.status != 200 or me.json().get("authed") is not True:
            fail("authenticated /api/me through Nginx did not report the session")
        if client.request("GET", "/api/db").status != 200:
            fail("admin API request through Nginx failed")

        install_script = client.request("GET", "/install.sh")
        if install_script.status != 200:
            fail(f"/install.sh through Nginx returned {install_script.status}")
        expected_script = (ROOT / "deploy" / "agent" / "install.sh").read_bytes()
        if install_script.body != expected_script:
            fail("/install.sh served through Nginx differs from the reviewed source installer")
        if b"api.github.com" in install_script.body or b"/releases/download/" in install_script.body:
            fail("Hub-served installer contains a GitHub download path")

        metadata = client.request("GET", "/api/agent/distribution")
        if metadata.status != 200:
            fail(f"/api/agent/distribution through Nginx returned {metadata.status}")
        document = metadata.json()
        expected_download = f"/agent/v{self.version}/{NATIVE_TARGET}"
        for key, value in (
            ("version", self.version),
            ("target", NATIVE_TARGET),
            ("architecture", NATIVE_ARCH),
            ("filename", "romi-agent"),
            ("sha256", sha256_bytes(self.hub_agent_bytes)),
            ("size", len(self.hub_agent_bytes)),
            ("download", expected_download),
        ):
            if document.get(key) != value:
                fail(f"distribution metadata {key} is {document.get(key)!r}, expected {value!r}")

        binary = client.request("GET", expected_download)
        if binary.status != 200 or binary.body != self.hub_agent_bytes:
            fail("versioned Agent binary through Nginx does not match the Hub release archive byte-for-byte")
        if sha256_bytes(binary.body) != document["sha256"]:
            fail("served Agent binary SHA-256 does not match metadata")
        if "immutable" not in binary.headers.get("Cache-Control", ""):
            fail("versioned Agent binary is not advertised as immutable")
        alias = client.request("GET", "/agent/x86_64")
        if alias.status != 404:
            fail(f"mutable /agent/x86_64 alias returned {alias.status} instead of 404")
        for path in ("/", "/admin/"):
            page = client.request("GET", path)
            if page.status != 200 or b"<html" not in page.body.lower():
                fail(f"{path} through Nginx did not return the built frontend")
        info("Nginx TLS paths pass health, session/login, admin API, installer, distribution, versioned binary, and frontend checks")

    def websocket_probe(self) -> None:
        if self.tls_admin is None or self.nginx_ca is None:
            fail("TLS session was not initialised")
        context = ssl.create_default_context(cafile=str(self.nginx_ca))
        raw = socket.create_connection(("127.0.0.1", 443), timeout=5)
        try:
            tls = context.wrap_socket(raw, server_hostname=TEST_HOST)
        except Exception:
            raw.close()
            raise
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            request = (
                f"GET /api/ws HTTP/1.1\r\n"
                f"Host: {TEST_HOST}\r\n"
                f"Upgrade: websocket\r\n"
                f"Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n"
                f"Cookie: {self.tls_admin.cookie_header()}\r\n"
                f"\r\n"
            )
            tls.sendall(request.encode("ascii"))
            tls.settimeout(5)
            response = tls.recv(4096)
            if not response.startswith(b"HTTP/1.1 101") and not response.startswith(b"HTTP/2 101"):
                fail(f"WebSocket upgrade through Nginx failed: {response.splitlines()[:1]!r}")
        finally:
            tls.close()
        info("WebSocket Upgrade through Nginx reached the Hub successfully")

    # ---- agent provisioning -------------------------------------------------

    def fetch_and_install_agent(self, token: str) -> None:
        self.agent_install_script = self.work / "install.sh"
        response = self.direct.request("GET", "/install.sh")
        if response.status != 200:
            fail(f"loopback /install.sh returned {response.status}")
        expected_script = (ROOT / "deploy" / "agent" / "install.sh").read_bytes()
        if response.body != expected_script:
            fail("Hub-served installer differs from the reviewed source installer")
        self.agent_install_script.write_bytes(response.body)
        self.agent_install_script.chmod(0o700)
        result = run(
            [
                "sh",
                str(self.agent_install_script),
                "--server",
                HUB_BASE,
                "--token-stdin",
            ],
            input_text=token + "\n",
            capture=True,
        )
        if token in result.stdout + result.stderr:
            fail("permanent Agent token appeared in installer output")
        env_path = Path("/etc/romi/agent.env")
        expect_mode(env_path, 0o600, 0, 0)
        values = parse_env_file(env_path)
        if values.get("ROMI_TOKEN") != token:
            fail("permanent token was not stored in /etc/romi/agent.env")
        if values.get("ROMI_SERVER") != HUB_BASE:
            fail(f"Agent ROMI_SERVER is {values.get('ROMI_SERVER')!r}, expected {HUB_BASE!r}")
        unit = Path("/etc/systemd/system/romi-agent.service")
        unit_text = unit.read_text(encoding="utf-8")
        if token in unit_text or "ROMI_TOKEN" in unit_text.split("EnvironmentFile", 1)[-1]:
            fail("Agent token appears in the unit file")
        if f"EnvironmentFile={env_path}" not in unit_text:
            fail("Agent unit does not read /etc/romi/agent.env")
        wait_until(lambda: systemctl_is_active("romi-agent.service"), 15.0, "Agent service active")
        journal = run(["journalctl", "-u", "romi-agent.service", "--no-pager", "--output=cat"], capture=True, check=False)
        if token in (journal.stdout + journal.stderr):
            fail("permanent Agent token leaked into the systemd journal")
        exec_start = run(["systemctl", "show", "-p", "ExecStart", "--value", "romi-agent.service"], capture=True)
        if token in exec_start.stdout:
            fail("permanent Agent token appears in ExecStart")
        info("Agent installed through the Hub-served installer with --token-stdin; token is only in the 0600 env file")

    def create_permanent_node(self) -> None:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        response = self.tls_admin.request(
            "POST", "/api/nodes", json_body={"name": "romi-rehearsal-permanent", "traffic_reset_day": 1}
        )
        if response.status != 200:
            fail(f"node creation through TLS proxy returned {response.status}")
        if response.headers.get("Cache-Control", "") != "no-store":
            fail("issued token response did not carry Cache-Control: no-store")
        issued = response.json()
        self.permanent_node_id = int(issued["id"])
        self.permanent_token = str(issued["token"])
        if len(self.permanent_token) < 32:
            fail("Hub issued a suspiciously short node token")

    def node_view(self, node_id: int) -> dict | None:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        response = self.tls_admin.request("GET", "/api/nodes")
        if response.status != 200:
            fail(f"/api/nodes returned {response.status}")
        for node in response.json().get("nodes", []):
            if node.get("id") == node_id:
                return node
        return None

    def wait_for_telemetry(self, node_id: int, timeout: float = 45.0) -> dict:
        def predicate():
            node = self.node_view(node_id)
            return node if has_telemetry(node) else None

        node = wait_until(predicate, timeout, f"telemetry for node {node_id}")
        if node.get("agent_version") != self.version:
            fail(
                f"node reports Agent version {node.get('agent_version')!r}, expected {self.version!r}"
            )
        info(f"node {node_id} is online and has sent real telemetry through the Agent service")
        return node

    def registration_flow(self) -> None:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        opened = self.tls_admin.request("POST", "/api/register-window")
        if opened.status != 200:
            fail(f"opening a registration window returned {opened.status}")
        window = opened.json()
        key = str(window.get("register_key", ""))
        if not key:
            fail("registration window response contains no key")
        self.registration_key = key
        before = {node["id"] for node in self.tls_admin.request("GET", "/api/nodes").json().get("nodes", [])}

        fixture = self.work / "registration-host"
        # Registration goes through the same live Nginx/TLS route an operator
        # would use. curl (inside the installer) can be pointed at the rehearsal
        # CA without installing it in the host trust store, while the Agent's
        # own rustls/webpki connection is left unmodified.
        if self.nginx_ca is None:
            fail("TLS CA is not available for the registration exchange")
        registration_env = dict(os.environ)
        registration_env["CURL_CA_BUNDLE"] = str(self.nginx_ca)
        registration_env["SSL_CERT_FILE"] = str(self.nginx_ca)
        result = run(
            [
                "sh",
                str(self.agent_install_script),
                "--server",
                f"https://{TEST_HOST}",
                "--register-key",
                key,
                "--root-prefix",
                str(fixture),
                "--no-start",
            ],
            capture=True,
            env=registration_env,
        )
        if key in result.stdout + result.stderr:
            fail("registration key appeared in installer output")
        fixture_env = fixture / "etc" / "romi" / "agent.env"
        expect_mode(fixture_env, 0o600)
        fixture_values = parse_env_file(fixture_env)
        permanent = fixture_values.get("ROMI_TOKEN", "")
        if not permanent or permanent == key:
            fail("registration exchange did not store a distinct permanent Agent token")
        if key in fixture_env.read_text(encoding="utf-8"):
            fail("short-lived registration key was stored in agent.env")

        log_path = self.work / "registration-agent.log"
        environment = dict(os.environ)
        environment.update({name: value for name, value in fixture_values.items() if name.startswith("ROMI_")})
        # Keep the real exchange on TLS, but let the fixture process connect
        # over loopback HTTP: rustls/webpki deliberately does not trust the
        # rehearsal CA unless it is a public root, and the documented product
        # behavior is not weakened for a local test.
        environment["ROMI_SERVER"] = HUB_BASE
        project_agent = fixture / "opt" / "romi" / "current" / "romi-agent"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [str(project_agent)],
                stdout=log,
                stderr=subprocess.STDOUT,
                env=environment,
            )
        try:
            def predicate():
                for node in self.tls_admin.request("GET", "/api/nodes").json().get("nodes", []):
                    if node["id"] not in before and has_telemetry(node):
                        return node
                return None

            registered = wait_until(predicate, 45.0, "registered node to connect with its exchanged token")
            self.registered_node_id = int(registered["id"])
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log_text = log_path.read_text(encoding="utf-8")
        if key in log_text or permanent in log_text:
            fail("registration key or permanent token leaked into the fixture Agent log")

        closed = self.tls_admin.request("DELETE", "/api/register-window")
        if closed.status != 204:
            fail(f"closing registration window returned {closed.status}")
        anonymous = HTTPSession(f"https://{TEST_HOST}", cafile=self.nginx_ca)
        refused = anonymous.request(
            "POST",
            "/api/agent/register",
            body="rehearsal-after-close",
            headers={"Authorization": f"Bearer {key}"},
        )
        if refused.status != 403:
            fail(f"closed registration window accepted its key (HTTP {refused.status})")
        info("registration window exchanged a real key for a permanent token, connected, and then rejected the closed key")

    def node_metrics(self, node_id: int) -> dict:
        if self.tls_admin is None:
            fail("TLS session was not initialised")
        response = self.tls_admin.request("GET", f"/api/nodes/{node_id}/metrics?hours=1")
        if response.status != 200:
            fail(f"metrics request returned {response.status}")
        return response.json()

    # ---- reinstall, restart, and lock checks --------------------------------

    def idempotent_hub_reinstall(self) -> None:
        if self.hub_installer is None:
            fail("Hub installer path is not set")
        current = Path("/opt/romi/current")
        release = Path("/opt/romi/releases") / self.version
        before_link = os.readlink(current)
        before_hub = sha256_file(release / "romi-hub")
        before_agent = sha256_file(release / "romi-agent")
        db = Path("/var/lib/romi/romi.duckdb")
        before_db = db.stat()
        bootstrap = Path("/var/lib/romi/bootstrap-password")
        run(["sh", str(self.hub_installer), "--site", self.site])
        wait_until(lambda: self.health(self.direct), 45.0, "Hub health after idempotent reinstall")
        if os.readlink(current) != before_link:
            fail("idempotent Hub reinstall changed the current release target")
        if sha256_file(release / "romi-hub") != before_hub or sha256_file(release / "romi-agent") != before_agent:
            fail("idempotent Hub reinstall rewrote immutable release binaries")
        after_db = db.stat()
        if (after_db.st_dev, after_db.st_ino) != (before_db.st_dev, before_db.st_ino):
            fail("idempotent Hub reinstall replaced the database file")
        if bootstrap.exists():
            fail("idempotent Hub reinstall regenerated the one-time bootstrap credential")
        self.wait_for_telemetry(self.permanent_node_id)
        info("idempotent Hub reinstall preserved state, symlink target, binaries, and database")

    def idempotent_agent_reinstall(self) -> None:
        if self.agent_install_script is None:
            fail("Agent installer path is not set")
        current = Path("/opt/romi/current")
        release = Path("/opt/romi/releases") / self.version
        before_link = os.readlink(current)
        before_agent = sha256_file(release / "romi-agent")
        before_env = Path("/etc/romi/agent.env").read_text(encoding="utf-8")
        result = run(
            ["sh", str(self.agent_install_script), "--server", HUB_BASE, "--token-stdin"],
            input_text=self.permanent_token + "\n",
            capture=True,
        )
        if self.permanent_token in result.stdout + result.stderr:
            fail("Agent token appeared in idempotent reinstall output")
        if os.readlink(current) != before_link:
            fail("idempotent Agent reinstall changed the current release target")
        if sha256_file(release / "romi-agent") != before_agent:
            fail("idempotent Agent reinstall rewrote the immutable binary")
        if Path("/etc/romi/agent.env").read_text(encoding="utf-8") != before_env:
            fail("idempotent Agent reinstall changed credentials without intent")
        wait_until(lambda: systemctl_is_active("romi-agent.service"), 15.0, "Agent active after reinstall")
        self.wait_for_telemetry(self.permanent_node_id)
        info("idempotent Agent reinstall reused the release and kept credentials stable")

    def hub_restart_cycle(self) -> None:
        # Live telemetry arrives immediately; history is committed at the next
        # minute boundary. Wait for the persistence precondition, not a fixed sleep.
        before_points = wait_until(
            lambda: {row["ts"] for row in self.node_metrics(self.permanent_node_id).get("metrics", [])
                     if row.get("ts") is not None},
            90.0, "committed minute telemetry before restart", interval=1.0,
        )

        systemctl("restart", "romi-hub.service")
        wait_until(lambda: self.health(self.direct), 45.0, "Hub health after restart")
        self.wait_for_telemetry(self.permanent_node_id)

        systemctl("stop", "romi-hub.service")
        wait_until(lambda: not systemctl_is_active("romi-hub.service"), 15.0, "Hub service stopped")
        stale = run(
            ["pgrep", "-af", "/opt/romi/current/romi-hub"],
            capture=True,
            check=False,
        )
        if stale.returncode == 0:
            fail(f"stale Hub process remains after stop: {stale.stdout.strip()!r}")

        # Start a second Hub as the service user on the same database. A clean
        # stop must have released DuckDB's single-writer lock.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        lock_check = subprocess.Popen(
            [
                "/opt/romi/current/romi-hub",
                "--listen",
                f"127.0.0.1:{port}",
                "--db",
                "/var/lib/romi/romi.duckdb",
                "--db-temp",
                "/var/lib/romi/tmp",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            user=HUB_USER,
            group=HUB_USER,
            cwd="/var/lib/romi",
        )
        try:
            session = HTTPSession(f"http://127.0.0.1:{port}")

            def lock_check_health():
                if lock_check.poll() is not None:
                    output = lock_check.stderr.read() if lock_check.stderr else ""
                    fail(f"second Hub could not open the database after stop (exit {lock_check.returncode}): {output[-300:]}")
                return self.health(session)

            wait_until(lock_check_health, 20.0, "second Hub to open the same database after clean stop")
        finally:
            lock_check.terminate()
            try:
                lock_check.wait(timeout=10)
            except subprocess.TimeoutExpired:
                lock_check.kill()
                lock_check.wait(timeout=5)

        systemctl("start", "romi-hub.service")
        wait_until(lambda: self.health(self.direct), 45.0, "Hub health after stop/start")
        self.wait_for_telemetry(self.permanent_node_id)
        after_metrics = self.node_metrics(self.permanent_node_id)
        after_points = {row.get("ts") for row in after_metrics.get("metrics", []) if row.get("ts") is not None}
        if not before_points.issubset(after_points):
            fail("previously committed telemetry was not readable after a Hub restart")
        info("restart, stop/start, database-lock release, Agent reconnect, and telemetry durability checks passed")

    # ---- security -----------------------------------------------------------

    def systemd_analysis(self) -> None:
        for unit in ("romi-hub.service", "romi-agent.service"):
            unit_path = f"/etc/systemd/system/{unit}"
            verified = systemd_analyze("verify", unit_path)
            output = verified.stdout + verified.stderr
            failures = systemd_verify_failures(unit, output)
            if failures:
                fail(f"systemd-analyze verify failed for {unit}:\n{output}")
            if verified.returncode != 0:
                info(
                    f"systemd-analyze verify exited {verified.returncode} for {unit}; "
                    "the diagnostics name only unrelated host units"
                )
            security = systemd_analyze("security", "--no-pager", unit)
            info(f"---- systemd-analyze security {unit} (exit {security.returncode}) ----")
            print(security.stdout + security.stderr, flush=True)
        info("systemd units verify and their security exposure output was captured for manual review")

    # ---- cleanup ------------------------------------------------------------

    def cleanup_host(self) -> None:
        if os.path.lexists(OWNERSHIP_MARKER):
            cleanup_claimed_host_state()
            self.host_claimed = False
            return
        if self.host_claimed:
            fail("the rehearsal ownership marker disappeared; refusing to remove unclaimed host state")
        info("no rehearsal ownership marker; refusing to remove host state")

    # ---- top-level flow -----------------------------------------------------

    def run_all(self) -> None:
        info(f"preflight: release directory {self.release_dir}")
        self.preflight()
        self.claim_disposable_host()
        self.load_and_verify_release()
        self.install_hub_from_archive()
        self.verify_hub_filesystem()
        self.setup_nginx()
        self.bootstrap_lifecycle()
        self.direct_provisioning_is_refused()
        self.tls_paths()
        self.websocket_probe()
        self.create_permanent_node()
        self.fetch_and_install_agent(self.permanent_token)
        self.verify_agent_filesystem()
        self.wait_for_telemetry(self.permanent_node_id)
        self.registration_flow()
        self.idempotent_hub_reinstall()
        self.idempotent_agent_reinstall()
        self.hub_restart_cycle()
        self.systemd_analysis()
        info("all native systemd, bootstrap, Agent, telemetry, proxy, and reinstall checks passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--release-dir", default="dist/release", type=Path,
        help="verified public-release directory (default: dist/release)",
    )
    parser.add_argument("--site", default=DEFAULT_SITE, help="external HTTPS site URL used by the Hub unit")
    parser.add_argument("--work-dir", type=Path, help="working directory for extracted artifacts and test certs")
    parser.add_argument(
        "--cleanup", action="store_true",
        help="remove the real installation and test TLS infrastructure after the rehearsal",
    )
    parser.add_argument(
        "--cleanup-only", action="store_true",
        help="safely remove only state claimed by an incomplete rehearsal ownership marker",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cleanup_only:
        if os.geteuid() != 0:
            print("FAIL: --cleanup-only must run as root so it can remove claimed systemd state", file=sys.stderr)
            return 1
        try:
            cleanup_claimed_host_state()
        except RehearsalError as error:
            print(f"FAIL: cleanup failed: {error}", file=sys.stderr)
            return 1
        return 0
    if args.work_dir is None:
        work = Path(tempfile.mkdtemp(prefix="romi-systemd-rehearsal-"))
        remove_work = True
    else:
        work = args.work_dir.resolve()
        remove_work = False
    rehearsal = Rehearsal(args.release_dir, args.site.rstrip("/"), work, args.cleanup)
    try:
        rehearsal.run_all()
    except Exception as error:  # noqa: BLE001 - top-level rehearsal reporting
        print(f"FAIL: {error}", file=sys.stderr)
        if args.cleanup:
            try:
                rehearsal.cleanup_host()
            except Exception as cleanup_error:  # noqa: BLE001
                print(f"WARN: attempted cleanup after failure also failed: {cleanup_error}", file=sys.stderr)
        return 1
    if args.cleanup:
        try:
            rehearsal.cleanup_host()
        except Exception as error:  # noqa: BLE001
            print(f"FAIL: cleanup failed: {error}", file=sys.stderr)
            return 1
    print("PASS: real systemd Hub/Agent release rehearsal completed", flush=True)
    if remove_work:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
