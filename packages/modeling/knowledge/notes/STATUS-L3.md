# STATUS L3 quad-remesh

Design note: `design-L3-quad-remesh.md` (ready; matches the code).

| Step | State |
|:--|:--|
| Design note | done |
| Baseline `tsc -b packages/modeling` on `origin/integration/v2` (b6c89a33) | green, 0 errors |
| Worktree | `_scratch/l3-quad-remesh`, branch `feat/mesh-l3-quad-remesh` |
| Solver `src/quad/` (remesh.ts, features.ts, quality.ts, index.ts) | done |
| Falsifiers and remesh tests (14 tests in `src/quad/__tests__/quad-remesh.unit.test.ts`) | done, 14/14 green |
| Mutation set `scripts/mutation/sets/l3-quad.json` (20 mutations) | done: 19 killed, 1 equivalent survivor (below) |
| Gates | see Gate results |
| Commit and push | pending |
| PR against `integration/v2` | pending |

## Mutation results (final run, `node scripts/mutation/run.ts scripts/mutation/sets/l3-quad.json`)

KILLED (19): l3-protect-skipped, l3-protect-sharp-only, l3-constraint-protect-off, l3-deviation-max-to-first,
l3-unresolved-inverted, l3-model-partial-dropped, l3-tolerance-validate-off, l3-duplicate-id-ignored,
l3-pair-order-reversed, l3-pair-reuse-allowed, l3-provenance-quad-dropped, l3-material-check-off,
l3-corner-layout-off, l3-bend-check-off, l3-planarity-off, l3-straight-corner-off,
l3-scaled-jacobian-min-as-max, l3-non4-valence-off-by-one, l3-provenance-index-shifted.

SURVIVED (1), equivalent: l3-unresolved-report-empty (`unresolvedFeatures: unresolved` replaced by `[]`). On success
`unresolved` is always empty, because any unresolved constraint returns `model-partial` before the report is built.
The field is therefore always empty in the reported success value, and the mutant is behaviourally identical. The
set records this as `survives` with that reason.

Final summary line: `killed 19, survived 1, skipped 0, error 0`. Result file: `/tmp/l3-mut/result-final.json`.

## Gate results

| Gate | Command | Result |
|:--|:--|:--|
| Quad suite plus spread guard | `vitest run src/__tests__/spread-sinks.unit.test.ts src/quad` | 19/19 passed |
| Full modeling suite | `forgeax-heavy --low vitest run --maxWorkers=8` | 3707 passed, 20 skipped, 1 failed before the fix (spread-sinks: `quadIds.push(...row)`); fixed with `pushAll`; the affected files now pass. Full re-run pending (see Remaining) |
| `tsc -b` | scaffold `packages/modeling` | exit 0 |
| Test-config typecheck | `tsc -p tsconfig.test.json --noEmit` | exit 0 |
| biome | `biome check src/quad scripts/mutation/sets/l3-quad.json` in the kernel worktree | exit 0, 6 files, no fixes |
| exact guard | `node scripts/check-exact-guard.ts` | green: closure 194 files, 0 changed |

Biome cannot run from the scaffold package because of the shim/config path in that tree, so it was run in the kernel
worktree, which holds the root `biome.json`.

## Remaining

1. Re-run the full modeling vitest suite on the final code (only the spread fix changed since the failing run).
2. Commit design docs and STATUS in a separate commit in the chosen location (see the repository note below).
3. Commit kernel code in its own commit on `feat/mesh-l3-quad-remesh`.
4. Push, open the PR against `integration/v2` with `gh api`, do not merge.

note and STATUS cannot be committed from it. They must go to a tracked location in the kernel repo, which is the
path the coordinator must confirm.

Environment note: the shared merge-runner `node_modules` links only a subset of `@forgeax/*` packages. The lane
worktree and the scaffold therefore use private `node_modules` directories that link every scaffold package. The
shared tree is not modified.

Scope disclosure: v1 has NO cross field (4-RoSy). Pair scoring uses face geometry only. Integer-grid (MIQ,
QuadriFlow) resampling is not implemented in v1 and is listed as the v2 deliverable.
