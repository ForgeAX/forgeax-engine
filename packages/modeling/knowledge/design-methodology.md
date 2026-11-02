# Design methodology: coarse to fine, with every decision as data

Part of the [`@forgeax/engine/modeling` manual](../README.md).

A model that is built straight from a mental picture drifts: proportions are decided
implicitly, details are modeled on a body that is later reshaped, and nobody can say which
number was a fact and which a guess. The method here fixes that with one habit: **decide
at the coarsest level that can decide it, write the decision down as data, and let every
finer level be checked against it.** The kernel gives the data format and the checks; the
taste stays with you.

Read this file first when starting a new object (vehicle, machine, prop, creature). Then
go to [design-drawings.md](design-drawings.md) for the drawing data and its checks,
[vehicle-design.md](vehicle-design.md) for the car-shaped worked route, and the API
manuals [../reference/drawings.md](../reference/drawings.md),
[../reference/surfaces.md](../reference/surfaces.md),
[../reference/validation.md](../reference/validation.md) and
[../reference/rig.md](../reference/rig.md) for parameters.

## The five levels

| Level | Decides (and then freezes) | Kernel carrier | What fails when it is violated |
|:--|:--|:--|:--|
| L0 intent | purpose, scale, the few numbers that define the object (overall size, wheelbase, reach, stroke) | `package` items and `dimension` items with `basis` | a `dimension` finding of `validate({ drawing })` |
| L1 overall form | silhouette in each main view, mass distribution, stance, the dominant lines | closed `silhouette` curves, `feature` lines | `silhouette` finding (IoU below 0.93), `feature` finding |
| L2 regions | where the form splits into panels, sub-assemblies, openings; sections at stations | `section` curves, patch layout, shut-line table, joint table | `section` finding, `patch-layout` warnings, `shut-line` errors |
| L3 detail and parts | bevels, grooves, fasteners, fits, mechanism pivots | `pivot` and `linkage` items, recipes, `panelLine`, designed contacts | interference scan, `designed-contact`, `mesh-quality` |
| L4 production | triangle budget, UV, bake, export | `meshQuality`, `validate` options, `finish` | `mesh-quality`, `uv-*`, `bake` warnings |

A level may only add information, never silently contradict the one above. When a lower
level shows that a higher decision is wrong (the cabin does not fit inside the silhouette,
the hinge cannot sit on the drawn break), go back up, change the decision in the data,
and rebuild; do not patch the geometry and leave the drawing stale. A stale drawing makes
the next `validate({ drawing })` run report the difference, which is exactly its purpose.

## Decisions live in one data module

Keep the drawing in its own module that the build function imports, so there is one
copy of every number. A `Drawing` is plain data (no images): views, then items with a
closed `role` (`package`, `silhouette`, `feature`, `section`, `break`, `pivot`,
`linkage`, `structure`, `guide`, `construction`). Three fields turn it into a design
record rather than a sketch:

- `basis`: `public` (a published dimension), `blueprint` (traced from a plan),
  `estimate` (your judgement) or `derived` (computed from others). Be honest: an
  `estimate` is allowed to change, a `public` fact is not.
- `tolerance`: the allowed deviation in meters; the checks use it per item (default 2 mm).
- `link`: items in different views with the same `link` are one 3D element, so a roof
  line drawn in side and plan is one thing, not two.

```ts
import { model, type Drawing } from '@forgeax/engine/modeling';

export const BRIEF: Drawing = {
  name: 'cart',
  views: [{ id: 'side', ortho: 'right' }, { id: 'plan', ortho: 'top' }],
  items: [
    { id: 'front axle', view: 'side', role: 'package', kind: 'point', at: [-0.6, 0.15] },
    { id: 'rear axle', view: 'side', role: 'package', kind: 'point', at: [0.6, 0.15] },
    { id: 'wheelbase', view: 'side', role: 'package', kind: 'dimension', measure: 'distance',
      refs: ['front axle', 'rear axle'], value: 1.2, basis: 'public', tolerance: 0.002 },
  ],
};

const m = model();
m.drawing(BRIEF);               // attaches the drawing; the mesh is unchanged
// ... build geometry from the same constants ...
const report = m.validate({ drawing: true });
```

Resolving (`resolveDrawing`) rejects duplicate ids, unknown refs, a link used twice in
one view and malformed curves before any geometry is made, so a broken brief fails early.

## Order of work inside a level

Considerations, not a recipe:

1. **Package before skin.** Hard points that other things depend on (axles, seat, pivots,
   hinge axes, the volume a driver or mechanism needs) come first as `package` and
   `pivot` items. A skin drawn first has to be re-cut when they arrive.
2. **Lines before surfaces.** The few lines that carry the form (silhouette, shoulder,
   waist, center line, sills) are drawn and judged as curves before any patch exists.
   Curves are cheap to fix; see [vehicle-design.md](vehicle-design.md) for how the
   feature-line network feeds patches, and `curveFairness` / `curvatureComb` in
   [../reference/surfaces.md](../reference/surfaces.md) for judging a line.
3. **Sections carry form.** Two silhouettes do not define a volume. Add `section`
   curves at the stations where the form changes (cabin, widest point, nose); the
   `validate({ drawing })` section check cuts the built model at the same station and
   compares both ways.
4. **Big masses before small ones.** Blockout the whole at L1 and check it against the
   references before any L3 feature: `threeView` gives a hull from three outlines in a
   few operations.
5. **Detail on a frozen host.** Bevels, grooves and fasteners are placed on geometry whose
   shape is final. If the host changes, the detail is rebuilt, which is cheap only when
   the detail was written as parameters of the host (labels and selectors, not indices).
6. **Cheap check, then expensive check.** Run the numeric checks (dimensions, IoU,
   fairness, shut lines) at every level; render and inspect only after they pass.
   The numbers find drift a glance cannot; the eye finds taste the numbers cannot.

## What each level can be checked with

| Question | Tool | Notes |
|:--|:--|:--|
| Do the key dimensions hold? | `validate({ drawing })`, `dimension` items | refs give the drawn span; `value` and `tolerance` are meters |
| Does the silhouette match? | `silhouetteIoU(model, view, reference)`, the `silhouette` check | threshold 0.93; `onlyA` / `onlyB` tell where it is missing or extra |
| Does a station match? | `section` check, `sectionSegments` | `reach` (default 0.05 m) bounds how far a cut may lie from a drawn piece |
| Does a 3D line match its drawing? | `feature` check with a `link` to a session `featureLine` | compared both ways over the shared span |
| Is the surface fair? | `validate({ surfaceQuality })` | density, continuity, inflection, spike, curvature rate, fairness |
| Do panels meet as planned? | `validate({ layout })`, `validate({ shutLines })` | gaps and flush in millimeters |
| Does the mechanism move? | `rig` + `scan`, `mobility`, designed contacts | [../reference/rig.md](../reference/rig.md) |
| Is the tiling usable? | `meshQuality`, `validate({ quality })` | stylized, low-poly or bake targets |
| What changed between two versions? | `captureModels(body, { steps: true })` snapshots | step replay of every operation |

All of these return structured findings (`Issue<Code>` with `detail`), so a failing level
tells you which item, view or row to look at. See
[../reference/validation.md](../reference/validation.md) for the closed code lists.

## Planning an articulated or transforming design

When one object has two forms (a vehicle that unfolds, a limb with a stowed pose),
decide these before detailing either form; all of them are ordinary drawing data:

- **Form mapping.** Give the same `link` (or the same part tag) to the same element in
  both forms, so "where does the door go when it unfolds" is a row you can read, not a
  memory. Parts that exist in only one form should be a deliberate list.
- **Ordered parts.** Name the parts and their disassembly order; `explodeMesh(mesh, { by:
  'tag', distance, order })` and an `explode` view show the assembly order and
  `explodeDrawing` derives the matching part table.
- **Joint table.** `drawingTable(id, view, { kind: 'joints', joints })` prints kind, axis
  and limits per joint; keep it identical to the `rig(m, { joints })` spec by building both
  from the same array.
- **Bill of parts.** `{ kind: 'bom', parts }` from an explode view; budgets (triangle
  count per part, material slots) are manual judgement, checked with `meshQuality`.
- **Mechanism gate.** Before detailing, prove the chain moves: `rig(...).scan(path)`
  with `clearance` over the whole path, `mobility(pose, { drivers })` for closed loops,
  and `solve(pose)` conditioning and `branchRisk` for fold points. A mechanism that fails
  here is a design problem; no amount of surface work fixes it.

## Organic and character work

The same levels apply with different carriers: `guide` lines are turnaround rules
(eye line, shoulder, hip, knee drawn across all views at equal heights), `structure`
lines are the planes and loops the topology should follow, and a closed `silhouette` is
the readability test (a character should be recognizable as a filled shape). Check the
front and side silhouette with `silhouetteIoU` against the drawing, and the tiling with
`meshQuality(faces, limits, { flow })`, which also measures how triangles follow
declared flow guides. Proportions and gesture are manual judgement: no tool measures
appeal.

## Common failure modes

- **Detail first.** Fasteners and grooves modeled on an unchecked body are lost when the
  body changes. Freeze L1 and L2 (their checks pass) before L3.
- **Two sources of truth.** A number typed in the drawing and again in the build drifts.
  Import one constant into both.
- **Estimates treated as facts.** Mark `basis: 'estimate'` and keep `tolerance` loose;
  tighten only when a source confirms it.
- **Fitting dense traces.** A dense smooth trace becomes a sliver-heavy prism. Use `fit`
  curves within a few millimeters (see `CurveSpec` in [design-drawings.md](design-drawings.md)).
- **Passing vacuously.** A check with nothing to compare reports it: surface quality
  returns `nothing-checked`, a drawing item with no measure is reported without
  `found`. Treat "unmeasured" as not passed.
- **Fixing the render instead of the data.** If a render looks wrong, find the failing
  finding first; if none fails, the missing check is itself a gap in the drawing.

## What the kernel does not do

It does not choose proportions, judge taste, track revisions across files or detect that
a higher-level decision changed. Keep decisions in version-controlled modules and rerun
the checks after every change; `captureModels(body, { steps: true })` keeps a snapshot
after each operation when you need to replay what moved.
