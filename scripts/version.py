#!/usr/bin/env python3
"""The authoritative romi release version and its cross-file consistency checks.

romi has one version source: the root ``VERSION`` file. A public release is the
exact Git tag ``vX.Y.Z`` for the ``X.Y.Z`` in that file. This script makes the
rule executable for local validation, CI, and the release workflow; it never
reads GitHub's mutable "latest" release and never contacts the network.
"""
import argparse
import json
import re
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
TAG = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
PRIVATE_COMPONENTS = ("admin", "web")


class VersionError(ValueError):
    """A version source or a synchronized file contradicts the release model."""


def parse_semver(text):
    """Return the three numeric components of a strict X.Y.Z string."""
    if not isinstance(text, str) or SEMVER.fullmatch(text) is None:
        raise VersionError(f"not a strict X.Y.Z version: {text!r}")
    return tuple(int(part) for part in text.split("."))


def read_version(root=ROOT):
    path = root / "VERSION"
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise VersionError(f"cannot read {path}: {error}") from error
    parse_semver(text)
    return text


def tag_for(version):
    parse_semver(version)
    return f"v{version}"


def _cargo_package(root, relative):
    path = root / relative
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise VersionError(f"cannot read {path}: {error}") from error
    package = document.get("package")
    if not isinstance(package, dict):
        raise VersionError(f"{relative} has no [package] table")
    return package


def _locked_package(root, relative, name):
    path = root / relative
    try:
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise VersionError(f"cannot read {path}: {error}") from error
    matches = [package for package in document.get("package", []) if package.get("name") == name]
    if len(matches) != 1:
        raise VersionError(f"{relative} must contain exactly one {name!r} package, found {len(matches)}")
    return matches[0]


def fresh_private_package(root, relative):
    path = root / relative
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VersionError(f"cannot read {path}: {error}") from error
    if package.get("private") is not True:
        raise VersionError(f"{relative} must stay private; it is not independently published")
    if package.get("version") != "0.0.0":
        raise VersionError(f"{relative} must carry the private placeholder version 0.0.0")
    return package


def check(root=ROOT, tag=None):
    """Validate VERSION and every release-relevant synchronized file."""
    version = read_version(root)
    errors = []
    for relative, expected_name in (("server/Cargo.toml", "romi-hub"), ("agent/Cargo.toml", "romi-agent")):
        try:
            package = _cargo_package(root, relative)
        except VersionError as error:
            errors.append(str(error))
            continue
        if package.get("name") != expected_name:
            errors.append(f"{relative}: package name must be {expected_name!r}, got {package.get('name')!r}")
        if package.get("version") != version:
            errors.append(f"{relative}: package version must be {version}, got {package.get('version')!r}")

    for relative, expected_name in (("server/Cargo.lock", "romi-hub"), ("agent/Cargo.lock", "romi-agent")):
        try:
            locked = _locked_package(root, relative, expected_name)
        except VersionError as error:
            errors.append(str(error))
            continue
        if locked.get("version") != version:
            errors.append(f"{relative}: locked {expected_name} version must be {version}, got {locked.get('version')!r}")

    for component in PRIVATE_COMPONENTS:
        try:
            fresh_private_package(root, f"{component}/package.json")
        except VersionError as error:
            errors.append(str(error))

    if tag is not None:
        if TAG.fullmatch(tag) is None:
            errors.append(f"release tag must look like vX.Y.Z with no prefix or suffix: {tag!r}")
        elif tag != tag_for(version):
            errors.append(f"tag {tag!r} does not match VERSION {version!r} (expected {tag_for(version)!r})")

    if errors:
        raise VersionError("; ".join(errors))
    return version


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=["check"], default="check")
    parser.add_argument("--tag", help="validate a release tag against VERSION")
    args = parser.parse_args(argv)
    try:
        version = check(tag=args.tag)
    except VersionError as error:
        parser.exit(1, f"FAIL: {error}\n")
    if args.tag is not None:
        print(f"PASS: {args.tag} matches VERSION {version} and all synchronized package versions")
    else:
        print(f"PASS: VERSION {version} matches the romi-hub/romi-agent Cargo packages and private frontends")
    return 0


if __name__ == "__main__":
    sys.exit(main())
