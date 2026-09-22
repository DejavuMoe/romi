#!/usr/bin/env python3
"""Measure complete CI gates, with explicit diagnostic ablations on fresh runners."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
VARIANTS = ("baseline", "no-clippy", "no-dev-debug")


def gates(variant):
    return [
        ("frontend-build", ["make", "frontend"]),
        ("script-tests", ["make", "check-scripts", "check-release-scripts"]),
        ("frontend-checks", ["make", "check-frontends"]),
        ("rust-format", ["make", "check-format"]),
        ("clippy", None if variant == "no-clippy" else ["make", "check-clippy"]),
        ("rust-tests", ["make", "check-rust-tests"]),
        ("release-package", ["make", "package"]),
    ]


def measured(name, command, env, directory, cwd=ROOT):
    started = time.perf_counter()
    print(f"\nMEASURE {name}: {' '.join(command)}", flush=True)
    with (directory / f"{name}.log").open("w") as log:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        for line in process.stdout:
            log.write(line)
            print(line, end="", flush=True)
        code = process.wait()
    result = {"phase": name, "seconds": round(time.perf_counter() - started, 3), "exit_code": code}
    print(json.dumps(result), flush=True)
    return result


def paired(order, output):
    """Compare the expensive Rust gates on the same VM, with separate cold targets."""
    variants = ["baseline", "no-dev-debug"]
    if order == "nodebug-first":
        variants.reverse()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "kind": "paired-rust-gates", "order": order, "sha": os.environ.get("GITHUB_SHA"),
        "run_id": os.environ.get("GITHUB_RUN_ID"), "runner_image": os.environ.get("ImageVersion"),
        "cpu": next(line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                    if line.startswith("model name")),
        "cpus": os.cpu_count(), "cargo_build_jobs": os.environ.get("CARGO_BUILD_JOBS"),
        "measurements": [],
    }
    code = 0
    try:
        subprocess.run(["make", "frontend"], cwd=ROOT, check=True)
        for slot, variant in zip(("a", "b"), variants):
            target = ROOT / "target/ci-paired" / slot
            if target.exists():
                raise RuntimeError("Paired cold targets must not already exist")
            directory = output / variant
            directory.mkdir()
            env = dict(os.environ)
            env["CARGO_PROFILE_DEV_DEBUG"] = env["CARGO_PROFILE_TEST_DEBUG"] = "0" if variant == "no-dev-debug" else "2"
            result = {"variant": variant, "phases": []}
            report["measurements"].append(result)
            for name, command in gates(variant):
                if name not in ("clippy", "rust-tests"):
                    continue
                command = [command[0], f"CARGO_TARGET_DIR={target}", *command[1:]]
                phase = measured(name, command, env, directory)
                result["phases"].append(phase)
                if phase["exit_code"]:
                    raise RuntimeError(f"{variant}/{name} failed")
            result["seconds"] = round(sum(p["seconds"] for p in result["phases"]), 3)
            result["target_bytes"] = int(subprocess.check_output(["du", "-sb", target], text=True).split()[0])
    except Exception as error:
        report["error"] = str(error)
        print(f"FAIL: {error}", file=sys.stderr)
        code = 1
    finally:
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    return code


def measure(variant, output):
    if any((ROOT / "target" / profile).exists() for profile in ("debug", "release")):
        raise RuntimeError("Cold measurement requires a fresh runner without target/debug or target/release")
    env = dict(os.environ)
    env["CARGO_PROFILE_DEV_DEBUG"] = env["CARGO_PROFILE_TEST_DEBUG"] = "0" if variant == "no-dev-debug" else "2"
    env["CARGO_TARGET_DIR"] = str(ROOT / "target")
    output.mkdir(parents=True, exist_ok=True)
    cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), "unknown")
    report = {
        "variant": variant, "sha": env.get("GITHUB_SHA"), "run_id": env.get("GITHUB_RUN_ID"),
        "runner_image": env.get("ImageVersion"), "os": platform.platform(), "cpu": cpu,
        "cpus": os.cpu_count(), "cargo_build_jobs": env.get("CARGO_BUILD_JOBS"),
        "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
        "dev_debug": env["CARGO_PROFILE_DEV_DEBUG"],
        "locks": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                  for name in ("pnpm-lock.yaml", "server/Cargo.lock", "agent/Cargo.lock")},
        "rounds": [],
    }
    code = 0
    try:
        for cache in ("cold", "warm"):
            directory = output / cache
            directory.mkdir()
            result = {"cache": cache, "phases": []}
            report["rounds"].append(result)

            def run(name, command, cwd=ROOT):
                phase = measured(name, command, env, directory, cwd)
                result["phases"].append(phase)
                if phase["exit_code"]:
                    raise RuntimeError(f"{cache}/{name} failed")

            for name, command in gates(variant):
                if command is None:
                    result["phases"].append({"phase": name, "seconds": 0, "skipped": True})
                else:
                    run(name, command)
            archives = list((ROOT / "dist").glob("romi-*.tar.gz"))
            if len(archives) != 1:
                raise RuntimeError("Expected exactly one snapshot archive")
            archive = archives[0]
            run("checksum", ["sha256sum", "--check", archive.name + ".sha256"], ROOT / "dist")
            with tempfile.TemporaryDirectory(prefix="romi-ci-ablation-") as extracted:
                with tarfile.open(archive) as package:
                    package.extractall(extracted, filter="data")
                binaries = str(Path(extracted) / "bin")
                run("artifact-smoke", [sys.executable, "scripts/smoke.py", "--bin-dir", binaries])
                env["ROMI_E2E_BIN_DIR"] = binaries
                run("artifact-e2e", ["pnpm", "test:e2e"])
                env.pop("ROMI_E2E_BIN_DIR", None)
            result["target_bytes"] = int(subprocess.check_output(["du", "-sb", ROOT / "target"], text=True).split()[0])
            result["gate_seconds"] = round(sum(phase["seconds"] for phase in result["phases"]), 3)
    except Exception as error:
        report["error"] = str(error)
        print(f"FAIL: {error}", file=sys.stderr)
        code = 1
    finally:
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        summary = [f"## CI ablation: {variant}", f"Source: `{report['sha']}`", "",
                   "Warm means reusing this runner's build output; it excludes cross-run cache transfer costs.",
                   "The no-clippy arm is diagnostic only and is not a complete quality gate.", "",
                   "| Cache | Phase | Seconds | Result |", "| --- | --- | ---: | --- |"]
        for result in report["rounds"]:
            for phase in result["phases"]:
                status = "SKIPPED" if phase.get("skipped") else str(phase["exit_code"])
                summary.append(f"| {result['cache']} | {phase['phase']} | {phase['seconds']:.3f} | {status} |")
        if "error" in report:
            summary.append(f"\nFailed: {report['error']}")
        rendered = "\n".join(summary) + "\n"
        (output / "summary.md").write_text(rendered)
        if env.get("GITHUB_STEP_SUMMARY"):
            with open(env["GITHUB_STEP_SUMMARY"], "a") as file:
                file.write(rendered)
    return code


def self_check():
    baseline = dict(gates("baseline"))
    assert baseline == dict(gates("no-dev-debug")), "candidate must preserve every gate"
    ablated = dict(gates("no-clippy"))
    assert [name for name in baseline if baseline[name] != ablated[name]] == ["clippy"]
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        good = measured("success", [sys.executable, "-c", "print('ok')"], dict(os.environ), directory)
        bad = measured("failure", [sys.executable, "-c", "raise SystemExit(7)"], dict(os.environ), directory)
        assert good["exit_code"] == 0 and bad["exit_code"] == 7
        assert good["seconds"] > 0 and (directory / "success.log").read_text().strip() == "ok"
    print("PASS: ablations preserve declared gates and record command failures")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=VARIANTS, default="baseline")
    parser.add_argument("--output", type=Path, default=ROOT / "target/ci-ablation")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--paired", choices=("baseline-first", "nodebug-first"))
    args = parser.parse_args()
    if args.self_check:
        self_check()
    elif args.paired:
        sys.exit(paired(args.paired, args.output))
    else:
        sys.exit(measure(args.variant, args.output))
