import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location(
    "compress_evidence", Path(__file__).with_name("compress-evidence.py")
)
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


@unittest.skipUnless(sys.platform == "darwin", "macOS filesystem compression")
class EvidenceCompressionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="forgeax-compression-test-")
        self.root = Path(self.directory.name)
        self.path = self.root / "frame.rhitape"
        self.payload = b"RHITAPE" + bytes(2 * 1024 * 1024)
        self.path.write_bytes(self.payload)
        self.old = time.time() - 48 * 3600
        os.utime(self.path, (self.old, self.old))

    def tearDown(self):
        self.directory.cleanup()

    def compress(self, apply=True):
        return maintenance.compress_file(
            self.path, apply=apply, cutoff=time.time() - 24 * 3600, min_bytes=1024
        )

    def test_verified_compression_preserves_contents_mode_mtime_and_path(self):
        before = self.path.stat()
        row = self.compress()
        self.assertEqual(row["status"], "compressed")
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertEqual(self.path.stat().st_mode, before.st_mode)
        self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertLess(self.path.stat().st_blocks, before.st_blocks)
        self.assertEqual(self.compress()["status"], "skip-compressed")
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_dry_run_does_not_replace_or_compress(self):
        before = maintenance.identity(self.path.stat())
        self.assertEqual(self.compress(False)["status"], "eligible")
        self.assertEqual(maintenance.identity(self.path.stat()), before)

    def test_open_file_is_preserved(self):
        with self.path.open("rb"):
            self.assertEqual(self.compress()["status"], "skip-open")

    def test_recent_symlink_and_hardlink_are_preserved(self):
        os.utime(self.path, None)
        self.assertEqual(self.compress()["status"], "skip-recent")
        os.utime(self.path, (self.old, self.old))
        link = self.root / "shared.rhitape"
        link.hardlink_to(self.path)
        self.assertEqual(self.compress()["status"], "skip-hardlinked")
        link.unlink()
        self.path.unlink()
        self.path.symlink_to(self.root / "missing")
        self.assertEqual(self.compress()["status"], "skip-nonregular")

    def test_git_storage_is_rejected_even_as_an_explicit_file(self):
        git = self.root / ".git"
        git.mkdir()
        path = git / "evidence.bin"
        path.write_bytes(self.payload)
        with self.assertRaises(ValueError):
            list(maintenance.candidates([path]))

    def test_source_changed_by_a_writer_is_not_replaced(self):
        original_path = os.environ["PATH"]
        tool = self.root / "ditto"
        tool.write_text('#!/bin/sh\n/usr/bin/ditto "$@" || exit $?\nprintf writer >> "$3"\n')
        tool.chmod(0o755)
        os.environ["PATH"] = f"{self.root}:{original_path}"
        try:
            self.assertEqual(self.compress()["status"], "skip-changed")
        finally:
            os.environ["PATH"] = original_path
        self.assertEqual(self.path.read_bytes(), self.payload + b"writer")
        self.assertFalse(self.path.stat().st_flags & maintenance.UF_COMPRESSED)
        self.assertFalse(list(self.root.glob(".*.compress-*")))

    def test_bad_copy_never_replaces_the_original(self):
        # Exercise a failing executable at the real tool boundary.
        before = maintenance.identity(self.path.stat())
        original_path = os.environ["PATH"]
        tool = self.root / "ditto"
        tool.write_text("#!/bin/sh\nexit 1\n")
        tool.chmod(0o755)
        os.environ["PATH"] = f"{self.root}:{original_path}"
        try:
            with self.assertRaises(subprocess.CalledProcessError):
                self.compress()
        finally:
            os.environ["PATH"] = original_path
        self.assertEqual(maintenance.identity(self.path.stat()), before)
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertFalse(list(self.root.glob(".*.compress-*")))


if __name__ == "__main__":
    unittest.main()
