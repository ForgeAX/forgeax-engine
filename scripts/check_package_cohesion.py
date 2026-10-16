#!/usr/bin/env python3
"""Small, deterministic package-cohesion gate used by the migration loop.

The gate intentionally reports only facts that are useful at package seams:
source-file count and root-level source sprawl.  It accepts one or more
package paths and returns zero when all configured limits hold.
"""

from __future__ import annotations

import argparse
from pathlib import Path


def package_report(package: Path) -> list[str]:
    source = package / "src"
    if not source.is_dir():
        return []
    # Tests are consumers of a package, not package implementation cohesion.
    files = sorted(
        p
        for p in source.rglob("*")
        if p.suffix in {".ts", ".tsx", ".js", ".mjs"} and "__tests__" not in p.parts
    )
    findings: list[str] = []
    if len(files) > 140:
        findings.append(f"{package}: source file count {len(files)} > 140")
    root_files = [p for p in files if p.parent == source]
    if len(root_files) > 48:
        findings.append(f"{package}: root source sprawl {len(root_files)} > 48")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("packages", nargs="*", type=Path, default=[Path("packages/runtime")])
    args = parser.parse_args()
    findings = [finding for package in args.packages for finding in package_report(package)]
    for finding in findings:
        print(finding)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
