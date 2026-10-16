#!/usr/bin/env python3
# ruff: noqa: E501
"""
check_learn_render_readme.py -- shape-classified grep gate for
`apps/learn-render/N.<topic>/M.<example>/README.md`.

Three shapes (plan-strategy section 2.9 D-3 / requirements AC-05 + AC-22 + AC-23 + AC-24):

1. complete  -- 5 sections 1.3..1.7 (shaders / textures / transformations /
                coordinate-systems / camera). Must satisfy 7 strict MUST greps.
2. placeholder -- 1.1 hello-window. Must satisfy 3 subset greps. Exempt from
                AC-23 (LO fold) + AC-24 (err.code diff line).
3. redirect    -- 1.2 hello-triangle. Same 3 subset greps + redirect target.
                Exempt from AC-23 + AC-24.

Exit non-zero on first violation; print FAIL stderr triple
(reason / rerun / hint) for each problem. Reads files only; no writes.

Usage:
    python scripts/check_learn_render_readme.py [--root <repo-root>]

ASCII-only source: all literal Chinese section-heading markers are encoded as
`\\uXXXX` escapes so this script passes `scripts/forgeax/check_english_only.py`.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT_DEFAULT = Path(__file__).resolve().parent.parent

# Section-heading literals (escape-encoded for ASCII-only source).
# The five H_* constants are the CJK-titled section headings required by
# wiki section 7.4 (rich-markdown template). Encoded via \uXXXX so this
# script itself stays ASCII (passes scripts/forgeax/check_english_only.py).
#
#   H_WHAT  -> "## " + U+8FD9 U+4E2A U+793A U+4F8B U+5C55 U+793A U+4EC0 U+4E48
#              ("## this-example-shows-what")
#   H_FLOW  -> "## " + U+6E32 U+67D3 U+6D41 U+7A0B
#              ("## render-flow")
#   H_USAGE -> "## " + U+5F15 U+64CE U+7528 U+6CD5
#              ("## engine-usage")
#   H_DIFF  -> "## " + U+4E0E + " LO " + U+539F U+7248 U+7684 U+5DEE U+5F02
#              ("## diff-against-LO-original")
#   H_RUN   -> "## " + U+8FD0 U+884C  ("## run")
H_WHAT = "## \u8fd9\u4e2a\u793a\u4f8b\u5c55\u793a\u4ec0\u4e48"
H_FLOW = "## \u6e32\u67d3\u6d41\u7a0b"
H_USAGE = "## \u5f15\u64ce\u7528\u6cd5"
H_DIFF = "## \u4e0e LO \u539f\u7248\u7684\u5dee\u5f02"
H_RUN = "## \u8fd0\u884c"

# Shape classification (plan-strategy section 2.9 D-3 / wiki section 7.1).
PLACEHOLDER = {"1.hello-window"}
REDIRECT = {"2.hello-triangle"}
COMPLETE = {
    "3.shaders",
    "4.textures",
    "5.transformations",
    "6.coordinate-systems",
    "7.camera",
}

# Mapping of example dir name -> expected LO section number (1.1, 1.2, ...).
LO_SECTION = {
    "1.hello-window": "1.1",
    "2.hello-triangle": "1.2",
    "3.shaders": "1.3",
    "4.textures": "1.4",
    "5.transformations": "1.5",
    "6.coordinate-systems": "1.6",
    "7.camera": "1.7",
}


def fail(reason: str, rerun: str, hint: str) -> None:
    print(f"[reason] {reason}", file=sys.stderr)
    print(f"[rerun] {rerun}", file=sys.stderr)
    print(f"[hint] {hint}", file=sys.stderr)
    print("", file=sys.stderr)


def check_complete(path: Path, body: str) -> list[tuple[str, str, str]]:
    """Return list of (reason, rerun, hint) tuples; empty list = pass."""
    violations: list[tuple[str, str, str]] = []
    rerun = f"python scripts/check_learn_render_readme.py  # offending file: {path}"

    # 1. Top header carries `LearnOpenGL` + section-N marker.
    if not re.search(r"^# .+LearnOpenGL", body, re.MULTILINE):
        violations.append((
            f"complete README {path} missing top H1 header with LearnOpenGL marker",
            rerun,
            "section 1: title format `# <Name> (LearnOpenGL section 1.N)` (e.g. `# Shaders (LearnOpenGL section 1.3)`)",
        ))

    # 2. H_WHAT (this-example-shows section heading).
    if H_WHAT not in body:
        violations.append((
            f"complete README {path} missing what-this-example-shows heading",
            rerun,
            f"section 2: required heading literal `{H_WHAT}` (CJK escape encoded)",
        ))

    # 3. H_FLOW + a mermaid fenced block.
    if H_FLOW not in body:
        violations.append((
            f"complete README {path} missing render-flow heading",
            rerun,
            f"section 3: required heading literal `{H_FLOW}`",
        ))
    if not re.search(r"```mermaid\b", body):
        violations.append((
            f"complete README {path} missing ```mermaid``` fenced block",
            rerun,
            "section 3 body: a ```mermaid flowchart``` fenced block is required (rich-markdown skill)",
        ))

    # 4. H_USAGE + a ts fenced block.
    if H_USAGE not in body:
        violations.append((
            f"complete README {path} missing engine-usage heading",
            rerun,
            f"section 4: required heading literal `{H_USAGE}`",
        ))
    if not re.search(r"```ts\b", body):
        violations.append((
            f"complete README {path} missing ```ts``` fenced block",
            rerun,
            "section 4 body: a ```ts``` fenced block excerpt from `src/index.ts` is required",
        ))

    # 5. H_DIFF (diff-against-LO heading) + must contain `err.code`.
    if H_DIFF not in body:
        violations.append((
            f"complete README {path} missing diff-against-LO heading",
            rerun,
            f"section 5: required heading literal `{H_DIFF}`",
        ))
    if "err.code" not in body:
        violations.append((
            f"complete README {path} diff table missing `err.code` mention (AC-24)",
            rerun,
            "section 5 body: structured-error row must reference `err.code` closed-union narrowing (charter P3 explicit failure)",
        ))

    # 6. H_RUN + a bash fenced block.
    if H_RUN not in body:
        violations.append((
            f"complete README {path} missing run heading",
            rerun,
            f"section 6: required heading literal `{H_RUN}`",
        ))
    if not re.search(r"```bash\b", body):
        violations.append((
            f"complete README {path} missing ```bash``` fenced block",
            rerun,
            "section 6 body: a ```bash``` fenced block of `pnpm --filter ... dev / smoke / build` commands is required",
        ))

    # 7. <details> collapsible block + LO C++/GLSL fragment grep.
    if "<details>" not in body or "</details>" not in body:
        violations.append((
            f"complete README {path} missing `<details>...</details>` LO C++/GLSL fold (AC-23)",
            rerun,
            "section 7: required `<details><summary>...</summary> ... </details>` block with LO original code; AC-23 grep gate",
        ))
    elif not re.search(
        r"\b(glActiveTexture|glBindTexture|glBindVertexArray|glClear|glCreateShader|glDrawArrays|glDrawElements|glGenBuffers|glGenTextures|glGetUniformLocation|glLinkProgram|glShaderSource|glTexImage2D|glUniform[1-4][fi]?v?|glUseProgram|glVertexAttribPointer|gl_Position|FragColor|GLuint|glm::|glfw)\b|#version 330",
        body,
    ):
        violations.append((
            f"complete README {path} `<details>` block lacks LO original C++/GLSL fragment markers",
            rerun,
            "section 7 body: at least one LO-style identifier (`glXxx` / `#version 330` / `gl_Position` / `glm::` / `glfw`) must appear inside the fold",
        ))

    return violations


def check_subset(path: Path, body: str, shape: str) -> list[tuple[str, str, str]]:
    """3-section subset check for placeholder + redirect shapes (AC-22)."""
    violations: list[tuple[str, str, str]] = []
    rerun = f"python scripts/check_learn_render_readme.py  # offending file: {path}"

    # 1. Top callout (`> [!NOTE|IMPORTANT|...]`) within first 30 lines.
    head = "\n".join(body.splitlines()[:30])
    if not re.search(r"> \[!(NOTE|IMPORTANT|TIP|CAUTION|WARNING)\]", head):
        violations.append((
            f"{shape} README {path} missing top callout",
            rerun,
            "subset section 1: required GFM-style top alert callout in the first 30 lines",
        ))

    # 2. LearnOpenGL reference.
    if "LearnOpenGL" not in body:
        violations.append((
            f"{shape} README {path} missing `LearnOpenGL` reference",
            rerun,
            "subset section 2: top callout must reference `LearnOpenGL` (link or `LearnOpenGL section 1.N` text)",
        ))

    # 3. Redirect must point at apps/hello/triangle/. Placeholder must point at src/index.ts.
    if shape == "redirect":
        if "apps/hello/triangle" not in body:
            violations.append((
                f"redirect README {path} missing redirect target `apps/hello/triangle`",
                rerun,
                "subset section 3 (redirect): explicit relative-path link to `apps/hello/triangle/...` is required (architecture-principles SSOT)",
            ))
    else:
        if "src/index.ts" not in body:
            violations.append((
                f"placeholder README {path} missing entry-code link `src/index.ts`",
                rerun,
                "subset section 3 (placeholder): a relative link to `src/index.ts` is required so the reader can jump to the minimal entry",
            ))

    return violations


def discover(root: Path) -> list[tuple[Path, str]]:
    """Scan apps/learn-render/N.*/M.*/README.md and bind shape per dir name."""
    base = root / "apps" / "learn-render"
    if not base.exists():
        return []
    found: list[tuple[Path, str]] = []
    for chapter in sorted(base.iterdir()):
        if not chapter.is_dir():
            continue
        for example in sorted(chapter.iterdir()):
            if not example.is_dir():
                continue
            readme = example / "README.md"
            if not readme.exists():
                continue
            name = example.name
            if name in PLACEHOLDER:
                shape = "placeholder"
            elif name in REDIRECT:
                shape = "redirect"
            elif name in COMPLETE:
                shape = "complete"
            else:
                # Default to `complete` for unknown new examples added under
                # later chapters; they are most useful when held to the strict
                # 7-section bar.
                shape = "complete"
            found.append((readme, shape))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=str(ROOT_DEFAULT),
        help="repository root (defaults to the directory containing scripts/)",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    targets = discover(root)
    if not targets:
        print(
            f"[reason] no apps/learn-render/N.*/M.*/README.md files found under {root}",
            file=sys.stderr,
        )
        return 2

    failed = 0
    for path, shape in targets:
        try:
            body = path.read_text(encoding="utf-8")
        except OSError as exc:
            fail(
                f"unable to read {path}: {exc}",
                f"python scripts/check_learn_render_readme.py  # offending file: {path}",
                "ensure the README is committed and readable; OSError above",
            )
            failed += 1
            continue

        if shape == "complete":
            violations = check_complete(path, body)
        else:
            violations = check_subset(path, body, shape)

        if violations:
            failed += 1
            for reason, rerun, hint in violations:
                fail(reason, rerun, hint)
        else:
            section = LO_SECTION.get(path.parent.name, "?")
            print(f"[ok] {path.relative_to(root)} -- shape={shape} LO section={section}")

    if failed:
        print(
            f"[summary] {failed} README file(s) failed shape-classified MUST grep",
            file=sys.stderr,
        )
        return 1

    print(
        f"[summary] {len(targets)} README file(s) passed (5 complete + 1 placeholder + 1 redirect)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
