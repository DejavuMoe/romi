#!/usr/bin/env python3
"""The release version check refuses a VERSION its readiness record leaves behind."""
import tempfile
import unittest
from pathlib import Path

import version


class ReadinessRecordTest(unittest.TestCase):
    def record(self, text):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (root / "docs").mkdir()
        (root / "docs" / "readiness.md").write_text(text, encoding="utf-8")
        return root

    def test_a_filled_section_for_the_version_passes(self):
        root = self.record("# 验收\n\n## v0.2.0\n\n- make check-linux 通过\n\n## v0.1.0\n\n旧记录\n")
        self.assertIn("make check-linux", version.readiness_section(root, "0.2.0"))
        self.assertNotIn("旧记录", version.readiness_section(root, "0.2.0"))

    def test_a_missing_section_fails(self):
        root = self.record("# 验收\n\n## v0.1.0\n\n旧记录\n")
        with self.assertRaisesRegex(version.VersionError, "no '## v0.2.0' section"):
            version.readiness_section(root, "0.2.0")

    def test_an_empty_section_fails(self):
        root = self.record("# 验收\n\n## v0.2.0\n\n## v0.1.0\n\n旧记录\n")
        with self.assertRaisesRegex(version.VersionError, "is empty"):
            version.readiness_section(root, "0.2.0")

    def test_a_longer_version_is_not_mistaken_for_this_one(self):
        root = self.record("# 验收\n\n## v0.1.01\n\n记录\n")
        with self.assertRaises(version.VersionError):
            version.readiness_section(root, "0.1.0")


if __name__ == "__main__":
    unittest.main()
