# Design drawings as data

Part of the [`@forgeax/engine/modeling` manual](../README.md).

A design drawing in this kernel is a `Drawing` value: views plus typed items (points,
curves, dimensions, notes, tables). It holds no pixels. It is the single owner of 2D
design intent, so the same object drives three things: the hull you build
(`threeView`, `extrudeContour`), the checks you run (`validate({ drawing })`,
`silhouetteIoU`) and the sheets you hand to a reader (`drawingSvg`, `drawingDxf`). Use a
drawing whenever a number or a line is a decision rather than a result. The complete
contract (every field, option and limit) is in [../reference/drawings.md](../reference/drawings.md);
this file is about what to draw and why. Method: [design-methodology.md](design-methodology.md).

## Views and frames

Six orthographic views share the `ORTHO_VIEWS` frames: Y up, the subject's front faces
+Z. In a view a point is `(u, v)` with `u = p . right`, `v = p . up`. So in the
`right` view `u = -z` (the nose of a car facing +Z is on the left, as in a side
elevation); in `top`, `u = x`, `v = -z`; in `front`, `u = x`, `v = y`. `model.render`
uses the same frames, so a drawing and a render line up. Beyond the six:

- **Section view** `{ id, section: { axis, at } }`: a station across an axis. Across z it
  reads like `front`, across x like `right`, across y like `top`.
- **3/4 view** `{ id, toward, up? }`: the viewer on the `toward` side; the same
  `lookFrame` frame the perspective views use (a zero or `up`-parallel direction is
  `model-degenerate`).
- **Detail view** `{ id, of, detail: { box, scale, label? } }`: an enlarged window of its
  parent, marked in the parent.
- **Exploded view** `{ id, of, explode: { by, distance, directions?, order? } }`.

Choose views by the question: silhouettes and package in orthographic views, form
carried by sections, appearance by 3/4 views. Items in different views that name the same
`link` are one 3D element and are cross-checked.

## Roles: what an item is for

The closed `DrawingRole` set decides how an item is checked and drawn.

| Role | Use it for | Consumed by |
|:--|:--|:--|
| `package` | fixed facts: axles, seat points, overall dimensions, clearances | `dimension` check; sheets |
| `silhouette` | a closed outline of the whole or of a part in an ortho or 3/4 view | `silhouetteIoU` (floor 0.93); `threeView` |
| `feature` | styling or panel lines (shoulder, waist, sills, windows) | `feature` check against a linked session `featureLine`; `drawingCurve3` |
| `section` | the cut outline at a station | `section` check (cut both ways) |
| `break` | a designed break or shut-line path drawn in a view | a shut-line row's `break` check |
| `pivot`, `linkage` | hinge and joint points, link lengths | documentation and joint tables; rig spec built from the same numbers |
| `structure`, `guide` | topology/flow lines; alignment guides across views | sheets; manual reading (not measured) |
| `construction` | helper geometry that must not be mistaken for design | sheets only |
| `visible`, `hidden`, `material` | sheet output of hidden-line removal; a callout naming a material slot | `meshViewLines`; `material` check |

Optional fields turn a line into evidence: `basis` (`public`, `blueprint`, `estimate`,
`derived`), `tolerance` (meters, default 2 mm), `note`, `continuity` for a curve, and
`inset` for an open line whose 3D counterpart stops short at a panel shut.

## Choosing a curve spec

A `curve` item takes a `CurveSpec`, open or closed:

- `polyline`: exactly your points. Best for mechanical outlines and for what a boolean
  prism will cut.
- `spline`: a smooth path through your keys, sampled within the tolerance. Best when
  you place a few key points by hand.
- `fit`: reduces a dense trace to the fewest points within the tolerance of every sample
  (`smooth: true` runs a spline through the kept points). Best for outlines traced from
  an image. Keep the tolerance at a few millimeters; a dense smooth fit makes a
  sliver-heavy prism for the boolean in `threeView`.
- `arc` (center, radius, from/to radians) and `nurbs` (a planar `NurbsCurve`): exact
  geometry.

`resolveCurveSpec(spec, { closed?, tolerance? })` is the one sampler and reports
`deviation`, `bounds` and a counter-clockwise orientation for closed curves. A closed
curve with no area is `model-degenerate`.

## Blockout from three views

`m.threeView(d, ids, options)` intersects the extrusions of two or three closed curves on
distinct view axes: the quickest honest hull. Contour i grows outward by i x `clearance`
(default 0.5 mm) so the views share extremes without coplanar faces. Trimmed from
`examples/body-blockout`, which adds wheel arches, glass assignment and wheels:

```ts
import { model, resolveDrawing, type Drawing } from '@forgeax/engine/modeling';

const closed = (id: string, view: string, points: [number, number][]) =>
  ({ id, view, role: 'silhouette', kind: 'curve', closed: true,
     curve: { kind: 'polyline', points }, tolerance: 0.004 }) as const;

export const WEDGE: Drawing = {
  name: 'wedge',
  views: [{ id: 'side', ortho: 'right' }, { id: 'plan', ortho: 'top' }, { id: 'front', ortho: 'front' }],
  items: [
    closed('profile', 'side', [[-1, 0.05], [-1, 0.25], [-0.5, 0.4], [0.2, 0.5], [0.9, 0.4], [1, 0.3], [1, 0.05]]),
    closed('outline', 'plan', [[-0.3, -1], [0.3, -1], [0.45, -0.5], [0.45, 0.7], [0.3, 1], [-0.3, 1], [-0.45, 0.7], [-0.45, -0.5]]),
    closed('section', 'front', [[-0.45, 0.05], [0.45, 0.05], [0.45, 0.3], [0.3, 0.5], [-0.3, 0.5], [-0.45, 0.3]]),
    { id: 'front axle', view: 'side', role: 'package', kind: 'point', at: [-0.6, 0.12] },
    { id: 'rear axle', view: 'side', role: 'package', kind: 'point', at: [0.6, 0.12] },
    { id: 'wheelbase', view: 'side', role: 'package', kind: 'dimension', measure: 'distance',
      refs: ['front axle', 'rear axle'], value: 1.2, basis: 'public' },
  ],
};

const m = model();
m.drawing(WEDGE);
m.threeView(WEDGE, ['profile', 'outline', 'section'], { label: 'hull', material: 'paint' });
const report = m.validate({ drawing: true }); // silhouette IoU and the wheelbase span
```

Considerations: the views must agree on shared extremes (here length 2, width 0.9,
height 0.05 to 0.5), because the prisms are intersected; an outline that is wider in
one view than another is cut to the smaller. `extrudeContour(d, id, { depth: [near, far] })`
makes one prism when you need an extrusion rather than an intersection.

A three-view hull has flat extrusion walls. It is a mass study, not a surface: use it to
fix proportions and cut openings, then rebuild the visible skin from lines and patches
([vehicle-design.md](vehicle-design.md)).

## Package and dimension items

`package` points and `dimension` items record what the design must satisfy.
A dimension has `measure` (`distance`, `dx`, `dy`, `angle`, `radius`), `refs` of 0 to 2
items (an angle takes three points `[a, vertex, b]` in its own view) and a `value` in
meters (radians for angles). With one ref, `dx` and `dy` are measured from the view axis
(a height above the ground line); with an arc ref `radius` is its radius. The check
compares the drawn span with `value`, so a dimension is both documentation and an
assertion. Give each its `basis`: a `public` figure should have a tight tolerance, an
`estimate` should say so.

## Sections

A `section` curve in a section view is the form at a station. The check cuts a copy of the
state at the station (`sectionSegments` gives the boundary edges of a plane cut) and
compares drawn and cut curves both ways inside the drawn span, within `reach`
(default 0.05 m). A band left out between drawn pieces (a roll or a flange) counts
against none. Sections catch what silhouettes cannot: a body can match side and plan and
still be a box in the cabin.

## Feature lines in 3D from two views

Draw one styled line twice with the same `link`, in two views that share a world axis
(side + plan share z, front + side share y, front + plan share x). `drawingCurve3` reads
each curve along the shared axis, joins them and fits a cubic NURBS (4 to 32 control
points) within the tightest tolerance:

```ts
import { drawingCurve3, model, resolveDrawing } from '@forgeax/engine/modeling';

// D has a `feature` item per view, both with link 'shoulder' (side and plan)
const resolved = resolveDrawing(D);
if (!resolved.ok) throw resolved.error;
const line = drawingCurve3(resolved.value, 'shoulder', { controlPoints: 6 });
if (!line.ok) throw line.error;
const m = model();
m.featureLine({ name: 'shoulder', curve: line.value, continuity: 'G0' });
```

A view that is not single-valued along the shared axis (the line doubles back) or two
views with no overlap are `model-precondition`; views that share no axis are
`model-invalid-argument`. The registered line then feeds patch layout, surface-quality
fairness and the `feature` drawing check ([../reference/surfaces.md](../reference/surfaces.md)).

## Breaks, shut lines and moving parts

A `break` curve is where a panel is meant to split: the shut line of a door, a hood, a
cover. A shut-line table row can name it with `break: { drawing, item }`; the measured
seam centre line seen in that view is compared both ways with the drawn break, at the
item's tolerance and covering at least 0.98 of it, and a miss is the `break` check
([vehicle-design.md](vehicle-design.md) covers the table). `pivot` and `linkage` items
record hinge points and link lengths; build the `rig` joints from the same numbers so
the drawing and the mechanism cannot disagree.

## Guides and structure (organic and character work)

`guide` lines (eye line, shoulder, hip, knee, ground) repeat across front and side
views so features sit at equal heights; `structure` lines mark where loops and planes
should run. Neither is measured. What is measured is the outline: draw the front and side
silhouette as closed curves and check with `silhouetteIoU`. For topology flow use
`meshQuality` with `flow` guides (see [../reference/surfaces.md](../reference/surfaces.md)).

## Checking a drawing against the model

`m.validate({ drawing: true | { reach } })` runs, for every attached drawing:

| Check | What it compares | Fails when |
|:--|:--|:--|
| `section` | cut at the station vs drawn curve, both ways | `max` or `back` above the item tolerance |
| `silhouette` | projected state vs drawn closed outline | `iou` below 0.93 |
| `feature` | session line projected into the view vs drawn curve, over the shared span | `max`, `back` above tolerance; `coverage` short |
| `dimension` | the span the refs draw vs `value` | `measured` outside `value` +- tolerance |
| `material` | the first face under a `depth`-carrying point vs the note text | `expected` differs from `found` |

Each failure is a `drawing` warning whose `detail` is a `DrawingFinding` (`check`,
`drawing`, `item`, `view`, `tolerance`, and the relevant measures). A finding without
measures means unmeasured (no session line for the link, a station the state does not
cross, a material point beside the subject): it is never a pass. `silhouetteIoU(model, view,
reference, cell?)` is the same measure for direct use; it also compares two sessions
(a low-poly against its high-poly) and accepts a perspective view. It returns
`{ iou, onlyA, onlyB }` where A is the reference, so `onlyA` is the area the model is
missing.

## Sheets and export

`drawingSvg(resolved, options)` and `drawingDxf(resolved, options)` return a
`Result<string>`. Useful options:

- `sheet: { size: 'A0'..'A4', orientation?, title? }`: ISO border, zone marks, title block
  and scale bar; with `scale` omitted the largest ISO scale that fits is chosen
  (`model-precondition` with `{ needed, available }` in millimeters otherwise).
- `projection: 'first' | 'third'` places ortho views as that projection method does;
  `views` and `columns` place them freely; `grid` draws labelled lines; `layers: true`
  gives each role group an id and `data-layer` so a reader can toggle it.
- Section curves are hatched at 45 degrees with `hatchSpacing`; `evenOddHatch` keeps
  nested outlines as holes.
- Tables: a `table` item from `drawingTable(id, view, source)` with `{ kind: 'dts', rows,
  report? }` (zone limits and a status column), `{ kind: 'joints', joints }` or
  `{ kind: 'bom', parts }`; more than `TABLE_CELL_LIMIT` (4000) cells is
  `model-work-budget`. A note with `balloon: true` keys a table row.
- A note with `deviation` prints the signed value under its text, red past `tolerance`.
- `meshViewLines(mesh, view, { id, creaseAngle?, sharp?, workLimit? })` produces
  `visible` and `hidden` lines (true hidden-line removal) to draw the built model on the
  sheet; `meshViewEdges` has no hidden-line removal.
- `explodeMesh` and `explodeDrawing(mesh, drawing)` produce the exploded view, its part
  balloons and a `bom` table from the same options, so the sheet and the 3D agree.

## Failure codes you will meet

| Code | Typical cause here | Recovery |
|:--|:--|:--|
| `model-invalid-argument` | duplicate item id, unknown ref, link twice in one view, unknown field, bad table | fix the data; the message names the item |
| `model-degenerate` | closed curve with zero area, `up`-parallel 3/4 direction | change the points or direction |
| `model-precondition` | sheet too small, curve not single-valued for `drawingCurve3` | enlarge the sheet or split the line |
| `model-work-budget` | too many table cells or hidden-line work past `workLimit` | split the sheet or raise the limit deliberately |

## Limits

Drawings are not parametric constraints: a changed dimension does not move the
geometry. They are evidence the build and the checks agree. Reading a drawing from an
image, choosing proportions and judging taste remain manual work.
