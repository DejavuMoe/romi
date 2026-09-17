#!/usr/bin/env python3
"""Build and verify immutable romi public-release artifacts.

This is deliberately separate from ``scripts/package.py``. That tool produces a
``local-snapshot`` of whatever source tree is present; this tool refuses a dirty
worktree and ties every public artifact to one strict ``vX.Y.Z`` tag and one
full Git commit. A manual ``--candidate`` run has the same artifact shape but a
``release-candidate`` manifest and no tag, which is what the GitHub Actions
dry-run mode builds.

Nothing here signs or publishes. SHA-256 proves integrity only; provenance is
created by the release workflow in a separate least-privilege job.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import NamedTuple, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import version as romi_version  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TARGET = "x86_64-unknown-linux-gnu"
FORMAT = 1
PROJECT = "romi"
PUBLIC_KIND = "public-release"
CANDIDATE_KIND = "release-candidate"
COMPONENTS = ("hub", "agent")
HEX_SHA = re.compile(r"^[0-9a-f]{40}$")
HEX256 = re.compile(r"^[0-9a-f]{64}$")
SUM_LINE = re.compile(r"^([0-9a-f]{64})  ([^\s/]+)$")

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_MEMBERS = 64
README = "README.md"


class ReleaseError(RuntimeError):
    """A release identity, archive, manifest, or checksum invariant failed."""


def checked_version(root: Path, tag: Optional[str] = None):
    try:
        return romi_version.check(root, tag=tag)
    except romi_version.VersionError as error:
        raise ReleaseError(str(error)) from error


class Identity(NamedTuple):
    version: str
    tag: Optional[str]
    commit: str
    kind: str


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value) -> bytes:
    """Deterministic JSON: sorted keys, fixed indentation, trailing newline."""
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def git(root: Path, *arguments: str) -> str:
    command = ["git", "-c", "user.name=romi release test", "-c", "user.email=release@example.invalid", *arguments]
    try:
        return subprocess.check_output(command, cwd=root, text=True, stderr=subprocess.STDOUT).strip()
    except subprocess.CalledProcessError as error:
        output = (error.output or "").strip()
        raise ReleaseError(f"git {' '.join(arguments)} failed: {output}") from error


def resolve_commit(root: Path, value: Optional[str]) -> str:
    if value is None:
        value = "HEAD"
    raw = git(root, "rev-parse", value)
    # A non-hex or abbreviated result is never written into release metadata.
    commit = raw.splitlines()[0].strip()
    if HEX_SHA.fullmatch(commit) is None:
        raise ReleaseError(f"not a full 40-hex Git commit: {commit!r}")
    return commit


def head_commit(root: Path) -> str:
    return resolve_commit(root, "HEAD")


def ensure_clean(root: Path) -> None:
    status = git(root, "status", "--porcelain=v1", "--untracked-files=all")
    if status:
        first = status.splitlines()[0]
        raise ReleaseError(f"release packaging requires a clean worktree; {first}")


def resolve_identity(root: Path, tag: Optional[str], commit_value: Optional[str], candidate: bool) -> Identity:
    """Validate VERSION, the worktree, HEAD, and (for public mode) the exact tag."""
    ensure_clean(root)
    version = checked_version(root)
    commit = resolve_commit(root, commit_value)
    if commit != head_commit(root):
        raise ReleaseError(f"release commit {commit} is not checked-out HEAD {head_commit(root)}")
    if candidate:
        if tag is not None:
            raise ReleaseError("a release candidate must not claim a tag")
        checked_version(root)
        return Identity(version, None, commit, CANDIDATE_KIND)
    if tag is None:
        raise ReleaseError("a public release requires its vX.Y.Z tag")
    checked_version(root, tag=tag)
    expected = romi_version.tag_for(version)
    try:
        tag_commit = git(root, "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}")
    except ReleaseError as error:
        raise ReleaseError(f"release tag {tag} does not exist or cannot be resolved") from error
    if tag_commit != commit:
        raise ReleaseError(f"release tag {tag} points at {tag_commit}, not checked-out {commit}")
    return Identity(version, tag, commit, PUBLIC_KIND)


def rustc_identity(root: Path) -> dict:
    try:
        output = subprocess.check_output(["rustc", "-vV"], cwd=root, text=True, stderr=subprocess.STDOUT)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ReleaseError(f"cannot read rustc identity: {error}") from error
    lines = output.splitlines()
    if not lines:
        raise ReleaseError("rustc produced no identity")
    host = next((line.split(":", 1)[1].strip() for line in lines if line.startswith("host:")), "")
    if not host:
        raise ReleaseError("rustc did not report a host triple")
    return {"rustc": lines[0].strip(), "rustc_host": host}


def duckdb_engine(root: Path) -> str:
    schema = root / "server" / "src" / "db" / "schema.rs"
    try:
        text = schema.read_text(encoding="utf-8")
    except OSError as error:
        raise ReleaseError(f"cannot read {schema}: {error}") from error
    match = re.search(r'pub const ENGINE_VERSION: &str = "([^"]+)";', text)
    if match is None:
        raise ReleaseError("server/src/db/schema.rs does not declare ENGINE_VERSION")
    return match.group(1)


def artifact_filename(component: str, version: str) -> str:
    return f"romi-{component}-v{version}-{TARGET}.tar.gz"


def manifest_filename(kind: str, version: str) -> str:
    if kind == CANDIDATE_KIND:
        return f"romi-release-candidate-v{version}.json"
    if kind == PUBLIC_KIND:
        return f"romi-release-v{version}.json"
    raise ReleaseError(f"unknown release kind: {kind!r}")


def binary_filename(component: str) -> str:
    return f"romi-{component}"


def component_sources(component: str):
    """(archive member, source path, mode) for everything except release.json."""
    common = (
        ("LICENSE", "LICENSE", 0o644),
        ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md", 0o644),
        ("VERSION", "VERSION", 0o644),
        ("upstream.lock.json", "upstream.lock.json", 0o644),
        ("docs/release.md", "docs/release.md", 0o644),
    )
    if component == "hub":
        return (
            (f"bin/{binary_filename('hub')}", None, 0o755),
            (README, "README.md", 0o644),
            *common,
            ("server/LICENSE", "server/LICENSE", 0o644),
            ("admin/LICENSE", "admin/LICENSE", 0o644),
            ("web/LICENSE", "web/LICENSE", 0o644),
            ("docs/storage.md", "docs/storage.md", 0o644),
        )
    if component == "agent":
        return (
            (f"bin/{binary_filename('agent')}", None, 0o755),
            (README, "agent/README.md", 0o644),
            *common,
            ("agent/LICENSE", "agent/LICENSE", 0o644),
        )
    raise ReleaseError(f"unknown component: {component!r}")


def expected_members(component: str) -> set:
    return {member for member, _, _ in component_sources(component)} | {"release.json"}


def component_metadata(identity: Identity, component: str, engine: Optional[str]) -> dict:
    metadata = {
        "format": FORMAT,
        "project": PROJECT,
        "kind": identity.kind,
        "component": component,
        "version": identity.version,
        "tag": identity.tag,
        "commit": identity.commit,
        "target": TARGET,
        "binary": f"bin/{binary_filename(component)}",
    }
    if component == "hub":
        if not engine:
            raise ReleaseError("Hub release metadata requires the DuckDB engine version")
        metadata["duckdb_engine"] = engine
    return metadata


def archive_bytes(payload: dict) -> bytes:
    """A gzip/tar archive with fixed member metadata for deterministic framing."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for name in sorted(payload):
            data, mode = payload[name]
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), compresslevel=9, mtime=0)


def build_component_archive(identity: Identity, component: str, binary_dir: Path, root: Path, engine: str):
    payload = {}
    for member, source, mode in component_sources(component):
        if source is None:
            path = binary_dir / binary_filename(component)
            try:
                payload[member] = (path.read_bytes(), mode)
            except OSError as error:
                raise ReleaseError(f"cannot read release binary {path}: {error}") from error
            if not payload[member][0]:
                raise ReleaseError(f"release binary {path} is empty")
        else:
            path = root / source
            try:
                payload[member] = (path.read_bytes(), mode)
            except OSError as error:
                raise ReleaseError(f"cannot read release payload file {path}: {error}") from error
    payload["release.json"] = (encoded(component_metadata(identity, component, engine)), 0o644)
    filename = artifact_filename(component, identity.version)
    data = archive_bytes(payload)
    return filename, data, sha256(data), len(data)


def build_release(binary_dir: Path, output_dir: Path, identity: Identity, root: Path = ROOT) -> dict:
    """Build both archives, the whole-release manifest, and SHA256SUMS."""
    output_dir.mkdir(parents=True, exist_ok=True)
    checked_version(root, tag=identity.tag)
    rustc = rustc_identity(root)
    if rustc["rustc_host"] != TARGET:
        raise ReleaseError(
            f"release target {TARGET} was requested, but rustc builds for {rustc['rustc_host']}"
        )
    engine = duckdb_engine(root)
    artifacts = {}
    for component in COMPONENTS:
        filename, data, digest, size = build_component_archive(identity, component, binary_dir, root, engine)
        path = output_dir / filename
        path.write_bytes(data)
        artifacts[component] = {
            "component": component,
            "target": TARGET,
            "filename": filename,
            "sha256": digest,
            "size": size,
        }
    manifest = {
        "format": FORMAT,
        "project": PROJECT,
        "kind": identity.kind,
        "version": identity.version,
        "tag": identity.tag,
        "commit": identity.commit,
        "target": TARGET,
        "artifacts": [artifacts[component] for component in COMPONENTS],
        "build": {
            "rustc": rustc["rustc"],
            "rustc_host": rustc["rustc_host"],
            "duckdb_engine": engine,
            "source_commit": identity.commit,
            "source_tag": identity.tag,
        },
        "integrity": {"algorithm": "sha256", "file": "SHA256SUMS"},
        "provenance": (
            None
            if identity.kind == CANDIDATE_KIND
            else {
                "mechanism": "github-attestation",
                "repository": "DejavuMoe/romi",
                "subjects": "all published release files",
            }
        ),
    }
    manifest_name = manifest_filename(identity.kind, identity.version)
    (output_dir / manifest_name).write_bytes(encoded(manifest))
    write_sha256sums(output_dir, [artifacts["hub"]["filename"], artifacts["agent"]["filename"], manifest_name])
    return manifest


def write_sha256sums(directory: Path, names) -> None:
    lines = []
    for name in sorted(names):
        path = directory / name
        if not path.is_file():
            raise ReleaseError(f"cannot checksum missing release file {name}")
        lines.append(f"{sha256(path.read_bytes())}  {name}\n")
    (directory / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")


def safe_member_name(name: str) -> bool:
    if not name or name.startswith("/") or "\\" in name or name.endswith("/") or "//" in name:
        return False
    path = PurePosixPath(name)
    if not path.parts or "." in path.parts or ".." in path.parts:
        return False
    return str(path) == name


def read_archive(path: Path) -> dict:
    """Read a release archive into memory after rejecting every unsafe member."""
    try:
        if path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ReleaseError(f"{path.name}: compressed archive exceeds {MAX_ARCHIVE_BYTES} bytes")
        with tarfile.open(path, mode="r:gz") as archive:
            members = {}
            expanded = 0
            for entry in archive:
                if not entry.isfile():
                    raise ReleaseError(f"{path.name}: archive contains a non-regular member {entry.name!r}")
                if not safe_member_name(entry.name):
                    raise ReleaseError(f"{path.name}: archive member is unsafe or not normalised: {entry.name!r}")
                if entry.name in members:
                    raise ReleaseError(f"{path.name}: duplicate archive member {entry.name!r}")
                if len(members) >= MAX_MEMBERS:
                    raise ReleaseError(f"{path.name}: more than {MAX_MEMBERS} archive members")
                if entry.size > MAX_MEMBER_BYTES:
                    raise ReleaseError(f"{path.name}: member {entry.name!r} exceeds {MAX_MEMBER_BYTES} bytes")
                expanded += entry.size
                if expanded > MAX_EXPANDED_BYTES:
                    raise ReleaseError(f"{path.name}: expanded archive exceeds {MAX_EXPANDED_BYTES} bytes")
                handle = archive.extractfile(entry)
                if handle is None:
                    raise ReleaseError(f"{path.name}: cannot read member {entry.name!r}")
                members[entry.name] = {"data": handle.read(), "mode": entry.mode}
    except (tarfile.TarError, OSError) as error:
        if isinstance(error, ReleaseError):
            raise
        raise ReleaseError(f"{path.name}: cannot read release archive: {error}") from error
    if "release.json" not in members:
        raise ReleaseError(f"{path.name}: release.json is missing")
    return members


def extract_archive(path: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name, member in read_archive(path).items():
        target = destination / PurePosixPath(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(member["data"])
        target.chmod(0o755 if member["mode"] & 0o111 else 0o644)


def validate_component_metadata(meta: dict, identity: Identity, component: str, engine: str) -> None:
    expected = component_metadata(identity, component, engine)
    for key in ("format", "project", "kind", "component", "version", "tag", "commit", "target", "binary"):
        if meta.get(key) != expected[key]:
            raise ReleaseError(
                f"release.json for {component}: {key} is {meta.get(key)!r}, expected {expected[key]!r}"
            )
    if component == "hub":
        if meta.get("duckdb_engine") != engine:
            raise ReleaseError(
                f"release.json for hub: DuckDB engine is {meta.get('duckdb_engine')!r}, expected {engine!r}"
            )


def verify_archive(path: Path, identity: Identity, component: str, engine: str) -> dict:
    members = read_archive(path)
    found = set(members)
    expected = expected_members(component)
    missing = sorted(expected - found)
    extra = sorted(found - expected)
    if missing or extra:
        detail = []
        if missing:
            detail.append(f"missing {missing}")
        if extra:
            if any("romi-bench" in name for name in extra):
                detail.append(f"benchmark-only binary must not be packaged: {extra}")
            else:
                detail.append(f"unexpected {extra}")
        raise ReleaseError(f"{path.name}: member list is wrong; {'; '.join(detail)}")
    try:
        meta = json.loads(members["release.json"]["data"])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"{path.name}: release.json is not valid JSON: {error}") from error
    if not isinstance(meta, dict):
        raise ReleaseError(f"{path.name}: release.json must contain an object")
    validate_component_metadata(meta, identity, component, engine)
    binary = f"bin/{binary_filename(component)}"
    if members[binary]["mode"] & 0o111 == 0:
        raise ReleaseError(f"{path.name}: {binary} is not marked executable")
    if not members[binary]["data"]:
        raise ReleaseError(f"{path.name}: {binary} is empty")
    return meta


def read_sha256sums(path: Path) -> dict:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ReleaseError(f"cannot read {path}: {error}") from error
    if not lines:
        raise ReleaseError("SHA256SUMS is empty")
    sums = {}
    for number, line in enumerate(lines, 1):
        match = SUM_LINE.fullmatch(line)
        if match is None:
            raise ReleaseError(f"SHA256SUMS line {number} is not canonical: {line!r}")
        digest, name = match.groups()
        if name == "SHA256SUMS" or name in sums:
            raise ReleaseError(f"SHA256SUMS line {number}: duplicate or recursive entry {name!r}")
        sums[name] = digest
    if list(sums) != sorted(sums):
        raise ReleaseError("SHA256SUMS entries must be sorted")
    return sums


def find_manifest(directory: Path) -> Path:
    candidates = [path for path in directory.iterdir() if path.is_file() and re.fullmatch(r"romi-release.*\.json", path.name)]
    if len(candidates) != 1:
        raise ReleaseError(f"expected exactly one romi-release*.json manifest, found {len(candidates)}")
    return candidates[0]


def verify_release_dir(
    directory: Path,
    root: Path = ROOT,
    tag: Optional[str] = None,
    commit: Optional[str] = None,
    run_binaries: bool = False,
) -> dict:
    """Verify one release directory end to end from its files alone."""
    directory = Path(directory)
    if not directory.is_dir():
        raise ReleaseError(f"release directory does not exist: {directory}")
    entries = list(directory.iterdir())
    if any(not entry.is_file() for entry in entries):
        raise ReleaseError("release directory may contain files only")
    manifest_path = find_manifest(directory)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read release manifest {manifest_path.name}: {error}") from error
    if not isinstance(manifest, dict):
        raise ReleaseError("release manifest must be a JSON object")

    expected_kind = PUBLIC_KIND if tag is not None else CANDIDATE_KIND
    if manifest.get("format") != FORMAT or manifest.get("project") != PROJECT:
        raise ReleaseError("release manifest format/project is not supported")
    if manifest.get("kind") != expected_kind:
        raise ReleaseError(f"release manifest kind is {manifest.get('kind')!r}, expected {expected_kind!r}")
    version = manifest.get("version")
    try:
        romi_version.parse_semver(version)
    except romi_version.VersionError as error:
        raise ReleaseError(f"release manifest version is invalid: {error}") from error
    if manifest_path.name != manifest_filename(expected_kind, version):
        raise ReleaseError(
            f"release manifest is named {manifest_path.name!r}, expected {manifest_filename(expected_kind, version)!r}"
        )
    manifest_tag = manifest.get("tag")
    if tag is not None:
        if tag != romi_version.tag_for(version):
            raise ReleaseError(f"passed tag {tag!r} does not match manifest version {version!r}")
        if manifest_tag != tag:
            raise ReleaseError(f"release manifest tag is {manifest_tag!r}, expected {tag!r}")
    elif manifest_tag is not None:
        raise ReleaseError(f"release candidate must not claim tag {manifest_tag!r}")

    manifest_commit = manifest.get("commit")
    if not isinstance(manifest_commit, str) or HEX_SHA.fullmatch(manifest_commit) is None:
        raise ReleaseError("release manifest commit must be a full 40-hex Git commit")
    if commit is not None and manifest_commit != commit:
        raise ReleaseError(f"release manifest commit {manifest_commit} does not match {commit}")
    if manifest.get("target") != TARGET:
        raise ReleaseError(f"release manifest target {manifest.get('target')!r} is not {TARGET!r}")

    build = manifest.get("build")
    if not isinstance(build, dict):
        raise ReleaseError("release manifest build identity is missing")
    if not isinstance(build.get("rustc"), str) or not build["rustc"]:
        raise ReleaseError("release manifest must record the rustc version")
    if build.get("rustc_host") != TARGET:
        raise ReleaseError(f"release manifest rustc host {build.get('rustc_host')!r} is not {TARGET!r}")
    engine = duckdb_engine(root)
    if build.get("duckdb_engine") != engine:
        raise ReleaseError(f"release manifest DuckDB engine {build.get('duckdb_engine')!r} is not {engine!r}")
    if build.get("source_commit") != manifest_commit or build.get("source_tag") != manifest_tag:
        raise ReleaseError("release manifest build identity does not match its source commit/tag")
    if manifest.get("integrity") != {"algorithm": "sha256", "file": "SHA256SUMS"}:
        raise ReleaseError("release manifest must point at the canonical SHA256SUMS file")
    provenance = manifest.get("provenance")
    if expected_kind == PUBLIC_KIND:
        if provenance != {
            "mechanism": "github-attestation",
            "repository": "DejavuMoe/romi",
            "subjects": "all published release files",
        }:
            raise ReleaseError("public release manifest must describe the GitHub attestation provenance")
    elif provenance is not None:
        raise ReleaseError("release candidate must not claim publication provenance")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != len(COMPONENTS):
        raise ReleaseError(f"release manifest must contain exactly {len(COMPONENTS)} artifacts")
    by_component = {}
    for artifact in artifacts:
        if not isinstance(artifact, dict) or artifact.get("component") not in COMPONENTS:
            raise ReleaseError(f"release manifest contains an unsupported artifact: {artifact!r}")
        component = artifact["component"]
        if component in by_component:
            raise ReleaseError(f"release manifest repeats component {component!r}")
        expected_name = artifact_filename(component, version)
        if artifact.get("target") != TARGET or artifact.get("filename") != expected_name:
            raise ReleaseError(f"release manifest artifact {component!r} has the wrong target or filename")
        if not isinstance(artifact.get("sha256"), str) or HEX256.fullmatch(artifact["sha256"]) is None:
            raise ReleaseError(f"release manifest artifact {component!r} has an invalid SHA-256")
        if not isinstance(artifact.get("size"), int) or artifact["size"] <= 0:
            raise ReleaseError(f"release manifest artifact {component!r} has an invalid size")
        path = directory / expected_name
        if not path.is_file():
            raise ReleaseError(f"release archive is missing: {expected_name}")
        actual = path.read_bytes()
        if len(actual) != artifact["size"] or sha256(actual) != artifact["sha256"]:
            raise ReleaseError(f"release archive {expected_name} does not match the manifest digest/size")
        by_component[component] = artifact

    expected_files = {
        artifact_filename("hub", version),
        artifact_filename("agent", version),
        manifest_path.name,
        "SHA256SUMS",
    }
    actual_files = {entry.name for entry in entries}
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        raise ReleaseError(f"release directory files wrong; missing {missing}, unexpected {extra}")

    sums = read_sha256sums(directory / "SHA256SUMS")
    if set(sums) != expected_files - {"SHA256SUMS"}:
        missing = sorted((expected_files - {"SHA256SUMS"}) - set(sums))
        extra = sorted(set(sums) - (expected_files - {"SHA256SUMS"}))
        raise ReleaseError(f"SHA256SUMS covers the wrong files; missing {missing}, unexpected {extra}")
    for name, digest in sums.items():
        actual = sha256((directory / name).read_bytes())
        if actual != digest:
            raise ReleaseError(f"SHA-256 mismatch for {name}: {actual} != {digest}")
    for component, artifact in by_component.items():
        if sums[artifact["filename"]] != artifact["sha256"]:
            raise ReleaseError(f"release manifest and SHA256SUMS disagree about {artifact['filename']}")

    for component in COMPONENTS:
        verify_archive(directory / artifact_filename(component, version), Identity(version, manifest_tag, manifest_commit, expected_kind), component, engine)

    if run_binaries:
        with tempfile.TemporaryDirectory(prefix="romi-release-check-") as temporary:
            base = Path(temporary)
            for component in COMPONENTS:
                destination = base / component
                extract_archive(directory / artifact_filename(component, version), destination)
                binary = destination / "bin" / binary_filename(component)
                run_binary_check(binary, component, version)
    return manifest


def run_binary_check(binary: Path, component: str, version: str) -> None:
    expected_version = f"{binary_filename(component)} {version}"
    try:
        # `--version` never opens a database or a network connection.
        result = subprocess.run(
            [str(binary), "--version"], capture_output=True, text=True, timeout=20, check=False
        )
    except OSError as error:
        raise ReleaseError(f"cannot execute {binary.name}: {error}") from error
    if result.returncode != 0:
        raise ReleaseError(f"{binary.name} --version exited {result.returncode}: {result.stderr.strip()}")
    if result.stdout.strip() != expected_version:
        raise ReleaseError(f"{binary.name} --version printed {result.stdout.strip()!r}, expected {expected_version!r}")
    # `--help` is another safe, offline execution check. The Hub exits 0 and the
    # Agent exits 2 (usage is an error by its own contract); both must name the
    # romi component and none of the inherited monitor names.
    help_result = subprocess.run(
        [str(binary), "--help"], capture_output=True, text=True, timeout=20, check=False
    )
    allowed = {0, 2}
    text = help_result.stdout + help_result.stderr
    if help_result.returncode not in allowed or f"romi-{component}" not in text or "monitor" in text.lower():
        raise ReleaseError(f"{binary.name} --help is not the expected romi identity")
    if "monitor" in result.stdout.lower():
        raise ReleaseError(f"{binary.name} --version still exposes the inherited product name")


# ---- tooling self-checks (no network, no GitHub) ----

def make_git_repo(root: Path, commit: bool = True) -> str:
    git(root, "init", "--quiet")
    if commit:
        git(root, "add", "-A")
        git(root, "commit", "--quiet", "-m", "fixture")
    return head_commit(root)


def fixture_version_files(root: Path, version: str = "0.1.0") -> None:
    (root / "VERSION").write_text(f"{version}\n", encoding="utf-8")
    for component, name in (("server", "romi-hub"), ("agent", "romi-agent")):
        package = root / component
        package.mkdir(parents=True, exist_ok=True)
        (package / "Cargo.toml").write_text(
            f'[package]\nname = "{name}"\nversion = "{version}"\n', encoding="utf-8"
        )
        (package / "Cargo.lock").write_text(
            f'version = 3\n\n[[package]]\nname = "{name}"\nversion = "{version}"\n', encoding="utf-8"
        )
    for component in ("admin", "web"):
        package = root / component
        package.mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text(
            json.dumps({"name": f"@romi/{component}", "private": True, "version": "0.0.0"}),
            encoding="utf-8",
        )


def fixture_release_inputs(root: Path) -> Path:
    """Create a minimal but version-consistent source tree plus release binaries."""
    fixture_version_files(root)
    (root / "LICENSE").write_text("MIT fixture\n", encoding="utf-8")
    (root / "THIRD_PARTY_NOTICES.md").write_text("notices fixture\n", encoding="utf-8")
    (root / "upstream.lock.json").write_text("{}\n", encoding="utf-8")
    (root / "README.md").write_text("romi fixture\n", encoding="utf-8")
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "release.md").write_text("release fixture\n", encoding="utf-8")
    (root / "docs" / "storage.md").write_text("storage fixture\n", encoding="utf-8")
    for relative in ("server/LICENSE", "admin/LICENSE", "web/LICENSE", "agent/LICENSE"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("MIT fixture\n", encoding="utf-8")
    (root / "agent" / "README.md").write_text("romi agent fixture\n", encoding="utf-8")
    schema = root / "server" / "src" / "db" / "schema.rs"
    schema.parent.mkdir(parents=True, exist_ok=True)
    schema.write_text('pub const ENGINE_VERSION: &str = "v1.5.5";\n', encoding="utf-8")
    binary_dir = root / "target" / "release"
    binary_dir.mkdir(parents=True)
    for name in ("romi-hub", "romi-agent"):
        binary = binary_dir / name
        binary.write_bytes(b"fixture binary\n")
        binary.chmod(0o755)
    return binary_dir


def make_tar(path: Path, members) -> None:
    with tarfile.open(path, mode="w:gz") as archive:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


def expect_raises(error_type, function, contains: Optional[str] = None) -> None:
    try:
        function()
    except error_type as error:
        if contains is not None and contains not in str(error):
            raise AssertionError(f"expected {contains!r} in {error!r}") from error
        return
    raise AssertionError(f"expected {error_type.__name__}")


def run_self_checks() -> int:
    checks = []

    def check(name, function):
        checks.append(name)
        try:
            function()
        except Exception as error:  # noqa: BLE001 - report the first failing invariant clearly
            raise AssertionError(f"release self-check {name!r} failed: {error}") from error

    def semantic_versions_are_strict():
        assert romi_version.parse_semver("10.20.30") == (10, 20, 30)
        for bad in ("", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-rc1", "v1.2.3", "1.2.x"):
            expect_raises(romi_version.VersionError, lambda value=bad: romi_version.parse_semver(value))

    def dirty_worktree_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "tracked").write_text("one\n", encoding="utf-8")
            make_git_repo(root)
            (root / "tracked").write_text("two\n", encoding="utf-8")
            expect_raises(ReleaseError, lambda: ensure_clean(root), "clean worktree")
            (root / "untracked").write_text("x\n", encoding="utf-8")
            (root / "tracked").write_text("one\n", encoding="utf-8")
            expect_raises(ReleaseError, lambda: ensure_clean(root), "clean worktree")

    def tag_version_mismatch_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_version_files(root)
            make_git_repo(root)
            git(root, "tag", "-m", "fixture", "v0.2.0")
            expect_raises(ReleaseError, lambda: resolve_identity(root, "v0.2.0", None, False), "VERSION")

    def matching_tag_and_commit_are_accepted():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_version_files(root)
            make_git_repo(root)
            git(root, "tag", "-m", "fixture", "v0.1.0")
            identity = resolve_identity(root, "v0.1.0", None, False)
            assert identity == Identity("0.1.0", "v0.1.0", head_commit(root), PUBLIC_KIND)
            candidate = resolve_identity(root, None, None, True)
            assert candidate == Identity("0.1.0", None, head_commit(root), CANDIDATE_KIND)

    def wrong_commit_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_version_files(root)
            make_git_repo(root)
            first = head_commit(root)
            (root / "next").write_text("x\n", encoding="utf-8")
            git(root, "add", "-A")
            git(root, "commit", "--quiet", "-m", "second")
            git(root, "tag", "-m", "fixture", "v0.1.0")
            expect_raises(ReleaseError, lambda: resolve_identity(root, "v0.1.0", first, False), "HEAD")
            # A tag the checked-out commit does not point at must also be refused.
            git(root, "tag", "-m", "fixture", "-f", "v0.1.0", first)
            expect_raises(ReleaseError, lambda: resolve_identity(root, "v0.1.0", None, False), "points at")

    def build_and_verify_fixture():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", "v0.1.0", "a" * 40, PUBLIC_KIND)
            output = root / "release"
            build_release(binary_dir, output, identity, root=root)
            verify_release_dir(output, root=root, tag="v0.1.0", commit="a" * 40, run_binaries=False)

    def missing_artifact_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", None, "b" * 40, CANDIDATE_KIND)
            output = root / "release"
            build_release(binary_dir, output, identity, root=root)
            (output / artifact_filename("agent", "0.1.0")).unlink()
            expect_raises(ReleaseError, lambda: verify_release_dir(output, root=root, commit="b" * 40), "missing")

    def unexpected_artifact_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", None, "c" * 40, CANDIDATE_KIND)
            output = root / "release"
            build_release(binary_dir, output, identity, root=root)
            (output / "surprise.txt").write_text("extra\n", encoding="utf-8")
            expect_raises(ReleaseError, lambda: verify_release_dir(output, root=root), "unexpected")

    def checksum_mismatch_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", None, "d" * 40, CANDIDATE_KIND)
            output = root / "release"
            build_release(binary_dir, output, identity, root=root)
            target = output / artifact_filename("hub", "0.1.0")
            data = bytearray(target.read_bytes())
            data[-1] ^= 0xFF
            target.write_bytes(bytes(data))
            expect_raises(ReleaseError, lambda: verify_release_dir(output, root=root), "does not match")

    def manifest_mismatch_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", None, "e" * 40, CANDIDATE_KIND)
            output = root / "release"
            build_release(binary_dir, output, identity, root=root)
            manifest = find_manifest(output)
            document = json.loads(manifest.read_text(encoding="utf-8"))
            document["artifacts"][0]["filename"] = "romi-hub-wrong.tar.gz"
            manifest.write_bytes(encoded(document))
            expect_raises(ReleaseError, lambda: verify_release_dir(output, root=root), "wrong target or filename")

    def path_traversal_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "evil.tar.gz"
            make_tar(archive, [("../escape", b"x")])
            expect_raises(ReleaseError, lambda: read_archive(archive), "unsafe")

    def duplicate_member_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "duplicate.tar.gz"
            make_tar(archive, [("same", b"a"), ("same", b"b")])
            expect_raises(ReleaseError, lambda: read_archive(archive), "duplicate")

    def wrong_target_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_release_inputs(root)
            engine = duckdb_engine(root)
            meta = component_metadata(Identity("0.1.0", None, "a" * 40, CANDIDATE_KIND), "hub", engine)
            meta["target"] = "aarch64-unknown-linux-gnu"
            expect_raises(
                ReleaseError,
                lambda: validate_component_metadata(meta, Identity("0.1.0", None, "a" * 40, CANDIDATE_KIND), "hub", engine),
                "target",
            )

    def benchmark_binary_is_rejected():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_release_inputs(root)
            engine = duckdb_engine(root)
            members = {name: data for name, data in (("bin/romi-hub", b"x"),)}
            # Build a real valid member set first, then add the excluded binary.
            identity = Identity("0.1.0", None, "a" * 40, CANDIDATE_KIND)
            archive = root / "bench.tar.gz"
            payload = {}
            for member, source, _ in component_sources("hub"):
                payload[member] = (b"binary\n" if source is None else (root / source).read_bytes())
            payload["release.json"] = encoded(component_metadata(identity, "hub", engine))
            payload["bin/romi-bench"] = b"excluded\n"
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
                for name in sorted(payload):
                    info = tarfile.TarInfo(name)
                    info.size = len(payload[name])
                    tar.addfile(info, io.BytesIO(payload[name]))
            archive.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
            expect_raises(ReleaseError, lambda: verify_archive(archive, identity, "hub", engine), "benchmark")

    def same_inputs_serialize_identically():
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary_dir = fixture_release_inputs(root)
            identity = Identity("0.1.0", None, "a" * 40, CANDIDATE_KIND)
            first, second = root / "first", root / "second"
            build_release(binary_dir, first, identity, root=root)
            build_release(binary_dir, second, identity, root=root)
            for name in (artifact_filename("hub", "0.1.0"), manifest_filename(CANDIDATE_KIND, "0.1.0"), "SHA256SUMS"):
                assert (first / name).read_bytes() == (second / name).read_bytes(), name

    for name, function in [
        ("strict semantic versions", semantic_versions_are_strict),
        ("dirty worktree rejected", dirty_worktree_is_rejected),
        ("tag/version mismatch rejected", tag_version_mismatch_is_rejected),
        ("matching tag and commit accepted", matching_tag_and_commit_are_accepted),
        ("wrong commit rejected", wrong_commit_is_rejected),
        ("candidate build and verify", build_and_verify_fixture),
        ("missing artifact rejected", missing_artifact_is_rejected),
        ("unexpected artifact rejected", unexpected_artifact_is_rejected),
        ("checksum mismatch rejected", checksum_mismatch_is_rejected),
        ("manifest mismatch rejected", manifest_mismatch_is_rejected),
        ("path traversal rejected", path_traversal_is_rejected),
        ("duplicate archive member rejected", duplicate_member_is_rejected),
        ("wrong target rejected", wrong_target_is_rejected),
        ("benchmark binary rejected", benchmark_binary_is_rejected),
        ("deterministic serialization", same_inputs_serialize_identically),
    ]:
        check(name, function)
    print(f"PASS: release tooling accepted all {len(checks)} focused checks")
    return len(checks)


# ---- CLI ----

def cmd_package(args) -> int:
    if args.candidate and args.tag is not None:
        raise SystemExit("--candidate and --tag are mutually exclusive")
    if not args.candidate and args.tag is None:
        raise SystemExit("use --candidate for a dry run, or --tag vX.Y.Z for a public release")
    identity = resolve_identity(ROOT, args.tag, args.commit, candidate=args.candidate)
    binary_dir = Path(args.binary_dir)
    if not binary_dir.is_absolute():
        binary_dir = ROOT / binary_dir
    for component in COMPONENTS:
        run_binary_check(binary_dir / binary_filename(component), component, identity.version)
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".romi-release-", dir=output_dir.parent))
    try:
        build_release(binary_dir, temporary, identity, root=ROOT)
        # Every artifact is extracted and executed before it is allowed to leave
        # the temporary directory.
        verify_release_dir(temporary, root=ROOT, tag=identity.tag, commit=identity.commit, run_binaries=True)
        if output_dir.is_dir():
            shutil.rmtree(output_dir)
        elif output_dir.exists():
            output_dir.unlink()
        temporary.replace(output_dir)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    manifest = manifest_filename(identity.kind, identity.version)
    print(f"{identity.kind}: {output_dir / manifest}")
    for component in COMPONENTS:
        print(output_dir / artifact_filename(component, identity.version))
    print(output_dir / "SHA256SUMS")
    return 0


def cmd_verify(args) -> int:
    manifest = verify_release_dir(
        Path(args.directory),
        root=ROOT,
        tag=args.tag,
        commit=args.commit,
        run_binaries=args.run_binaries,
    )
    print(
        f"PASS: verifies {manifest['kind']} romi {manifest['version']} "
        f"({manifest['commit'][:12]}) for {manifest['target']}"
    )
    return 0


def cmd_check(_args) -> int:
    run_self_checks()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    package = sub.add_parser("package", help="build a candidate or public release directory")
    package.add_argument("--candidate", action="store_true", help="non-publishing release-candidate with no tag")
    package.add_argument("--tag", help="existing vX.Y.Z tag for a public release")
    package.add_argument("--commit", help="full Git commit (defaults to HEAD; must equal HEAD)")
    package.add_argument("--binary-dir", default="target/release", help="directory holding romi-hub/romi-agent")
    package.add_argument("--output-dir", default="dist/release", help="directory to replace with release files")
    package.set_defaults(function=cmd_package)

    verify = sub.add_parser("verify", help="verify a release directory")
    verify.add_argument("directory", help="directory containing manifest, archives, and SHA256SUMS")
    verify.add_argument("--tag", help="the expected vX.Y.Z tag; selects public-release verification")
    verify.add_argument("--commit", help="expected full 40-hex commit")
    verify.add_argument("--run-binaries", action="store_true", help="extract and execute --version/--help")
    verify.set_defaults(function=cmd_verify)

    check = sub.add_parser("check", help="run focused offline release-tooling checks")
    check.set_defaults(function=cmd_check)

    args = parser.parse_args(argv)
    try:
        return args.function(args)
    except ReleaseError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
