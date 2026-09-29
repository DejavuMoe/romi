#!/usr/bin/env python3
"""Offline release authorization regressions; never publish or mutate Git."""
import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import release_gate as gate


REPO = "DejavuMoe/romi"
SHA = "a" * 40


def evidence():
    responses = {}
    for workflow, event, name in gate.GATES:
        run = dict(id=42, run_number=7, run_attempt=2, head_sha=SHA,
                   head_branch="master", event=event, path=f".github/workflows/{workflow}",
                   head_repository={"full_name": REPO}, status="completed", conclusion="success")
        job = dict(name=name, head_sha=SHA, run_id=42, run_attempt=2,
                   status="completed", conclusion="success")
        responses[workflow] = (run, job)
    return responses


class ReleaseGateTests(unittest.TestCase):
    def test_only_latest_trusted_same_sha_success_qualifies(self):
        run, _ = evidence()["ci.yml"]
        self.assertEqual(gate.latest_run([run], REPO, SHA, "ci.yml", "push"), run)
        for field, value in (
            ("head_sha", "b" * 40), ("head_branch", "topic"), ("event", "pull_request"),
            ("event", "workflow_dispatch"), ("path", ".github/workflows/other.yml"),
            ("head_repository", {"full_name": "someone/fork"}), ("head_repository", None),
            ("status", "queued"), ("conclusion", "failure"), ("conclusion", "cancelled"),
        ):
            with self.subTest(field=field, value=value):
                bad = dict(run, **{field: value})
                with self.assertRaises(ValueError):
                    gate.latest_run([bad], REPO, SHA, "ci.yml", "push")
        for latest in (dict(run, run_number=8, conclusion="failure"),
                       dict(run, run_attempt=3, status="in_progress", conclusion=None)):
            with self.assertRaises(ValueError):
                gate.latest_run([run, latest], REPO, SHA, "ci.yml", "push")

    def test_successful_workflow_cannot_hide_skipped_or_stale_job(self):
        run, job = evidence()["ci.yml"]
        gate.require_job([job], run, job["name"])
        for jobs in ([], [job, job], *[
            [dict(job, **{field: value})] for field, value in (
                ("conclusion", "skipped"), ("conclusion", "failure"), ("status", "in_progress"),
                ("name", "PR gate not run (ablation)"), ("head_sha", "b" * 40),
                ("run_attempt", 1), ("run_id", 99),
            )
        ]):
            with self.subTest(jobs=jobs), self.assertRaises(ValueError):
                gate.require_job(jobs, run, job["name"])

    def test_end_to_end_check_requires_all_three_gates_and_exact_attempt(self):
        records = evidence()
        current = None

        def pages(endpoint, key):
            nonlocal current
            if key == "workflow_runs":
                current = next(workflow for workflow in records if f"/{workflow}/" in endpoint)
                self.assertIn(f"head_sha={SHA}", endpoint)
                return [records[current][0]]
            self.assertIn("/runs/42/attempts/2/jobs?", endpoint)
            return [records[current][1]]

        with patch.object(gate, "api_pages", side_effect=pages):
            summary = gate.check(REPO, SHA)
            self.assertEqual(summary.count("| success |"), len(gate.GATES))
            original = copy.deepcopy(records)
            for workflow in records:
                records[workflow][0]["conclusion"] = "failure"
                with self.assertRaisesRegex(ValueError, workflow):
                    gate.check(REPO, SHA)
                records = copy.deepcopy(original)

    def test_pagination_and_api_failures(self):
        result = subprocess.CompletedProcess([], 0, json.dumps([
            {"workflow_runs": [{"id": 1}]}, {"workflow_runs": [{"id": 2}]},
        ]))
        with patch.object(gate.subprocess, "run", return_value=result) as run:
            self.assertEqual(gate.api_pages("endpoint", "workflow_runs"), [{"id": 1}, {"id": 2}])
            self.assertIn("--paginate", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")
        with patch.object(gate.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "gh")):
            with self.assertRaises(subprocess.CalledProcessError):
                gate.check(REPO, SHA)


if __name__ == "__main__":
    unittest.main()
