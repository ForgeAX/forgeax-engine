# Export, delivery and reuse

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Export normals

`toMesh` / `finish` / bake `normals` take a `NormalMode`:

| Mode | Normals |
|:--|:--|
| `smooth` (default) | angle-weighted average over each normal group (split at sharp edges and boundaries) |
| `flat` | face normals |
| `autoSmooth` `{ angle }` | smooth groups split where faces meet above `angle` |
| `weighted` `{ bevelBorrow?, faceWeight? }` | corner angle x face area (mid-poly hard surface); `bevelBorrow` (degrees): faces under a fifth of their group's largest face drop out where a large face lies within that angle, so large faces stay exactly flat and bevels interpolate between their neighbours' normals; `faceWeight` multiplies the weight of faces with a tag |
| `surface` | `weighted`, with exact patch normals on `m.surface` faces (rule under Export, step 1); keeps the default weighted path off patches |
| `transfer` `{ from, sourceNormals? }` | each render vertex takes the interpolated normal of the nearest point of `from` (an FXEM snapshot; bake params carry it as base64) whose face points the same side; `from` exports with `sourceNormals` (default smooth); vertices split only at sharp edges |

Gates (`normals-export.unit.test.ts`): a 1 cm chamfer on a 1 m box keeps its large faces
within 0.5 degrees of flat with `bevelBorrow: 60` (measured 0; area weighting alone 0.81,
smooth 28.9); a flat 8 x 8 grid takes a dome's normals within 1 degree (measured 0.06; its
own 19.9). Pitfalls: `bevelBorrow` only helps where bevels are smooth-connected to the
large faces (do not mark the rails sharp); `transfer` follows the source's nearest point,
so a source far from the low poly (beyond its thickness) can pick the wrong side - keep
the source close, or mark creases sharp. The bake takes the same modes, so render the
base with the mode it was baked with.

## Export

`m.toMesh(options)` / `m.finish({ key, normals })`:

1. Compact, then group corners into normal groups: smooth across every non-sharp
   interior edge (`smooth`, `weighted`), never (`flat`), or below an angle
   (`autoSmooth`). Weights are corner angle, times face area for `weighted`.
   `surface` groups like `weighted` but gives exact patch normals to `m.surface` faces: a
   corner whose face carries its patch's name tag and `uv1` within 2e-5 m of that patch
   takes `patchNormal` (at a pole or zero-speed line, the limit normal from the interior when
   the one-sided normals agree within 1 degree), and a normal group (a vertex's smooth corner
   fan) takes the mean of its corners' exact normals, so a smooth patch seam keeps one
   normal. Each corner is judged on the candidate patch nearest its vertex. A corner off its
   patch (a T-junction or weld moved the vertex from its `uv1` point) does not contribute, but
   its patch normal there must still agree within 1 degree, since the vertex stands for that
   point too. A group with a corner of a non-surface face, with no corner on its patch, with a
   corner where the patch has no normal (a cone point: a zero-speed point whose one-sided
   normals differ), or whose normals differ by more than 1 degree (a crease left smooth across
   a seam, or a fan welded across a normal jump) takes the `weighted` normal. The report's
   `exactNormals` counts `[exact, all]` render vertices. `mirror` records each patch's
   reflection as `<name>.mirror` (`.k` appended if taken), so mirrored faces keep exact
   normals and surface checks name each half; the reflection reverses su x sv, and exact
   normals take their side from the face, so they still point outward. Other recorded patches stay where
   `m.surface` built them: after a translate or rotate, `uv1` still names the patch point but
   the vertex has moved, so those vertices take the weighted normal; when no vertex keeps an
   exact normal the report carries an `info` diagnostic.
2. Triangulate each face (strictly convex fan, otherwise ear clipping in its Newell
   plane that clips the best-shaped ear first and never leaves a straight run without
   an apex, so cut faces with collinear inserted points never emit slivers that
   collapse in f32).
3. Split render vertices exactly; group triangles by material slot in first-use order.
   A triangle that collapses or flips once positions round to f32 fails export, unless
   it is thinner than 4 f32 steps at its own coordinates: such a sliver of a valid face
   (small parts posed far from the origin) covers less than one representable step and
   is dropped and counted in `report.slivers`.
4. Derive tangents with Geometry's `computeTangentVec4`, then build through
   `createMeshBuilder`.

The report gives faces, triangles, GPU vertex count, slot names, bounds and dropped slivers.

With `checkTopology: true` (`toMesh`, `finish`; default off, so existing reports are
unchanged) the report adds `topology: { freeEdges, nonManifoldEdges, components }`. It welds
the source faces at distance 0 (bitwise-equal f32 positions, -0 equal to 0), so it sees what a
renderer-side re-weld of the exported buffer sees, whatever vertex ids the source used: a seam
one f32 step apart is open, bitwise-equal duplicates are closed. `freeEdges` counts welded
edges used by one face, `nonManifoldEdges` those used by more than two, `components` groups
faces connected through welded vertices. Dropped slivers (`report.slivers`) are the only
source faces the exported buffer can lack. `export-topology.unit.test.ts` re-welds the exported
buffer independently and asserts the same three counts.

## LODs

`finish` makes no LODs. Pass its outputs through Import's `generatePackMeshLods`
(`@forgeax/engine/import/mesh-lod-generator`), which adds `mesh/<key>/lod<n>` outputs under
per-level error budgets; sharp edges and UV seams limit hard-surface reduction.

`lodTopologyReport(lods)` checks the result without changing it. Per LOD it welds bitwise-equal
positions (split normals, UVs and sections stay closed) and returns `freeChains` (connected
boundary-edge chains), `nonManifoldEdges` (edges with more than two triangles) and
`boundarySetEqualsLod0` (the boundary edges, by welded position pair, equal LOD0's designed
set). A LOD passes when it has no non-manifold edge and its boundary set equals LOD0's.

Skinned LODs reduce joints with `reduceSkinForLod` ([rig](rig.md)): a per-LOD joint budget, `keep` for
sockets, merged weights renormalised and a reported pose displacement.

## Performance tiers

| Tier | Work | Budget |
|:--|:--|:--|
| Runtime adjust | a lightweight part rebuilt from changed parameters in a Worker (not per frame, not allocation-free): every operation, then `finish()` | p90 <= 100 ms |
| Offline | Pack build and cook generation; heavy work belongs in the MeshJob cooker | one build <= 7.5 s, half the 15 s Pack build timeout |

`bench/perf-tiers.ts` holds the deterministic case set (primitives, inset/extrude, twist and
bend, bevel, a boolean, subdivision, sweep, array, revolve and the hinge, gear and spring
recipes, support loops on a crease; boolean spike parts, voxel union, remesh, `uv.auto` and a G2 surface blend with isoparm export offline).
`src/__tests__/perf-tiers.unit.test.ts` gates every case's p90 against its tier budget and,
with `FORGEAX_UPDATE_GOLDEN=1`, rewrites `reports/perf-tiers.json` and `.md` (median, p90,
`finish()` time and per-operation `durationMs`). The gate measures the CPU time of its
thread where Node reports it (wall time otherwise), so a loaded host rarely fails it, and
measures an over-budget case up to three times; the budgets are absolute, the report numbers
host-dependent. `npx vitest bench bench/perf-tiers.bench.ts` runs the same cases interactively.

`bench/scale-f1.mjs` measures large-assembly scale: it appends `--parts` (default 400) bevelled
cylinders into one session (606 k triangles at the defaults), exports it and runs Import LOD
generation plus `lodTopologyReport`, then writes `reports/scale-<date>.json` with faces,
triangles, per-phase milliseconds (build, export, lod, lodTopology), `peakRssMb`
(`process.resourceUsage().maxRSS`), `peakHeapUsedMb` (sampled at phase boundaries; add
`--expose-gc` to start from a collected heap), per-LOD triangles and a linear extrapolation to
`--target-triangles` (default 750 000) with its factor stated. It needs a built `dist`
(`npx tsup`), is a measurement with no threshold, fails only on an error, and uses a
synthetic assembly rather than a finished form. `scale-f1.unit.test.ts` runs it on a tiny fixture.

## Reuse across Packs

Design 10.1 names three ways to reuse modeling work. They are ordinary Pack mechanisms;
modeling adds none. `examples/desk-lamp/` uses each one, and
`examples/desk-lamp/__tests__/reuse.integration.test.ts` runs each one through the real
Pack loader (`scanInventory` and `loadScriptablePack` in the isolated Worker, and the
instance resolved through its parent).

| Path | Mechanism | Cache | Portable source | Keeps tags, labels, n-gons | Use for |
|:--|:--|:--|:--|:--|:--|
| Function reuse (default) | static `import { buildLamp } from './lamp.ts'` of a recipe module | the whole Pack, by its source closure | yes | yes | recipes, style primitives, splitting one author's build |
| Parameter variant | `lamp-tall.pack.json` instance: `{ packageId, parent, values }` | each instance on its own (own `packageId`, so own output GUIDs) | yes | yes | product lines, size steps |
| Product reuse (exception) | `readByGuid(AssetGuid.derive(upstream, 'mesh/lamp'))`, then `m.lift(mesh)` | the upstream Pack only; the reader rebuilds every time | no (needs the upstream outputs) | no: lifted triangles keep material slots, UVs and hard edges only | a very expensive upstream, or one maintained by someone else, when the downstream only places, merges or booleans whole parts |

- Prefer function reuse: the downstream keeps addressing the upstream's tags and roles
  (`sel.createdBy('shade', 'side')`), the build stays one deterministic unit, and the
  source moves with the Pack. Relative imports carry `.ts`.
- An instance changes values, never code; its parameters and bounds come from the parent
  declaration (`asset inspect --parameters-only` checks them without building).
- Product reuse drops the upstream's modeling identity: re-establish it with tags on the
  lift (`lift(mesh, { label, tag })`) and `dissolve(sel.edges.dihedral('<', deg))` when
  n-gons matter. `forgeax model *` captures cannot follow `readByGuid` (the build reports
  `model-capability-unavailable`); inspect the upstream Pack instead.
