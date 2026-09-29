#!/usr/bin/env python3
"""Push a release's verified Agent image archives as one multi-architecture image.

The publish job runs this after `release_matrix.py verify` has checked every
archive against SHA256SUMS and its rehearsal receipt. It only loads, retags and
pushes those exact archives: nothing is rebuilt and no romi binary is executed.
Each architecture is pushed under `<version>-<arch>`, then one index is created
for `<version>` (and `latest`), and its digest is written for attestation.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import version as versions  # noqa: E402

# Release archive architecture -> OCI platform architecture.
ARCHES = {"x86_64": "amd64", "aarch64": "arm64"}


class PublishError(RuntimeError):
    pass


def run(*command, capture=False):
    result = subprocess.run(command, check=False, text=True, capture_output=capture)
    if result.returncode != 0:
        detail = (result.stderr or "").strip() if capture else ""
        raise PublishError(f"{' '.join(command)} failed ({result.returncode}) {detail}".strip())
    return result.stdout if capture else ""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def default_registry():
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "DejavuMoe")
    return f"ghcr.io/{owner.lower()}/romi-agent"


def load_arch(directory, version, arch, platform, registry):
    archive = directory / f"romi-agent-v{version}-docker-{arch}.tar.gz"
    receipt = json.loads((directory / f"container-{arch}.json").read_text(encoding="utf-8"))
    local = f"romi-agent:{version}"
    if receipt.get("archive") != archive.name or receipt.get("image") != local:
        raise PublishError(f"container-{arch}.json does not describe {archive.name} as {local}")
    if receipt.get("sha256") != sha256(archive):
        raise PublishError(f"{archive.name} does not match its rehearsal receipt")
    run("docker", "load", "--input", str(archive))
    found = run("docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", local, capture=True).strip()
    if found != f"linux/{platform}":
        raise PublishError(f"{archive.name} holds a {found} image, expected linux/{platform}")
    target = f"{registry}:{version}-{platform}"
    run("docker", "tag", local, target)
    # Both archives load under the same local name; drop it before the next one.
    run("docker", "image", "rm", local)
    run("docker", "push", target)
    return target


def publish(directory, registry, latest):
    version = versions.read_version(ROOT)
    sources = [load_arch(directory, version, arch, platform, registry) for arch, platform in ARCHES.items()]
    tags = [f"{registry}:{version}"] + ([f"{registry}:latest"] if latest else [])
    run("docker", "buildx", "imagetools", "create", *[arg for tag in tags for arg in ("--tag", tag)], *sources)
    index = json.loads(run("docker", "buildx", "imagetools", "inspect", "--raw", tags[0], capture=True))
    platforms = sorted(f"{m['platform']['os']}/{m['platform']['architecture']}" for m in index.get("manifests", []))
    if platforms != sorted(f"linux/{platform}" for platform in ARCHES.values()):
        raise PublishError(f"{tags[0]} lists {platforms}, expected one image per architecture")
    descriptor = json.loads(run("docker", "buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}",
                                tags[0], capture=True))
    return registry, descriptor["digest"], tags


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--directory", type=Path, default=ROOT / "dist" / "release")
    parser.add_argument("--registry", default=default_registry(), help="image name without tag")
    parser.add_argument("--latest", action="store_true", help="also move the latest tag to this release")
    parser.add_argument("--output", type=Path, default=os.environ.get("GITHUB_OUTPUT"),
                        help="append name= and digest= for the attestation step")
    args = parser.parse_args(argv)
    try:
        name, digest, tags = publish(args.directory, args.registry, args.latest)
    except (PublishError, OSError, ValueError, KeyError) as error:
        parser.exit(1, f"FAIL: {error}\n")
    if args.output:
        with open(args.output, "a", encoding="utf-8") as output:
            output.write(f"name={name}\ndigest={digest}\n")
    print(f"PASS: pushed {', '.join(tags)} at {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
