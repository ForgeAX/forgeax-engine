# Trimmed-face split-3 fallback (blossom path)

Lane: quad feature, branch `feat/qf-split3`, base `origin/integration/v2` (803fd803). Source of the method:
Remacle, Lambrechts, Seny, Marchandise, Johnen, Geuzaine (2012), "Blossom-Quad: a non-uniform quadrilateral
mesh generator using a minimum cost perfect matching algorithm". This note is the design of record; the code is
authoritative once merged.

## Problem

On some trimmed planar faces the CDT triangulation has no perfect matching of its dual graph at all
(`no-perfect-matching`): plate-grid3x4, housing, box-minus-cyl, filleted-bracket face 4, loft-0. Matching
cannot be improved by cost, so the face stays non-quad or fails closed.

## Decision

Opt-in `fallback: 'split-3'` on the blossom path. Matching is always tried first. The split runs only when
`minCostPerfectMatching` returns `no-perfect-matching`. Any other failure stays a named failure.

Split rule, per triangle `(a, b, c)` with centroid `g`:

- Edge midpoints `mab, mbc, mca` are inserted on each triangle edge that is interior to the face.
- Three quads: `(a, mab, g, mca)`, `(b, mbc, g, mab)`, `(c, mca, g, mbc)`.
- Boundary edges of the face are NOT split by the centroid rule; they are split by the count rule below.

## How counts reach the neighbours

A 1-to-3 split turns each boundary sample into two half-segments, so the face needs a midpoint on every
boundary edge it borders. Counts are therefore set before triangulation:

1. `solveRowCounts` runs as today. Every shared edge keeps its target count `m` (even, since ring totals
   are already forced even for trimmed faces), so neighbours are unchanged and no count is halved globally.
2. The split face's CDT ring uses only the even-index shared samples (`m/2` segments per edge). The odd
   samples are shared ids that become the midpoints of those CDT segments, so the final boundary is `m`
   segments and each neighbour's ids match by edge id.
3. Consequence: "boundary edges double" means the CDT boundary is half the shared target, and the split
   restores the full target through shared midpoints. The split face never creates a boundary vertex that a
   neighbour does not also own.

## Smoothing

Not implemented. The split emits centroids and midpoints at their raw positions; no relaxation pass runs in
`quad-trimmed.ts` or `quad.ts`. The Laplacian in `quad-iso-quadric.ts` belongs to the iso path only.

Measured as a probe (not in the library, 40 iterations, weight 0.5, only single-face interior vertices move,
boundary and shared-edge vertices fixed):

| Row | minSJ before | minSJ after | quads below 0.3 before / after |
|:--|:--|:--|:--|
| box-minus-cyl (324q) | 0.163 | 0.286 | 16 / 8 |
| housing (3412q, density 4) | 0.195 | 0.302 | 83 / 0 |
| plate-grid3x4 (5512q, density 4) | 0.096 | 0.123 | 758 / 186 |

Relaxation is therefore a candidate, not a result. Adopting it requires its own change, digest regeneration,
and the same gates. The plate worst quads sit near the outer rim, where fixed vertices limit relaxation.

## Expected quality

For a 1-to-3 split of a well-shaped triangle, each quad has corners near 60 degrees and 120 degrees, so its
scaled Jacobian is about sin(60 deg) = 0.866 on equilateral input. On the thin CDT triangles of these faces
the corner sines fall well below that; the floor 0.3 is expected to be cleared on typical faces but is not
guaranteed. Reported per shape, not assumed.

## Failure modes

- Thin triangles at the trim: a centroid on a sliver can invert a quad. Detected by `folded` and reported;
  the face fails closed with `split-3-fold` rather than emitting a fold.
- Boundary-row quads: the split produces no boundary row (quads touch boundary edges only through midpoints).
  Row-quad orthogonality is therefore reported separately and is NOT claimed for split faces.
- Count parity: an odd half-count makes the midpoint insertion impossible; fails closed `split-3-parity`.
- Vertex growth: each triangle adds one centroid and up to three midpoints; capped by `maxPoints`.
- Digest: changing `quad-trimmed.ts` regenerates `BREP_KERNEL_DIGEST`, done last.

## Density and fallback (measured, committed HEAD f783a321 plus the counter fix)

- Blossom-row without `fallback: 'split-3'` fails with `no-perfect-matching` on box-minus-cyl (density 1),
  housing and plate-grid3x4 (density 4 also fails without the fallback). Density alone does not close them.
- With the fallback, `faceQuality[].split3` is true on 2 faces per row (box-minus-cyl faces 4, 5; housing
  faces 4, 5; plate-grid3x4 faces 4, 5). Earlier harness output reported 0 because the field was not wired.
- Density 4 applies only as the fold retry inside the split-3 path. It is not a standalone closure.

