#!/usr/bin/env python3
"""Generate and check THIRD_PARTY_LICENSES.txt, the license texts of everything
the release binaries contain.

The Hub binary statically links its Rust crates and DuckDB with DuckDB's
bundled C/C++ components, and embeds the built admin panel and status page.
The Agent binary links its own Rust crates. MIT, BSD, Apache-2.0 and ISC all
ask that their notices travel with such copies, so every archive and the Agent
image carry this file.

Inputs are the lockfiles resolved in a prepared build environment: crate
sources from the cargo registry (`cargo metadata --locked`), bundled npm
packages from `pnpm licenses list --prod`, and the license files in
`licenses/`, which DuckDB's crate and the copied shadcn/ui components do not
ship themselves. `check` regenerates the file and fails on any difference, so
a dependency change cannot leave it behind.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "THIRD_PARTY_LICENSES.txt"
LICENSES = ROOT / "licenses"
TARGETS = (
    "x86_64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
)
BINARIES = (("server/Cargo.toml", "romi-hub", "Hub"), ("agent/Cargo.toml", "romi-agent", "Agent"))
FRONTENDS = ("admin", "web")
# Built from, not bundled as a package: the generated stylesheet carries
# Tailwind's base layer, and shadcn/ui components were copied into admin/src.
BUILD_INPUTS = ("tailwindcss",)
LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice|copyright)([-._].*)?$", re.IGNORECASE)


def duckdb_engine():
    """The bundled engine version, read where the Hub declares it."""
    schema = (ROOT / "server/src/db/schema.rs").read_text(encoding="utf-8")
    match = re.search(r'pub const ENGINE_VERSION: &str = "(v[0-9.]+)";', schema)
    if match is None:
        raise RuntimeError("server/src/db/schema.rs no longer declares ENGINE_VERSION")
    return match.group(1)


DUCKDB_ENGINE = duckdb_engine()


class LicenseError(RuntimeError):
    pass


def run_json(command, cwd=ROOT):
    try:
        output = subprocess.run(command, cwd=cwd, check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        raise LicenseError(f"{' '.join(command)} failed: {detail.strip()}") from error
    return json.loads(output)


def normalized(text):
    return "\n".join(line.rstrip() for line in text.strip().splitlines())


def license_texts(directory, name):
    """(file name, text) for a package's license files.

    Top-level files first, then those of code a package vendors under
    `lib-vendor/` (victory-vendor carries d3 that way). A package that
    publishes none falls back to the upstream text kept in licenses/packages/.
    """
    found = []
    directory = Path(directory)
    for folder in (directory, *sorted((directory / "lib-vendor").glob("*/"))):
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            if path.is_file() and LICENSE_FILE.match(path.name):
                label = path.relative_to(directory).as_posix()
                found.append((label, normalized(path.read_text(encoding="utf-8", errors="replace"))))
    if not found:
        kept = LICENSES / "packages" / f"{name.replace('/', '__')}.txt"
        if kept.is_file():
            found.append((kept.name, normalized(kept.read_text(encoding="utf-8"))))
    return found


def rust_crates():
    """{(name, version): entry} for crates linked into either binary.

    Follows normal dependencies only: build scripts and dev tools do not end up
    in the binaries. Proc-macro crates are kept, a harmless superset.
    """
    crates = {}
    for manifest, root_name, label in BINARIES:
        for target in TARGETS:
            metadata = run_json(["cargo", "metadata", "--locked", "--format-version", "1",
                                 "--manifest-path", manifest, "--filter-platform", target])
            packages = {package["id"]: package for package in metadata["packages"]}
            nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
            root = next(id_ for id_, package in packages.items() if package["name"] == root_name)
            pending, seen = [root], {root}
            while pending:
                for dep in nodes[pending.pop()]["deps"]:
                    if any(kind["kind"] is None for kind in dep["dep_kinds"]) and dep["pkg"] not in seen:
                        seen.add(dep["pkg"])
                        pending.append(dep["pkg"])
            for id_ in seen - {root}:
                package = packages[id_]
                key = (package["name"], package["version"])
                entry = crates.setdefault(key, {
                    "license": package.get("license") or "see license file",
                    "source": package.get("repository") or f"https://crates.io/crates/{package['name']}",
                    "texts": license_texts(Path(package["manifest_path"]).parent, package["name"]),
                    "used_by": set(),
                })
                entry["used_by"].add(label)
    return crates


def npm_packages():
    """{(name, version): entry} for packages bundled into the two frontends."""
    packages = {}

    def add(item, version, path, label):
        key = (item["name"], version)
        entry = packages.setdefault(key, {
            "license": item.get("license") or "see license file",
            "source": item.get("homepage") or f"https://www.npmjs.com/package/{item['name']}",
            "texts": license_texts(path, item["name"]),
            "used_by": set(),
        })
        entry["used_by"].add(label)

    for frontend in FRONTENDS:
        listing = run_json(["pnpm", "--dir", frontend, "licenses", "list", "--prod", "--json"])
        label = "admin panel" if frontend == "admin" else "status page"
        for items in listing.values():
            for item in items:
                for version, path in zip(item["versions"], item["paths"]):
                    add(item, version, path, label)
    for name in BUILD_INPUTS:
        path = (ROOT / "admin" / "node_modules" / name).resolve()
        manifest = json.loads((path / "package.json").read_text(encoding="utf-8"))
        add({"name": name, "license": manifest.get("license"), "homepage": manifest.get("homepage")},
            manifest["version"], path, "generated stylesheet")
    return packages


def static_components():
    """Components whose license files are kept in licenses/."""
    engine = LICENSES / f"duckdb-{DUCKDB_ENGINE}"
    if not engine.is_dir():
        raise LicenseError(f"{engine} is missing; it must match the bundled DuckDB {DUCKDB_ENGINE}")
    duckdb = {}
    for path in sorted(engine.glob("*.txt")):
        component = path.stem.removesuffix("-NOTICES")
        entry = duckdb.setdefault(component, [])
        entry.append((path.name, normalized(path.read_text(encoding="utf-8"))))
    shadcn = [("shadcn-ui.txt", normalized((LICENSES / "shadcn-ui.txt").read_text(encoding="utf-8")))]
    return duckdb, shadcn


def render():
    crates, packages = rust_crates(), npm_packages()
    duckdb, shadcn = static_components()
    lines = [
        "romi third-party licenses",
        "=========================",
        "",
        "The romi Hub and Agent binaries include the components below. Each keeps its own",
        "license; the texts follow the component lists. romi itself is MIT, see LICENSE.",
        "",
        "Generated by scripts/third_party.py from server/Cargo.lock, agent/Cargo.lock and",
        "pnpm-lock.yaml. Do not edit by hand.",
        "",
    ]
    texts = {}

    def section(title, rows):
        lines.extend([title, "-" * len(title), ""])
        for name, license_, used_by, source, found in rows:
            lines.append(f"{name}  ({license_})  [{used_by}]  {source}")
            if not found:
                raise LicenseError(f"{name}: no license text; add the upstream text to licenses/packages/")
        lines.append("")

    def collect(name, found):
        for _, text in found:
            texts.setdefault(text, []).append(name)

    rows = []
    for (name, version), entry in sorted(crates.items()):
        rows.append((f"{name} {version}", entry["license"], ", ".join(sorted(entry["used_by"])),
                     entry["source"], entry["texts"]))
        collect(f"{name} {version}", entry["texts"])
    section("Rust crates linked into romi-hub and romi-agent", rows)

    rows = []
    for (name, version), entry in sorted(packages.items()):
        rows.append((f"{name} {version}", entry["license"], ", ".join(sorted(entry["used_by"])),
                     entry["source"], entry["texts"]))
        collect(f"{name} {version}", entry["texts"])
    rows.append(("shadcn/ui components", "MIT", "admin panel", "https://github.com/shadcn-ui/ui", shadcn))
    collect("shadcn/ui components", shadcn)
    section("JavaScript embedded in the Hub's admin panel and status page", rows)

    rows = []
    for component, found in sorted(duckdb.items()):
        rows.append((component, "see license text", "Hub", f"https://github.com/duckdb/duckdb/tree/{DUCKDB_ENGINE}/third_party",
                     found))
        collect(f"DuckDB {DUCKDB_ENGINE} third_party/{component}", found)
    section(f"C/C++ components compiled into DuckDB {DUCKDB_ENGINE} (Hub only)", rows)

    lines.extend(["License texts", "=============", ""])
    for text, names in sorted(texts.items(), key=lambda item: (sorted(item[1])[0], item[0])):
        lines.append("-" * 78)
        lines.append("Applies to: " + ", ".join(sorted(set(names))))
        lines.append("-" * 78)
        lines.append("")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=["generate", "check"])
    args = parser.parse_args(argv)
    try:
        text = render()
    except LicenseError as error:
        parser.exit(1, f"FAIL: {error}\n")
    if args.action == "generate":
        OUTPUT.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(text.encode())} bytes)")
        return 0
    current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
    if current != text:
        parser.exit(1, "FAIL: THIRD_PARTY_LICENSES.txt is out of date; run python3 scripts/third_party.py generate\n")
    print("PASS: THIRD_PARTY_LICENSES.txt matches the locked dependencies")
    return 0


if __name__ == "__main__":
    sys.exit(main())
