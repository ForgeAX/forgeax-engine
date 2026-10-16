#!/usr/bin/env python3
"""Compress idle macOS evidence without changing its path or readable bytes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time


SUFFIXES = {".rhitape", ".bin", ".json", ".jsonl", ".log", ".rgba"}
EXCLUDED = {".git", ".worktrees", "node_modules", ".pnpm-store"}
PROTECTED = {".git", "node_modules", ".pnpm-store"}
UF_COMPRESSED = 0x20


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def holders(path):
    result = subprocess.run(
        ["lsof", "-nP", "-t", "--", str(path)], capture_output=True, text=True
    )
    if result.returncode == 1 and not result.stdout and not result.stderr:
        return []
    if result.returncode == 0 and not result.stderr:
        return result.stdout.splitlines()
    raise RuntimeError(f"cannot establish open-file state: {result.stderr.strip()}")


def candidates(roots):
    seen = set()
    for root in roots:
        if root.is_symlink():
            raise ValueError(f"refusing a symlink root: {root}")
        root = root.resolve(strict=True)
        if PROTECTED.intersection(root.parts):
            raise ValueError(f"refusing a protected storage path: {root}")
        if root.is_file():
            paths = [root]
        else:
            paths = []
            for directory, children, filenames in os.walk(root):
                children[:] = sorted(
                    name for name in children
                    if name not in EXCLUDED and not (Path(directory) / name).is_symlink()
                )
                paths.extend(Path(directory) / name for name in sorted(filenames))
        for path in paths:
            if path not in seen and path.suffix in SUFFIXES:
                seen.add(path)
                yield path


def compress_file(path, *, apply, cutoff, min_bytes):
    original = path.lstat()
    row = {"path": str(path), "bytes": original.st_size,
           "allocatedBefore": original.st_blocks * 512}
    if not stat.S_ISREG(original.st_mode) or path.is_symlink():
        return {**row, "status": "skip-nonregular"}
    if original.st_nlink != 1:
        return {**row, "status": "skip-hardlinked"}
    if original.st_mtime > cutoff:
        return {**row, "status": "skip-recent"}
    if original.st_size < min_bytes or original.st_blocks * 512 < min_bytes:
        return {**row, "status": "skip-small"}
    if original.st_flags & UF_COMPRESSED:
        return {**row, "status": "skip-compressed"}
    if holders(path):
        return {**row, "status": "skip-open"}
    if not apply:
        return {**row, "status": "eligible"}

    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.compress-", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        expected = digest(path)
        subprocess.run(
            ["ditto", "--hfsCompression", "--noclone", str(path), str(temporary)],
            check=True, capture_output=True, text=True,
        )
        compressed = temporary.stat()
        if compressed.st_size != original.st_size or digest(temporary) != expected:
            raise RuntimeError(f"compressed copy failed content verification: {path}")
        allocated_after = compressed.st_blocks * 512
        if not compressed.st_flags & UF_COMPRESSED or allocated_after >= row["allocatedBefore"]:
            return {**row, "status": "skip-no-saving"}
        # A writer or replacement after the initial check invalidates this candidate.
        if identity(path.lstat()) != identity(original) or holders(path):
            return {**row, "status": "skip-changed"}
        os.replace(temporary, path)
        return {**row, "status": "compressed", "allocatedAfter": allocated_after,
                "sha256": expected}
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="exact evidence roots or files")
    parser.add_argument("--apply", action="store_true", help="default is a read-only candidate scan")
    parser.add_argument("--min-age-hours", type=float, default=24)
    parser.add_argument("--min-bytes", type=int, default=1024 * 1024)
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        parser.error("this command requires macOS HFS+/APFS filesystem compression")
    if args.min_age_hours < 0 or args.min_bytes < 1:
        parser.error("age must be non-negative and minimum size must be positive")
    counts = {}
    saved = 0
    errors = 0
    for path in candidates(args.paths):
        try:
            row = compress_file(path, apply=args.apply,
                                cutoff=time.time() - args.min_age_hours * 3600,
                                min_bytes=args.min_bytes)
        except Exception as error:
            row = {"path": str(path), "status": "error", "error": str(error)}
            errors += 1
        counts[row["status"]] = counts.get(row["status"], 0) + 1
        if row["status"] == "compressed":
            saved += row["allocatedBefore"] - row["allocatedAfter"]
        if row["status"] in {"eligible", "compressed", "error"}:
            print(json.dumps(row), flush=True)
    print(json.dumps({"summary": {"apply": args.apply, "counts": counts,
                                  "allocatedBytesReduced": saved}}), flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
