# UV cuts, packing and low-poly delivery

A game mesh needs a clean UV layout (seams, flattened islands, an atlas) and a controlled
triangle budget (union, simplify, LODs). This page is about the decisions behind both: where
to cut, which flattening method to use, how to pack, how to get one low mesh from many
overlapping parts, and what the checks mean. It matters before any bake
([baking-uv.md](baking-uv.md)) and before export. The API owners are
[`reference/uv-bake.md`](../reference/uv-bake.md) (`uv.project`, `uv.unwrap`, `uv.pack`,
`uv.auto`, `measureUv`), [`reference/voxels-remesh.md`](../reference/voxels-remesh.md)
(`lowpoly`, `simplify`, `cleanup.*`, `remesh`) and [`reference/export.md`](../reference/export.md)
(normal modes, LODs, `lodTopologyReport`). Failure codes are in
[`reference/validation.md`](../reference/validation.md).

## Seams are a shading decision as much as a UV one

A hard (sharp) edge splits normals at export; a UV seam splits texture coordinates. The two
should coincide: if an edge is sharp but its uv0 is continuous, the baked normal map has to
paint a discontinuity across a texel row, and the bake check `sharp-not-seam` reports it
(`validate({ bake: { checks: ['sharp-not-seam'] } })`). So mark hard edges first
(`markSharp(sel.edges.dihedral('>', 40))`) and let them be seams: `uv.unwrap({ seams: 'sharp' })`
and `uv.auto` (with `respectSharp`, default true) both do that.

Further considerations for the rest of the cuts:

- Hide soft seams where nobody looks: concave areas, undersides, back faces, and along
  existing panel lines.
- A cylinder-like part is cut along one generatrix (a straight line on its side); a straight
  cut flattens to a straight border, which packs well and keeps strips straight.
- Mirrored or repeated parts can share UV space (`uv.pack({ stack: true })`), halving the
  texel cost. A mirrored island flips the tangent sign; export splits those corners, and the
  `tangent-seam` and `stack-conflict` bake checks tell you when the difference matters.
- Mark a seam on a closed surface: an island with no boundary cannot be flattened and fails
  `model-precondition` with the hint to mark one (`markSeam(selector)`).

## Choosing a flattening method

`uv.project({ mode: 'box' | 'planar' | 'cylinder', scale, faces?, channel? })` is the quick
first map: it never distorts planar faces but overlaps freely. Use it for tiling materials, as
a "before" state, or as the required initial `uv0` (finish rejects faces without it).

`uv.unwrap({ faces?, method, seams, pins, refine })` flattens per island:

| Method | Character | Use it for |
|:--|:--|:--|
| `lscm` (default) | conformal: preserves angles, lets area vary | general organic and mixed islands |
| `expmap` | geodesic polar coordinates, local | small, nearly developable patches (badges, decals) |
| `rectify` | straightens quad grids into rows and columns | chamfer ribbons, revolved bands |
| `refine: 'slim'` | reduces stretch after the first layout, gated | islands whose stretch is too high |

Trade-off: conformal layouts keep shapes but waste or distort area; isometric-minded
refinement keeps texel density even but cannot always fold out. Judge by the metrics, which
each unwrap reports: Sander L2 and L-infinity stretch (1 is isometric), area distortion (warns
at 4 or more; cut long strips with pockets into more islands), flipped or zero-area triangles,
and texel density dispersion. SLIM only replaces the layout when the gate passes (no flips,
lower energy, no more overlaps, no wider density spread); each island reports
`refineStatus` (`accepted`, `no-gain`, `flipped`, `overlap`, `density`, `unavailable`,
`rectified`), so a rejected refinement is information, not an error. Rectify warns at area
distortion of 1.25 or more, which usually means the island is not a real grid.

Errors to know: `model-precondition` (no boundary), `model-degenerate` (collapsed island),
`model-solver-diverged` (LSCM did not converge; it carries `method`, `iterations`,
`residual`, `island`). Cut the island smaller or mark a seam.

## Automatic charts: `uv.auto`

`m.uv.auto({ resolution, padding, maxCharts, maxDistortion, respectSharp, method, refine, pack,
budget })` (plus the chart normal-spread limit, see the reference) seeds charts by farthest-point sampling, merges neighbours
while each chart stays a disk within the normal-spread limit (default 45 degrees) and
`maxDistortion` (default 1.5), then unwraps and packs. Guarantees and tunables:

- Marked seams, open edges and (by default) sharp edges are hard boundaries; the info
  diagnostic counts `crossedEdges`, and the intent is zero.
- Every separate part is at least one chart, so `maxCharts` (default 100) is a seeding
  target, not a quota; if validity needs more, a warning says so with the part count.
- A chart that cannot be a disk or stay within limits is split until it can; `slitSplits`
  counts splits at crease ends. `fallbacks` counts islands where LSCM was worse than the
  ExpMap start and the start was kept.
- `pack: { method, rotate, stack, density }` forwards to `uv.pack`.
- A tight `budget` makes a large model fail rather than hang; production atlases of many
  panels can need a bigger budget (see the per-group `budget` in `examples/mech-gt`).

Union once, then triangulate once, then unwrap and bake. Parts that merely overlap bake
buried faces into the maps and waste texels, so combine them first with `m.lowpoly(rigid,
{ targetFaces: <large>, quads: false })` (exact union, no reduction) and gate the result with
`m.validate({ shells: { expected } })`: `shell-overlap` reports crossing shells (error,
`reason: 'crossing'`) or an unexpected component count (warn, `reason: 'component-count'`).

## Packing and texel density

`m.uv.pack({ resolution, padding, normalize, rotate, method, stack, density, with })`:

- `padding` is texels between islands (half at the border); `padding: { mips: k }` means
  2^(k+1) texels, enough to keep islands apart down to mip k (see the mip discussion in
  [baking-uv.md](baking-uv.md)). Padding is wasted area, so pay only for protected levels.
- `method` defaults to skyline rectangles; `method: 'raster'` packs conservative cell masks,
  fills holes and concave charts, never fits worse than skyline, but costs seconds on
  hundreds of islands.
- `rotate` (default true) turns islands to their bounding rectangle; `{ step: 45 }` adds
  eighth turns; `normalize` (default true) scales islands to their 3D area so density is even.
- `stack: true` gives congruent islands one shared placement (metric `stacked`).
- `density: { target, tolerance? }` packs at a fixed texels-per-metre target and may shrink
  to target x (1 - tolerance) or fail `model-precondition`.
- `with: [models]` shares one atlas across sessions: pass the same list to every session.

Measure rather than guess: `measureUv(mesh, channel?)` gives per-island and total density;
`validate({ texelDensity: { resolution, target, tolerance? (0.2), channel? } })` raises one
`texel-density` warning with `min`, `max`, `outside` and the worst islands, or
`missing-channel` for faces lacking the channel. `validate({ uniqueUv: true })` reports
`uv-overlap`; unintended overlap, unlike stacking, corrupts baked maps. Other UV codes:
`uv-degenerate` (zero-area or inverted UV triangles) and `uv-missing`.

Density is a judgement about where the eye lands: spend texels on hero surfaces, trade down
on undersides, and keep one density across neighbouring parts of one object so seams do not
jump. Choose a per-group atlas resolution, then verify it with a density measurement, as the
`texelDensity` helper in `examples/mech-gt` does.

## Low-poly delivery: `lowpoly`, `simplify`, cleanup

`m.lowpoly(faces?, { targetFaces, union, hardAngle, silhouette, quads, slivers, uv, tags })`
composes union, simplification, quad pairing, optional UVs and bake-group tags into one
game-ready shell.

- `union.mode`: `'auto'` (exact booleans, retrying order-fragile parts), `'exact'` (return
  the failure), `'voxel'` (rebuild the whole set). A mixed or voxel union rebuilds surface
  and loses labels, materials and corner values; the report `lost` counts what went.
  `union.voxelSize` aligned with the parts' planes avoids both slowness and drift.
- Edges above `hardAngle` (45) become sharp; `silhouette: { views, weight }` guards shape
  during reduction; `quads: false` skips tiling and pairing; `slivers: width` runs
  `cleanup.slivers`; `uv` runs `uv.auto`; `tags: { groupPrefix }` labels each output
  component for baking.
- Open or inside-out input parts are `model-precondition` (detail `part`, `volume`,
  `closed`), never a fallback.

The report is an `Issue<LowpolyIssueCode>` list, all warn:

| Code | Meaning |
|:--|:--|
| `not-closed` | an output component is open or has no volume |
| `deviation` | Hausdorff distance over 2 percent of the diagonal |
| `silhouette` | view IoU under 0.97 (reported only with `silhouette` views) |
| `quad-ratio` | quad area ratio under 0.85 |
| `planarity`, `valence` | quads not flat enough, or poles beyond the limits |
| `over-budget` | more triangles than `targetFaces` |

Also read `hausdorff`, `signed` (how far the low surface sinks inside or rises outside the
shell) and `iou`. The deviation is measured against the unioned shell, so interior faces the
union removed are not error.

Finer tools: `m.simplify` (quadric error; `clearance`, `maxAspect`, `maxValence`, `silhouette`,
`maxError`), `m.cleanup.quads(faces?, { maxAngle: 15, maxPlanarity: 0.02 })`,
`m.cleanup.tiling(faces?, { maxError, maxAspect: 5, iterations: 10, clearance, preserve })`
(flips fans toward Delaunay; a pitfall of simplify is collinear fans no quad can take, so
simplify with `maxAspect: 4` first), `m.remesh` for even density, and
`m.cleanup.slivers(faces?, { width, quiet? })`. Keep sliver widths at or below 2 mm; larger
removals can fail with `model-degenerate` and roll back. Gate with `validate({ slivers:
{ width, part? } })` (`face-degenerate`, `reason: 'sliver'`).

## LODs and what must survive them

`finish` makes no LODs. `generatePackMeshLods` (`@forgeax/engine/import/mesh-lod-generator`)
adds `mesh/<key>/lod<n>` outputs under error budgets; sharp edges and UV seams limit
reduction. Verify without changing anything: `lodTopologyReport(lods)` returns, per LOD,
`freeChains`, `nonManifoldEdges` and `boundarySetEqualsLod0`. A LOD passes when it has no
non-manifold edge and its boundary set equals LOD0's designed boundary: a hole that LOD1
opens is an error, and an opening that LOD0 designed must remain. Skinned LODs also need
joint reduction (`reduceSkinForLod`, see [`reference/rig.md`](../reference/rig.md)).

Hard-surface bevel ribbons are the common UV trap: they are long, curved quad strips.
Cutting them at sharp edges (via `uv.auto` or `seams: 'sharp'`) and flattening with `rectify`
gives straight strips that pack tightly.

## Runnable shape (examples/wheel-uv)

```ts
import { model, sel } from '@forgeax/engine-modeling';

// tire: a revolved section; first a box projection (overlapping "before" state)
tire.uv.project({ mode: 'box', scale: 2 });
// two opposite radial seams and the sidewall boundaries
tire.markSeam(radialLine(1).or(radialLine(-1)));
tire.markSeam(lowerWall.boundary().or(upperWall.boundary()));
tire.uv.unwrap({ method: 'lscm' });                    // grooved/pocketed strips warn
tire.uv.unwrap({ method: 'lscm', seams: 'sharp' });    // ribs and pockets become islands
tire.uv.pack({ resolution: 1024, padding: 8 });
// a badge on the cap is a small developable patch
cap.uv.unwrap({ method: 'expmap', faces: sel.createdBy('badge', 'top') });
// both parts share one atlas in the wheel session
wheel.uv.pack({ resolution: 2048, padding: 8 });
```

`radialLine`, `lowerWall` and `upperWall` are selectors built in the example; read
`examples/wheel-uv/wheel.ts` for them and the final
`finish({ key: 'wheel', normals: { mode: 'autoSmooth', angle: 40 } })`.
`examples/armor-bake` shows the shorter route: mark sharp edges, then `uv.auto({ resolution,
padding: 8 })`.
