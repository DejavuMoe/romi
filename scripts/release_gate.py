#!/usr/bin/env python3
"""Require successful main-branch release evidence for one exact commit (read-only)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


# Only main-branch pushes qualify as CI evidence: manual timing experiments and
# PR merge-ref builds cannot accidentally authorize a release of another tree.
GATES = (
    ("ci.yml", "push", "Test and verify package"),
    ("platforms.yml", "push", "Platform acceptance"),
    ("release.yml", "workflow_dispatch", "Build and verify artifacts"),
    ("release-rehearsal.yml", "workflow_dispatch", "Public shape and real systemd rehearsal"),
)


def api_pages(endpoint: str, key: str) -> list[dict]:
    result = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", endpoint],
        check=True, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    return [item for page in json.loads(result.stdout) for item in page[key]]


def latest_run(runs: list[dict], repo: str, sha: str, workflow: str, event: str) -> dict:
    eligible = [run for run in runs if (
        run.get("head_sha") == sha
        and run.get("head_branch") == "master"
        and run.get("event") == event
        and run.get("path") == f".github/workflows/{workflow}"
        and (run.get("head_repository") or {}).get("full_name", "").lower() == repo.lower()
    )]
    if not eligible:
        raise ValueError(f"{workflow}: missing {event} evidence on master for {sha}")
    # Never fall back to an older success after a failed or pending newer run.
    run = max(eligible, key=lambda item: (item["run_number"], item["run_attempt"]))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError(f"{workflow}: latest run {run['id']} is {run.get('status')}/{run.get('conclusion')}")
    return run


def require_job(jobs: list[dict], run: dict, name: str) -> None:
    matching = [job for job in jobs if job.get("name") == name]
    if len(matching) != 1 or not all(
        job.get("head_sha") == run["head_sha"]
        and job.get("run_id") == run["id"]
        and job.get("run_attempt") == run["run_attempt"]
        and job.get("status") == "completed"
        and job.get("conclusion") == "success"
        for job in matching
    ):
        raise ValueError(f"run {run['id']}: required job {name!r} is missing, skipped or unsuccessful")


def check(repo: str, sha: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("expected an owner/repository name")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("expected a full lowercase 40-character commit SHA")
    rows, errors = [], []
    for workflow, event, job_name in GATES:
        runs = api_pages(
            f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&event={event}&per_page=100",
            "workflow_runs",
        )
        try:
            run = latest_run(runs, repo, sha, workflow, event)
            jobs = api_pages(
                f"repos/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100",
                "jobs",
            )
            require_job(jobs, run, job_name)
            url = f"https://github.com/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']}"
            rows.append(f"| {workflow} | [run {run['id']}, attempt {run['run_attempt']}]({url}) | success |")
        except ValueError as error:
            errors.append(str(error))
    if errors:
        raise ValueError("\n".join(errors))
    return "\n".join([
        "## Release evidence", "", f"Candidate: `{sha}`", "",
        "| Workflow | Exact run | Result |", "| --- | --- | --- |", *rows, "",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), required=not os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA"), required=not os.environ.get("GITHUB_SHA"))
    args = parser.parse_args()
    try:
        summary = check(args.repo, args.sha)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Release evidence gate failed: {error}", file=sys.stderr)
        return 1
    print(summary)
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(path).open("a", encoding="utf-8") as file:
            file.write(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
