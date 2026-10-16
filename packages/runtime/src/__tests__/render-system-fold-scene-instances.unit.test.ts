// feat-20260622-chunk-gpu-instancing-sprite-tilemap M4 / w15 — AC-08
// guard: `packages/render/src/scene-instances/` directory file set must
// remain at the feat baseline (no GPU-instancing files added).
//
// Why: requirements §4 AC-08 + research F-7 + plan-strategy §3.1 say the
// `scene-instances/` directory carries **skin joint post-spawn semantics
// only** (`post-spawn-resolve-joints.ts` + barrel `index.ts`). The naming
// collision with the new GPU-instancing fold path (this feat) is the
// SSOT chunk of confusion AGENTS.md warns about: AI users grepping
// `scene-instances` while debugging GPU instancing would land on the
// wrong file. AC-08 closes the collision by **forbidding new files into
// this directory** until the rename tweak (OOS-4) lands separately.
//
// Mechanism: snapshot the baseline file set (3 entries: `index.ts`,
// `post-spawn-resolve-joints.ts`, `__tests__/`) and fail the unit test if
// `fs.readdirSync` reports any extra entry. This guard runs in CI on every
// PR via `pnpm test:unit`; an attempt to land a `fold-bucket-builder.ts`
// or similar GPU-instancing file in this directory trips the guard
// immediately rather than 8 weeks later when an AI user grep-locates it.
//
// Constraints from upstream:
//   - requirements §3 OOS-4: scene-instances/ rename is a separate
//     follow-up tweak, not part of this feat. This test enforces the
//     freeze, not the rename.
//   - research F-7: positive + negative grep proves the directory's two
//     files have zero GPU-instancing call sites; baseline set is stable.
//   - plan-strategy §3.1: targetFiles for this feat do not cross into
//     `packages/render/src/scene-instances/`.
//
// FALSIFY anchor (documented, not in CI): `touch packages/runtime/src/
// scene-instances/fold-bucket-builder.ts` -> this test goes red.

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// runtime/src/__tests__ -> packages/render/src/scene-instances/
const SCENE_INSTANCES_DIR = resolve(HERE, '..', '..', '..', 'render', 'src', 'scene-instances');

const BASELINE_ENTRIES: readonly string[] = ['post-spawn-resolve-joints.ts'];

describe('scene-instances/ directory guard (AC-08)', () => {
  it('contains exactly the baseline file set (no GPU-instancing additions)', () => {
    const actual = readdirSync(SCENE_INSTANCES_DIR).sort();
    const expected = [...BASELINE_ENTRIES].sort();
    expect(actual).toEqual(expected);
  });
});
