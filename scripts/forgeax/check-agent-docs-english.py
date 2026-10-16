#!/usr/bin/env python3
"""Select tracked agent guidance for the shared English-only character gate."""
import argparse
import os
import subprocess
import sys
from pathlib import Path

from check_english_only import DEFAULT_CODE_EXTENSIONS, main as check_english

SKILL_TEXT_EXTENSIONS = DEFAULT_CODE_EXTENSIONS | {
    ".md", ".mdx", ".html", ".css", ".json", ".txt", ".sh",
}


def main():
    # This gate reports the rejected characters themselves. Windows console
    # encodings must not turn a valid violation into an encoding failure.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        root = args.root.resolve(strict=True)
        tracked = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z"], stderr=subprocess.PIPE,
        ).decode("utf-8").split("\0")
        paths = [
            name for name in tracked if name and (
                Path(name).name in {"AGENTS.md", "SKILL.md"}
                or (name.startswith("skills/") and Path(name).suffix.lower() in SKILL_TEXT_EXTENSIONS)
            )
        ]
        # The shared scanner skips unreadable inputs. CI must not silently pass
        # when a tracked instruction file is missing or has invalid encoding.
        for name in paths:
            path = root / name
            if not path.resolve(strict=True).is_relative_to(root):
                raise ValueError(f"instruction path leaves repository: {name}")
            path.read_text(encoding="utf-8")
        print(f"English-only agent guidance: {len(paths)} tracked files", flush=True)
        if not paths:
            return 0
        os.chdir(root)
        return check_english(["--", *paths])
    except (OSError, UnicodeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"agent-docs-english: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
