# B-E3-spike: measured verdict on the 25-pair SSI corpus

Status: measured and decided.

> [!IMPORTANT]
> **Decision (2026-11-13, coordinator under the owner's delegation of all v2 decisions): E3 continues to V2-M5.**
> Both gate criteria pass on all 25 pairs (recovery 100 %, worst error 2.08e-6 of the diagonal).
> G16 closes inside E3 rather than as a separate P2-D6 item.

Design inputs: `design-B-E3-corpus.md` (corpus, ground truth and recovery definition). Code measured: `src/brep/ssi/` at origin/main `76581473`.

## Gate

From the phase-2 plan, row B-E3-spike. Continue E3 only if, on the 25-pair SSI corpus including the 5 genuinely non-analytic pairs:

| Criterion | Threshold | Source |
|:--|:--|:--|
| Branch recovery | >= 90 % | plan row |
| Positional error | <= 1e-4 of `pair.diagonal` | plan row; threshold chosen by the corpus design, `tolerance = 1e-4 * pair.diagonal` |

## Method

- Reference: dense-sampling ground truth from the corpus (`trace(pair.truth, 192)`), branches shorter than 1 % of the pair diagonal dropped, the same rule that produced `fixtures/ssi-counts.json`.
- Found: `intersectFaces` with default options (`tol` 1e-7). Analytic pairs use the analytic patch of face b with its bounds (as in `ssi-nurbs-analytic.unit.test.ts`). Freeform pairs use NURBS on both faces. The three G16 pairs use the NURBS skin against the analytic plane with bounds (as in the corpus G16 test).
- Recovery: `recovery(reference, found, 1e-4 * diagonal, 0.01 * diagonal)`. A reference branch counts as recovered when every reference point lies within the tolerance of the found polylines.
- Positional error: largest reference-to-found distance over recovered branches, divided by the diagonal. Because recovery is defined at the 1e-4 tolerance, this is at most 1e-4 by construction. The measured value shows the actual margin.
- Pair classes: `analytic` = 17 pairs; `g16` = 3 pairs (NURBS skin against an analytic plane, A11 reduction); `freeform` = 5 pairs (the "5 genuinely non-analytic" of the gate).

## Results

Per class (all 25 pairs measured, none skipped):

| Class | Pairs | Reference branches | Recovered | Ratio | Pairs fully recovered | Worst recovered error / diag |
|:--|--:|--:|--:|--:|--:|--:|
| analytic | 17 | 25 | 25 | 100 % | 17 / 17 | 2.08e-06 |
| g16 | 3 | 3 | 3 | 100 % | 3 / 3 | 6.94e-07 |
| freeform (5 non-analytic) | 5 | 14 | 14 | 100 % | 5 / 5 | 1.97e-06 |
| all 25 | 25 | 42 | 42 | 100 % | 25 / 25 | 2.08e-06 |

Per pair:

| Pair | Class | Ref | Found | Recovered | Max recovered error / diag | Status | Issues |
|---|---|---:|---:|---:|---:|---|---|
| `plane-plane` | analytic | 1 | 1 | 1/1 | 1.11e-16 | ok | - |
| `plane-cylinder-oblique` | analytic | 1 | 1 | 1/1 | 4.81e-07 | ok | - |
| `plane-cylinder-parallel` | analytic | 2 | 2 | 2/2 | 8.40e-17 | ok | - |
| `plane-sphere` | analytic | 1 | 1 | 1/1 | 9.53e-07 | ok | - |
| `plane-cone-across` | analytic | 1 | 1 | 1/1 | 1.94e-07 | ok | - |
| `plane-cone-parallel` | analytic | 1 | 1 | 1/1 | 7.84e-07 | ok | - |
| `plane-torus-equator` | analytic | 2 | 2 | 2/2 | 8.75e-07 | ok | - |
| `plane-torus-axial` | analytic | 2 | 2 | 2/2 | 9.96e-07 | ok | - |
| `plane-torus-parallel` | analytic | 1 | 1 | 1/1 | 1.44e-06 | ok | - |
| `sphere-sphere` | analytic | 1 | 1 | 1/1 | 5.91e-07 | ok | - |
| `sphere-cylinder-through` | analytic | 2 | 2 | 2/2 | 1.04e-06 | ok | - |
| `cylinder-cylinder-through` | analytic | 2 | 2 | 2/2 | 1.40e-06 | ok | - |
| `cylinder-cylinder-skew` | analytic | 2 | 2 | 2/2 | 1.47e-06 | ok | - |
| `cylinder-cylinder-graze` | analytic | 1 | 1 | 1/1 | 1.08e-06 | ok | - |
| `sphere-cone-coaxial` | analytic | 1 | 1 | 1/1 | 5.73e-07 | ok | - |
| `torus-sphere-concentric` | analytic | 2 | 2 | 2/2 | 2.08e-06 | ok | - |
| `torus-cylinder-coaxial` | analytic | 2 | 2 | 2/2 | 1.66e-06 | ok | - |
| `g16-plate-s35` | g16 | 1 | 2 | 1/1 | 6.94e-07 | partial | model-partial/ssi-singular x2 |
| `g16-plate-s60` | g16 | 1 | 3 | 1/1 | 1.27e-07 | partial | model-partial/ssi-singular x2, model-partial/ssi-fit-tolerance x2 |
| `g16-plate-s100` | g16 | 1 | 2 | 1/1 | 2.81e-08 | partial | model-partial/ssi-fit-tolerance |
| `sheet-sheet-bumpy` | freeform | 5 | 5 | 5/5 | 1.96e-06 | ok | - |
| `sheet-sheet-rough` | freeform | 6 | 6 | 6/6 | 1.93e-06 | ok | - |
| `tube-sheet` | freeform | 1 | 1 | 1/1 | 1.93e-06 | ok | - |
| `tube-ramp` | freeform | 1 | 1 | 1/1 | 1.97e-06 | ok | - |
| `ribbon-sheet` | freeform | 1 | 1 | 1/1 | 1.93e-06 | ok | - |

## Pass or fail against the gate

| Criterion | Measured | Result |
|:--|:--|:--|
| Branch recovery >= 90 % (25 pairs, 42 branches) | 100 % (42 / 42); analytic 100 %, g16 100 %, freeform 100 % | Numeric gate: **pass** |
| Positional error <= 1e-4 diagonal (recovered branches) | worst 2.08e-06 (torus-sphere-concentric), i.e. about 48x inside the threshold | Numeric gate: **pass** |
| Corpus G16 acceptance (`ssi-nurbs-analytic` G16 test; the design note says the expectation flips to ok when an exact path takes the case) | all three g16 pairs return `status: partial` with `model-partial` issues | Acceptance flip: **not met** |

The numeric gate passes on every pair. The G16 status is not ok on any of the three G16 pairs. The corpus test pins `partial` as the current behaviour, and the design note names the flip to `ok` as the E3 acceptance for that case. Whether a numerically recovered but `partial` result counts against continuing E3 is a question for the decision owner.

## Not measured, and limits of this measurement

- **Nothing was left unmeasured.** All 25 pairs ran and none returned an error.
- **Found-to-reference distance is not a spurious-curve test.** The script also reports the largest distance from found points to the reference polylines. The reference polylines are chords of a 192-cell grid, so this figure is dominated by reference chord sag and by branch ends (up to 2.5e-03 on analytic pairs, 9.8e-03 on `sheet-sheet-rough`). It is not gated and is not evidence for or against spurious geometry.
- **Fragmentation is not penalized.** Recovery counts reference branches, not found branches. The G16 pairs return 2 or 3 found branches for 1 reference branch. Their extra points lie within 3.8e-07 diagonal of the reference curve, so they are fragments of the same curve, split at `ssi-singular` stops, not new geometry.
- **Partial status is not part of the recovery metric.** The G16 `partial` issues (`ssi-singular`, `ssi-fit-tolerance`) are reported by the marcher, but recovery alone does not count them.
- **Branches below 1 % of the diagonal are excluded** from both reference and recovery (the same rule as the committed counts). Features smaller than one 192-grid cell are missed by the reference itself (design note, Decision 1).
- **Tangent and coincident contacts are not in the corpus.** Those are the `partial` cases of E1/E3 and were not measured here.
- **Corpus size.** 25 pairs, 42 reference branches. The result does not establish a general recovery rate for arbitrary NURBS pairs.
- **Timing** was recorded per pair by the script but is not a gate; it includes the reference trace and is not an E3 performance measurement.

## Environment

- Worktree `docs/e3-spike-verdict` from origin/main `76581473`. `node_modules` is a symlink farm onto the engine checkout's `node_modules`, with `@forgeax/engine-modeling` pointing at this worktree.
- The engine checkout's `packages/image/dist` lacked `png-encoder.mjs`, so `@forgeax/engine-image` was shimmed in the worktree's `node_modules` from a scratch bundle of `packages/image/src` (esbuild, `--packages=external`). Vitest's setup imports `dist/index.mjs`, which needs that subpath. Analytic and freeform results depend only on `src/brep`. The shim does not affect the SSI code path.
- The measurement ran under `forgeax-heavy --low`.

## Commands

```bash
# 1. Existing corpus tests (report pass or fail only, no per-pair numbers)
cd <e3-spike-verdict-worktree>
~/.local/bin/forgeax-heavy --low ./node_modules/.bin/vitest run src/brep/__tests__/ssi \
  --maxWorkers=8 --typecheck.enabled=false --reporter=verbose
# Result: Test Files 6 passed (6); Tests 122 passed (122); exit 0

# 2. Per-pair measurement script (numbers)
./node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/bin/esbuild \
  scripts/ssi-spike/measure.ts --bundle --platform=node --format=esm --packages=external \
  --outfile=dist/ssi-spike/measure.mjs
~/.local/bin/forgeax-heavy --low node dist/ssi-spike/measure.mjs --json <path-to-json>
# Result: 25 rows, summaries as above; exit 0
```

Raw evidence (outside the repository): `_scratch/e3-spike-logs/measure-final.log` and `measure.json`, `existing-ssi.log`.
