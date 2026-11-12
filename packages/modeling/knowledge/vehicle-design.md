# Vehicle design: from package to shut lines

Part of the [`@forgeax/engine/modeling` manual](../README.md).

A car-like body is the hardest common hard-surface target: large smooth panels, a few
decisive lines, tight gaps and moving parts (doors, hood, wheels). The same route serves
any vehicle or appliance with painted panels. It is: **package and stance, then lines,
then sections, then patches and blends, then panel splits and openings, then moving
parts.** Each step has a kernel tool that measures it, listed below. Method and levels:
[design-methodology.md](design-methodology.md). Drawing data: [design-drawings.md](design-drawings.md).
Parameters live in [../reference/surfaces.md](../reference/surfaces.md),
[../reference/detail.md](../reference/detail.md) and [../reference/rig.md](../reference/rig.md).
Worked sources: `examples/body-blockout`, `examples/quality-body`, `examples/body-panels`,
`examples/patch-network`, `examples/door-hinge`, `examples/hood-linkage`,
`examples/suspension`, `examples/wheel-rim`.

## 1. Package and stance first

The package is what the body must contain or respect: wheel centers and tire diameters,
the passenger volume and eye points, engine or battery volume, ground clearance, overall
length, width and height. Put each as a `package` point or `dimension` item with an honest
`basis`. Stance is the proportion of those hard points to each other, and it is mostly
judgement; useful quantities to read off the drawing:

- wheelbase against tire diameter (a longer wheelbase against the wheels reads as
  stable and long; the tools only report the number);
- front and rear overhang, and the dash-to-axle distance (cabin forward or rearward);
- track against height (planted or tall);
- beltline height against wheel top, and glass height against body height.

Record the numbers as `dimension` items and compare them with the built model through
`validate({ drawing })`. Do not start surfacing before the `dimension` and `silhouette`
checks pass on a three-view blockout (`examples/body-blockout`: public dimensions,
three traced outlines fitted within 4 mm, `m.threeView`, wheel arches by `difference`
with a short cylinder per wheel, glass assigned to faces above the beltline with `assign`).
The blockout is a mass study; its flat walls are replaced in step 4.

## 2. Lines before surfaces

A car body reads through a handful of lines: the shoulder (hood to fender crest), the
waist or character line, the sill, the window base (beltline), the roof line and the
wheel-arch lips. Draw them as curves and judge them before any patch exists. Things to
look at, all measurable on a feature line (`curveFairness`, `curvatureComb`,
`validate({ surfaceQuality })`):

- **Few control points.** A line with 4 to 6 control points is usually fair; a dense
  interpolation of noisy points is not. `nurbs.approximate(points, { controlPoints, degree })`
  fits the fewest points within tolerance.
- **No accidental inflection.** `curve-inflection` flags a second sign change of
  curvature. A designed S-curve is declared on the line with `inflections` (normalized
  parameter ranges that each hold one).
- **No spikes, smooth curvature change.** `curve-spike` and `curve-curvature-rate`
  (default `maxRateRatio` 15; a fair arc is under 1) catch kinks that show later as
  broken highlights.
- **Draw in two views, join in 3D.** A line drawn in side and plan with one `link` becomes
  a space curve with `drawingCurve3`; `m.featureLine({ name, curve, continuity })`
  registers it. `continuity: 'G0'` declares a designed crease (later held by a blend);
  anything else is judged as smooth.

Hide moving-panel breaks in the line work: put a shut line on a crease or a character
line when the design allows, because a gap on a smooth crown is the most visible line on
the car. The tools do not choose; they measure the gap and flush you ended up with (step 5).

## 3. Sections carry form

Side and plan silhouettes do not say whether the roof is a box. Add `section` curves at
stations (cabin, widest point, nose, tail). Considerations: tumblehome (the greenhouse
narrows above the shoulder), the tuck-under of the lower body, how the section changes
between stations (a smooth change is a fair loft; a step is a feature line). The
`section` check cuts the built model at the same station and compares both ways, so it
catches a roof that is wider or flatter than drawn. Sections between the lines are also
what you loft in step 4.

## 4. Network, patches and blends

Build the body from a feature-line network: few-control-point patches lofted between the
lines, meeting at G0 creases that are held by small blends. Trimmed from
`examples/quality-body` (hood, fender and door of one side; x along the car, y up, z outward):

```ts
import { model, nurbs, type NurbsCurve, type Tuple3 } from '@forgeax/engine/modeling';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const L = 1.2;
const bump = (t: number) => 4 * t * (1 - t);
const line = (at: (t: number) => Tuple3): NurbsCurve =>
  unwrap(nurbs.approximate([0, 0.25, 0.5, 0.75, 1].map(at), { controlPoints: 4, degree: 3 }));

const shoulder = line((t) => [L * t, 0.5 + 0.03 * bump(t), 0.42]);
const waist = line((t) => [L * t, 0.3 + 0.012 * bump(t), 0.47]);
const sill = line((t) => [L * t, 0, 0.44]);
const center = line((t) => [L * t, 0.56 + 0.03 * bump(t), 0]);
const loft = (curves: NurbsCurve[]) => unwrap(nurbs.loft(curves, { degree: 2 }));
const hood = loft([center, line((t) => [L * t, 0.537 + 0.03 * bump(t), 0.23]), shoulder]);
const fender = loft([shoulder, line((t) => [L * t, 0.4 + 0.01 * bump(t), 0.46]), waist]);
const door = loft([waist, line((t) => [L * t, 0.15, 0.46]), sill]);

const m = model();
m.featureLine({ name: 'shoulder', curve: shoulder, continuity: 'G0' });
m.featureLine({ name: 'waist', curve: waist, continuity: 'G0' });
m.surface({
  patches: [
    { name: 'hood', surface: hood, flip: true },     // lofts face inward here, so flip
    { name: 'fender', surface: fender, flip: true },
    { name: 'door', surface: door, flip: true },
  ],
  blends: [
    { between: ['hood', 'fender'], radius: 0.005, continuity: 'G2', name: 'shoulder-blend' },
    { between: ['fender', 'door'], radius: 0.003, continuity: 'G2', name: 'waist-blend' },
  ],
  chord: 0.0005, nonPlanar: 'keep', spacing: 'even', tag: 'body',
});
const report = m.validate({ surfaceQuality: true, edgeFlow: true });
```

What to weigh while doing this:

- **Patch size and net.** Few large patches with at most 8 x 6 control points
  (`surface-density`, `maxNet` [8, 6]) are fairer than one dense patch. A dense
  grid interpolated through noisy samples smears creases and ripples highlights
  (`surface-fairness` fails it). When you must match an existing shape, `nurbs.fitSurface`
  with fairing is the route; see [../reference/surfaces.md](../reference/surfaces.md).
- **Continuity.** Declare what each shared edge should be (a feature line with
  `continuity`, or a patch layout side `continuity` G0 to G3). `surface-continuity`
  reports the `achieved` class against the `required` one: positional gap 1e-4 m, tangent
  kink 0.5 degrees, curvature jump per scene. Use `nurbs.match` / `measureEdge` to tie
  neighbours. G1 is the floor for painted panels meeting smoothly; G2 matters where
  reflections cross the edge; a crease is G0 on purpose.
- **Blends.** A small rolling-ball blend (`radius` 2 to 5 mm, G1 or G2) turns a crease into
  a controlled edge. Both patches stay exactly as designed; the blend adds its own band and
  trims the neighbours. Without a blend the crease is a sharp edge in the render.
- **Plan as data.** `m.patchLayout({ name, patches, featureLines, blends })` records the
  intended adjacency (roles `primary`, `secondary`, `transition`, `corner`, `glass`; sides
  `to`, `feature`, `mirror`, `free`) before building, and `m.surface({ layout })` builds it
  by matching sides in role order. `validate({ layout })` reports `patch-layout` warnings
  (codes `layout-*`) where the plan and the built sides differ (`examples/quality-body/layout.ts`,
  `examples/patch-network`).
- **Highlights.** Zebra stripes and highlight lines (`zebraStripes`, `highlightLines` with
  `field: 'reflection'` or `'isophote'`) and curvature shading show waves that outlines hide;
  `validate({ surfaceQuality: { highlights } })` checks that the extracted lines are
  themselves fair (`highlight`). Declare designed S-shapes on the patch with `inflections`
  so only accidental ripples fail.
- **`nothing-checked`.** A session with no patches and no feature lines is reported as
  unchecked, never as a pass.

## 5. Edge flow, support loops and export

A body that will be subdivided or edited needs edges that follow the lines. The isoparm
export (`nonPlanar: 'keep'`, `spacing: 'even'`) keeps the patch grid as quads and shares
one distribution along each shared side, so patch boundaries are continuous edge loops.
A patch `support: { sides, offset }` adds isoparms close to a crease so the loop holds
its edge. `checkEdgeFlow` (or `validate({ edgeFlow })`) reports a feature line whose edges
cover less than 0.98 of it (`feature-loop`), faces with aspect above 4, neighbours with
size ratio above 2, and counts of triangles and poles. Cut cells along trims are judged
with looser limits (`trim-aspect` 8, `trim-size-ratio` 4). The overlay kind `edges`
draws the quad edge flow over the shaded body for a close-up look.

## 6. Panel splits, gaps and flush

Cutting the body into panels is a design act: where the splits go, how many panels, how
wide the gaps. Considerations:

- **Where.** On creases and feature lines when possible; keep splits parallel to a body
  line or perpendicular to it, avoid a gap that wanders across a crown. Mirror splits
  about the center plane.
- **How wide.** Zones in `DTS_ZONES` give the defaults: zone A (visible body shuts) 3.5 mm
  +- 0.25 with flush, parallelism and symmetry limits of 0.3 mm; zone B +- 0.4 / 0.5;
  zone C +- 0.5 / 1 with no symmetry limit. A row may only tighten these.
- **How built.** `splitAlong(patch, cut, { gap, names, ring? })` splits one surface into two
  named patches with a constant gap: `cut` is `{ iso: 'u' | 'v', t }` or `{ curve }`, a 3D
  curve lying on the patch. Tessellate the halves with a small `snap` (the default can move
  a trim vertex 0.25 mm). `panelLine(path, { width, depth, profile })` cuts a groove for
  a cosmetic seam that does not separate the panels.

```ts
import { model, splitAlong } from '@forgeax/engine/modeling';

// `door` is a SurfacePatch surface from step 4
const split = unwrap(splitAlong({ surface: door, flip: true }, { iso: 'u', t: 0.5 },
  { gap: 0.0035, names: ['door-front', 'door-rear'] }));
const m2 = model();
m2.surface({ patches: [split.a, split.b], chord: 0.0005, snap: 0.00002, nonPlanar: 'keep', tag: 'door' });
const result = m2.shutLines({
  table: [{ id: 'door-split', parts: ['door-front', 'door-rear'], zone: 'A' }],
});
```

`m.shutLines({ table })` (also `validate({ shutLines })`, which turns failing rows into
`shut-line` errors) measures stations every 10 mm along each panel's edge: gap on the
theoretical line, flush, parallelism, symmetry against a `mirror` row, visual gap and
coverage (0.98). A row fails with `gap`, `flush`, `parallelism`, `symmetry`, `coverage`,
`visual-gap`, `break` or `unmeasured` (fewer than 3 stations). A `clearance: { min }`
row checks a designed separation such as a tire in its arch. A deviation you accept is an
`exception` with limits, a reason and a date, and still shows as a warning. A row's
`break: { drawing, item }` compares the measured seam with a drawn `break` curve. Details
in [../reference/detail.md](../reference/detail.md).

## 7. Openings, arches and glass

Window, handle and lamp openings are trims on a patch (`trims: [{ view, region }]` with a
closed outline in view meters); give `trimRing` a few millimeters so a later flange or
shell has small, planar faces at the cut instead of slivers. Wheel arches are an
operation on the mass: subtract a cylinder slightly larger than the tire (the blockout uses
a 35 mm gap) and check the gap with a `clearance` row. Glass is a material region: assign
faces above the beltline to a glass slot with `assign`, or build glass as its own patch
role `glass` in the layout. Tire and rim shapes are parts: `examples/wheel-rim` builds a
rim with spokes, and `examples/suspension` a double-wishbone corner of swept arms,
a lofted upright and a helix spring.

## 8. Moving panels and mechanisms

Doors, hoods and trunks add three constraints the static body does not have.

- **Release direction.** A panel must be able to leave its opening. `draft(model, {
  direction, faces, warn })` gives each face's angle to a pull direction (`safe` up to
  `warn` 85 degrees, `critical` to 90, `undercut` beyond, `shadowed` for faces behind
  others); `rig.release(part, path, { u, near, warn })` does the same along a motion
  path. An undercut means the part cannot leave that way; change the shape or the path.
- **Hinge or linkage.** Draw `pivot` and `linkage` items, then build a `rig(m, { joints,
  loops })` from the same numbers (`examples/door-hinge`: the hinge recipe bolted to body
  and door brackets, a hold-open spring and a trim cover; `examples/hood-linkage`: a hood on
  closed-loop linkages driven by a hydraulic cylinder). `recipes.pinJoint({ d, fit, ... })`
  builds a lug and clevis pair with ISO fits; its anchors give the pin axis.
- **Prove the motion.** `scan(path, { clearance })` samples the path and reports
  `confirmed` interference, undesigned `candidate` contact and `clearance` pairs closer
  than the threshold; designed contacts (pins in holes) are declared once. For closed
  loops `solve(pose)` reports `conditioning` and `branchRisk` (a fold where the assembly
  mode could flip) and `mobility(pose, { drivers })` compares the Gruebler-Kutzbach count
  with the Jacobian rank, reporting `overconstrained`, `underactuated` and redundant
  drivers. Joint `stops` with `rig.stopReport` check that a limit lands on its stop.

A mechanism that fails these checks is a design problem. Move the pivot, change the link
lengths or the opening, then rebuild; do not hide it by thinning the geometry.

## Order of gates

Run the cheap measurements at each stage and treat any unmeasured result as not passed:

1. Blockout: `dimension` and `silhouette` findings clean (`validate({ drawing })`).
2. Lines: `curve-inflection`, `curve-spike`, `curve-curvature-rate` clean.
3. Patches: `surface-density`, `surface-continuity`, `surface-fairness`, `highlight`,
   `patch-layout` clean; `nothing-checked` absent.
4. Flow: `feature-loop`, `aspect`, `size-ratio` clean (or accepted by name).
5. Panels: every `shutLines` row `pass`; exceptions listed, not hidden.
6. Motion: `scan` has no `confirmed` pair, mobility as intended, stops landed.
7. Delivery: `validate` has no errors; `finish` exports the mesh.

## What the tools do not decide

Whether the stance looks right, which line is the character line, how aggressive the
surfacing is, which gaps are acceptable on which panels and whether a crease should be
blended are your calls. The tools report numbers about the result; they do not rank
alternatives.
