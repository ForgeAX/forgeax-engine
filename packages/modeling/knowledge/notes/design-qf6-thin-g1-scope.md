# M-QF6 scoping, and the remaining split-3 rows

> [!IMPORTANT]
> Design note only; no kernel code is proposed for merge until the coordinator confirms. **[C]** = measured or read in
> the source at integration/v2 89df6137, **[P]** = proposal.

## 1. Weak rows after #661 **[C]**

| Row (iso, quad-dominant, size 0.8) | Before | After #661 |
|---|---|---|
| bracket-gusset | q229 t22 minSJ 0.339 | q458 t0 minSJ 0.489 |
| bracket-pocket | q250 t22 minSJ 0.228 | q834 t0 minSJ 0.408 |
| through-slot (holed top faces) | q704 t0 minSJ 0.541 | unchanged, already above 0.3 |

Plate-grid3x4 (split-3, size 5, `blossom-row`, no iso) is minSJ 0.123 and box-minus-cyl (size 0.25) is 0.286. With
`isoQuadric: true` on the same inputs they are q5032 t0 **0.398** and q216 t0 **0.536**. So the sub-0.3 numbers belong to
the non-iso split-3 route only, whose 1-to-3 centroid split of CDT triangles is bounded by the triangle shape (see
`design-qf-split3-fallback.md`, relaxation section). Improving them means editing `quad-trimmed.ts` /
`tessellate-trimmed.ts`, which this lane may not touch; the documented answer is: **use iso for holed planes**. The
contract test keeps asserting the all-quad property on the non-iso route, and does not claim a quality floor there.

## 2. What M-QF6 would need **[P]**

Two independent items share one prerequisite: a consumer of `FeatureConstraintSet` (today only its unit test calls
`deriveFeatureConstraints`; `quadrangulate` never reads it).

### 2.1 Thin features: at least 2 even rows across a thickness

- Measured baseline: a `4 x t x 2` box at size 0.5 gives q88 for t = 0.1 and 0.3 (one row across the thin side, cell
  aspect 5 and 1.7). Scaled Jacobian stays 1.0 because the cells are rectangles, so SJ alone cannot detect the gap;
  the metric must be rows-across-thickness (the research doc's "graph distance across opposite faces").
- Detection **[P]**: for each planar face pair with opposite outward normals whose gap is below `2 * size`, take the
  gap from the plane frames (exact for analytic planes, no sampling). Faces are matched by overlap of their lattices'
  bounding rectangles in the shared plane.
- Enforcement **[P]**: the thin direction is the set of edges that connect the two faces. Their counts get a floor of
  2 and `evenEdges` membership. This reuses the existing count owner (`solveRowCounts` floor + evenEdges); no new
  solver. The opposing-pair classes already propagate the floor to the matching edges around the rib.
- Fail closed: if the floor conflicts with a hole block (`iso-hole-no-room`), report `thin-feature-rows` with the
  face pair instead of emitting one row.

### 2.2 G1 chains: rows continue across a tangent edge

- `deriveFeatureConstraints` already emits `continue-across:g1-chain` with the edge chain and faces **[C]**.
- Enforcement **[P]**: the two faces on each chain edge must sample it once (already true: edges are shared) and their
  rows must meet it at the same parameters. In `edgeCounts` this is an opposing-pair-like class: for a fillet the
  chain edge on face A and the chain edge on face B are the same edge, so counts already agree; what is missing is the
  *cross* direction (rows of A and B reaching the chain edge from the same side count). That is a `pairs` addition in
  `solveRowCounts`, not a new layout.
- Measured gap to establish first: rows-continuity metric (>= 0.9 within 10 degrees) on `filletBox` and a filleted
  bracket; none is measured today, so the first slice is the metric, not the enforcement.

### 2.3 Order and size

1. Metric functions for both (rows across thickness, G1 row continuity), as report fields: small, no layout change.
2. Thin-feature floor via `forced`/`evenEdges`: small, planar only.
3. G1 pairs in the count solve: medium; needs the filleted bracket as fixture.
4. Symmetry rows (equal counts on mirror edges) last, because it needs a symmetry detector the repo does not have.

Risks: thin-region detection on non-planar pairs (needs offset distance queries, `offset.ts` covers surfaces but not
shell-to-shell gap); a floor of 2 can push hole blocks past `iso-hole-no-room` as seen in #661 (balanced retry
mitigates).
