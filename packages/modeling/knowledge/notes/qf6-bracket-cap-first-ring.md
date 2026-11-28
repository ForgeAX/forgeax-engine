# QF6 bracket cap first ring: structural gap (row stopped)

## Status

Row stopped as structural. The 14 missing first-ring quads on the bracket caps are not a local bug. `it.fails('covers every first-ring boundary edge with a quad (target 1.0)')` in `src/brep/__tests__/quad-qf6-bracket.unit.test.ts` (Q-B branch `v2-qb/qf6-thin-g1`) stays expected-fail.

## Measurements

Fixture: `examples/qf-m6-bracket/fixture.ts` (`bracketFixture`, Q-B branch). Call `quadrangulate(bracketFixture(), { size, trimmed, isoQuadric: true })`.

| trimmed | size | result | first ring (with quad / total) | triangles | minSJ |
|---|---|---|---|---|---|
| `quad-dominant` | 0.5 | ok | 234 / 248 | 8 (4 per cap, faces 0 and 1) | 0.7071 |
| `blossom` | 0.5 and 0.25 | `model-partial`, face 0, `no-perfect-matching` | n/a | n/a | n/a |
| `blossom-penalty` | 0.5 | ok, 1 folded and 1 unresolved pair per cap | 240 / 240 | 0 | 0 |
| `blossom-penalty` | 0.25 | `model-partial`, face 0, `no-perfect-matching` | n/a | n/a | n/a |

## Cause

- Each cap is a trimmed plane whose outline has coarse ring samples at the rounded corners (short edges of 0.3 and 0.48 at size 0.5).
- The dual of the cap triangulation has no perfect matching under admissible pairs: strict `blossom` fails with `no-perfect-matching` on face 0 at both sizes.
- Under `quad-dominant`, maximum matching leaves 4 single triangles per cap. Each single's interior neighbour is a quad in the output, so the partner was taken by another pair. That is 14 ring edges without a quad, the gap in the test.
- Making coverage complete (`blossom-penalty`) produces an unresolved fold per cap and minSJ 0. That violates the minSJ >= 0.3 guard, so it is not an acceptable fix.

## Minimal reproduction

```
quadrangulate(bracketFixture(), { size: 0.5, trimmed: 'quad-dominant', isoQuadric: true })
// report: triangles 8, first ring 234 / 248 (ring edges shared with the cap side)
quadrangulate(bracketFixture(), { size: 0.5, trimmed: 'blossom', isoQuadric: true })
// model-partial, detail.reason 'no-perfect-matching', face 0
```

## Owner and direction

The gap is the cap triangulation (`triangulateTrimmed`, rounded-corner sampling) combined with the matching in `src/brep/quad-trimmed.ts` (Q-A owner). A real fix needs a different interior point set or triangulation near the rounded corners, not a matching tweak. Not attempted here.

## Not verified

- Whether extra interior points near the corners make a perfect admissible matching. Not tried.
- Whether `spacing` or `angle` changes in `triangulateTrimmed` close the gap.
