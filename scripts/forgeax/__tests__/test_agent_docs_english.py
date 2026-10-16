"""Exercise the CI language gate against real temporary Git worktrees."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(__file__).resolve().parents[1] / "check-agent-docs-english.py"


class AgentDocsEnglishTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def write(self, name, text, tracked=True):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if tracked:
            subprocess.run(["git", "-C", str(self.root), "add", "--", name], check=True)
        return path

    def gate(self, **environment):
        return subprocess.run(
            [sys.executable, str(GATE), "--root", str(self.root)],
            capture_output=True, text=True, encoding="utf-8", check=False,
            env={**os.environ, **environment},
        )

    def test_rejects_nested_entry_docs_and_skill_references(self):
        for name in ["AGENTS.md", "templates/a game/AGENTS.md", "custom/SKILL.md",
                     "skills/sample/references/guide.md", "skills/sample/update.html"]:
            with self.subTest(name=name):
                self.write(name, "# \u4e2d\u6587\n")
                result = self.gate()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(str(Path(name)), result.stdout)
                self.assertIn(":1:3:", result.stdout)
                self.write(name, "# English\n")

    def test_reports_unicode_violations_with_a_windows_console_encoding(self):
        self.write("AGENTS.md", "# \u4e2d\u6587\n")
        result = self.gate(PYTHONIOENCODING="cp1252")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("AGENTS.md:1:3:", result.stdout)
        self.assertIn("\u4e2d", result.stdout)

    def test_preserves_allowed_symbols_and_localized_readmes(self):
        self.write("AGENTS.md", "# English \u03b1 \u2192 \U0001f680\n")
        self.write("skills/sample/SKILL.md", "# English\n")
        self.write("README.zh-CN.md", "\u4e2d\u6587")
        self.write("docs/guide.md", "\u4e2d\u6587")
        self.write("local/AGENTS.md", "\u4e2d\u6587", tracked=False)
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_other_forbidden_scripts(self):
        self.write("skills/sample/agents/openai.yaml", "title: \u0410\u0431\u0432\n")
        self.assertEqual(self.gate().returncode, 1)

    def test_missing_or_unreadable_tracked_doc_fails_closed(self):
        path = self.write("nested/AGENTS.md", "English")
        path.unlink()
        self.assertEqual(self.gate().returncode, 2)
        path.write_bytes(b"\xff")
        self.assertEqual(self.gate().returncode, 2)

    def test_reports_empty_scope_without_scanning_other_files(self):
        self.write("README.md", "\u4e2d\u6587")
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0", result.stdout)


if __name__ == "__main__":
    unittest.main()
