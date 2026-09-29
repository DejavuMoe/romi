#!/usr/bin/env python3
"""Build and exercise Linux artifacts on a matching native CPU, in a pinned image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IMAGES = {
    "x86_64-unknown-linux-gnu": "sha256:af0579d28b9a7ec5251aaafcb0c0a23dcde5c97065112aae0cc3abeda42d5394",
    "aarch64-unknown-linux-gnu": "sha256:3ddf079542eb8513a989f55bc68de3f3dff469bf8916400d955ce3a80a9ff8f0",
    "x86_64-unknown-linux-musl": "sha256:3ffeca71d0e4fc30f5537f76b7243e87ac99726b6d3d66591dfc5e497078b9fc",
    "aarch64-unknown-linux-musl": "sha256:e9c3e7a353207faa103704e704a8f5e11986f9514883cd9507b4dcc8170856be",
}


def run(*command, **kwargs):
    print("+", " ".join(map(str, command)), flush=True)
    return subprocess.run(list(map(str, command)), check=True, cwd=ROOT, **kwargs)


def build(target, inside):
    if platform.machine() != target.split("-")[0]:
        raise SystemExit("platform builds must execute on the matching native CPU")
    out = ROOT / "target/platform" / target
    out.mkdir(parents=True, exist_ok=True)
    if not inside:
        image = "mirror.gcr.io/library/rust@" + IMAGES[target]
        builder = "romi-builder:" + target
        run("docker", "build", "--build-arg", "BUILD_IMAGE=" + image,
            "--build-arg", "LIBC=" + target.split("-")[-1], "-t", builder, ROOT / "deploy/build")
        run("docker", "run", "--rm", "--init", "--cpus=2", "--memory=8g",
            "-v", str(ROOT) + ":/workspace", "-w", "/workspace",
            "-e", "ROMI_SOURCE_SHA=" + os.environ.get("GITHUB_SHA", "working-tree"),
            "-e", "CARGO_HOME=/workspace/target/platform/cargo-home",
            builder, "python3", "scripts/platform_build.py", "--target", target, "--inside")
        return
    os.environ["CARGO_TARGET_DIR"] = str(out / "cargo")
    os.environ["CARGO_BUILD_JOBS"] = "2"
    os.environ["RUSTUP_TOOLCHAIN"] = "1.98.0"
    os.environ["ROMI_RELEASE_TARGET"] = target
    rustc = subprocess.check_output(["rustc", "-vV"], text=True)
    assert f"host: {target}\n" in rustc, rustc
    for component, binary in (("server", "romi-hub"), ("agent", "romi-agent")):
        run("cargo", "build", "--locked", "--release", "--manifest-path", component + "/Cargo.toml", "--bin", binary)
    binaries = out / "bin"
    binaries.mkdir(exist_ok=True)
    hashes = {}
    for name in ("romi-hub", "romi-agent"):
        source = out / "cargo/release" / name
        shutil.copy2(source, binaries / name)
        hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
        run("readelf", "-h", source)
        dynamic = subprocess.run(["ldd", str(source)], capture_output=True, text=True)
        print(dynamic.stdout + dynamic.stderr, flush=True)
        assert "libduckdb" not in dynamic.stdout.lower()
        program_headers = subprocess.check_output(["readelf", "-l", str(source)], text=True)
        if target.endswith("musl") and name == "romi-agent":
            assert "Requesting program interpreter" not in program_headers, "Docker Agent must be static"
        if target.endswith("gnu"):
            import re
            versions = re.findall(r"GLIBC_(\d+)\.(\d+)", subprocess.check_output(["readelf", "--version-info", str(source)], text=True))
            assert versions and max(tuple(map(int, v)) for v in versions) <= (2, 36), "GNU baseline exceeds Debian 12"
    (out / "compiled-source").write_text(os.environ["ROMI_SOURCE_SHA"])
    run("python3", "scripts/smoke.py", "--bin-dir", binaries)
    if target.endswith("musl"):
        run("python3", "scripts/openrc_rehearsal.py", "--bin-dir", binaries, "--target", target)
    metadata = dict(format=1, target=target, version=(ROOT / "VERSION").read_text().strip(),
                    source_commit=os.environ["ROMI_SOURCE_SHA"], rustc=rustc.splitlines()[0],
                    os_release=platform.freedesktop_os_release(),
                    cxx=subprocess.check_output(["c++", "--version"], text=True).splitlines()[0],
                    rustc_host=target, binaries=hashes, image=IMAGES[target],
                    native_machine=platform.machine(), smoke="success",
                    openrc="success" if target.endswith("musl") else "not-applicable")
    (binaries / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=IMAGES, required=True)
    parser.add_argument("--inside", action="store_true")
    args = parser.parse_args()
    build(args.target, args.inside)
