# Kernel-canonical capability list at v2 head

Knowledge note for the [`@forgeax/engine-modeling` package](../../README.md). It is a dated audit list, not a contract; the reference pages in `reference/` and the TSDoc in `src/` are the contracts.

> [!NOTE]
> Source snapshot: `KERNEL-CAPABILITIES.md` at `aecc009` (2026-10-29). This list is re-checked against
> `origin/main` at **76581473** (2026-11-13, lane D-A). A row is marked **proved** only when a unit test
> in `src/__tests__/` or `examples/**/__tests__/` calls the row's API by method or bare call name. That is a
> name-level proof: it shows the test exercises the API, not that its assertions pin the row's full purpose.
> Rows marked **unproven** need a dedicated test or a manual check before they are relied on.

## Method

1. Take each `done` row from the snapshot; read its API column for code names (`m.*`, bare identifiers).
2. Presence on main: the first name is defined outside `__tests__` in `src/` (`yes`/`no`).
3. Proof: the first test file, of up to two, that calls any listed name as `.name(` or `name(`.
4. Rows with no name in the API column, or whose names match no call, are listed as unproven.

## Capability rows (snapshot `done`)

| id | family | snapshot status | first API name | on main | proving test (call grep) | proof state |
|:--|:--|:--|:--|:--|:--|:--|
| K-001 | primitives | done | `box` | yes | `examples/body-panels/__tests__/panels.case.dawn.test.ts`, `examples/case/__tests__/record-source.unit.test.ts` | proved |
| K-002 | primitives | done | `extrudePolygon` | yes | `examples/body-panels/__tests__/panels.case.dawn.test.ts`, `examples/sheet-bracket/__tests__/sheet-bracket.case.dawn.test.ts` | proved |
| K-003 | session | done | `bounds` | yes | `examples/bracket/__tests__/bracket.case.dawn.test.ts`, `examples/door-hinge/__tests__/hinge.case.dawn.test.ts` | proved |
| K-004 | session | done | `lift` | yes | `examples/crate/__tests__/crate.unit.test.ts`, `examples/desk-lamp/__tests__/lamp.case.dawn.test.ts` | proved |
| K-005 | session | done | `append` | yes | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `examples/actuator/__tests__/actuator.unit.test.ts` | proved |
| K-006 | session | done | `compact` | yes | `src/__tests__/export-sidecar.unit.test.ts`, `src/__tests__/fxem.unit.test.ts` | proved |
| K-007 | selection | done | `edgeSel` | yes | none found | **unproven** |
| K-008 | tagging | done | `assign` | yes | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `examples/armor-bake/__tests__/armor.case.dawn.test.ts` | proved |
| K-009 | session | done | ``ModelingError`, `MODELING_ERROR_HINTS`` | not checked | none found | **unproven** |
| K-010 | poly-edit | done | `extrude` | yes | `examples/feature-bracket/__tests__/feature-bracket.case.dawn.test.ts`, `examples/feature-bracket/__tests__/feature-bracket.unit.test.ts` | proved |
| K-011 | poly-edit | done | `inset` | yes | `src/__tests__/bevel-spike.ts`, `src/__tests__/bevel.unit.test.ts` | proved |
| K-012 | poly-edit | done | `shell` | yes | `examples/mech-gt/__tests__/proportions.perturb.unit.test.ts`, `examples/mech-gt/__tests__/s2-body.unit.test.ts` | proved |
| K-013 | poly-edit | done | `bridge` | yes | `src/__tests__/bevel-spike.ts`, `src/__tests__/bevel.unit.test.ts` | proved |
| K-014 | poly-edit | done | `loopCut` | yes | `src/__tests__/bevel.unit.test.ts`, `src/__tests__/cleanup.unit.test.ts` | proved |
| K-015 | poly-edit | done | `bisect` | yes | `src/__tests__/cut.unit.test.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-016 | poly-edit | done | `delete` | yes | `examples/body-panels/__tests__/panels.case.dawn.test.ts`, `examples/c4carrier/__tests__/uv-workflows.case.dawn.test.ts` | proved |
| K-017 | poly-edit | done | `array` | yes | `src/__tests__/boolean-cases.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-018 | poly-edit | done | `rotate` | yes | `examples/body-panels/__tests__/panels.case.dawn.test.ts`, `examples/bracket/__tests__/bracket.case.dawn.test.ts` | proved |
| K-019 | poly-edit | done | `resolveTJunctions` | yes | `src/__tests__/repair.unit.test.ts` | proved |
| K-020 | poly-edit | done | `knife` | yes | `src/__tests__/followups.unit.test.ts`, `src/__tests__/knife.unit.test.ts` | proved |
| K-021 | poly-edit | done | `quads` | yes | `src/__tests__/lowpoly-kernel.unit.test.ts` | proved |
| K-022 | poly-edit | done | `panelLine` | yes | `src/__tests__/panel.unit.test.ts` | proved |
| K-023 | poly-edit | done | `layer` | yes | `src/__tests__/layer.unit.test.ts`, `src/__tests__/shell-taper.unit.test.ts` | proved |
| K-024 | poly-edit | done | `strands` | yes | `src/__tests__/strands.unit.test.ts` | proved |
| K-025 | poly-edit | done | `spherize` | yes | `src/__tests__/spherize.unit.test.ts` | proved |
| K-026 | poly-edit | done | `shrinkwrap` | yes | `src/__tests__/poisoned-operand.unit.test.ts`, `src/__tests__/shrinkwrap.unit.test.ts` | proved |
| K-030 | boolean | done | `difference` | yes | `src/__tests__/bevel-holes.unit.test.ts`, `src/__tests__/bevel-spike.ts` | proved |
| K-031 | boolean | done | `computeCacheKey (bare)` | yes | `src/__tests__/boolean.unit.test.ts`, `src/__tests__/compute-cache.unit.test.ts` | proved |
| K-032 | weld | done | `pipeNetwork` | yes | `src/__tests__/pipe-audit-b26.unit.test.ts`, `src/__tests__/pipe-bend-audit.unit.test.ts` | proved |
| K-033 | weld | done | `weld` | yes | `src/__tests__/bevel.unit.test.ts`, `src/__tests__/followups.unit.test.ts` | proved |
| K-034 | weld | done | `bend` | yes | `src/__tests__/deform.unit.test.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-035 | repair | done | `watertight (bare)` | yes | `src/brep/__tests__/e2-solids.unit.test.ts` | proved |
| K-040 | sweep | done | `catmullRom` | yes | `src/__tests__/determinism-fixtures.ts`, `src/__tests__/path-extrude.unit.test.ts` | proved |
| K-041 | deform | done | `bend` | yes | `src/__tests__/deform.unit.test.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-042 | deform | done | `arap` | yes | `src/__tests__/deform-solve.unit.test.ts` | proved |
| K-043 | subd | done | `subdivide` | yes | `examples/crease-neck/__tests__/crease-neck.unit.test.ts`, `examples/limit-cage/__tests__/limit-cage.unit.test.ts` | proved |
| K-044 | subd | done | `limit` | yes | `examples/limit-cage/__tests__/limit-cage.unit.test.ts`, `src/__tests__/subd-limit.unit.test.ts` | proved |
| K-045 | subd | done | `markCrease` | yes | `examples/crease-neck/__tests__/crease-neck.unit.test.ts`, `src/__tests__/b25-audit.unit.test.ts` | proved |
| K-046 | solve | done | `encodeCsr (bare)` | yes | `src/__tests__/sparse.unit.test.ts` | proved |
| K-050 | nurbs | done | ``nurbs.*`` | not checked | none found | **unproven** |
| K-051 | nurbs | done | `measureEdge (bare)` | yes | `examples/patch-network/__tests__/patch-network.unit.test.ts`, `src/__tests__/blend-corner.unit.test.ts` | proved |
| K-052 | surface | done | `patches (bare)` | yes | `examples/patch-network/__tests__/patch-network.unit.test.ts` | proved |
| K-053 | surface | done | ``nurbs.surface.fillN` (n2)` | not checked | none found | **unproven** |
| K-054 | surface | done | `patchLayout` | yes | `src/__tests__/blend-corner.unit.test.ts`, `src/__tests__/falsifiers/rows-assembly.ts` | proved |
| K-055 | surface | done | `featureLine` | yes | `src/__tests__/drawing-check.unit.test.ts`, `src/__tests__/edge-flow.unit.test.ts` | proved |
| K-056 | blend | done | `blends` | yes | `src/__tests__/blend-corner.unit.test.ts` | proved |
| K-057 | blend | done | `supportLoops` | yes | `src/__tests__/support-loops.unit.test.ts` | proved |
| K-058 | fillet | done | `bevel` | yes | `src/__tests__/bake-cage.unit.test.ts`, `src/__tests__/bake-cases.unit.test.ts` | proved |
| K-059 | shut lines | done | `shutLines` | yes | `src/__tests__/falsifiers/rows-assembly.ts`, `src/__tests__/poisoned-operand.unit.test.ts` | proved |
| K-060 | views | done | `curvatureComb (bare)` | yes | `src/__tests__/surface-analysis.unit.test.ts` | proved |
| K-061 | 2D | done | `textRegion (bare)` | yes | `src/__tests__/bake-cases.unit.test.ts`, `src/__tests__/stamp-outline.unit.test.ts` | proved |
| K-062 | analysis | done | `checkEdgeFlow (bare)` | yes | `src/__tests__/blend.unit.test.ts`, `src/__tests__/edge-flow.unit.test.ts` | proved |
| K-063 | analysis | done | `meshQuality` | yes | `examples/maid-whale/__tests__/g6-apron.unit.test.ts`, `examples/maid-whale/__tests__/g6-back-hair.unit.test.ts` | proved |
| K-070 | voxel | done | `fillHoles` | yes | `src/__tests__/cleanup.unit.test.ts`, `src/__tests__/followups.unit.test.ts` | proved |
| K-071 | simplify | done | `simplify` | yes | `examples/maid-whale/__tests__/g6-faceting.unit.test.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-072 | remesh | done | `remesh` | yes | `src/__tests__/b25-audit.unit.test.ts`, `src/__tests__/determinism-fixtures.ts` | proved |
| K-073 | lowpoly | done | `lowpoly` | yes | `src/__tests__/lowpoly.unit.test.ts`, `src/__tests__/part-role.unit.test.ts` | proved |
| K-080 | uv | done | `pack` | yes | `examples/c4carrier/__tests__/uv-workflows.case.dawn.test.ts`, `examples/wheel-uv/__tests__/wheel-pack.unit.test.ts` | proved |
| K-081 | uv | done | ``m.uv.auto`` | not checked | none found | **unproven** |
| K-082 | uv | done (n4) | `bakeTrimSheet (bare)` | yes | `src/__tests__/bake-slots.unit.test.ts`, `src/__tests__/material-id-slots.unit.test.ts` | proved |
| K-085 | bake | done | `bakeMaps (bare)` | yes | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `examples/actuator/__tests__/actuator.unit.test.ts` | proved |
| K-086 | bake | done | `tools (bare)` | yes | `src/__tests__/tools.integration.test.ts` | proved |
| K-088 | stamp | done | ``stamp.*`` | not checked | none found | **unproven** |
| K-089 | texture | done | `encodeKtx2 (bare)` | yes | `src/__tests__/ktx2-delivery.integration.test.ts` | proved |
| K-090 | material | done | ``proceduralMaterials.*`` | not checked | none found | **unproven** |
| K-100 | rig | done | `bindAuto` | yes | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `src/__tests__/skin-bind.unit.test.ts` | proved |
| K-101 | rig | done | `clips` | yes | none found | **unproven** |
| K-102 | rig | done | ``Rig.solve`, `Rig.mobility`, `JointSpec.` | not checked | none found | **unproven** |
| K-103 | rig | done | `clearance (bare)` | yes | `examples/mech-gt/__tests__/s6c-car-form.integration.test.ts` | proved |
| K-104 | rig | done | `motionReport` | yes | `examples/limb-choreography/__tests__/choreo.case.dawn.test.ts`, `examples/limb-choreography/__tests__/choreo.unit.test.ts` | proved |
| K-105 | rig | done | `sweepOverlap (bare)` | yes | `src/__tests__/falsifiers/rows-assembly.ts`, `src/__tests__/motion-space.unit.test.ts` | proved |
| K-106 | rig | done | `actuation` | yes | `examples/limb-choreography/__tests__/choreo.case.dawn.test.ts`, `examples/limb-choreography/__tests__/choreo.unit.test.ts` | proved |
| K-107 | rig | done (n4) | ``Rig.mountHardware`, `Rig.connectivity`` | not checked | none found | **unproven** |
| K-108 | rig | done | `isoFit (bare)` | yes | `src/__tests__/pin-joint.unit.test.ts` | proved |
| K-109 | rig | done | `draft (bare)` | yes | `examples/shaping/__tests__/shaping.unit.test.ts`, `src/__tests__/apply-draft.unit.test.ts` | proved |
| K-120 | validation | done | `validate` | no | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `examples/actuator/__tests__/actuator.unit.test.ts` | proved |
| K-121 | validation | done | ``ValidationReport.coverage`, `PhaseClaim` | not checked | none found | **unproven** |
| K-122 | validation | done | ``OpReport`, journal` | not checked | none found | **unproven** |
| K-123 | regen | done | `regen (bare)` | yes | `examples/feature-bracket/__tests__/feature-bracket.case.dawn.test.ts`, `examples/feature-bracket/__tests__/feature-bracket.unit.test.ts` | proved |
| K-124 | determinism | done | `checkInvariants (bare)` | yes | `src/__tests__/perf-tiers.unit.test.ts`, `src/__tests__/setup.ts` | proved |
| K-125 | validation | done | `diffMeshes (bare)` | yes | `src/__tests__/diff.unit.test.ts`, `src/__tests__/snapshot-canonical-tags.unit.test.ts` | proved |
| K-126 | validation | done | `pickFaces (bare)` | yes | `src/__tests__/synthesize.unit.test.ts` | proved |
| K-127 | diagnostics | done | `explodeMesh (bare)` | yes | `src/__tests__/drawing-explode.unit.test.ts`, `src/__tests__/views.unit.test.ts` | proved |
| K-128 | capture | done | `captureModels` | yes | `src/__tests__/diagnostics.unit.test.ts` | proved |
| K-130 | export | done | `finish` | yes | `examples/__tests__/scene-components.unit.test.ts`, `examples/actuator/__tests__/actuator.case.dawn.test.ts` | proved |
| K-131 | export | done | ``ExportReport.topology` (K5-3, #419)` | not checked | none found | **unproven** |
| K-132 | LOD | done | `lodTopologyReport (bare)` | yes | `src/__tests__/falsifiers/rows-mesh.ts`, `src/__tests__/lod-topology.ts` | proved |
| K-135 | cook | done | `assetsJobOutputs (bare)` | yes | `examples/maid-whale/__tests__/g7-face.import.integration.test.ts`, `examples/mech-gt/__tests__/s6-job.integration.test.ts` | proved |
| K-136 | cook | done | `reports` | yes | none found | **unproven** |
| K-140 | drawing | done | `drawing` | yes | `examples/sheet-bracket/__tests__/sheet-bracket.case.dawn.test.ts`, `src/__tests__/drawing-callouts.unit.test.ts` | proved |
| K-141 | drawing | done | `extrudeContour` | yes | `src/__tests__/drawing-tools.integration.test.ts`, `src/__tests__/views.unit.test.ts` | proved |
| K-142 | drawing | done | `drawingCurve3 (bare)` | yes | `examples/maid-whale/__tests__/turnaround-structure.unit.test.ts`, `src/__tests__/drawing-layer.unit.test.ts` | proved |
| K-143 | drawing | done | `drawingDxf (bare)` | yes | `src/__tests__/drawing-callouts.unit.test.ts`, `src/__tests__/drawing-explode.unit.test.ts` | proved |
| K-144 | drawing | done | `drawingTable (bare)` | yes | `src/__tests__/drawing-callouts.unit.test.ts` | proved |
| K-145 | drawing | done | `explodeDrawing (bare)` | yes | `src/__tests__/drawing-explode.unit.test.ts` | proved |
| K-146 | drawing | done | `meshViewLines (bare)` | yes | `src/__tests__/drawing-hlr.unit.test.ts` | proved |
| K-150 | tools | done | `validate` | yes | `examples/actuator/__tests__/actuator.case.dawn.test.ts`, `examples/actuator/__tests__/actuator.unit.test.ts` | proved |
| K-151 | tools | done | `interference` | yes | `examples/c4carrier/__tests__/heavy-turret.unit.test.ts`, `examples/mech-gt/__tests__/car-form.unit.test.ts` | proved |

Counts: 84 proved, 14 unproven of the snapshot `done` rows.

Unproven: K-007, K-009, K-050, K-053, K-081, K-088, K-090, K-101, K-102, K-107, K-121, K-122, K-131, K-136. Two of these (`K-009`, `K-007`) use exported classes or selector
factories that the grep does not see as a call; they may be covered by tests under other names.

## SolidCraft landing (evidence on main)

PR #453 (`feat/solidcraft-port`, merge `a40b6877`) is an ancestor of `origin/main`. Lines below cite only
APIs that exist in `src/` and have a test file that references them.

| capability | source | proving test | commit evidence |
|:--|:--|:--|:--|
| `applyDraft` (prism walls about a neutral plane) | `src/draft.ts`, `src/model.ts` | `src/__tests__/apply-draft.unit.test.ts` | `d79f8999` (ancestor of `a40b6877`) |
| `sketch.solve` (2D sketch constraints) | `src/sketch.ts` | `src/__tests__/sketch.unit.test.ts` | file present on main; PR #453 landing |
| `nurbs.surface.fair` | `src/surface-quality.ts`, `src/blend.ts` | `src/__tests__/nurbs-fair.unit.test.ts` | file present on main |
| DXF output | `src/sheet.ts`, `src/model.ts` | `src/__tests__/drawing-layer.unit.test.ts` (DXF callouts and layers) | file present on main |
| Sheet metal | `src/sheet.ts` | `src/__tests__/sheet.unit.test.ts` | file present on main |

Not covered here: the per-lane SolidCraft L1-L7 detail beyond these APIs, and the post-#453 probe re-runs P1-P3
(P2-A12). Those need their own evidence before any line is added.

## Phase 2 rows (not on main)

Snapshot status `phase2`: listed for completeness, not canonical.

- K-074 (remesh): Quad retopology
- K-083 (uv): SLIM-style UV refinement (U77/U78)
- K-084 (uv): ABF/ARAP UV parameterization
- K-087 (bake): Bake report names cage-clip / stray-detail groups with a fix hint
- K-091 (material): Generated UV texture layer from PNG with mask
- K-092 (bake): Thin grille/vent through-holes as opacity/height recesses (recipe)
- K-110 (rig): Skinned LOD: per-LOD bone reduction (merge leaf bones, remap 1-influence binding)
- K-111 (rig): Sliver removal after mergeRigid with zero-sliver gate
- K-133 (LOD): Weld-at-0 before LOD in Import; cross-section simplify
- K-134 (LOD): Scale measurement script
- K-147 (drawing): Promote d6 design-v2 drawing-sheet module (feat/f1-design-sheets 7bdc36e)

## Not checked

Rows whose API column names no code identifier (checked for presence only by their snapshot text):

K-009, K-050, K-053, K-081, K-088, K-090, K-102, K-107, K-121, K-122, K-131

`K-120` names a token (`forgeax...`) that is not an API; it is counted as unproven under its own grep and is not a kernel capability.
