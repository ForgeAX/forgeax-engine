# Surface quality: building smooth, reflective body surfaces

Part of the [`@forgeax/engine/modeling` knowledge notes](../README.md).

Silhouette and dimensions do not tell whether a curved surface is fair. A body panel can match
every measurement and still ripple under a reflection, crack along a seam, or smear a crease
across several grid cells. This note covers what makes a surface read as smooth, which kernel
tools build it that way, and which tools measure it. It matters for any hard-surface part that
is seen through reflections: vehicle bodies, appliance shells, helmets, armor plates.

Owners: the API and every parameter live in [`../reference/surfaces.md`](../reference/surfaces.md)
(curves, `nurbs.match`, patch layout, `checkSurfaceQuality`, edge flow) and
[`../reference/detail.md`](../reference/detail.md) (`blendSurfaces`, setback corners,
`supportLoops`). N-sided holes and corner patches are in [`nsided-patches.md`](nsided-patches.md).
Worked examples: [`../examples/quality-body`](../examples/quality-body) (right way versus wrong way
on one corner), [`../examples/patch-network`](../examples/patch-network) (a patch layout),
[`../examples/blend-corner`](../examples/blend-corner) (run-outs and setback corners).

Quick map of the sections:

1. What goes wrong, and the one idea behind the fix
2. Continuity levels and what each one costs in control rows
3. Order of work: lines, patches, blends, trims
4. Patch layout: where the boundaries go
5. Blends and crease holding
6. The measuring tools and how to read them
7. Failure codes and how to recover
8. Edge flow of the exported mesh
9. Judgements the tools do not make

## 1. What goes wrong

A surface looks bad for a small number of reasons, and most of them are decided before any
patch exists.

- **Too many control points.** A trace interpolated through every sample (`nurbs.grid`) carries the
  noise of the trace into the curvature. A 0.4 mm error in position is invisible; in the second
  derivative it is large, and a reflection shows it. A dense net cannot be edited by hand either.
- **Boundaries in the wrong place.** A patch edge that crosses a highlight band at a slant shows
  a visible join even when the join is G2. Boundaries should follow feature lines, or run along
  the direction the highlights run.
- **Creases smeared by tessellation.** A sharp crease inside one patch lands between grid lines and
  becomes a soft wobble. A crease is a patch boundary (G0 edge) plus a deliberate rounding.
- **Continuity bought by moving points afterwards.** Pushing control points to hide a join leaves a
  dent. Match the edge with `nurbs.match` instead, which moves the fewest points under a
  least-squares reparametrization.
- **Seams between separate calls.** Patches meet watertight only inside one `m.surface` call;
  separate calls never weld (`validate` reports `t-junction`).

The common fix: **few, long, low-span patches built between fair feature lines, joined at an
honest continuity level, with creases rounded by a small blend.** The kernel's checks measure
exactly this: net size, edge continuity, curve fairness, and highlight-line fairness.

## 2. Continuity levels

Continuity is the level of agreement across a shared edge. Each level asks for more control rows
on each side, which is why layout planning is about rows.

| Level | Meaning across the edge | Rows used from the edge, per side | Measured by `measureEdge` |
|:--|:--|:--|:--|
| G0 | positions meet | 1 | `gap` (m) |
| G1 | tangent planes meet | 2 | `kink` (degrees) |
| G2 | normal curvature meets | 3 | cross-edge curvature jump (1/m, and relative) |
| G3 | curvature rate dk/ds meets | 4 | rate jump (1/m^2, and relative) |

- A direction needs at least `level + 1` rows per matched side, 2 per feature side, 1 per free side.
  A 3-row net cannot be G2 on both sides: `nurbs.match` returns `model-precondition` with the hint
  to insert knots or elevate (`nurbs.surface.refine`, `nurbs.surface.elevate`, both exact).
- Typical use: primary panel to primary panel G2; panel to a rounded blend G1 or G2; a crease G0
  and then rounded. G3 is for highlight-critical joins of large primaries; request it with
  `continuity: 'G3'` on a layout side, a feature line, or a `nurbs.match` level.
- Pick the lowest level that survives the reflection. Raising it costs rows, and rows cost the
  fairness of the interior.

## 3. Order of work

The order is a judgement, not a procedure, but reversing it is what produces rework.

1. **Lines first.** Build the feature lines (shoulder, waist, sill, window edge, shut lines) as
   single-span, low-degree curves: `nurbs.approximate(points, { controlPoints: 4 or 5, degree: 3 or 4 })`
   or `nurbs.interpolate` through very few stations. Register them with
   `m.featureLine({ name, curve, continuity?, inflections? })`. Check them with `curveFairness`
   and `curvatureComb` before building anything on them.
2. **Primaries.** Large panels between those lines: `nurbs.loft(curves, { degree })` through
   lines and in-between sections, or `nurbs.fitSurface` on a trace with the feature lines as fixed
   `boundaries`. Stay inside the net budget (section 6).
3. **Secondaries.** Smaller panels that must match the primaries on their shared sides
   (`nurbs.match`, or a layout side declaration).
4. **Blends and corners.** Round the creases (section 5), then fill corners
   ([`nsided-patches.md`](nsided-patches.md)).
5. **Trims and openings.** Cut windows, vents and shut lines last, as `trims`/`imprints` on the
   finished surface. A shut line is a cut through one continuous surface, not two surfaces that were
   built apart and made to meet.

`nurbs.fitSurface` is the bridge from a noisy source (a traced grid) to a sparse net:
`net: [nu, nv]` or `net: 'auto'` with `maxError`, plus fairing `{ stretch, bend, rate }`.
Curvature-rate fairing (`rate`) removes trace noise without flattening the crown the way bending
fairing does. A net as large as the grid, without fairing, is plain interpolation and fails
quality like `nurbs.grid`.

```ts
// examples/quality-body/body.ts, trimmed: lines first, panels lofted between them
const line = (at: (t: number) => Tuple3) => {
  const fit = nurbs.approximate([0, 0.25, 0.5, 0.75, 1].map(at), { controlPoints: 4, degree: 3 });
  if (!fit.ok) throw fit.error;
  return fit.value;
};
const shoulder = line((t) => [1.2 * t, 0.5 + 0.03 * 4 * t * (1 - t), 0.42]);
const waist = line((t) => [1.2 * t, 0.3 + 0.012 * 4 * t * (1 - t), 0.47]);
const fender = nurbs.loft([shoulder, fenderMid, waist], { degree: 2 });
```

## 4. Patch layout: where boundaries go

A patch layout states the plan as data before the surface exists:
`m.patchLayout({ name, patches, featureLines, blends })`, then `m.surface({ layout: name, ... })`.
Roles are `primary`, `secondary`, `transition`, `corner`, `glass`. Each side of a patch is declared
once: `{ to: 'P02:u0', continuity, feature? }` (a shared edge; a list shares a side among several
patches), `{ feature }`, `{ mirror: 'x' | 'y' | 'z', continuity? }`, or `{ free: true }`.

Considerations:

- **Boundaries on feature lines.** A G0 crease names its line (`feature: 'knee'`); a smooth edge
  whose worst quarter runs at 10 to 60 degrees to the highlight band direction (where the surface is
  curved beyond R100 m) reports `layout-highlight`. Feature lines, blends, shut lines and trims
  define bands and are exempt.
- **Few, long patches.** One primary is typically degree 5 to 7 with at most 8 control points per
  direction. More than 8 gives `layout-net`. Splitting a long band exactly at stations
  (`nurbs.surface.split`) keeps the shape and gives two patches that are one polynomial at the cut.
- **No wedges.** A primary corner collapsed or within 20 degrees of straight or folded, or a side
  shorter than 5 % of its opposite, is `layout-degenerate-corner`. A three-sided patch folded into a
  four-sided one is how this happens; use a corner patch ([`nsided-patches.md`](nsided-patches.md)).
- **Mirror sides.** A side on a symmetry plane is held by matching against its own mirror image
  (default G2), so the center line has no seam.
- **Designed S-shapes.** `inflections: { u?, v? }` on a patch, and `inflections: [[t0, t1], ...]` on a
  feature line, declare ranges where one inflection is intended (a wheel-arch flare, a tuck and a
  flare along a flank). The fairness checks accept those and still reject a second one.

```ts
// examples/quality-body/layout.ts, trimmed: three primaries, two G0 creases, two rounded blends
m.featureLine({ name: 'shoulder', curve: lines.shoulder, continuity: 'G0' });
m.featureLine({ name: 'waist', curve: lines.waist, continuity: 'G0' });
m.patchLayout({
  name: 'body',
  featureLines: ['shoulder', 'waist'],
  patches: [
    { id: 'hood', role: 'primary', surface: hood, flip: true, sides: { v0: { free: true } } },
    { id: 'fender', role: 'primary', surface: fender, flip: true,
      sides: { v0: { to: 'hood:v1', continuity: 'G0', feature: 'shoulder' } } },
    { id: 'door', role: 'primary', surface: door, flip: true,
      sides: { v0: { to: 'fender:v1', continuity: 'G0', feature: 'waist' } } },
  ],
  blends: [
    { between: ['hood', 'fender'], radius: 0.005, continuity: 'G2', name: 'shoulder-blend' },
    { between: ['fender', 'door'], radius: 0.003, continuity: 'G2', name: 'waist-blend' },
  ],
});
m.surface({ layout: 'body', chord: 0.0005, nonPlanar: 'keep', spacing: 'even', tag: 'body' });
```

`validate({ layout })` reports `patch-layout` warnings whose `detail.check` is one of
`layout-rows`, `layout-net`, `layout-degree`, `layout-feature-unplaced`, `layout-unbuilt`,
`layout-fit`, `layout-continuity`, `layout-highlight`, `layout-degenerate-corner`. Read the check
name first: `layout-rows` and `layout-net` are plan errors (change the plan), `layout-fit` and
`layout-continuity` are measurements of the built patches, `layout-unbuilt` means nothing was
measured.

## 5. Blends and crease holding

A hard line needs a controlled transition, or it either shows a razor edge or a wobble. The tools:

- **`blendSurfaces` / `blends` in `m.surface`**: a rolling-ball fillet along one shared crease, both
  patches keep their exact surfaces and gain a trim outline, only the blend is fit. Radius is a
  constant or `[t, r]` stations (typically 2 to 5 mm on a body). `continuity: 'G1'` (default, near-
  circular cubic) or `'G2'` (quintic). The blend patch is tagged `transition` and its faces are
  tagged `support` for edge flow.
- **Run-outs**: leading or trailing radius stations of 0 end the blend before the side ends, with a
  C2 step (for example `[[0, 0.012], [0.8, 0.012], [1, 0]]`). Keep the crease outside the range
  declared as a `G0` feature line. A run-out shorter than 0.4 of the side length reports
  `surface-fairness` on the neighbouring isoparm even though the zebra is unaffected; lengthen it.
- **Setback corners**: three or more blends meeting at one vertex (`corners: [{ blends, setback,
  continuity }]`); see [`nsided-patches.md`](nsided-patches.md).
- **Support loops** (`m.supportLoops(edges, { offset })`) hold a crisp edge on the subdivision
  route: one or two loops at 1 to 5 mm on both sides. `markSharp` is the infinitely sharp
  alternative.
- **Shut-line edge rounds**: a shut line is a groove cut in the surface; its edges are held with
  the same support loops or the panel line profile, not by a separate surface.

Failure modes: a tangent joint (no crease) or a ball that leaves a patch is `model-precondition`.
A blend whose fit stops above `tolerance / 2` reports a `warn` with its `gap`. A trim edge along a
blend is judged at the `blend` class limits with that gap as the position limit.

## 6. The measuring tools

All of them evaluate the exact NURBS patches that `m.surface()` records, not the triangulation,
except where noted.

**Views (for the eye; deterministic, exact where a patch owns the vertex):**

- `surfaceField(mesh, surfaces?)` gives normal, Gaussian and mean curvature per render vertex.
  Vertices not owned by a patch fall back to a mesh estimate that depends on tessellation.
- `zebraStripes(field, surfaces, { eye | direction, right, up, width?, orientation?, refine? })`:
  reflected parallel light tubes. Stripes should flow smoothly and cross patch joins without a
  bend; a kink in a stripe is a G1 break, a stripe that thickens or thins abruptly is a G2 break.
- `highlightLines(surfaces, { field: 'reflection', ... } | { field: 'isophote', direction, step })`:
  the same information as curves, so it can be judged by number.
- `curvatureShading(field, { kind: 'gaussian' | 'mean' })`: blue negative, white zero, red positive.
  Two-tone surfaces where one tone is intended are fine; a speckle is noise.
- `curvatureComb(curve, { samples?, scale? })`: a tooth per sample; teeth must change side only at a
  designed inflection, and the envelope should be smooth.
- `coloredMesh(triangles)` turns any of these into a `MeshAsset` for an unlit vertex-color material.

**Gates (numbers, `m.validate({ surfaceQuality: true | options })`):**

| Code | What it catches | Default |
|:--|:--|:--|
| `surface-density` | control net per patch, [longer, shorter] | `maxNet` [8, 6] |
| `surface-continuity` | every shared edge below its `required` level | gap 1e-4 m, kink 0.5 degrees, curvature 5 % (floor 0.01 1/m) |
| `curve-inflection` | an undeclared inflection on a feature line | `maxInflections` 0 |
| `curve-spike` | a lone curvature peak | `spike` 0.5 |
| `curve-curvature-rate` | rate ratio \|dk/ds\| x length / max curvature | `maxRateRatio` 15 |
| `surface-fairness` | the same curve checks on 5 interior isoparms per direction | `fairness` thresholds, `isoparms` |
| `highlight` | the same on every fitted highlight line (opt-in with `highlights`) | `fairness` thresholds |
| `nothing-checked` | no patches or feature lines were recorded | never passes vacuously |

Strict limits: `D09_CLASSES` holds per-class limits for production surfaces (primary and trim edges
0.01 mm, 0.1 degree, 2 % curvature, rate 10 %; blend edges 5 % curvature with no rate requirement).
Pass them as `surfaceQuality: { classes: D09_CLASSES }`. The defaults are looser: a 0.3 degree kink
passes the default 0.5 degrees and fails as a primary edge under `D09_CLASSES`.

```ts
const v = m.validate({
  surfaceQuality: {
    classes: D09_CLASSES,
    highlights: { field: 'reflection', eye: [3, 1, 3], right: [1, 0, -1], up: [0, 1, 0], width: 3 },
  },
  edgeFlow: { tolerance: 0.005 },
});
for (const i of v.issues) console.log(i.code, i.detail.check, i.detail.subject);
```

How to read a failure: `detail.subject` names the patch, edge (`a:side|b:side`) or line; the
located fields give the worst value, parameter and point; `detail.opIndex` says which operation
declared it. `surface-continuity` reports `achieved` (`none`, `G0`, `G1`, `G2`) beside `required`.

## 7. Recovery by code

- `surface-density`: the net is too big. Refit with `nurbs.fitSurface` at a smaller `net`, or split
  the patch into two long ones. Do not delete the check: dense nets are where ripples come from.
- `surface-continuity` on a smooth edge: run `nurbs.match(a, sideA, b, sideB, { level })`, or
  declare the side in a layout so the build matches it. If `match` says `model-precondition`, insert
  knots or elevate degree first. If the gap is large the two patches do not meet: fix the lines.
- `surface-continuity` on a crease: declare it a designed break (`G0` feature line) and add a blend.
- `curve-inflection` / `surface-fairness` inflections: remove the wiggle at the source (fewer
  control points, `rate` fairing). If the S-shape is designed, declare `inflections`.
- `curve-spike` / `curve-curvature-rate`: usually one control point out of line, or a line made of
  too many fitted points; refit with fewer control points and a lower `maxError` budget.
- `highlight`: shows a fault the numeric edge checks miss because it lies inside a patch. Find
  the line with `detail.point`, then the owning patch, then the net rows near it.
- Joins across `m.surface` calls: build adjacent panels in one call; `sew`, `weld` and `snap`
  only close gaps within a few multiples of the model tolerance. A larger gap is
  `model-precondition` on the seam.

## 8. Edge flow of the exported mesh

Surface quality also has a mesh side: the exported edges should follow the feature-line network.

- `checkEdgeFlow(mesh, featureLines, options?)` (or `validate({ edgeFlow })`): `feature-loop` (a
  feature line not covered by a single chain of on-line edges, coverage 0.98, tolerance 0.5 mm),
  `aspect` (above 4), `size-ratio` (above 2), `trim-aspect` (above 8) and `trim-size-ratio`
  (above 4) for cut cells, and info counts for `triangles` and `poles`. Faces tagged `support`
  (blend bands, support strips) are exempt from shape limits.
- Export shape: `m.surface({ nonPlanar: 'keep', spacing: 'even' })` keeps isoparm quads and spaces
  them evenly in arc length; patches that share a side share its isoparms, so the boundaries are
  continuous edge loops. `trimRing: d` adds a ring of quads around every trim so a flange or shell
  inset does not fold. `support: { sides, offset }` on a patch adds support isoparms along a crease.
- `m.meshQuality(faces?, limits?)` is the triangle-tiling counterpart for stylized faceting
  (equilateral ideal); defaults in `MESH_QUALITY_LIMITS` (aspect p50 2, p90 4, smallest angle
  p10 at least 20 degrees, size ratio p95 at most 2).
- The V-wire overlay (`overlays: ['edges']`) draws the n-gon edges so the flow can be read by eye.

## 9. Judgements the tools do not make

- Whether a highlight line has the right character (tight and quick on a shoulder, long and slow on a
  roof) is an eye judgement; the tools judge only fairness (no ripples, spikes or accidental
  inflections) and continuity.
- Quality grades of surfaces (production, visible-secondary, hidden) are a manual choice of which
  `classes` limits to apply to which patches. The kernel applies one set per edge class.
- Whether a feature line is the right line is a design decision; the tools only check that it is
  fair and that the patches follow it.
- A designed S-shape needs a declaration; nothing infers it. If the checks flag an inflection you
  want, declare it where it belongs (patch or feature line) rather than loosening a limit.
