# UVs, trim sheets and baking

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## UV unwrap and pack (compute jobs)

Run `m.uv.project({ mode: 'box' | 'planar' | 'cylinder', scale, faces?, channel? })` after the
last topology edit: `finish` rejects faces without `uv0`, and without `uv1` once any face has it.

`m.uv.unwrap(options)` flattens faces (default all; `faces` selects) per island. Islands
are cut by seams: `seams: 'marked'` (default, edges flagged by `markSeam`), `'sharp'`
(marked plus sharp edges, the design 5.4 coupling) or an edge selector (marked plus the
selection, not written back), and by the selection boundary. Corners of one vertex
split into UV elements around it, so bowties and slit ends split exactly. Each island is
flattened by `method: 'lscm'` (default) or `'expmap'`, then normalized to its 3D area
(1 UV unit = 1 m), turned to its minimal bounding rectangle (wider than tall) and laid
out side by side along +u. Pack afterwards for an atlas.

- LSCM: two pins are substituted out (their columns move to the right-hand
  side) and the reduced least-squares system is solved directly: Cholesky of its normal
  matrix in envelope storage under a reverse Cuthill-McKee order (exact, 0 iterations;
  CGLS needs about n iterations where slivers meet large triangles). An island whose
  envelope exceeds 16M entries, or whose normal matrix is numerically singular, goes to
  the `solve.sparse` CGLS (Jacobi column scaling, `tolerance` default 1e-9,
  `maxIterations`). `pins: 'boundary'`
  (default) takes the farthest-apart pair of the longest boundary loop,
  `'extent'` of the whole island. An island without a boundary
  is `model-precondition` (hint: mark a seam); a collapsed island or a vertex on no
  positive-area triangle is `model-degenerate`; a solve that does not converge is
  `model-solver-diverged` with `method`, `iterations`, `residual` and `island`.
- ExpMap: geodesic polar coordinates grown by Dijkstra from the element
  nearest the area centroid, with tangent frames transported along the tree. For small,
  nearly developable patches (decals, badges); a whole sphere folds.
- **SLIM refinement (`refine: 'slim'`, opt-in; default off, output unchanged)**: after
  the island is flattened, a flip-free minimization of the symmetric Dirichlet energy
  (local rotation fit, weighted global least-squares proxy, step
  bounded by the first sign change of any triangle's determinant, then backtracking)
  runs from that layout, at most 24 iterations, deterministic. It is applied per
  island, so seams stay cuts: islands are never joined, split or reordered. A folded
  disk island restarts from its Tutte embedding (`refineRepaired`); any other island
  SLIM cannot run on keeps its layout (`refineUnavailable`). Rectified quad grids are
  not refined. The result replaces the layout only when the gate accepts it: no flipped
  or zero-area triangle, strictly lower energy, no more overlapping triangle pairs than
  before (exact predicates) and an area distortion (the texel density spread)
  not above the start's; otherwise the start is kept (`refineRejected`). The density
  test allows only a 1e-9 relative rounding slack, by measurement: on `uv.auto` of five
  real parts (armor-bake base, actuator shell, the three scifi-mech low sets; 1729
  islands) 349 refinements were accepted and none widened the spread; the 28 density
  rejections widened it by 0.68 % to 50 % (median 1.6 %) for energy gains of 2.5e-6 to
  1.8e-3 relative. No proposal fell between the slack and 0.68 %, so a looser tolerance
  would only trade texel density for negligible stretch. Energy is per
  3D area at the island's own scale, so 4 is isometric. Metrics, only when `refine` is
  set: `refined`, `refineRejected`, `refineUnavailable`, `refineRepaired`,
  `refineIterations`, `overlaps` (UV triangle pairs that overlap), area-weighted
  `energyBefore` / `energyAfter` of the refined islands that started flip-free, and per
  island `refineStatus` (`accepted`, `no-gain`, `flipped`, `overlap`, `density`,
  `unavailable`, `rectified`), `refineIterations`, `flippedBefore`, `energyBefore`,
  `energyAfter`. A warn diagnostic reports remaining overlaps. An unknown value is
  `model-invalid-argument`. `uv.auto({ refine: 'slim' })` forwards it to its unwrap.
- Metrics (info diagnostic, per job and per island up to 32): Sander L2 and L-infinity
  stretch normalized for scale (1 = isometric), area distortion (max over triangles of
  max(rho, 1 / rho), clipped at 100), flipped and zero-area triangles, CG iterations and
  residual, texel density dispersion. Soft assertions (warn): faces with zero-area or
  inverted UV triangles, and islands with area distortion >= 4 (cut long strips with
  non-developable parts such as pockets into more islands).
- `m.uv.pack({ resolution, padding })` packs the islands of faces (default all; islands
  are connected components of equal corner values) into one square atlas: islands are
  scaled to their 3D area (`normalize`, default true), turned to their minimal bounding
  rectangle (`rotate`, default true), sorted by height and placed bottom-left on a
  skyline with both quarter turns; a binary search finds the largest common scale that
  fits. `padding` texels separate islands (half at the border); `padding: { mips: k }` is 2^(k+1)
  texels, enough to keep islands apart down to mip k with a filled bake gutter. Faces without the channel
  are `model-precondition`; an atlas that cannot hold the islands is `model-precondition`.
  Metrics: texels per meter, coverage, rectangle utilization, turned islands, texel
  density dispersion.
- **Pack upgrades**: `method: 'raster'` packs conservative cell masks (cells of
  at most 512 per atlas side, dilated by half the padding) instead of bounding rectangles,
  so small islands go into holes and concave parts. Greedy strategies are tried in turn
  until one fits: largest first to the lowest top edge, skyline rows for the big islands
  with the small ones into the gaps, tallest first, and the plain skyline positions (so
  raster never fits less than skyline). The scale search starts at the skyline scale.
  `rotate: { step: 45 }` adds eighth turns. `stack: true` gives congruent islands (same
  triangles, same shape within 1e-4 of the extent, up to quarter turns) the leader's
  placement and bit-identical UVs (metric `stacked`). `density: { target, tolerance? }`
  packs at `target` texels per meter (normalized islands) and may drop to
  target x (1 - tolerance), or fails `model-precondition`. `with: [models]` shares one
  atlas across sessions: the job takes one FXEM per session, and each call writes
  only its own session, so pass the same list to every session.
  Gates (`uv-pack.unit.test.ts`): ring islands with chips are 0.62 raster vs 0.50 skyline;
  bevelled panels are 0.70 vs 0.50; stacked copies coincide exactly.
  Raster costs seconds on hundreds of islands (`wheel-uv` wheel: 919 islands, about 9 s);
  skyline stays the default.
- **Rectify**: `uv.unwrap({ method: 'rectify' })` maps islands that are quad
  grids to straight rows and columns. Each u (or v) grid line sits at the running sum of
  the average 3D edge length between lines, so a curved bevel ribbon or a revolved band
  becomes a rectangle (rectangularity 1). Other islands take LSCM (metrics `rectified`,
  `rectifyFallbacks`). Grids that do not develop warn at area distortion >= 1.25
  (falsifier: a domed patch). `uv.auto({ method: 'rectify' })` does the same per chart.
  Gate (`wheel-pack.unit.test.ts`): the `wheel-uv` wheel rectified packs at 0.62 coverage
  (0.67 raster) against 0.25 from its LSCM arcs, max area distortion 1.23.
- **Texel density**: `validate({ texelDensity: { resolution, target, tolerance?,
  channel? } })` measures each island's density the way `measureUv`, `uv.pack` and
  `uv.trim` do (resolution x sqrt(UV area / 3D area)). Islands farther than `tolerance`
  (default 0.2) from `target` are one `texel-density` warning with `min`, `max`,
  `outside` and the worst islands; a face without the channel is a `missing-channel`
  warning. Gate: a 205–536 px/m mesh is reported, and one density gives no finding.
- `measureUv(mesh, channel?)` measures any complete channel the same way (per island and
  totals plus `faceIsland`); `validate({ uniqueUv: true })` reports overlaps.
- Both are compute jobs (`uv.unwrap`, `uv.pack`: one FXEM in, f32 corner UVs in FXEM
  order out, provenance `faceIsland` plus island metrics or placements). `solve.sparse`
  takes FXCS CSR bytes (`encodeCsr`), the right-hand side and an optional initial guess
  (`encodeVector`) with `method: 'cg' | 'pcg-jacobi' | 'cgls'`; `solveSparse` and
  `TripletList` are the in-process forms. All three report backend, identity, quality,
  cache key and metrics, honor `budget` and the signal, and are byte-deterministic. The
  native backends (Eigen, xatlas) are deferred: `compute: 'native'` fails
  `model-capability-unavailable`.

## Automatic UVs and baking (compute jobs)

> [!IMPORTANT]
> Union, then triangulate once, then unwrap and bake: combine overlapping parts with `m.lowpoly` (exact union, [Voxels](voxels-remesh.md)) before `uv.auto`, and gate the low mesh with `m.validate({ shells: { expected } })` (`shell-overlap`, [Validation](validation.md)). Appended overlapping instances bake buried faces into the maps.

`m.uv.auto({ resolution, padding })` cuts seams automatically (design 13): the `uv.chart` job seeds `maxCharts` (default 100) patches by
normal-weighted farthest-point sampling over the face graph, grows them by the same
distance, then merges neighbors (most similar first, normal limit in four stages up to
`maxNormalDeviation`, default 45 degrees) while the joint ExpMap keeps the area-weighted
mean area distortion within `maxDistortion` (default 1.5) and no triangle above four
times it. Marked seams, open edges and, with `respectSharp` (default true), sharp edges
are hard boundaries; a patch that is not a disk (a closed part, a band between two hard
loops) gets another seed until every patch is one, and a merge must stay a disk, so LSCM
never folds a band. A patch still invalid after that (not a disk, or over the distortion
limits) splits along its own farthest faces until it is valid or one face, and a chart
that holds both sides of a hard edge (a slit: a crease that dies out, an isolated sharp
edge) splits between them, so every hard edge is a chart border. Charts never merge
across parts or hard edges: every separate part is at least one chart, so `maxCharts`
is the seeding target, not a merge quota; when validity needs more charts than
`maxCharts`, a warning reports it with the part count. The chart borders become
seams of one `uv.unwrap` (`method`, default LSCM) and the result is packed by `uv.pack`;
`pack: { method, rotate, stack, density }` passes those `uv.pack` options through (default skyline, so `pack: { method: 'raster' }` fills ring holes and concave charts).
Each LSCM island starts from its ExpMap and keeps the ExpMap when LSCM folds, collapses
or distorts it more (unwrap metric `fallbacks`).
The info diagnostic reports charts, parts (`components`), initial patches, splits,
`slitSplits`, merges and the unwrap / pack metrics; the effect assertion is that no
chart crosses a hard edge (`crossedEdges`).

`bakeMaps({ base, detail, maps, resolution })` bakes a detail (high) mesh onto a base
(low) with uv0 (the `bake` job, CPU only). One correspondence pass feeds every evaluator in `maps`: each base
sample casts one ray from its cage, `cage.offset` outside the base along the direction
field, inward for at most `cage.maxRay`, and takes the first detail triangle of its own
bake group that faces the ray (within 84 degrees); a miss takes the nearest facing detail
point of the group.

| Map | Value |
|:--|:--|
| `normal` | detail shading normal in the base tangent space: exactly the inverse of the shaders' `applyTBN` with the exported `computeTangentVec4` frame (render the base with the same `normals` export mode) |
| `normalObject` | detail shading normal in object (world) space, 0.5 + n / 2: independent of tangents, the map to compare with other bakers |
| `ao` | open fraction of `ao.rays` (32) cosine-distributed rays in the cone 15 degrees (`ao.bias`) above the tangent plane; an occluder at distance t weighs 1 - t / reach (`ao.attenuation: 'linear'`, default; `'none'`: full), reach `ao.distance` (default per group min(0.1 x its diagonal, 0.5 m)); `ao.floor` adds a ground plane at that world y |
| `curvature` | mean curvature (convex positive) mapped by its 95th percentile around 0.5; on the texture target measured in texture space from the corresponding detail points and normals of neighbouring texels of one chart, so creases with split normals and fillets both show and flat regions are exactly 0 (the vertex target interpolates vertex curvature) |
| `edgeWear` | smoothstep of normalized convex curvature over `edgeWear.range` (default [0.15, 0.5]), times 1 - `edgeWear.noise.amount` x value noise (`noise.scale` 0.02 m) |
| `cavity` | smoothstep of normalized concave curvature over `cavity.range` (default [0.15, 0.5]) |
| `height` | signed offset along the ray, (h - inner) / (outer - inner) over `height.range` (default symmetric: the largest cage `offset` or `maxRay - offset`; `provenance.heightRange`); floaters read the solid detail under them. `height.bits: 16` stores it as `r16unorm` |
| `position` | detail point normalized by `provenance.positionBounds`: the detail's box per axis (`position.bounds: 'box'`) or the cube around its bounding sphere (`'sphere'`, uniform scale) |
| `thickness` | mean of min(t, reach) / reach over `thickness.rays` (32) cosine-distributed rays into the detail (0 thin, 1 at least `thickness.distance` thick; default 0.1 x the group diagonal) |
| `opacity` | fraction of a texel's samples whose ray found the detail (no nearest-point fallback); its mips keep the alpha-test coverage at `opacity.cutoff` (default 0.5) |
| `ormh` | R = AO, G = roughness and B = metallic of the hit material slot (`slots`, below), A = height |
| `materialId` | detail slot's authored `materialId` or `MATERIAL_ID_PALETTE` fallback, stored as sRGB; its mips point-sample level 0, so every level holds only slot colors; `provenance.materials` lists the resolved linear colors (an id mask; appearance comes from `baseColor`) |
| `baseColor` | the hit slot's `baseColor` (sRGB RGBA, an sRGB texture); its alpha also multiplies `opacity` |
| `emissive` | the hit slot's linear `emissive` x `emissiveIntensity` over `provenance.emissiveScale` (the brightest slot, at least 1; use it as the material's emissive intensity), linear RGB |
| `resample` | a detail texture (`resample`, rgba8) through the detail uv0 |

**Wrap and tileable bakes**: `wrap: { u?, v? }` joins opposite atlas borders per uv
axis. `true` joins them in texture space only: the B-spline filter, the gutter and
texture-space curvature cross the border (a cylinder whose u runs once around). A world
vector also names the translation of one uv period (a trim strip or a tiling patch whose
uv0 spans [0, 1]): the detail repeats at -1, 0 and +1 periods along that axis, so rays,
occlusion and curvature near the border see the neighbouring tiles and opposite borders
match. Each map kind has at most one settings object named after it (`height`,
`position`, `thickness`, `edgeWear`, `cavity`, `opacity`).

**Slots**: `slots: Record<slot, BakeSlot>` is the one per-material table the slot
maps read: `{ baseColor?: [r, g, b, a] (sRGB), roughness?, metallic?, emissive?: [r, g, b]
(linear), emissiveIntensity?, materialId?: [r, g, b] (linear) }`. `ormh` reads roughness and metallic, `baseColor` the colour,
`emissive` the emission, `opacity` the alpha (times its ray-hit coverage). A slot without an
entry, or an unset field, takes `slots['*']`, then the defaults (white opaque, 0.5, 0, no
emission, intensity 1); `'*'` never names a material slot. Fields out of range are
`model-invalid-argument`, misspelt ones too (`detail.option`). `bakeTrimSheet` reads the
same table (`slots`), and its analytic modules map their `material` names through it.
`materialId` takes three finite channels in [0, 1]: the slot's value, then `slots['*']`,
then the existing slot-order palette (which cycles after eight colors). Assign distinct
colors for stable slot identities beyond that palette, or share a color across slots
to bake a semantic family mask. Changing appearance or slot order does not change an
authored ID. ID colors affect only the ID map and its provenance; they do not affect
base color, opacity, emission or material response. Mesh and analytic trim modules
use the same policy.
IDs stay categorical through the complete bake: each texel keeps its first accepted
opaque correspondence sample, gutter rings copy the first covered neighbor in row
order, the B-spline filter skips IDs, and mips point-sample level 0. Continuous maps
keep their existing sample and gutter averaging. This also corrects mixed boundary
and gutter colors in legacy palette bakes; the palette colors themselves are unchanged.
Gate (`bake-slots.unit.test.ts`): a glow strip's emissive covers its projection at IoU 1
(gate 0.95) and is zero elsewhere; without a glow entry nothing glows, swapped names move it,
and alpha 0.3 drops the hull's opacity to 77.

**Bake groups**: the bake reads one face-tag convention, `tags: { groupPrefix,
floater }`. `tags.groupPrefix: 'bake:'` splits both meshes by face tag: a face tagged `bake:<id>` belongs to
group `<id>`, untagged faces to group `''`. Rays only find detail of their own group, so
parts that touch or overlap in projection bake as if exploded (tags replace name matching). `groups[id]` overrides `cage` and `direction` per group. AO
occluders follow `ao.scope`: `'group'` (default, the sample's own group) or `'all'` (every
group but `ao.exclude`).
`tags.floater` marks detail faces that float over the surface (bolts, plates without a
mesh join): they bake into the normal map, but `height` reads the solid detail under them
and AO never sees them. A face with two group tags, or a base group without detail faces,
is `model-precondition`. `provenance.groups[].steepArea` is the share of the group's
detail area that stands within 15 degrees of its rays (V3: vertical engraving and boss
walls no bake can see); above 3% the bake reports `steep-wall` (see Bake checks).

**Cage**: `cage: { offset, maxRay }`, each `'auto'` (default) or meters. Auto measures
the group both ways on a grid of 1/64 of its diagonal (every detail sample against its
nearest base point, every base sample against its nearest facing detail point) as the
distance along the ray to the detail triangle's plane (on facets within 15 degrees of the
ray, which would inflate it by 1 / cos, the sample's own distance along the ray; a 0.1 m
blind hole measured 0.61 m before): the largest outward distance times
1.05 is `offset`, `offset` plus the largest inward distance times 1.05 is `maxRay` (at least 0.1% of the diagonal each). An automatic offset or depth beyond 20% of the group
diagonal is `model-precondition` with the group (split the parts into groups or pass an
explicit cage). `provenance.groups` reports each group's resolved cage, samples, ray hits
and nearest-point fallbacks (V2); a group under 99% hits reports `ray-miss`.

**Direction** (`direction`, also per group):

| Mode | Rays | Use |
|:--|:--|:--|
| `'averaged'` (default) | position-welded, angle-weighted vertex normals of the group, interpolated | continuous across hard edges: no seam, no ray gap |
| `'shading'` | the base's exported (split) shading normals | the pre-cage behaviour; opens seams and gaps at hard edges |
| `'face'` | each base face's geometric normal | floaters and panel details on flat faces stay round and in place (no skew); gaps at hard edges |
| `{ face: tag }` | tagged base faces along their face normal, the rest averaged | per-face skew control without a brush |
| `{ blend: meters }` | averaged at hard edges, turning (smoothstep) to the face normal at `blend` meters from them | both: no seam at the edge, no skew inside; the recommended mode for hard-surface panels |

Hard edges for `blend` are base edges whose faces disagree on a shading normal, or that
separate groups (`report.metrics.hardEdges`). The vertex target takes `'averaged'` or
`'shading'`.

**Parallel bakes**: `bakeMapsParallel(options, executor)` returns the same
`BakeResult` as `bakeMaps` (byte for byte; only `report.metrics.work` differs) with the
texture target's 32-texel tile rows sampled by a `BakeExecutor` function. `bakeWorkers({
workers })` from `@forgeax/engine-modeling/tools` (Node only, the bake twin of the
capture Worker) starts that many Worker threads; each prepares the request once and takes
rows from a shared queue (the internal `bakePhases`). Rows are independent and merged by
position, so any worker count, split or completion order gives the same bytes; the work
budget spans all Workers and cancellation stops them between rows. Worker failures cross
the thread boundary as plain `BakeFailure` data and become `ModelingError`s on the
calling thread. The vertex target runs serially. Bake rays traverse a binned SAH BVH (16 bins
per axis): closest hits break ties by (distance, triangle index) and nearest points by
(squared distance, triangle index); a hit outside its triangle's box (a ray almost in the
triangle's plane, whose distance is round-off) is dropped, and pruning keeps a 1e-9
safety margin, so the tree changes the node visits (about half on the `bvh-sah` gate
scene), never the result (gate: every vertex query of the maid-whale G6 model agrees on
the SAH and median trees). Shrinkwrap, layer and shut-line queries keep the old median
tree with its round-off hits (`LEGACY_BVH`, internal) so the shapes tuned on them do not
move; the round-off hits are a known shrinkwrap defect to fix with their owners. Pitfall: each
Worker repeats the preparation (BVH build and cage estimate), so small bakes gain little
(2.8 s serial vs 2.0 s with 4 Workers on the gate fixture); use Workers for the long
bakes.

Texels run in 32 x 32 tiles with `samples` (1, 4, 9, 16) per texel, a cubic B-spline
reconstruction within each chart (`filter`, material ids unfiltered) and a gutter: `gutter:
'fill'` (default) grows every chart until the atlas is full (each empty texel averages its
nearest chart texels, ring by ring), a number grows that many texels. Results are
`TextureAsset`s (`mips` default true; `texture` stores them through a `TextureSink` and fills
`references`). `target: 'vertex'` evaluates the same maps per base vertex and group
(object-space normals) and returns per-corner colors plus the base FXEM with the first map
as vertex colors. A base whose uv0 covers no texel is `model-precondition`.
Pitfall: the B-spline reconstruction also blurs creases inside a chart (a 45-degree chamfer
p95 9.5 degrees, an L corner 7 degrees, against 0.3 with `filter: 'none'`); bake hard-surface
details whose creases fall inside a chart with `filter: 'none'` and enough `samples`.

**Mip bleed** (V4): `provenance.bleed[k - 1]` counts the 2^k x 2^k blocks of the box
mip chain that hold a chart texel and also a texel of another chart, a gutter texel two
charts share, or background. `protectMip` (default: the uv module's one mip-protection
default on the shorter side, the level where it reaches 128 texels, so 3 at 1024)
is the lowest level that must stay clean: blocks there report `mip-bleed`, and
`metrics.protectedBleed` sums them. Pack for it with `m.uv.pack` / `m.uv.auto` `padding: { mips: k }`, which spaces
islands 2^(k+1) texels apart (1024 -> k 3 -> 16 texels); with `gutter: 'fill'` that is
exactly enough for mip k.

**Options** are checked: an option the bake does not read, nested ones included (`ao.reach`,
a removed `distance`), is `model-invalid-argument` with `detail.option` (`bakeMaps`,
`bakeMapsParallel`, `bakeSources`). `detailNormals` defaults to autoSmooth 35 degrees (the
trim sheet's rule): a hard-surface chamfer bakes flat (a 45 degree chamfer box: 0.19
degrees, against 16.6 with smooth normals) while a sculpt or a fine round (steps under 35
degrees) stays smooth; pass `{ mode: 'smooth' }` for the old result. The B-spline filter
does not blend texels whose detail normals turn by more than 20 degrees, so creases stay
sharp (the plain filter bent the texels next to a chamfer crease by about 9.5 degrees).
`report.metrics.work` counts each tile row's own BVH visits, so every Worker split reports
the serial count.

**Bake checks** (BK-V): `result.pass` is false when `result.issues` holds an
`error` or `warn` issue (every bake check is `warn`; the maps are still delivered).
`issues` are `Issue<Code>` over the bake-time part of the one `BakeCheck` catalogue, whose
mesh-time part (`BAKE_CHECKS`) runs in `validate({ bake })`. Measurements stay in
`provenance`; `diagnostics` keeps one info line (maps, sampled texels, backend, metrics).

| Code | BK-V | Reported when | `detail` | Fix |
|:--|:--|:--|:--|:--|
| `ray-miss` | V2 | a group's rays found the detail for fewer than 99% of its samples (the rest took the nearest point) | `subject` (group id), `samples`, `rayHits` | widen the cage (`offset` out, `maxRay` in) or split the parts into groups |
| `steep-wall` | V3 | over 3% of a group's detail area stands within 15 degrees of its rays | `subject` (group id), `steepArea` | slope or chamfer engraving and boss walls (about 60 degrees), or rely on height and AO |
| `mip-bleed` | V4 | a 2^k block down to `protectMip` mixes charts or background | `protectMip`, `bleeding` (`level`, `blocks`) | pack with `padding: { mips: protectMip }` and keep `gutter: 'fill'` |
| `stack-conflict` | V5 | any texture bake: sub-samples that stacked or mirrored UVs share conflict when their bake tangent-space normals differ by more than 5 degrees or their heights along the ray by more than 2 % of the height range (each later triangle re-derives both; strict interior only, so shared chart edges do not count); reported over 1 % of the stacked sub-samples, or at 4 or more conflicts when one reaches 45 degrees or 10 % of the height range (a small asymmetric bump) | `subject` (base face of the first conflicting texel), `samples`, `conflicts`, `maxAngle` (degrees), `maxHeight` (m); totals also in `provenance.stack` | stack only modules with the same detail; mirror the detail with a mirrored island, or give the island its own UV space |
| `tangent-seam` | tangent handedness | samples land on base triangles whose corners disagree on tangent handedness; the frame interpolates through w = 0 and the normal map bends up to 15 degrees | `subject` (smallest such base face), `samples`; `provenance.handedness` | `exportMesh` already splits a welded mirror seam on uv0 handedness, so this fires only for a corner whose face has no uv area (sign 0 joins either side): give that face uv area or cut a UV seam there |
| `opacity-coverage` | V12 | an opacity mip, down to a 16-texel side, moves its alpha-test coverage more than 0.05 from mip 0 | `level`, `coverage`, `base`, `cutoff` | keep the default coverage-preserving opacity mips; do not re-filter the map |
| `cage-clip` | cage span | any sample of a group has facing detail outside its cage span: within `maxRay` beyond the ray's start (the start sits inside a feature, so the ray found a surface under it or nothing) or, when the ray found nothing, within `maxRay` past its end (a hole deeper than the cage). V2's 99 % ratio let a small stamp top or a pinhole vanish silently | `subject` (group id), `samples`, `clipped`, `offset`, `maxRay`, `hint`, `clusters` (one per clipped feature: `side`, `samples`, `worst`, `bounds`, `baseFaces`, `detailFaces`, `hint`); `provenance.groups[].clipped`, `.clipClusters` | raise `offset` above the tallest feature and `maxRay` past the deepest, or use the automatic cage; each cluster's `hint` names the values to raise, or the feature to bake as its own group |
| `stray-detail` | hovering part | samples landed on a detail part (welded by its source vertices, floaters excluded) whose smallest distance to the group's base exceeds the relief of the parts that touch it (plus 0.1 % of the diagonal): a foreign part the cage caught | `subject` (group id), `parts`, `gap` (meters), `samples`, `hint`, `clusters` (one per hovering part: `part`, `samples`, `gap`, `bounds`, `baseFaces`, `detailFaces`, `hint`); `provenance.groups[].stray`, `.stray.clusters` | move the part to its own bake group (`tags.groupPrefix`), tag it `tags.floater` if it is meant to float, or drop it from the detail |

`bakeTrimSheet` forwards the mesh-module bake's `pass` and `issues` (an analytic-only sheet
passes). The V5 re-derivation reads no AO or other map and leaves every output byte-identical.

`cage-clip` costs one extra any-hit ray per sample (two on a miss), `stray-detail` one
nearest-point query per detail vertex at preparation; both leave the output bytes unchanged
(`report.metrics.work` counts the extra visits).

Both issues group their findings into clusters (PIPELINE S5c), additive to the per-group
fields. A cage-clip cluster joins the clipped samples of one feature (adjacent cells of a
grid of 1/32 of the group diagonal, per `side`: `above` the cage start, `below` the cage end)
with its sample count, `worst` excess in meters, `bounds` (`min`/`max`, base-surface space) and
the base and detail face ids (FXEM face ids of the exported meshes, at most 32 listed, the
`*FaceCount` is exact); locating a clipped sample casts one more ray and leaves `work`
unchanged. A stray cluster is one hovering detail part with the samples it caught, its `gap`,
bounds and faces. Clusters are ordered by sample count and bounds (stray: by part), and Worker
parts merge by key (counts add, `worst` is a maximum, bounds a min and a max), so a Worker-split
bake lists the serial clusters. The issue `hint` and each cluster `hint` name the fix: raise
`offset` and `maxRay` by the worst excess, split the feature into its own group, or remove the
floater island (or tag it `tags.floater`). Gates (`bake-audit.unit.test.ts`): a cage starting 1 cm up under a 3 cm stamp fails where a 5 cm start passes,
a 0.1 m hole fails at `maxRay` 0.1 and passes at 0.2, a 0.2 m square hovering 0.1 m over the
plate fails (gap 0.05 m) and passes when tagged floater, and an attached stamp is not stray.
The same file also gates: a 4 mm bump on one of two stacked plates fails
`stack-conflict` below the ratio (identical plates pass), plates 9 mm apart fail it with a
height map only, a base corner of flipped handedness fires `tangent-seam` (a welded mirror seam passes), the cage of
a 0.1 m blind hole stays under 0.12 m, an unknown option names itself, and a chamfer crease
keeps its flat texels under the B-spline filter.

Pitfalls (each is measured by a gate in `bake-cage.unit.test.ts`):

- A fillet that spans fewer than about 6 texels shows a 5-10 degree step at the UV seam even
  with the averaged cage: that is its own gradient, not a seam. Raise the resolution or widen
  the bevel.
- The averaged cage skews detail away from the face normal over the whole face of a low
  poly box (a bolt 20 mm from a plate edge shifted 2.7 texels); use `{ blend }` or `'face'`
  for flat panels with floaters.
- `'face'` and `'shading'` open seams at hard edges (44 degrees on a rounded box); keep them
  away from rounded edges, or blend.
- A detail far from its base (a flange of another part) inflates the automatic cage of a
  shared group and leaks into neighbours: group the parts.
- `bleed` counts box-mip footprints; bilinear sampling at mip k also reads the neighbouring
  block, so keep one more level of padding where a chart edge must stay exact at mip k.
- Walls parallel to the rays are never sampled: a vertical step shows no curvature and no
  cavity at its foot. Slope or round such walls in the detail (`bake-maps` gate uses a
  frustum).
- Coverage-preserving opacity mips can only match coverage where alpha varies: a wire grid
  aligned to the texel grid gives few distinct alphas per level, so coverage moves in steps.
- With linear attenuation AO is lighter overall than the old full-hit AO; set
  `ao.attenuation: 'none'` to compare with older bakes.
- Low AO ray counts leave noise that dominates compressed size: `ao.denoise: 2` (texel
  radius) averages each texel with its chart neighbours whose detail normals agree,
  keeping contact shadows (gate: 8 rays reach 37% of the undenoised error to a
  512-ray reference).
- Under an `opacity` map, the other maps take only the samples whose ray hit the detail;
  transparent texels are filled from the hits around them by the gutter, so their mips
  stay consistent (gate: 3.5 against 49 degrees for nearest-point fallbacks).
- `resolution: [width, height]` bakes strips (trims): the mip chain runs down both sides
  and `protectMip` follows the shorter side.
- A detail that extends far beyond the base (a wall standing at the edge of a floor plate)
  trips the automatic cage limit; give such bakes an explicit cage.

In a Pack, `bakeSources({ base, detail, maps, resolution, key })` returns
`texture/<key>-<map>` `modeling-bake` cook sources instead; the project's build plugin
registers `createBakeCooker()` (`nativeCookers`), which runs the job once per distinct
bake outside the build timeout and publishes each map as an ordinary texture. The TS
backend identity digests every TS kernel source (bake, cage, BVH, voxel / remesh, charts,
skin weights and the boolean core), so a kernel change misses the cooker's DDC entries;
native Embree is deferred
(`compute: 'native'` is `model-capability-unavailable`).

**Compute-job cache.** `ComputeOptions.cache` (the `@forgeax/engine-types` `ByteCache`,
`{ get(key), put(key, bytes) }`) is a host result store consulted only by `runComputeJob`, keyed by
`computeCacheKey(request, backendIdentity)` (the `report.cacheKey` of every job). An entry
carries the digest of its key and body; a verified entry returns the stored result
byte-identical to a run (outputs, provenance, locations, status and metrics including
`work`), while a missing, corrupt or foreign entry runs the job and rewrites it. A
cancelled run, or an entry whose recorded work exceeds the current budget, is never
served. `bakeMaps({ cache })` forwards it; `createBakeCooker` and `createMeshJobCooker`
forward the cook host's `context.cache` (DevKit backs it with the project build DDC), and
an assets job receives it as `build(params, { packageId, cache })` for the jobs it runs, so
a geometry edit re-runs only the jobs whose inputs changed.

## Trim sheets: `trimSheet`, `uv.trim`, `uv.swatch`, `stamp`, `trimReport`

A trim sheet is one shared texture whose regions hold detail modules: the
runtime keeps a flat form (a quad or face run) and maps it into a region; the detail
exists only at build time, baked from a mesh or stamped from a height field.

```ts
const sheet = trimSheet({
  key: 'kitwall', size: 1024, density: 320, padding: 8,   // texels per meter of cells
  modules: [
    { id: 'louvre', size: [0.96, 0.24], tiling: 'u', period: 0.24, source: { kind: 'mesh', detail: slats } },
    { id: 'bolt', size: [0.13, 0.13], source: { kind: 'analytic', height: (s, t) => boltHeight(s, t) } },
    { id: 'recess', size: [0.1, 0.1], source: { kind: 'flat', material: 'dark' } },
  ],
});
if (!sheet.ok) throw sheet.error;
m.uv.trim({ faces: sel.tag('louvre'), region: sheet.value.regions.louvre, axis: [0, 1, 0] });
const maps = bakeTrimSheet(sheet.value, { maps: ['normal', 'ao', 'height', 'materialId'], texture });
```

- **Module space**: s along +x, t along +y, the module plane z = 0 facing +z, the lower-left
  corner at the origin; `size: [s, t]` in meters. Texel x runs along u and rows along v,
  and `uv.trim` maps an instance with u along its s axis and v along t = n x s, so the
  runtime tangent frame is the one the module was baked in (no mirroring).
- **Layout** (`trimSheet`, pure, no baking): fixed `rect`s first (a standardized layout keeps
  region ids and places), then `tiling: 'u'` strips across the whole width, top-down in
  declaration order (thin strips first), then cells tallest first, first fit on a
  `block` grid (default 4 texels, BC-aligned). A strip's density is `size / size[0]` (its
  length fills the width; sample with repeat addressing); a cell's is `density` (per module
  override for its closest view distance). `padding` (a `UvPadding`: even texels or
  `{ mips: k }` = 2^(k+1); default: the mips down to the 128-texel level, the one mip
  default bake `protectMip` shares, 16 texels at 1024) is the texel gap between contents, half at
  the border, edge-padded in the bake. `inset` (default 0.5 texel) borders every region
  content: `uv.trim` / `uv.swatch` map inside it (strips: along v only), so bilinear taps
  never reach a neighbor or, through repeat addressing, the opposite sheet edge (edge bleed); rects grow by 2 x inset so the content keeps the density.
  `fill: true` scales every auto cell by the largest common factor that fits;
  `fill: { grow }` (grow in [1, 2]) then grows each cell, largest first, by up to `grow`
  more (one scale bucket), so free texels are used. Each region reports `rect`, `uv`,
  `size`, per-axis `density`, `tiling` and `period`; the sheet reports `utilization`
  (content texels / sheet texels), `reserved`, `fillScale` and `densitySpread`.
- **`period`** divides `size[0]` a whole number of times, or `model-invalid-argument` (the
  repeat would not tile). A strip with `density`, duplicate ids, a rect outside the sheet
  or overlapping another are `model-invalid-argument`; regions that do not fit are
  `model-precondition` (lower the density, raise the size).
- **`m.uv.trim({ faces, region, axis?, fit?, offset?, anchor?, split? })`**: instances are face
  runs joined across edges that are not seams or sharp and turn by at most `split`
  degrees (default 30). Each is projected onto its own plane: u along `axis` (a world
  direction projected into the plane) or, by default, the long side of its minimal
  rectangle. Per axis, `fit` is `'metric'` (meters at the region density; the instance must
  fit, else `model-precondition`), `'fit'` (stretch over the region) or `'tile'` (u of a strip
  only: meters, repeating past the region; default there). `offset` shifts in meters;
  `anchor: 'world'` measures from the world origin so tiling continues across instances.
  Every instance lands in the same region (stacked): the info diagnostic reports instances,
  per-instance density along u and v, `densityDeviation` (largest relative difference from
  the region density) and `projectionError` (measured over planned density). Warnings:
  deviation above 10 % (stretched instances: declare a region or scale bucket at their
  size) and projection error above 2 % (a non-planar run: trim flat runs separately).
- **`m.uv.swatch({ faces, region })`** (swatch UVs): every face on its own
  stretched into the region inside its `inset` (the region owns it; default 0.5 texel), so
  bilinear taps never leave the region and a flat swatch colors the face exactly.
- **`bakeTrimSheet(sheet, { maps, samples?, cage?, ao?, slots?, filter?, detailNormals?, mips?, texture? })`**:
  maps from `TRIM_MAP_KINDS` (normal, ao, height, curvature, materialId, baseColor, emissive; `slots` as in `bakeMaps`, `report.emissiveScale`). Mesh modules go
  through one `bakeMaps` job, each module on its own plane far from the others (AO holds
  self-occlusion only), a strip with copies of its detail one length on
  either side so its ends tile; a plate at z = 0 (slot `trim-base`) catches rays unless the
  detail reaches below z = 0 (a detail with grooves brings its own floor) or
  `backing: false`. Analytic modules are rasterized: normals from the height gradient,
  cosine-weighted horizon occlusion (8 directions x 8 steps, the bake's bias), height and
  mean curvature on the bake's encodings; an analytic `normal(s, t)` (stamps give it)
  shades each sample by the surface it lands on, as a ray bake does, instead of a finite
  difference across a cliff; flat modules are the plane. Mesh bakes use `filter: 'none'`
  by default (the box-filtered supersamples analytic modules use, so both kinds filter
  alike; 'bspline' smooths as `bakeMaps` does). Every region is then
  edge-padded with its own border texels over half the padding. Defaults: `samples` 4,
  `cage: { offset, maxRay }` (the `bakeMaps` cage) 1.25 x the largest relief and twice
  that (analytic relief sampled at twice the texel grid; heights encode by
  `heightRange` = max(offset, maxRay - offset)),
  `ao.distance` 2 x the relief, detail normals autoSmooth 35 degrees, mips on; texture keys
  `<sheet key>-<map>`. Byte-deterministic.
- **Gates** (`trim.unit.test.ts`): the pilot region set lays out at 56.5 % (627 px fan,
  42 px bolt), 65.7 % with `fill: true`, 74.9 % with `fill: { grow: Math.SQRT2 }` (densities
  within a factor of sqrt 2); module-size quads in any placement land on the region
  corners within 1e-6 with zero density deviation; analytic normals match the field's
  gradient at p95 0.31 degrees; strips tile across the wrap with seam error 0 degrees (mesh
  and analytic), while the same mesh detail baked as a cell shows 21.6 degrees (falsifier);
  mesh and analytic sources of one relief agree at p95 1.0 / 1.0 degrees (both axes), AO
  within 0.018 mean and height within 0.002.
- **Reuse**: a module's `signature: { id, params }` is its canonical identity
  (numbers at 5 significant digits: M12 and M12.0001 match). Members with one content key
  (signature, or the FXEM digest of a mesh detail, or a flat slot) plus declaration, bucket
  and variant share one region: `metrics.dedupeHits`, `members[].alias`. One signature
  declared twice differently is `model-invalid-argument` (it would miss the dedupe).
  `scales: [..]` (cells) adds scale buckets at the module density and `variants: n` adds
  detail variants from a source factory `({ variant, scale }) => source` (a plain source
  scales with its bucket); regions are `<id>` for the bucket nearest 1, variant 0, and
  `<id>.s<bucket>v<variant>` otherwise, listed in `sheet.families.<id>`.
  `report.cacheKey` is the DDC key: the bake job's `computeCacheKey` (TS backend identity)
  over the settings and region keys; undefined when a region has no identity.
- **Families in `uv.trim`**: pass `region: sheet.families.bolt`; each instance takes the
  bucket nearest its size (geometric mean against the module size) and maps `fit` there,
  so sqrt 2 buckets keep density within 2^(1/4) - 1 = 19 %. `variation` picks per instance,
  from a hash of its centroid (0.1 mm) and `seed`: `variant` ('hash' by default with
  variants), `rotate` ('hash' or quarter turns; quarter turns on square cells only),
  `mirror` (mirrored UVs flip the tangent sign; export splits them, and uv.trim does not
  warn about them), `phase` (strips: a whole-period offset) and `hashTo: true` (the hash in
  the corner color alpha, the documented per-instance lane a material reads for tint or
  wear, until the surface contract names mask targets; default off).
  `tolerance` (default 0.1) sets the density warning.
- **`trimReport(sheet, meshes, { replaced?, cloneLimit?, bytesPerTriangle?, bytesPerTexel? })`**:
  attributes each UV island to the region holding its UV centroid (a strip by its band)
  and reports per region instances, utilization (texels some instance samples), measured
  density (min, max, mean, spread), scale range and mirrored count; per family clones (more
  than `cloneLimit`, default 8, instances with one region, one mirroring and one hash
  color: BK-V7) and, with `replaced` triangles per instance, the break-even
  (`savedBytes`, `regionBytes` = texels x 4/3 x 2.67, `instancesNeeded`, `worthIt`: BK-V10);
  for the sheet coverage, used texels, instances, islands outside every region, density
  spread, unused regions and dedupe counts. Warnings: clones, costly families, unused regions.
- **Stamps**: `stamp.boltHex({ across, height, chamfer?, rotation?, washer?, margin?,
  material? })` (the `recipes.hexBolt` head: 45 degree rim chamfer 0.05 x across),
  `stamp.rivet`, `stamp.hole` (dark slot 'hole', optional countersink), `stamp.slot`, and
  the tileable strips `stamp.groove` (v or u profile), `stamp.perforation` (square or
  staggered), `stamp.treadPlate` (crossed lugs), `stamp.knurl` (crossed V grooves,
  pyramids; period pitch / sin(angle)) and `stamp.weldBead` (crown with chevron
  ripples), plus `stamp.text({ text, height, depth })` (`textRegion` outlines rastered by
  `coverage` at 64 samples per cap height; negative depth engraves). Each returns
  `{ size, tiling?, period?, source, signature }` to spread into a module:
  `{ id: 'bolt', ...stamp.boltHex({ across: 0.018, height: 0.0075 }).value }`. Shapes are
  signed distances (planes for polygons, so chamfer faces are exact) with height profiles
  (flat top with chamfer, spherical dome, floor with walls), raised or cut in order.
- **Reuse gates** (`trim-reuse.unit.test.ts`, `stamp.unit.test.ts`): the analytic M12 head
  matches the `recipes.hexBolt` bake at p95 0.0 degrees (byte-identical normals) and AO
  MAE 0.026 (gate 0.035), and a 20 %
  larger head gives 45 degrees (falsifier); instances from 0.6x to 1.7x stay within 17.9 %
  of the density with sqrt 2 buckets and drift 66.7 % with one (falsifier); a wall of
  40 fans and 214 other parts reports 40 fan instances at coverage 0.5656, the fan
  break-even at 31 instances and the bolt at 3, clones without variation and
  none with rotate / mirror hashing; stamp strips (knurl included) tile with seam error 0 degrees.
- **Pitfalls**: map with `uv.trim` before exporting tangents (the frame derives from the
  UVs); keep a strip's u tiling on strips only (a cell has no repeat); trim each flat run
  separately (a box's faces are 6 instances by the 30 degree split); a `TrimSheet` keeps
  the module sources by reference, so bake before mutating a detail model.

## Thin holes and grilles: `thinHole`, `thinHoleCheck`

Vents, grilles and perforated plates a few millimeters thick are not worth through-geometry
in the runtime mesh (a rule of thumb): the runtime keeps one flat quad, the perforated plate
exists only at build time, and the holes are baked as an alpha-tested cutout or a shallow
recess. This is a recipe over `bakeMaps`; `thinHole` only builds its two sessions and the
settings, so nothing here is a new bake concept.

| Mode | Holes are | Bake | Runtime |
|:--|:--|:--|:--|
| `'opacity'` (default) | see-through | detail plate with real through-holes; `opacity` map (coverage-preserving mips) plus `height` of the solid plate | material `baseColorTexture` = the opacity map, `alphaCutoff` = `plan.cutoff`; a dark quad behind the plate stays real geometry |
| `'recess'` | blind pockets `depth` deep (at most the plate thickness) | detail plate over a floor slab at `-depth`; no opacity map | opaque material with `displacementTexture` from the `height` map (POM or vertex displacement) and the baked normal and AO |

```ts
import { bakeMaps, thinHole, thinHoleCheck } from '@forgeax/engine/modeling';

const plan = thinHole({
  width: 0.12, height: 0.12, diameter: 0.007, pitch: 0.011, pattern: 'hex',
  thickness: 0.0015, resolution: 512, maps: ['normal', 'ao'],
});
if (!plan.ok) throw plan.error;
const { base, detail, settings } = plan.value;                 // base: one quad, uv0 over [0, 1]^2
const baked = bakeMaps({ base, detail, ...settings });          // or bakeSources({ base, detail, ...settings, key })
if (!baked.ok) throw baked.error;
const report = thinHoleCheck(baked.value, plan.value);          // { pass, expected, measured, maxError }
```

- **`thinHole(options)`** returns `{ detail, base, settings, holes, openFraction, cutoff, mode,
  width, height }` or `model-invalid-argument` (non-positive or non-finite sizes, `diameter >=
  pitch`, fewer than 3 `segments`, `cutoff` outside (0, 1), a recess `depth` outside (0,
  thickness], a tile no hole fits). The tile spans [0, width] x [0, height] in the XY plane, the plate
  top is the base plane z = 0 facing +z, and holes sit on a `'square'` or staggered `'hex'`
  grid (`pitch`; hex rows `pitch x sqrt(3) / 2` apart), whole holes only. `detail` is a closed manifold
  that passes `validate()`; `openFraction` is the exact polygon area of the holes over the tile.
- **`settings`** are the bake settings: `samples: 4`, a cage of `offset = thickness` and
  `maxRay = 3 x thickness`, `height.range = [-relief, 0]` (relief is the plate thickness, or
  the recess depth) so the solid plate reads 1 and the pocket floor 0, and `opacity.cutoff`.
  Override any field by spreading after `...settings` (`maps` adds further kinds such as
  `ormh`).
- **Parallax never digs a see-through hole.** The height map of an opacity bake encodes the
  plate alone; a hole's texels are transparent, so POM must not run on this material (the
  hole is cut by alpha, not by depth). A backing that the hole should reveal is runtime
  geometry, not part of the bake detail. Using it as detail fills the holes (the opacity
  rays hit it), which `thinHoleCheck` reports as a failure.
- **`thinHoleCheck(bake, plan, tolerance = 0.05)`** compares the result with the exact area.
  Opacity: the alpha-test coverage (alpha >= cutoff) on every mip down to a 16-texel side
  stays within `tolerance` of the solid share `1 - openFraction`, so the holes neither
  close nor widen with distance. Recess: the share of mip-0 floor texels is within
  `tolerance` of `openFraction`. A missing map fails.
- **Expected bake warnings.** An opacity bake reports `ray-miss` (the holes are the misses
  by design) and `steep-wall` (the hole walls stand along the rays), both warnings. Judge
  the bake with `thinHoleCheck` and `validate()` of `detail`; do not silence the bake checks.
- **Choose by distance.** A hole smaller than about one texel at the closest view cannot
  be resolved: pick `'recess'` or flat shading there. Keep real geometry for holes
  seen at grazing angles at arm's length (classifier `classifyDetail`).
- Gate: `thin-hole.unit.test.ts` (exact open fraction and closed valid detail; hole centers
  alpha 0 and web alpha 1; mip coverage within 0.05 of the exact area; the backing-plate
  falsifier; recess floor and web heights). Example: [thin-vent](../examples/thin-vent/).

## Bake verification metrics (tools)

`@forgeax/engine-modeling/tools` (Node only) carries the image metrics that bake gates and
case reports use. Images are `ColorImage { width, height, rgb }` with sRGB-encoded values in
[0, 1] (`colorImage(width, height, rgba8)` from a readback, `readPng(bytes)` through the
Engine image decoder); `PixelMask` is one byte per pixel.

| Function | Definition | Validation |
|:--|:--|:--|
| `flip(ref, test, { ppd? })` | LDR FLIP, implemented from its published definition: CSF filtering in YCxCz, Hunt-adjusted HyAB color difference with the green-blue normalizer, edge and point feature detectors; `{ mean, p95, map }`, default 67.02 pixels per degree | a published reference pair: mean 0.159697 vs the published 0.159693 (test with `FORGEAX_FLIP_REFERENCE_DIR`; the images are not committed); green against blue is 1 |
| `ssim(ref, test, mask?)` | SSIM on luma, Gaussian 11 taps sigma 1.5, K1 0.01, K2 0.03 | identity, symmetry, monotonic in noise |
| `deltaE2000(lab1, lab2)`, `imageDeltaE(ref, test, mask?)`, `srgbToLab` | CIEDE2000, D65 sRGB | all 34 published pairs within 5e-5 |
| `shimmer(frames, mask?)` | mean per-pixel temporal standard deviation of luma over frames rendered at sub-pixel camera offsets (BK-V6 proxy) | 0 on still frames; an aliasing checker rises |
| `heatmapPng(map, width, height, max, mask?)` | an error map as a PNG (Engine PNG encoder), masked pixels gray | decoder round trip |

Silhouette IoU from ID / alpha passes is the kernel's `maskIoU` (one owner). Sizes that differ are a `RangeError` (a caller bug, as in the other tools).

## Golden bakes and `model.bake`

`goldenCase(shape, uvResolution?)` (`./tools`) builds a low-poly base with uv0 and a dense
detail of an analytic surface: `sphere` (r 0.5), `cylinder` (r 0.4, height 1, hard rims),
`bevelledBox` (unit box, edges rounded with r 0.1) and `torus` (0.5 / 0.2), with their
`GOLDEN_SURFACES` (signed distance and exact normal). `goldenReport(case, bakeResult,
{ resolution, distance, ao? }, thresholds?)` decodes every texel the base's uv0 covers
through the shaders' `applyTBN` with the exported frame, compares it in object space with
the analytic normal where the bake ray from `distance` outside along the base normal meets
the true surface, and compares the AO texel with the analytic open fraction of the same
ray cone (a 24 x 24 quadrature with sphere-traced visibility and the bake's attenuation,
`ao.attenuation` default `'linear'`; convex shapes are exactly open). The report is `{ pass, texels, normal: { p50, p95, p99, max }, ao: { mae, max },
issues }`; issues are `bake` warnings (`golden-normal`, `golden-ao`) beyond the gates
(p95 3 and p99 8 degrees, AO MAE 0.05).

Measured at 128 px with defaults (`golden.integration.test.ts`): sphere and torus p95 under
0.7 degrees, bevelled box 2.7 (its 12-segment bevel facets), torus AO MAE 0.0006 at 64
rays (linear attenuation). Falsifiers: a faceted detail fails the normal gate, half the AO distance misses the
AO truth (MAE 0.007), a mirrored tangent handedness is far off. A hard-rimmed cylinder
passes with the default averaged rays (max under 1 degree; before S1b they baked the cap
into the first side row).

`forgeax model bake --source a.pack.ts --base <session> --detail <session> --resolution N`
(`model.bake`) captures both sessions, bakes them with `bakeMaps` (the bake options as
arguments: `maps`, default normal and AO, `samples`, `distance`, `gutter`, `filter`,
`normals`, `detailNormals`, `ao`) and returns the `forgeax.model.bake/1` report: `pass`,
the sessions and outputs, the job metrics (ray hit ratio, covered, rays hits, nearest,
cache key), per-map channel statistics, and `issues` (`validate({ bake })` on the base and
the bake's own warnings). `--out <dir>` writes `<map>.png` (level 0, project-relative;
paths outside the project are `tool-invalid-args`). `--compare true` adds `model.render`
argument pairs of the high and low sessions over the front, three-quarter, top and grazing
views (`BAKE_COMPARE_VIEWS`) for visual review; the deterministic gate is the golden
harness, and the metrics above compare renders.
