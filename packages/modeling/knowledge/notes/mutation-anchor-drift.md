# Mutation anchor drift (S5 measurement)

> [!IMPORTANT]
> Measured on `feat/fable-failable-checks` at `667d92f0` plus the lane's registry commit. Sources are
> `scripts/mutation/sets/*.json` (402 mutations in 22 sets) checked against the working tree.

## Anchor check

`old` must match its file exactly once. The check counted 13 of 402 mutations outside that rule:

| Set | Mutation | Matches | File |
|:--|:--|--:|:--|
| `e1-corpus-9b.json` | `a9c-crossings-closing-segment-dropped` | 0 | `src/brep/__tests__/e1/check.ts` |
| `e1a1.json` | `e1a1-plane-coincident-dropped` | 0 | `src/brep/intersect-plane.ts` |
| `e1a1.json` | `e1a1-unsupported-silent` | 0 | `src/brep/intersect.ts` |
| `e1a1.json` | `e1a1-options-twice` | 0 | `src/brep/intersect.ts` |
| `e1a2-a.json` | `e1a2-a-receipt-understated` | 0 | `src/brep/intersect.ts` |
| `l1-nurbs-trim.json` | `l1-old-trim-spacing` | 0 | `src/brep/tessellate.ts` |
| `perf-brep-ops.json` | `perf-triangulation-dropped` | 2 | `src/brep/tessellate.ts` |
| `uv2-458-hygiene.json` | `458-isthin-false` | 0 | `src/seams.ts` |
| `uv2-459-edge-kinds.json` | `459-planseams-object` | 0 | `src/seams.ts` |
| `x1a-metric-uv0.json` | `x1a-cyl-scale` | 0 | `src/brep/tessellate.ts` |
| `x1a-metric-uv0.json` | `x1a-sphere-sv` | 0 | `src/brep/tessellate.ts` |
| `x1a-metric-uv0.json` | `x1a-torus-minor` | 0 | `src/brep/tessellate.ts` |
| `x1a-metric-uv0.json` | `x1a-cone-mid` | 0 | `src/brep/tessellate.ts` |

Eight set files are affected, not nine. The `SKIPPED` status in the runner covers these anchors, so
a skipped mutant says nothing about the tests.

## Surviving mutant

`a9-seam-strict-sign` (`scripts/mutation/sets/e1-corpus-a9.json`) survived its run (`e1-corpus-a9`,
2 m 18 s). It replaces `p.s < 0 !== q.s < 0` with `p.s * q.s < 0` in `src/brep/__tests__/e1/check.ts`.
The two forms differ only when one sign is exactly zero, so the current corpus does not exercise a
zero-valued crossing sample. Unverified: whether a corpus case with an exact zero would kill it.

## Next steps

- Re-anchor or retire the 13 entries against current source (owner: the set authors).
- Add a zero-sample crossing case to the e1 corpus before treating `a9-seam-strict-sign` as killed.
