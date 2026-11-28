# QF2 continue-across: diagnosis (open, moved to v2.x)

## Status

`continue-across` constraints are derived but have no generator consumer. Row closed as diagnosis only; the fix is out of scope for the v2 convergence lane and moves to v2.x.

## Facts

- The constraint is derived in `src/brep/feature-constraints.ts` (`deriveFeatureConstraints`, origin `g1-chain`, `hard: false`).
- `quadrangulate` in `src/brep/quad.ts` never reads it. `src/quad/constrained-field.ts` consumes only `align-tangent` and hard `trim-loop`.

## Baseline (filletBox size [4, 3, 2], radius 0.5, `trimmed: 'quad-dominant'`)

| size | G1 fraction | regular / continued | minimum scaled Jacobian | maxPerpDeg |
|---|---|---|---|---|
| 0.5 | 0.8333 | 96 / 80 | 0.9892 | 15.7 |
| 0.25 | 0.9259 | 216 / 200 | 0.9831 | 12.95 |

## Where the failures are

- All 16 failing seam vertices at size 0.5 are cylinder-sphere seams.
- The deviation (about 15.7 degrees) sits on the sphere side. The plane side is clean (0 degrees).
- Sphere faces are laid by `gridPatch` (`src/brep/quad.ts`, around line 677) from the shared count solve.
- Consequence: a consumer has to change the sphere `gridPatch` layout or its edge counts. A plane-side `pairCost` in `trimmedPlane` does not reach these vertices.
- Starting point: vertex 142 at (-1.5, 1.354, 0.854), seam pair (6, 22).

## Not found

- The cause of the 15.7 degree deviation on the sphere grid. Not isolated.
- Whether a count-only change on the sphere side closes the gap without breaking the size 0.25 case.
- Any fix. No code consumes `continue-across` yet.

## Gates

- `src/brep/__tests__/quad-qf2-continue-across.unit.test.ts`: floor at 0.83 (measured 0.8333) and `it.fails` for 1.0.
