# Examples

These are build-time Pack examples of `@forgeax/engine/modeling`, smallest first; the package README's reference map ([../README.md#reference-map](../README.md#reference-map)) links each capability to its reference file.

Examples import the physical packages (`@forgeax/engine-modeling`, `@forgeax/engine-render`, ...) because they
live inside the Engine workspace; a Pack anywhere else imports the same exports through the
`@forgeax/engine/<package>` subpaths (`@forgeax/engine/modeling`, `@forgeax/engine/render`).

| Example | TS lines | Teaches |
| --- | ---: | --- |
| [limit-cage](limit-cage/) | 38 | `subdivide`, `scale` with `sel.facing`, `snapToLimit`, `checkpoint` in straight-line code |
| [crease-neck](crease-neck/) | 45 | Fractional `crease` sharpness on a rim, `snapToLimit` onto the refined cage |
| [limb-choreography](limb-choreography/) | 66 | `rig.choreograph` motion with held read points, space claims and stop checks |
| [bracket](bracket/) | 93 | `extrude`, `fillet`, `bevel`, `sel.createdBy`, `sel.edges.dihedral` and `sel.edges.concave` |
| [feature-bracket](feature-bracket/) | 99 | Parametric rebuild with `sel.createdBy` provenance selectors instead of indices, `regen` stability |
| [tunic](tunic/) | 105 | `layer`, `shrinkwrap`, `knife` projection, `revolve`, `sel.tag`, `sel.near` on a garment |
| [wheel-uv](wheel-uv/) | 115 | `uv.unwrap` (LSCM, ExpMap) with seams, `uv.pack`, `inset`, `sel.inBox` |
| [spec-single-source](spec-single-source/) | 134 | One spec module owns lengths and landmarks; two parts and a `derived` drawing read it, `validate({ drawing })` flags a stale part |
| [crate](crate/) | 120 | First prop: `inset`, `extrude`, `shell`, `mirror`, `append`, `assign`, `checkpoint`, `sel.extreme` |
| [pauldron](pauldron/) | 122 | `subdivide` with sharp creases, `taper`, lattice dome, `rig.finish` binding parts to a skeleton |
| [door-hinge](door-hinge/) | 127 | `recipes` hinge parts, `clearanceRadius` bolts, `rotate` assembly, `panelLine` grooves |
| [hole-catalogue](hole-catalogue/) | SC-L3 | `hole` simple, counterbore, countersink and tapped (through and blind), `threads` catalogue, modeled helical thread with a bolt seated in it, `tolerance` segmentation |
| [joint-boot](joint-boot/) | 128 | `MeshJob` cook via `meshJobSources`: voxel union, remesh, `simplify`, `markSharp` clamps |
| [housing](housing/) | 138 | `inset` slots, `shell` hollowing, `bisect` planes, screw bosses and ribs |
| [panel](panel/) | 143 | Boolean `difference`/`union`/`intersect` jobs, `array` hole grids, `splitBy` |
| [sketch-bracket](sketch-bracket/) | 120 | `sketch.solve` constraint profile (tangent slot, bore, slanted edge) with `dof`, extruded with `extrudePolygon` |
| [armor-bake](armor-bake/) | 145 | `uv.auto` charts plus `bakeMaps` normal, AO and material-id maps from a detail mesh |
| [thin-vent](thin-vent/) | 90 | `thinHole` grille as an opacity cutout over one flat quad, `thinHoleCheck` mip coverage, a real dark backing quad |
| [sheet-bracket](sheet-bracket/) | 94 | `sheet` flat pattern with bends, K-factor allowance, folded body and the `drawingDxf` export of the pattern |
| [plate](plate/) | C-700 | `brep.box` -> `fromShape` (metric uv0) -> `assign`, built through the Pack `MeshJob` path with the exact stage injected |
| [hair-fork](hair-fork/) | 161 | `pipeNetwork` with per-node and per-edge radii for forking, tapering strands |
| [pipe-weld](pipe-weld/) | 167 | `pipeNetwork` hard-welded joints with `weld` and `fillet`, mitered bends |
| [desk-lamp](desk-lamp/) | 174 | `split` + `fillHoles`, `duplicate`, `disconnect`, `sel.edges.meshBoundary`, `sel.near` |
| [forearm](forearm/) | 186 | `arap` pose-fitting with handles, `smooth.implicit` fairing, `bend` comparison session |
| [shaping](shaping/) | 182 | `bevel` width list (gradient plate, three-width corner), `applyDraft` about a neutral plane, `nurbs.surface.fair` |
| [pipe-manifold](pipe-manifold/) | 186 | `pipeNetwork` tee, cross and 5-way nodes joined into one manifold |
| [pipe-bend](pipe-bend/) | 188 | `pipeNetwork` elbows with bend radius, 3D double bend, section radius checks |
| [hydraulic-joint](hydraulic-joint/) | 192 | `recipes.*` parts, `extrudePolygon` brackets, two-circle closure for cylinder extension |
| [body-blockout](body-blockout/) | 201 | `threeView` outline fitting, `drawing`, view-prism intersection, wheel-arch `difference` |
| [patch-network](patch-network/) | 227 | `featureLine` curves, `nurbs.fitSurface` patch layout, G2 knee blends, `diagnostics` |
| [blend-corner](blend-corner/) | 235 | Blend run-outs and setback corners between patches, `weld`, `diagnostics` |
| [actuator](actuator/) | 242 | Game-ready route: `shell`, `simplify`, `uv.auto` + `bake`, `rig.finish`, `bindAuto` weights |
| [transforming-limb](transforming-limb/) | 276 | Multi-part `rig` with `JointSpec`, `PosePath` transformation, `DesignedContact`, `scan` |
| [c4carrier](c4carrier/) | 340 | Hard-surface twin turret: `loft` minus inner `loft`, `difference` windows/bores/slots, `bevel`, `panelLine`, `revolve` barrels; 5-joint `rig` and yaw x pitch x recoil `scan` with `clearance` |
| [wheel-rim](wheel-rim/) | 286 | `revolve` section, radial `array` of window prisms, `union`, `bevel` of window rims |
| [suspension](suspension/) | 314 | `sweep` tubes along polylines, `loft` between sections, helix spring, `array` studs |
| [body-panels](body-panels/) | 422 | NURBS `surface` panels with trims, `loft`, `mirror`, `shell`, `proceduralMaterials`, `textRegion` |
| [hood-linkage](hood-linkage/) | 543 | Closed four-bar: `recipes.pinJoint`, `rig.solve` loop closure, `sweep`, mobility `scan` |
| [quality-body](quality-body/) | 559 | Feature-line network, `loft` panels and rolling-ball blends versus a traced dense patch |

## Not a first read

| Path | Lines | What it is |
| --- | ---: | --- |
| `oracles/` | 172 | Test-infrastructure evidence: the analytic oracle table and a fuzz gallery of exact coplanar, touching, tangent and flush-cap survivors rendered on Dawn; not a modeling example |
| `case/` | 930 | Shared render and history harness (`record.ts`, `render.ts`) used by the case tests; not a modeling example |
| `scifi-mech/` | 1926 | Large whole-subject build (C-410): hard-surface kit with low/high levels and bake wear maps |
| `maid-whale/` | 9659 | Large whole-subject build (C-200): staged body, clothing, hair, details; read one file after a smaller example |
| `mech-gt/` | 10109 | Large whole-subject build (C-100 car/mech); shared proportions that other examples import |
| `c131/` | 317 | Stress case (C-131) collecting known kernel limits: welded pipe joints, a mounting kit with interference pairs, a split and hemmed panel, blends |
| `tg-cases/` | 1335 | Tileable trim and texture cases (C-401 to C-406: tread plate, nets, rivets, engraving, weave, rope) baked through a shared harness (`lib.mts`); run as scripts, not Pack builds |
| `freeze-kernel-fixtures.ts` | 69 | Test fixture generator: regenerates the kernel tests' frozen FXEM inputs from example builds |
| `CASES.md` | 367 | Case evidence records and test commands per example |
