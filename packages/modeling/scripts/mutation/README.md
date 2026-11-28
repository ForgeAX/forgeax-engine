# Mutation scripts

A mutation replaces one source text with a plausible defect, runs the owning tests, and expects a failure (KILLED).
A mutation that leaves every test green (SURVIVED) names a gap in the tests, or a dead branch.

```
node scripts/mutation/run.ts scripts/mutation/sets/<set>.json [mutation-id ...] [--out result.json]
```

Run it from `packages/modeling` (Node 24 runs the `.ts` file directly). It goes through `forgeax-heavy --low` when that
launcher exists, runs vitest on the set's `tests`, and restores every touched file, also on SIGINT/SIGTERM. Run one set at a time.

## Set format

```json
{
  "tests": ["src/__tests__/uv-density.unit.test.ts"],
  "mutations": [
    { "id": "455-multiplier", "file": "src/uv.ts", "old": "<exact text, once>", "new": "<defect>", "survives": "optional reason" }
  ]
}
```

- `old` must occur exactly once in `file`. Zero or several matches give SKIPPED: the source moved on, re-derive the mutation
  against the current text (a stale mutation is not evidence).
- `survives` records why a surviving mutation is acceptable (an equivalent mutant, a path owned by another suite). A SURVIVED
  mutation without it, a SKIPPED one or an ERROR makes the script exit 1.
- `tests` lists every suite that owns the mutated paths. A mutation killed only by a suite missing from the list shows as
  SURVIVED here, so add the suite rather than weakening the mutation.

## Sets

| Set | Task | Mutations |
|:--|:--|--:|
| `uv2-455-density` | per-part texel density | 12 |
| `uv2-456-sweep-uv` | metric uv of swept surfaces | 10 |
| `uv2-457-roles` | part roles, sidecar provenance, edge intent on triangles | 36 |
| `uv2-458-hygiene` | island hygiene (dilate, flip, overlap report) | 14 |
| `uv2-459-edge-kinds` | edge-kind table, seams and normal split | 18 |
| `uv2-bk63-analytic` | analytic bake: solve, tolerance, facet-normal reference, verifier, stale-descriptor guard and its stride, others filter | 45 |
| `l1-nurbs-trim` | physical spacing bound for trimmed-face interior samples (`COARSEST` in `tessellate-trimmed.ts`) | 1 |
| `l2-quad` | quad scaled-Jacobian and metric parity | 2 |
| `l3-quad` | quad remesh unresolved report, model and chain proofs, rounding, range bounds | 9 |
| `e1a1`, `e1a2-a` ... `e1a2-d`, `e1-corpus*`, `e3-ssi-corpus`, `c700-plate`, `perf-brep-ops`, `x1a-*` | exact-stage B-rep and corpus sets | 4 to 43 each |

The sets come from the UV2-1 audit (mutants of PR #455-#459). Add a set per audited feature: copy one, list the tests and the
mutations, run it, and commit the set only when every line is KILLED or carries a `survives` reason.

### CI subset

`.github/workflows/modeling-ci.yml` runs only `l1-nurbs-trim`, `l2-quad` and `l3-quad` (12 mutations). Measured on the pub
server through `forgeax-heavy --low`: l1 6 s, l2 12 s, l3 67 s (not a hosted runner). The full set holds 402 mutations, each
running vitest on its owning suites; the other sets are not timed here and are not in CI. Run them locally before a PR that
touches their owners. The exact guard (`scripts/check-exact-guard.ts`) runs in CI on every PR.
