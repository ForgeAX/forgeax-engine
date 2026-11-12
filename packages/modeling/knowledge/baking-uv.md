# Baking and texel economy

Baking moves surface detail from a dense **detail** model onto a light **base** model as maps
(normal, AO, height, material id and more), so the base can stay low-poly while keeping its
look. It matters whenever a part carries many small repeated features (bolts, panel lines,
louvers, vents), or when a triangle budget forces detail into textures. The API owner is
[`reference/uv-bake.md`](../reference/uv-bake.md) (`bakeMaps`, `bakeSources`, `trimSheet`,
`bakeTrimSheet`, `trimReport`, `thinHole`); the checks it runs are listed in
[`reference/validation.md`](../reference/validation.md). UV layout (seams, unwrap, pack) is the
companion topic in [uv-cuts-lowpoly.md](uv-cuts-lowpoly.md); export normals are in
[`reference/export.md`](../reference/export.md). This page covers what to decide, what the
tools measure, and how to recover from each failure code.

## Decide first: should this detail be a texture at all

A triangle costs on the order of 100 bytes of vertex and index data; a compressed texel costs
about 4 bytes. Detail is worth baking when it is small, dense and repeated, and when its
silhouette does not matter at the viewing distance. It is not worth baking when:

- it forms a large plane's bevel or a visible silhouette edge: keep it as geometry;
- it is a buried face that no view can see: delete it from the detail, never bake it;
- it is a hole or vent that must read from the side: bake an opacity map or use `thinHole`
  (see below), not a normal map.

`trimReport(sheet, meshes, { replaced, cloneLimit, bytesPerTriangle, bytesPerTexel })` turns the
break-even into numbers (`worthIt`, `savedBytes`, `regionBytes`, `instancesNeeded`): a shared
trim sheet only pays when enough instances reuse it. Treat its verdict as a measurement and
the byte constants as arguments you can change.

## The bake in one picture

One correspondence pass drives every map. Each base sample casts a ray from `cage.offset`
outside the base, along the direction field, inward at most `cage.maxRay`, and takes the first
detail triangle of its own bake group that faces the ray (within 84 degrees). A miss takes the
nearest facing detail point of that group, and the miss is counted. Everything else (normal,
AO, height, thickness, material id) is a different readout of the same hit.

Consequences worth holding in mind:

- The base and detail must overlap in space. The base is the thing that renders; the detail is
  only a source and is never exported.
- Walls parallel to the rays are never sampled. Slope them in the detail (a few degrees) or
  accept a visible stretch. The `steep-wall` check measures this.
- A detail that hovers far from the base inflates the auto cage of a shared group. Give such a
  part its own group.

## Groups, floaters and the cage

Tag base and detail faces `bake:<id>` (`tags: { groupPrefix: 'bake:' }` by default). Rays find
only their own group's detail, so neighbouring panels cannot print onto each other. Rules the
bake enforces: a face with two group tags, or a base group with no detail faces, is
`model-precondition`.

- **Floaters** (`tags.floater`) are detail parts that sit on the surface without being the
  surface: bolts, plates, rivets. They bake into the normal map, but height reads the solid
  detail under them and AO never sees them, so a bolt does not darken its own panel.
- **Cage**: `cage: { offset, maxRay }`, each `'auto'` (default) or meters. Auto is measured on
  a grid of 1/64 of the group diagonal: offset is the largest outward distance times 1.05, and
  maxRay is that offset plus the largest inward distance times 1.05, each at least 0.1 percent
  of the diagonal. An auto offset or depth beyond 20 percent of the group diagonal is
  `model-precondition`: split the group, or pass an explicit cage. `provenance.groups` reports
  the cage actually used, the sample counts, the ray hits and the nearest-point fallbacks, so
  read it before tuning anything by eye.
- **Direction**: `'averaged'` (default) is continuous across hard edges; `'shading'` opens
  seams at hard edges; `'face'` keeps floaters in place but leaves gaps at hard edges;
  `{ face: tag }` and `{ blend: meters }` mix them. For hard-surface panels `{ blend }` is the
  usual compromise. The averaged field skews floaters on low-poly flat faces, which is the
  symptom that says switch to `blend` or `'face'`. The vertex target accepts only `'averaged'`
  or `'shading'`. `report.metrics.hardEdges` counts the hard edges the direction field met.
- Per group overrides live in `groups[id]` (cage and direction).

## Choosing maps

`maps` is a list of kinds; each has its own knobs, all documented in the reference.

| Map | Use it when | What to watch |
|:--|:--|:--|
| `normal` | any lit surface detail | exact inverse of the shader frame, see tangent contract |
| `normalObject` | comparing, debugging | tangent independent, so a mismatch with `normal` points at the frame |
| `ao` | crevice darkening | `ao.rays` (32), `ao.distance` default is per group min(0.1 x diagonal, 0.5 m); low ray counts leave noise, `ao.denoise: 2` smooths it |
| `curvature`, `edgeWear`, `cavity` | wear masks, edge highlights | curvature uses the 95th percentile; `edgeWear.range` defaults to [0.15, 0.5] |
| `height` | parallax, displacement | `range` and `bits: 16` for smooth ramps |
| `position`, `thickness` | masks and translucency | `thickness.distance` bounds the ray |
| `opacity` | vents, grilles, cut-outs | `cutoff` 0.5; mips preserve coverage |
| `materialId` | splitting regions in a shader | never filtered |
| `ormh` | one packed texture | R AO, G roughness, B metallic, A height |
| `baseColor`, `emissive` | transferring painted slots | `slots` per slot, `'*'` as default |

Mix and match by intent, not by habit: every extra map is another texture to ship. The
packed `ormh` map exists because four channels in one texture is cheaper than four textures.

## The tangent-space contract

The normal map is the exact inverse of the shaders' tangent-basis transform, using the
tangent frame that export derives (`computeTangentVec4`). It is only correct if the base is
rendered with the same normal mode it was baked with: pass the base's export mode as
`normals` (and the detail's as `detailNormals`, default autoSmooth 35 degrees), and export
with the same mode. Examples pin one constant for both (`armor-bake`). If a baked surface
shows faint seams along hard edges, compare against `normalObject` first: if it is clean, the
frame, not the bake, is at fault.

Mirrored or stacked UVs flip the tangent sign. Export splits corners where uv0 handedness
changes, and the `tangent-seam` issue flags corners that disagree. Mirrored halves are fine;
just do not weld across the mirror line and expect one smooth normal.

## Bake checks and recovery

`bakeMaps` returns `Result<BakeResult>`; `result.pass` is the gate. `issues` are
`Issue<Code>`, all severity `warn`, and the maps are still delivered, so read them as
measurements.

| Code | Trigger | Recover |
|:--|:--|:--|
| `ray-miss` | fewer than 99 percent of samples hit | widen `cage.maxRay`; check the detail covers the base |
| `steep-wall` | more than 3 percent of detail area within 15 degrees of the rays | slope walls in the detail, or change direction |
| `mip-bleed` | a chart mixes with a neighbour at the protected mip | more `padding`, `gutter: 'fill'`, or a higher `protectMip` |
| `stack-conflict` | stacked or mirrored samples disagree (over 5 degrees normal, over 2 percent height) | unstack the differing part, or make the detail symmetric |
| `tangent-seam` | corners disagree in handedness | split the seam in UV, or keep mirrors on a hard edge |
| `opacity-coverage` | mip coverage drifts by more than 0.05 | raise resolution or thicken the feature |
| `cage-clip` | the cage cuts through detail (`clusters`, `side` above or below, `hint`) | enlarge offset or maxRay in that group |
| `stray-detail` | a detail part hovers apart from the surface | put it in its own group, or tag it floater |

An option the bake does not read is `model-invalid-argument` with `detail.option`, so a typo
in a nested key fails loudly. `compute: 'native'` is `model-capability-unavailable`.

Mesh-time checks run before any bake: `validate({ bake: { checks, view } })` with
`BAKE_CHECKS` offers `sharp-not-seam` (a hard edge whose uv0 is continuous across it, which
will print a smoothed seam) and `subpixel-bevel` (a bevel narrower than a texel at
`view: { distance, fov?, height? }`). Run these on the base before you spend a bake.

## Mips, gutters and padding

Mips blend neighbouring charts. `provenance.bleed[k-1]` reports how many pixels of mip k
reach outside a chart; `protectMip` (default: the level where the shorter side reaches 128
texels, 3 at 1024) is the lowest level that must stay clean, and `metrics.protectedBleed`
counts violations. Pack with `padding: { mips: k }`, which means 2^(k+1) texels, and keep
`gutter: 'fill'` so the gap carries edge colour. Bleed counts box-mip footprints; bilinear
reads one more neighbour block, so add a level where an edge must stay exact. Padding costs
atlas area, so only the protected levels earn it.

Reconstruction: the default `filter` is a cubic B-spline inside each chart, which blurs
creases (about 9.5 degrees p95 on a 45 degree chamfer). Use `filter: 'none'` for hard
creases (about 0.3). `samples` (1, 4, 9, 16) supersamples per texel. A fillet narrower than
about 6 texels shows a step at the seam: give it more texels or leave it as geometry.

## Trim sheets: shared detail for many parts

A trim sheet bakes repeated strips and cells once and lets many parts map into them.
`trimSheet({ key, size, density, padding, modules, fill, inset, slots })` lays out modules
(`tiling: 'u'` strips with a `period` that divides `size[0]`, fixed `rect` cells, `density`
overrides) and reports each region's `rect`, `uv`, `size`, `density`, plus sheet
`utilization`, `reserved`, `fillScale`, `densitySpread`. Layout order: fixed rects, then
strips top-down, then cells tallest first on a 4-texel grid. `padding` defaults to the
mips-to-128-texel level; `inset` defaults to half a texel; `fill: true | { grow }` expands
modules to use spare space.

Module sources: `{ kind: 'mesh' }`, `{ kind: 'analytic' }`, or `{ kind: 'flat' }`. The
`stamp.*` helpers (`boltHex`, `rivet`, `hole`, `slot`, `groove`, `perforation`, `treadPlate`,
`knurl`, `weldBead`, `text`) each return a Result with `size`, `tiling?`, `period?`,
`source` and `signature`.

Use the sheet on geometry with `m.uv.trim({ faces, region, axis?, fit?: 'metric' | 'fit' |
'tile', offset?, anchor?: 'world', split?, variation, tolerance })`. It warns when density
deviates by more than 10 percent or the projection error exceeds 2 percent. Trim each flat
run separately, and trim before exporting tangents. `m.uv.swatch({ faces, region })` maps a
face to a flat swatch. `bakeTrimSheet(sheet, { maps, ... })` bakes the sheet itself
(`TRIM_MAP_KINDS`: normal, ao, height, curvature, materialId, baseColor, emissive). A strip
tiles seamlessly; a mesh detail baked as a cell shows its seam instead, so keep tileable
detail in strips.

## Thin holes and grilles

Normal maps cannot cut a hole. `thinHole(options)` builds the base and detail sessions for a
vent or grille in `'opacity'` or `'recess'` mode, and `thinHoleCheck(result, plan)` returns
`{ pass, expected, measured, maxError }` so the hole you asked for is the hole the map holds.
See `examples/thin-vent`.

## Determinism, caching and scale

Rays use a binned SAH BVH with deterministic tie-breaking, so output depends only on inputs.
`bakeMapsParallel(options, executor)` with `bakeWorkers({ workers })` from
`@forgeax/engine-modeling/tools` (Node only) splits the work with byte-identical output for
any split; each Worker repeats the preparation, so small bakes gain little. For Pack builds
use `bakeSources({ base, detail, maps, resolution, key })`, which returns
`texture/<key>-<map>` sources cooked by `createBakeCooker()` (`nativeCookers`); a
`ComputeOptions.cache` (ByteCache keyed by `computeCacheKey`) skips unchanged bakes.

## Verifying a bake

Compare renders, not just maps. `tools` offers `flip`, `ssim`, `deltaE2000`, `imageDeltaE`,
`shimmer`, `heatmapPng` and `maskIoU`; `goldenCase` and `goldenReport` give a reference
scene with thresholds (p95 3 degrees, p99 8 degrees, AO mean error 0.05). The CLI route is
`forgeax model bake --source a.pack.ts --base <session> --detail <session> --resolution N`
(report `forgeax.model.bake/1`, `--out`, `--compare true`).

## Runnable shape (examples/armor-bake)

```ts
import { bakeMaps, model, sel } from '@forgeax/engine-modeling';

const BASE_NORMALS = { mode: 'autoSmooth', angle: 40 } as const;
// base: b.markSharp(sel.edges.dihedral('>', 40)); b.assign(sel.all(), 'baked');
//       b.uv.auto({ resolution, padding: 8 });
const baked = bakeMaps({
  base, detail,
  maps: ['normal', 'ao', 'materialId'],
  resolution: 1024,
  normals: BASE_NORMALS, detailNormals: BASE_NORMALS,
  mips: false,
  ao: { rays: 32, distance: 0.05 },
});
if (!baked.ok) throw baked.error;
```

In a Pack, `bakeSources({ base, detail, ...settings, mips: true, key: 'armor' })` publishes the
same maps as textures (`armor.pack.ts`). `examples/mech-gt` shows the production habit of
one `uv.auto` atlas per group with a per-group resolution, then measuring the resulting texel
density per group.
