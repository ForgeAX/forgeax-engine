# Booleans and repair

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Booleans and repair (compute jobs)

`union`, `difference`, `intersection` and `splitBy` take another session, an FXEM
snapshot, or a selection of closed components of this session (the rest is then the
target). Both operands must be closed and outward (`model-precondition`, hint
`fillHoles` / `orient`). The call is a compute job (design 4.1): canonical FXEM in,
FXEM plus provenance out, on a backend chosen by `compute: 'auto' | 'ts' | 'native'`
(per call, or `model({ compute })`). The TypeScript baseline is always there
(`quality: 'baseline'`): every operand triangle is classified against BSP trees of
the original operands (coplanar overlaps exact by a front/back double descent), tool
components are taken one at a time, then the fragments are welded, T-junctions
resolved, and seam vertices (ends of open edges) closer than 4, then 16 tolerances
merged: a cut grazing a long triangle edge can place two split points of one seam just
over the weld distance apart. A seam that stays open is retried once at a finer and
once at a coarser tolerance band. `native` is unavailable until a Host
injects a backend (`model({ native })`) and fails with `model-capability-unavailable`.

- Provenance maps every result face to its source face: material, origin, tags and
  flags come from it, corner values by barycentric position in its source triangle,
  and target edge intent along source edges is kept. The cut curve is sharp where the
  faces fold. With `label`, only the faces the boolean brings in take it: operand faces
  get role `cutB`, and every face of the `splitBy` piece role `piece` (the piece is a new
  part). Target faces, cut or not, keep their own label and role, as with `loopCut` and
  `bisect`; there is no target role (the target faces a cut touches are
  `sel.createdBy(label, 'cutB').grow(1).minus(sel.createdBy(label, 'cutB'))`). `tag` and `material` apply to the operand faces
  (and the piece). Operand faces without values in a target channel are reported.
- The front end regroups same-source faces with `cleanup.planar`; a region with holes
  is first cut by straight lines through its holes, since n-gons hold none.
- Then it collapses slivers (`metrics.slivers`): a face narrower than `slivers` (default
  1/1000 of the operands' bounding diagonal) and than a tenth of its source face is a
  remainder the cut left beside a feature of the other operand; faces a few tolerances
  wide always are. Its short edges collapse in turn, each merged vertex at the
  least-squares meet of its other faces' planes; the sliver goes only if every one of
  those faces stays within the tolerance of its plane, keeps its orientation and a simple
  outline, and the mesh stays manifold, and no vertex moves more than twice the width
  limit. Whole tool faces (a small drill's facets) and untouched target faces are their
  own source, so they never count. `slivers: 0` keeps every remainder but degenerate ones.
- Postconditions (any backend): closed manifold, every face inside its source face,
  volume within the operation's bounds. Otherwise the result is `partial` with `detail.locations`; the default
  `onPartial: 'error'` fails with `model-partial`; `'accept'` keeps it with a warning
  only when it is still a closed manifold within the volume bounds and just some faces
  lost their source face. An open, non-manifold or out-of-bounds result always fails.
  A difference that removes nothing, an empty intersection or split piece is
  `model-op-no-effect`.
- Each call reports an info diagnostic: backend, backend identity, quality, the DDC
  cache key (sha256 of kind, inputs, params and backend identity) and metrics. The TS
  backend identity is `forgeax-modeling-ts@<digest>`, a content digest of the kernel
  source (`src/compute/kernel-digest.ts`, checked by its unit test), so a kernel change
  changes every cache key. The file also records each closure file's hash; a stale digest
  fails naming the changed, added and removed files and the regenerate command
  (`FORGEAX_UPDATE_GOLDEN=1`), and the PR body says why the kernel identity changed.
- n-gon bound (reported, not a postcondition): `metrics.resultFaces` against
  `inputFaces` (operand faces with at least one surviving piece) plus `cutFaces`
  (surviving faces the cut curve touches), counted per output shell (a split's pieces are
  a difference and an intersection, each bounded on its own). It holds on the hard-surface families of the
  spike set (plate holes, slots, nested, coplanar, radial, radial windows). It is **not promised for
  tools at arbitrary angles** (the freeform family, 36 of 50 within it): the straight hole
  cuts turn a face with scattered holes into one n-gon per strip (lines + 1), while the
  bound credits a cut face with two. On aligned hard-surface layouts the cut faces that
  stay one n-gon leave enough credit; tilted tools passing through a part split their
  side faces into separate regions, which use it up.
  `budget: { work }` bounds the job (`model-work-budget`, hint: native backend); the
  signal is polled inside the job.
- `cleanup.planar(faces?)` merges coplanar adjacent faces with identical attributes
  into hole-free n-gons and drops collinear vertices; edges with intent and corner
  discontinuities stay. `resolveTJunctions({ distance? })` inserts boundary vertices
  lying on other boundary edges. `weldEdgeSequence(edges, { maxDistance? })` stitches
  two facing boundary sequences, matching vertices by arc length.
- `cleanup.slivers(faces?, { width })` removes faces narrower than `width` (their
  height over the longest edge), locally: short edges collapse where every neighbour
  stays planar, oriented, simple and manifold, and needles (every vertex within the width
  of the long edge's line) are deleted while their apexes join the face across that edge
  (on an open boundary, the boundary moves in by at most the width). No other face is
  retriangulated; a needle joins only a neighbour whose plane holds its apex (on an open
  boundary an off-plane needle is deleted instead), and slivers
  that cannot go are listed in a warning (`quiet: true` makes finding none an `info`
  instead of `model-op-no-effect`, for conditional passes). `surface` applies the
  same removal to its own faces at a quarter of `snap`, so a trim passing a grid node
  leaves no needle for `shell` to trip on. The width test is purely geometric: dense pole
  fans and narrow but intended strips (a lip or flange no wider than `width` on an open
  boundary) qualify too, so pass the faces to clean rather than the whole part.
- Several overlapping parts that will be triangulated and baked as one surface are combined with `m.lowpoly(faces, { targetFaces, quads: false })` (the exact union, [Voxels](voxels-remesh.md)), not `append`ed; `validate({ shells })` reports the crossings that remain (`shell-overlap`).
- A snapshot of a poisoned session is a failing operand: `append`, `array`, the
  booleans, `shrinkwrap` and `bakeMaps` report `model-precondition` with `detail.cause`
  instead of adding its partial geometry.

The spike gate set (`src/__tests__/boolean-cases.ts`, report
`reports/boolean-spike.json`) holds 290 parametric parts, including 30 wheel-style
spoke windows cut into revolved discs (`radial-windows`); see the report for the
legality rate, provenance completeness, n-gon bound and timing.
