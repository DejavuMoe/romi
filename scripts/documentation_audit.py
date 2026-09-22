#!/usr/bin/env python3
"""Check project documentation links and measure documentation-only ablations."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ENTRY_DOCS = {"README.md", "AGENTS.md", "server/README.md", "agent/README.md", "web/README.md"}
REPORT = "docs/experiments/documentation.md"
SOURCE = ("server/src/", "agent/src/", "admin/src/", "web/src/", "shared/", "styles/")


def paths():
    raw = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT)
    return sorted({p for p in raw.decode().split("\0") if p and (ROOT / p).is_file()})


def is_doc(path):
    return path != REPORT and path.endswith(".md") and (path.startswith("docs/") or path in ENTRY_DOCS)


def measure(names, read):
    texts = [read(p).decode("utf-8-sig").replace("\r\n", "\n") for p in names if is_doc(p)]
    paragraphs = Counter(p.strip() for text in texts for p in text.split("\n\n") if len(p.strip()) > 80)
    return {
        "tracked_files": len(names),
        "docs_files": len(texts),
        "docs_lines": sum(len(text.splitlines()) for text in texts),
        "docs_characters": sum(len(text) for text in texts),
        "duplicate_paragraph_copies": sum(n - 1 for n in paragraphs.values() if n > 1),
        "design_files": sum(p.startswith("designs/") for p in names),
    }


def check():
    documents = [p for p in paths() if is_doc(p) or p in {REPORT, "THIRD_PARTY_NOTICES.md", "designs/romi-next/README.md", "designs/romi-next/revision-v12/README.md"}]
    errors = []
    for name in documents:
        text = re.sub(r"```.*?```", "", (ROOT / name).read_text(encoding="utf-8-sig"), flags=re.S)
        for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", text):
            target = match.group(1).strip().strip("<>")
            if target.startswith("#") or urlsplit(target).scheme:
                continue
            target = unquote(target.split("#", 1)[0])
            if not (ROOT / name).parent.joinpath(target).exists():
                errors.append(f"{name}: missing {target}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"PASS: local links in {len(documents)} project documents")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "measure"])
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "check":
        check()
        return
    names = paths()
    report = {"method": "UTF-8 project Markdown normalized to LF; experiment report excluded; exact paragraphs longer than 80 characters", "current": measure(names, lambda p: (ROOT / p).read_bytes())}
    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8-sig"))
        report["before"] = {k: v for k, v in baseline.items() if k != "source_hashes"}
        hashes = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in names if p.startswith(SOURCE)}
        report["production_source_files"] = len(hashes)
        report["production_source_unchanged"] = hashes == baseline["source_hashes"]
        if not report["production_source_unchanged"]:
            raise SystemExit("Production source differs from the baseline")
        if args.snapshot:
            with zipfile.ZipFile(args.snapshot) as archive:
                retained = [p for p in archive.namelist() if not p.endswith("/") and (ROOT / p).is_file()]
                report["archive_only"] = measure(retained, archive.read)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(encoded.encode("utf8"))
    print(encoded, end="")


if __name__ == "__main__":
    main()
