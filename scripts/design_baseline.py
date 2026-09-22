#!/usr/bin/env python3
"""Run existing end-to-end load checks against a verified baseline release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--release-dir", type=Path, required=True)
parser.add_argument("--commit", required=True)
args = parser.parse_args()
out = Path("target/design-ablation")
out.mkdir(parents=True, exist_ok=True)
scratch = (out / "scratch").resolve()
scratch.mkdir(exist_ok=True)
os.environ["TMPDIR"] = str(scratch)
subprocess.run([sys.executable, "scripts/release.py", "verify", str(args.release_dir),
                "--commit", args.commit, "--run-binaries"], check=True)
unpack = out / "baseline-package"
unpack.mkdir(exist_ok=True)
for archive in args.release_dir.glob("*.tar.gz"):
    with tarfile.open(archive) as package:
        package.extractall(unpack, filter="data")
identity = {"release_commit": args.commit, "hub_sha256": hashlib.sha256((unpack / "bin/romi-hub").read_bytes()).hexdigest()}
(out / "baseline-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
for nodes in (100, 500):
    for repeat in range(1, 4):
        subprocess.run([sys.executable, "scripts/bench.py", "--bin-dir", str(unpack / "bin"),
                        "--nodes", str(nodes), "--interval", "1", "--seconds", "30",
                        "--samples", "30", "--readers", "2", "--label", "baseline-duckdb",
                        "--out", str(out / f"baseline-{nodes}-{repeat}.json")], check=True)
