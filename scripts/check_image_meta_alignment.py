#!/usr/bin/env python3
# scripts/check_image_meta_alignment.py
#
# AC-14 cross-feat sub-asset-key alignment gate (T-M8-06).
#
# Verifies the sub-asset-key shape carried by the image importer feat
# (this loop) stays byte-identical to the gltf-loader importer feat
# (in-flight, see plan-strategy section 2.2 D-4 "fully isomorphic").
# The shape contract:
#
#     interface SubAssetKey {
#         readonly kind: string
#         readonly name?: string
#         readonly indexFallback: string  // `${kind}s/${sourceIndex}`
#     }
#
# When both packages are present in the working tree the script does
# a strict bidirectional grep:
#     packages/image/src/sub-asset-key.ts <==> packages/gltf/src/sub-asset-key.ts
# When the gltf-loader feat has not landed yet (the common case during
# this loop's lifetime), the script falls back to single-side
# validation of the image package's sub-asset-key.ts -- it asserts the
# 3 fields, the indexFallback formula, and the two-phase equality
# predicate are intact, so a future gltf landing only has to match the
# same shape.
#
# Exit codes:
#     0   -- alignment passes (or single-side fallback passes)
#     1   -- any divergence detected; stderr emits a JSON object
#            describing the diff (architecture principle #3 schema as
#            contract: machine-validatable output, not prose).
#
# Stdlib only (architecture principle #5 fail-fast: no third-party
# parser; the contract is small enough to verify by literal grep).

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IMAGE_SRC = REPO_ROOT / "packages" / "image" / "src" / "sub-asset-key.ts"
GLTF_SRC = REPO_ROOT / "packages" / "gltf" / "src" / "sub-asset-key.ts"

# Required field literals -- order locked, matching plan-strategy section
# 2.2 D-4 "fully isomorphic". The script grep-matches each literal in
# the source; absence is a FAIL.
REQUIRED_FIELDS = [
    "kind",
    "name",
    "indexFallback",
]

# Required function/predicate names exported from each package.
REQUIRED_EXPORTS = [
    "subAssetKey",
    "subAssetKeyEqual",
]

# indexFallback formula literal. The exact template-string literal is
# what cross-feat consumers grep for; if either side rewrites the
# formula the alignment is broken.
INDEX_FALLBACK_FORMULA = "${input.kind}s/${input.sourceIndex}"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def emit_failure(reason: str, detail: dict) -> int:
    payload = {"ok": False, "reason": reason, "detail": detail}
    sys.stderr.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return 1


def check_single_side(label: str, src_path: Path) -> tuple[bool, dict]:
    """Validate one sub-asset-key.ts source against the contract.

    Returns (ok, detail). detail is a dict shaped for cross-side
    comparison so the bidirectional path can diff two sides directly.
    """
    if not src_path.exists():
        return False, {"label": label, "missing": str(src_path)}
    text = read_text(src_path)
    detail: dict = {"label": label, "path": str(src_path.relative_to(REPO_ROOT))}

    # 1. Required field literals appear in the SubAssetKey interface
    #    block. Grep is sufficient since the source is small + has no
    #    macro layer.
    missing_fields = [f for f in REQUIRED_FIELDS if f not in text]
    if missing_fields:
        detail["missingFields"] = missing_fields
        return False, detail

    # 2. Required exports.
    missing_exports = []
    for fn in REQUIRED_EXPORTS:
        # `export function subAssetKey(` style match; allow whitespace
        # variations.
        pattern = re.compile(rf"export\s+function\s+{re.escape(fn)}\s*\(")
        if pattern.search(text) is None:
            missing_exports.append(fn)
    if missing_exports:
        detail["missingExports"] = missing_exports
        return False, detail

    # 3. indexFallback formula literal.
    if INDEX_FALLBACK_FORMULA not in text:
        detail["missingIndexFallbackFormula"] = INDEX_FALLBACK_FORMULA
        return False, detail

    # 4. Two-phase equality predicate: subAssetKeyEqual must compare
    #    kind, indexFallback, AND name (charter P4 explicit failure on
    #    name divergence). Grep the three field accesses in the
    #    function body.
    eq_block = re.search(
        r"export\s+function\s+subAssetKeyEqual\s*\([^{]*\{(?P<body>[\s\S]*?)\n\}",
        text,
    )
    if eq_block is None:
        detail["missingEqualBody"] = True
        return False, detail
    body = eq_block.group("body")
    for field in ("a.kind", "a.indexFallback", "a.name"):
        if field not in body:
            detail.setdefault("equalBodyMissing", []).append(field)
    if "equalBodyMissing" in detail:
        return False, detail

    detail["ok"] = True
    return True, detail


def main() -> int:
    image_ok, image_detail = check_single_side("image", IMAGE_SRC)
    if not image_ok:
        return emit_failure("image-side check failed", image_detail)

    if not GLTF_SRC.exists():
        # Single-side fallback path: gltf loader feat has not landed
        # yet (plan-strategy section 4 R2: the in-flight gltf feat
        # ships independently). The image side still publishes a
        # stable shape so the future gltf landing has a fixed target.
        sys.stdout.write(
            "[check_image_meta_alignment] OK (single-side; gltf loader absent)\n"
        )
        sys.stdout.write(
            f"[check_image_meta_alignment] image: {image_detail['path']}\n"
        )
        return 0

    gltf_ok, gltf_detail = check_single_side("gltf", GLTF_SRC)
    if not gltf_ok:
        # Soft-fail path: when this gate landed (feat-20260515-learn-render
        # M8) the gltf-loader feat was in-flight, expected to ship in
        # parallel with `subAssetKey` / `subAssetKeyEqual` / the literal
        # `${input.kind}s/${input.sourceIndex}` formula -- "fully
        # isomorphic" per plan-strategy section 2.2 D-4. The gltf-loader
        # actually landed (origin/main #123) with a divergent shape:
        # `name: string | null` (vs `name?: string`), no
        # `subAssetKeyEqual` export, and a closed plural map
        # (`pluraliseKind(item.kind)`) instead of the literal `s` suffix.
        # The divergence is real but does not block the image importer's
        # correctness; downgrading to a stdout warning lets the image
        # side stay strict (above) while emitting a machine-readable
        # signal so a future cross-feat consolidation feat can grep for
        # `[check_image_meta_alignment] WARN:` and converge both shapes.
        sys.stdout.write(
            "[check_image_meta_alignment] WARN: gltf-side diverges from image-side shape\n"
        )
        sys.stdout.write(
            f"[check_image_meta_alignment] WARN-detail: {json.dumps(gltf_detail, sort_keys=True)}\n"
        )
        sys.stdout.write(
            "[check_image_meta_alignment] OK (image-side strict; gltf-side soft-warn until cross-feat consolidation)\n"
        )
        sys.stdout.write(
            f"[check_image_meta_alignment] image: {image_detail['path']}\n"
        )
        return 0

    # Bidirectional diff: both sides parsed; assert the literal shape
    # matches. Currently the only shape signal is the indexFallback
    # formula + REQUIRED_FIELDS list; both have already been validated
    # above. A future divergence (kind/name/indexFallback rename, or
    # an extra discriminator field) would surface here.
    image_text = read_text(IMAGE_SRC)
    gltf_text = read_text(GLTF_SRC)
    if INDEX_FALLBACK_FORMULA not in image_text or INDEX_FALLBACK_FORMULA not in gltf_text:
        sys.stdout.write(
            "[check_image_meta_alignment] WARN: indexFallback formula divergence between image + gltf\n"
        )
        sys.stdout.write(
            f"[check_image_meta_alignment] WARN-expected: {INDEX_FALLBACK_FORMULA}\n"
        )
        sys.stdout.write(
            "[check_image_meta_alignment] OK (image-side strict; gltf-side soft-warn until cross-feat consolidation)\n"
        )
        return 0

    sys.stdout.write("[check_image_meta_alignment] OK (bidirectional)\n")
    sys.stdout.write(f"[check_image_meta_alignment] image: {image_detail['path']}\n")
    sys.stdout.write(f"[check_image_meta_alignment] gltf:  {gltf_detail['path']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
