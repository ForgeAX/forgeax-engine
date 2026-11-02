# Voxels, simplification and remeshing

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Voxels, simplification and remeshing (compute jobs)

Two compute jobs (design 4.1, 13) run on the TypeScript baseline; `compute: 'native'`
(an external voxel or remesh library, deferred) is `model-capability-unavailable`. Both report backend,
quality, cache key and metrics in the `info` diagnostic and honour `budget.work` and the
session signal (`model-work-budget`, `model-cancelled`).

**`voxel`**: narrow-band signed distance grids and Surface Nets.

- `m.voxel.fromMesh(faces?, { voxelSize, band, sign? })` returns an `SdfGrid` (samples
  at `origin + (i, j, k) * voxelSize`, x fastest, negative inside, exact point-triangle
  distances within `band` voxels and clamped beyond; `grid.sample(p)` interpolates). The
  mesh is unchanged. The lattice is phased by 0.382 voxels so authored geometry at round
  coordinates never puts samples exactly on the surface. Sign: `winding` (default; the
  generalized winding number >= 1/2, exact near the surface, a dipole far field, regions
  beyond the band filled from the band) tolerates holes and overlaps; `parity` counts
  signed ray crossings along each grid axis (top-left rule on exact orientations) and
  votes over the three axes, so a hole one axis looks through is outvoted. An open
  sheet or inverted faces bound nothing: fromMesh warns.
- `m.voxel.toMesh(grid, { iso?, smooth?, sharp? })` appends the iso surface. One vertex
  per surface sheet of a cell (a cube face crossed four times pairs its crossings by
  the sign of its corner sum, the same rule in both cells), one face per crossed grid
  edge: a closed, outward, manifold surface. `smooth` relaxes vertices toward their
  neighbours, back onto the level and inside their cells. `sharp` places each vertex at
  the dual-contouring minimizer of exact Hermite data: crossings of the grid edges with
  the source triangles (kept where the sampled field agrees within half a voxel) and
  their face normals, so box edges and corners come out exact; a minimizer that leaves
  its cell falls back to the mass point, and a quad twisted across a feature splits
  along its outward diagonal.
- `m.voxel.union(faces?, { voxelSize, radius })` replaces the faces by the smooth union
  (polynomial smooth minimum of blend `radius`, 0 is the hard union) of their
  vertex-connected parts (an inward-facing closed part, a cavity wall, stays with the
  smallest part whose bounds hold it, so hollow parts keep their cavities); the other
  operations voxelize the selected faces as one field; `offset(faces?, { voxelSize, distance })` by the iso surface at
  `distance`; `fillHoles(faces?, { voxelSize })` by the closed surface their winding
  number bounds. `band` defaults to what the radius or distance needs.
- The surface is new geometry: every face gets the operation's label with role
  `surface`, plus the tags and material slot of its nearest source face (the
  provenance is per face; faces beyond every source band, such as the cap over a filled
  hole, have none, reported as `unmappedFaces`). Corner values (UVs, colors), edge intent
  and the source labels and roles are lost; re-project UVs and re-mark edges after it.
- Assertions: hard, a non-empty closed surface (`model-op-no-effect` names the level);
  soft, an offset whose volume moved against `distance`, and a `fillHoles` that encloses
  less than 75% of the volume its openings would close (each opening capped by a fan to
  its centroid). Openings that subtend more than half the sphere at the interior (an open
  tube shorter than its diameter) leave the winding number there below 1/2, so the fill
  is a ring; the warning names each opening's center and radius. Close such openings
  topologically first (`fillHoles`, `planeCut({ fillHoles: true })`).

**`remesh`**: QEM simplification and isotropic remeshing on the selected faces
(triangulated); the other faces pass through and the selection border is pinned.

- `m.simplify(faces?, { targetFaces?, maxError?, quadric?, clearance?, maxAspect?, maxValence?, preserve? })`: quadric error
  edge collapses by priority until `targetFaces` triangles remain or the next collapse's
  RMS plane distance would exceed `maxError`. `quadric`: `plane`, `volume` (default; the
  Lindstrom-Turk constraint keeps the enclosed volume) or `attribute` (vertex normals as
  a quadric attribute). Constrained feature curves add perpendicular plane quadrics.
  `clearance` (meters) refuses any collapse that brings a triangle closer than that to a
  triangle it shares no vertex with, among the processed faces and every face passing
  through, unless the pair was already that close (exact contact test plus vertex and
  edge distances over a uniform grid). Layered parts and thin shells then never touch
  or cross however coarse the result; the refusals count as blocked collapses
  (`clearanceBlocked`). Without it, a coarse shell 3 mm over another surface cuts through it.
  `maxAspect` refuses a collapse that leaves a triangle above that aspect (longest edge
  squared over twice the area) unless its star was already worse, and `maxValence` one that
  gives a vertex more neighbours: QEM's optimal triangles are anisotropic,
  so on flat runs it otherwise leaves slivers and fans (a 48 x 48 plane at 300 triangles:
  aspect p90 62; with `maxAspect: 4, maxValence: 8` p90 3.4 at about 1160 triangles).
- `silhouette: { views, weight }` keeps the outline seen from gameplay views (the
  idea of image-driven simplification): every vertex on a contour generator of a
  `PerspectiveView` (front- and back-facing triangles around it, seen from the eye) has its
  quadric scaled by 1 + `weight`, so collapses move it last. `maxError` and the reported
  collapse error are weighted too. A 48 x 24 sphere at 120 triangles: six-view IoU against
  the input min 0.975 without, 0.983 with `weight: 50`. Absent, the output is unchanged.
- `m.cleanup.quads(faces?, { maxAngle?, maxPlanarity? })` pairs adjacent triangles
  into quads: an edge without intent (sharp, seam) between triangles of equal attributes
  and continuous corner values joins when their normals are within `maxAngle` (default 15
  degrees), the quad is convex with every corner under 170 degrees (a straighter corner
  makes the other diagonal a sliver) and its planarity (the distance between its diagonals
  over the longer one) is at most `maxPlanarity` (default 0.02). Triangles with the fewest
  candidates pair first, each with its best-scoring partner (planarity, bend, corner
  squareness; ties by edge id), so few triangles are left. The info reports `paired` and
  `quadMetrics`: `quadAreaRatio`, `planarityP99`, `regularValence` (interior vertices of
  valence 3 to 6) and `highValence`. Finding no pair is `model-op-no-effect`. Pitfall: QEM
  fans (one vertex joined to a whole edge run) leave collinear corners that no convex quad
  takes, so simplify with `maxAspect: 4` first, or run `cleanup.tiling`.
- `m.lowpoly(faces?, { targetFaces, union?, hardAngle?, silhouette?, quads?, slivers?, uv?, tags? })`
  composes the existing ops into one game-ready shell. The parts (vertex-connected
  components) are unioned: `union.mode` `'auto'` (default) runs the exact boolean part by
  part; a part that fails against the partial shell (order-fragile: flush or coplanar
  contacts) is deferred and retried against the finished shell, which resolves most of
  them. A part that still fails `model-partial` or a precondition (pure edge contact) is
  `voxel.union`ed with `radius: 0` and sharp features together with only the shell
  components its bounds touch (`union.voxelSize`, default two voxels across the thinnest
  part: half its shortest bounds side, clamped to [1/64, 1/16] of the whole set's longest
  side), so labels and materials are lost only there (`union: 'mixed'`, `clusters`);
  `'exact'` returns that failure, `'voxel'` skips the boolean and rebuilds the whole set. Edges above `hardAngle`
  (default 45 degrees) are marked sharp, the shell is simplified to `targetFaces` export
  triangles (a quad counts 2; as `simplify`, with `silhouette: { views, weight? }`, weight
  default 1), `cleanup.tiling` (within 1e-4 of the diagonal) flips the QEM fans toward
  Delaunay and `cleanup.quads` pairs the triangles (`quads: false` skips both), `uv`
  runs `uv.auto` with sharp edges as seams, and `tags: { groupPrefix }` tags each output
  component `groupPrefix + k` (the groups `bakeMaps` reads). The selected faces are
  replaced. A part that is open or has non-positive volume (inside-out) is
  `model-precondition` (detail `part`, `volume`, `closed`), never a fallback. One info
  diagnostic `lowpoly: ...` carries the report: `pass`, `issues` (`Issue<LowpolyIssueCode>`,
  warn: `not-closed`, `deviation` (Hausdorff above 2 % of the diagonal), `silhouette`
  (IoU below 0.97), `quad-ratio` (below 0.85), `planarity`, `valence`, `over-budget`),
  `union` (`none`, `exact`, `mixed`, `voxel`), `fallback`, `exactError`, `clusters`,
  `voxelSize` (voxel union only), `slivers` (see below), `lost` (voxel or mixed union,
  `labels`, `materials` face counts by name and `corners` set-corner counts by
  channel that the rebuild drops, plus `bySource` the same three counts per input tag, or
  `untagged`; names and sources with no loss are absent, keys ascend, so a clean fallback
  is four empty records), `parts`, `partVolumes`,
  `components` (`tag`, `faces`, `closed`, `volume`, `sources`: the input tags it holds),
  `tris`, the `quadMetrics`, `hausdorff`/`hausdorffMean`, `signed` (`inside` and
  `outside`, each `{ max, p95 }`: how far the low surface sinks below or rises above the
  shell, signed by the angle-weighted pseudo-normal of the closest shell feature), `iou` per
  view and the inner
  `simplify` info. `slivers: width` (meters, finite > 0) runs the `cleanup.slivers` removal
  (same definition: height over the longest edge) after simplify and quads, before uv, so
  the output holds no face narrower than `width` where removal is possible; the report
  `slivers: { width, found, removed, kept, maxMove, volumeChange }` (relative) is the
  bound, and `m.validate({ slivers: { width, part? } })` is the gate (`face-degenerate`
  error, `detail.reason: 'sliver'`, `count`, first `faces`). Tag a part to gate it alone:
  the `scifi-mech` `mergeRigid(m, name, { slivers: 0.002 })` tags its shells `rigid-shell` and
  `assertNoSlivers` gates them (all 12 groups: zero, volume change below 1e-3, the worst
  move 1.8 mm). Pitfall: the definition is the largest vertex distance from the longest
  edge's line, so a long n-gon strip is not a sliver; a width of 5 mm on the forearm group
  can end in `model-degenerate` (rolled back), keep widths at or below 2 mm. Six 1.1 x 1.1 x 0.1 m plates flush on a 1 m hub, shifted 5 cm: the exact
  union succeeds through the retry; `mode: 'voxel'` at `voxelSize: 0.1`, 300 triangles: closed, volume 1.694
  (parts 1 to 1.726), quad area ratio 0.96, one valence-7 pole (11 without the tiling pass),
  about 0.2 s; the default voxel size (0.05) takes about 1 s (longest / 64 took 15 s). Pitfalls: the deviation is
  measured from the unioned shell before simplification (interior faces the union removes
  are not error), and the `deviation` issue tests the unsigned `hausdorff`; the voxel fallback
  rebuilds the surface, so labels, materials and corner values of the parts are lost (the
  `lost` report counts them) and
  the default voxel size is fine and slow, so pass a `voxelSize` aligned with the parts'
  planes; IoU is reported only with `silhouette` views.
- **Union once, triangulate once (surfaces that overlap).** A game mesh whose parts overlap
  (a plate over a hub, a hose across a bracket) is one surface: combine it with
  `m.lowpoly(rigid, { targetFaces: <large>, quads: false })` (the exact union, no
  simplification) before `markSharp`, `uv.auto` or any bake, then triangulate and unwrap that
  result once. Parts only `append`ed side by side stay separate closed shells that cross each
  other: the buried faces bake as rays that hit the wrong skin, cast shadows and AO inside the
  surface, and cost triangles and texels. The gate is `m.validate({ shells: { expected: n } })`
  (Validation): `shell-overlap` is an error while two components cross, and a warn while the
  component count differs from `expected` (the count of designed separate shells, such as a
  ram that moves against the body). Recipe (`scifi-mech` `mergeRigid`): leave out only what moves
  against the body (rams, rods, springs) and decals; hoses and cables are static at game
  resolution and join the union. Pitfall: appending every
  instance (14,842 triangles, overlapping shells); an exact union that falls back to voxels
  loses labels and materials (`lost`), so read `union` and `fallback` in the report; a
  designed overlap (a rod through a bore) is a separate component, so count it in `expected`.
- `m.cleanup.tiling(faces?, { maxError, maxAspect?, iterations?, clearance?, preserve? })`:
  evens a triangle tiling as a `remesh` job. Each pass flips
  interior non-feature edges whose opposite angles sum above pi (caps first) when the flip
  raises the pair's smallest angle, then collapses the shortest edge of each triangle above
  `maxAspect` (default 5). No move gives a vertex more than 8 neighbours, turns a
  triangle by more than 45 degrees, takes a new triangle's centroid farther than `maxError`
  from the input, or (with `clearance`) brings two surfaces closer. Stops after
  `iterations` (default 10) or a pass that changes nothing. Metrics: `flips`, `collapses`,
  `passes`, `prevented`; a tiling with nothing to change is `model-op-no-effect`. The QEM
  plane above goes from aspect p90 62 and smallest-angle p10 0.9 degrees to 3.0 and 26.6.
- `m.remesh(faces?, { targetEdgeLength, iterations, smoothing?, clearance?, adaptive? })`: Botsch-Kobbelt passes
  (split above 4/3 L, collapse below 4/5 L without creating edges beyond 0.9 x 4/3 L,
  flips toward valence 6 (4 on boundaries) that keep creases under about 25 degrees,
  tangential uniform smoothing at speed `smoothing` (default 0.1) with every vertex
  reprojected onto the input), over a dirty-vertex queue that stops early. Collapses keep
  new triangle centroids within L/16 of the input and turn no triangle by more than 45
  degrees; finer curvature keeps finer triangles.
  `clearance` guards every split, collapse, flip and smoothing move as in simplify, so a
  remesh after QEM evens out slivers and fans without touching neighbouring layers.
  `adaptive: { error, minEdge }` replaces the uniform length with a sizing field: at each input vertex the curvature k (largest normal turn per meter toward a
  neighbour) gives the edge whose chord leaves the surface by `error`, sqrt(6 error / k -
  3 error^2), clamped to [minEdge, targetEdgeLength]; the field is graded (it grows by at
  most 1 per meter away from any vertex, so neighbouring sizes differ by about 2 at most)
  and each vertex takes it at its position on the input; an edge uses the smaller of its
  ends. A field that cannot go below the target (minEdge >= targetEdgeLength) is the
  uniform remesh byte for byte. A flattened ellipsoid (rim radius 7.5 cm) at 12 cm: uniform
  Hausdorff 3.2 cm; adaptive (`error` 2 mm, `minEdge` 1 cm) 2.9 mm with over 5 times the
  rim density, the same pole density, aspect p90 3.1 and size ratio p95 1.6.
  `direction: { guides, anisotropy?, constrain? }` lays
  long edges along a line field (a direction up to sign, so a long axis is defined). `guides`
  is a list of `{ faces?, flow }`, the first guide covering a face winning, or `'principal'`
  (the minimum principal curvature direction, least-squares fitted per vertex). A `Flow` is
  `{ along: dir }`, `{ around: { axis, center } }`, `{ from: point }` or `{ curve: points }`
  (the tangent of the nearest point; the caller passes the points). Preserved feature curves
  and `constrain` edges are hard constraints, so a pinned border cannot leave needles across
  the field; elsewhere the field is smoothed by local averaging. `anisotropy` (long over
  short edge, within [1, 6]; a guide may set its own) trades flow against shape: raising it
  lowers the long edges' flow angle and raises the aspect median. The default 1.7 sits in
  the window where both limits hold on a tube (flow p75 <= 20 degrees, aspect p50 <= 2:
  1.6 to below 1.8; 1.5 fails flow at 22 degrees, 2 fails aspect at 2.2). Give the two layers
  of a clearance-locked pair the same analytic guide (their fields then agree); `'principal'`
  differs between layers. Step 1 builds and reports the field (`direction` in the job
  diagnostic: constrained vertices, roughness) without changing the remesh yet.
- `preserve` (design 5.6 constraint classes): `boundaries`, `sharp` (marked edges),
  `labels` (label, role or tag borders), `uvSeams` (marked seams and corner-value
  breaks), `materials`; each `true` (default: the curve stays, its vertices slide along
  it, its ends stay), `'pin'` (frozen) or `false`.
- Output triangles carry the label, role, tags, material and flags of their source face;
  sharp and seam intent stays on surviving feature edges; corner values transfer by
  closest point within the source face's UV island.
- Metrics: two-sided sampled Hausdorff distance (`hausdorff`, `hausdorffMean`,
  `hausdorffRelative`), volume before/after/change on closed meshes, collapses, splits,
  flips, blocked collapses, edge length statistics and `edgesInRange`. Assertions:
  hard, full provenance and (labels preserved) every processed label and role survives;
  simplify must collapse at least one edge. Soft: a target that constraints block, a
  Hausdorff above twice `maxError` (without `maxError`, above 2% of the bounding
  diagonal, `hausdorffRelative`), a volume change above 2%, a mean edge length 25% off.
- Simplify before `uv.auto`. Preserved automatic seams are constrained curves, so a
  low `targetFaces` is met by coarsening what is left, the sharp rims: on a 48 x 16
  cylinder at 12% the seams cost a 2.8% (with a tagged window 8%) Hausdorff deviation
  against none with `uvSeams: false`. Chart the simplified surface instead.
- Runtime LOD stays with Import's meshoptimizer (design 4.1): `simplify` is an authoring
  operation on the editable mesh, not the LOD chain.

**Mesh jobs in a Pack** (design 10.4): a session whose voxel, remesh or simplify work
would crowd the 15 s Pack build moves into a `MeshJob` (`{ name, build(params) -> Model,
export? }`, ordinary code reused by static import). The Pack returns
`meshJobSources(job, { key, params })`: `mesh/<key>` as a `modeling-mesh-job` cook source
holding only the job name and its JSON parameters, so the build returns in milliseconds.
The project's build plugin registers `createMeshJobCooker([job, ...])` (`nativeCookers`);
the cooker runs the job outside the build timeout and publishes the export as an ordinary
mesh through the mesh producer (a failed job keeps the last-known-good mesh). Under a
`model.*` capture `meshJobSources` runs the job in place, so the tools still see its
session, journal and source lines, and the cooked mesh is the same bytes.

**Rig jobs** do the same for a whole rig (`mech-gt` S7: 605 outputs, two minutes to build).
A `RigJob` (`{ kind: 'rig', name, build(params) -> { rig, finish } }`, where `finish` is
the rig's finish options without `key` and `packageId`) is published with
`rigJobSources(job, { key, packageId, params, outputs })`: one `modeling-mesh-job` cook
source per output key (`mesh/<key>.<part>`, `scene/<key>`, `animation-clip/<key>`, ...).
A Pack must name its outputs without running the job, and a rig's part names only exist
once it is built. So `outputs` is the list `rigJobOutputs(job, { key, params })`
returns (`Rig.outputKeys`: the keys `finish` writes, without exporting), kept next to the
Pack (`s7.outputs.json`) and checked by a test. The same
`createMeshJobCooker([...])` cooks them: it builds the rig once per job and parameter set,
and that build serves every output; each payload publishes through its standard producer
(scenes through the Pack's `sceneComponents`). A list that no longer matches the built rig
fails the cook with a hint to regenerate it. Under a capture the job runs in place.

**Parallel job builds.** The cooker is `concurrency: 'parallel'`: a host may cook several
Packs at once, and a build stays until each of its outputs has been cooked once (the two
most recent completed builds stay for re-cooks). `createMeshJobCooker(jobs, { executor })`
runs rig and assets jobs that name their `module` elsewhere; `buildMeshJobSet` is the one
build both paths run, and an executor resolving `undefined` declines a request so it
builds inline. `module` is plain data: DevKit bundles build plugins, so `import.meta.url`
names the bundle, and the project build plugin sets it to the authored file (resolved from
the build's working directory). `meshJobWorkers({ maxJobs?, minFreeGb?, defaultPeakGb?,
maxHeapMb?, cacheWaitMs? })` in `./tools` is the Node executor: up to `maxJobs` persistent Workers, each
building one job at a time; a build prefers an idle Worker that already loaded its module, so
state a job module shares between its jobs (a common base form) is computed once per Worker. A Worker
imports the job's module (a `.ts` module needs Node type stripping, Node >= 23.6; older
Node declines with one diagnostic and the cooker builds inline). The cook host's store
stays the single cache owner: a Worker's synchronous read waits at most `cacheWaitMs`
(default 5 s) for the cooker's thread, and a timeout is a miss with a diagnostic, never a
hang. Admission is by memory: builds start in request order while MemAvailable, less the
expected remaining growth of running builds and the new build's expected peak, stays above
`minFreeGb` (`FORGEAX_HEAVY_MIN_FREE_GB`, default 12), at most `maxJobs` (4) at once and
always at least one. The expected peak is the last measured one (committed heap plus
external memory), kept as `peak:<job>@<identity>` in the cooker's store, else
`defaultPeakGb` (3); records only schedule and never reach outputs. `maxHeapMb` caps the
V8 heap of a Worker only: external memory (the kernel's typed arrays) is uncapped and can
still exhaust the build process.
