#!/usr/bin/env python3
"""Build the exact public-release shape without publishing anything.

The real public packager refuses to run without the Git tag it is claiming.
This wrapper is the non-publishing rehearsal path: it first proves that the
corresponding remote tag does not exist, then creates a lightweight LOCAL-ONLY
tag in the ephemeral checkout, invokes ``scripts/release.py package --tag``
unchanged, and removes that local tag in a ``finally`` block.

No command in this file pushes a branch or a tag, uploads an artifact, creates
a Release, or mints provenance. The remote check is fail-closed: a network
failure or an existing remote tag stops the rehearsal before a local tag is
created.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import version as romi_version  # noqa: E402


class RehearsalError(RuntimeError):
    """The local rehearsal could not prove the public-release preconditions."""


def git(root: Path, *arguments: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise RehearsalError(f"cannot run git: {error}") from error


def require_git(root: Path, *arguments: str) -> str:
    result = git(root, *arguments)
    if result.returncode != 0:
        raise RehearsalError(
            f"git {' '.join(shlex.quote(arg) for arg in arguments)} failed: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def remote_tag_exists(remote: str, tag: str, root: Path) -> bool:
    """Return whether ``remote`` really has ``refs/tags/<tag>``.

    ``git ls-remote --exit-code`` returns 0 when the pattern matched, 2 when it
    did not match, and any other status for a transport/auth/URL failure. Only
    the first two statuses are trustworthy answers.
    """
    result = git(root, "ls-remote", "--exit-code", "--tags", remote, f"refs/tags/{tag}")
    if result.returncode == 0:
        if not result.stdout.strip():
            raise RehearsalError(f"git ls-remote reported success for {tag} without returning a ref")
        return True
    if result.returncode == 2:
        return False
    raise RehearsalError(
        f"cannot prove remote tag {tag} is absent from {remote!r}: "
        f"{(result.stderr or result.stdout).strip() or 'git ls-remote failed'}"
    )


def create_local_tag(tag: str, commit: str, root: Path) -> None:
    existing = git(root, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}")
    if existing.returncode == 0:
        raise RehearsalError(
            f"local tag {tag} already exists at {existing.stdout.strip()}; "
            "refusing to move or recreate it"
        )
    result = git(root, "tag", "--no-sign", tag, commit)
    if result.returncode != 0:
        raise RehearsalError(f"cannot create local rehearsal tag {tag}: {(result.stderr or result.stdout).strip()}")


def delete_local_tag(tag: str, root: Path) -> None:
    result = git(root, "tag", "--delete", tag)
    if result.returncode != 0:
        raise RehearsalError(
            f"could not delete local rehearsal tag {tag}: {result.stderr.strip() or result.stdout.strip()}; "
            "remove it manually and do not push it"
        )
    still_there = git(root, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}")
    if still_there.returncode == 0:
        raise RehearsalError(f"local rehearsal tag {tag} is still present after deletion; do not push it")


def package(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not (root / "VERSION").is_file():
        raise RehearsalError(f"{root} does not look like the romi repository root")

    version = romi_version.read_version(root)
    tag = romi_version.tag_for(version)
    commit = require_git(root, "rev-parse", "HEAD")
    # release.py owns full 40-hex commit validation and performs it before
    # writing any release metadata.

    if remote_tag_exists(args.remote, tag, root):
        raise RehearsalError(
            f"remote tag {tag} already exists on {args.remote!r}; "
            "the release state has changed, so this rehearsal refuses to continue"
        )
    create_local_tag(tag, commit, root)
    try:
        command = [
            sys.executable,
            str(root / "scripts" / "release.py"),
            "package",
            "--tag",
            tag,
            "--commit",
            commit,
            "--binary-dir",
            str(Path(args.binary_dir)),
            "--output-dir",
            str(Path(args.output_dir)),
        ]
        result = subprocess.run(command, cwd=root, check=False)
        if result.returncode != 0:
            raise RehearsalError(
                f"public-release packager failed for local rehearsal tag {tag} (exit {result.returncode})"
            )
    finally:
        delete_local_tag(tag, root)

    print(
        f"PASS: built and verified the public-release shape for {tag} at {commit[:12]} "
        "using a local-only tag; the tag was deleted and was never pushed"
    )
    return 0


def run_self_checks() -> int:
    """Prove the fail-closed remote check and local-tag cleanup logic offline."""
    import os
    import shutil
    import tempfile

    def fake_git(directory: Path, status: int, stdout: str = "", stderr: str = "") -> None:
        script = directory / "git"
        script.write_text(
            "#!/bin/sh\n"
            "case \"$*\" in\n"
            f"  *ls-remote*) printf '%s' {shlex.quote(stdout)}; printf '%s' {shlex.quote(stderr)} >&2; exit {status};;\n"
            "  *) exit 125;;\n"
            "esac\n",
            encoding="utf-8",
        )
        script.chmod(0o755)

    def with_fake_git(status: int, stdout: str = "", stderr: str = ""):
        directory = Path(tempfile.mkdtemp(prefix="romi-rehearse-git-"))
        fake_git(directory, status, stdout, stderr)
        original = os.environ.get("PATH", "")
        os.environ["PATH"] = f"{directory}{os.pathsep}{original}"
        return directory, original

    for status, stdout, stderr, expected in (
        (2, "", "", False),
        (0, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.1.0\n", "", True),
    ):
        directory, original = with_fake_git(status, stdout, stderr)
        try:
            actual = remote_tag_exists("origin", "v0.1.0", ROOT)
            assert actual is expected, (status, stdout, actual)
        finally:
            os.environ["PATH"] = original
            shutil.rmtree(directory, ignore_errors=True)

    directory, original = with_fake_git(128, "", "network failure\n")
    try:
        try:
            remote_tag_exists("origin", "v0.1.0", ROOT)
        except RehearsalError as error:
            assert "network failure" in str(error)
        else:
            raise AssertionError("transport failure was treated as an absent tag")
    finally:
        os.environ["PATH"] = original
        shutil.rmtree(directory, ignore_errors=True)

    with tempfile.TemporaryDirectory(prefix="romi-rehearse-tag-") as temporary:
        root = Path(temporary)
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / "file").write_text("x\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "file"], check=True)
        subprocess.run(
            [
                "git", "-C", str(root),
                "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
                "commit", "--quiet", "-m", "fixture",
            ],
            check=True,
        )
        commit = require_git(root, "rev-parse", "HEAD")
        create_local_tag("v0.1.0", commit, root)
        try:
            create_local_tag("v0.1.0", commit, root)
        except RehearsalError as error:
            assert "refusing to move" in str(error)
        else:
            raise AssertionError("reusing an existing local tag was accepted")
        delete_local_tag("v0.1.0", root)
        assert git(root, "rev-parse", "--verify", "--quiet", "refs/tags/v0.1.0").returncode != 0

    print("PASS: release rehearsal tag checks are fail-closed and never push")
    return 0


def cmd_check(_args) -> int:
    return run_self_checks()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    package_parser = sub.add_parser("package", help="build/verify exact public-release artifacts using a local-only tag")
    package_parser.add_argument("--root", default=str(ROOT), help="repository root (default: this checkout)")
    package_parser.add_argument("--remote", default="origin", help="Git remote whose tag namespace is checked")
    package_parser.add_argument("--binary-dir", default="target/release", help="directory holding romi-hub/romi-agent")
    package_parser.add_argument("--output-dir", default="dist/release", help="directory to replace with release files")
    package_parser.set_defaults(function=package)

    check_parser = sub.add_parser("check", help="run offline self-checks for the rehearsal wrapper")
    check_parser.set_defaults(function=cmd_check)

    args = parser.parse_args(argv)
    try:
        return args.function(args)
    except RehearsalError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
