# Curves, surfaces, patch networks and surface quality

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Curves, surfaces and 2D regions

`nurbs` holds NURBS curves (`{ degree, points, weights?, knots }`) and tensor-product
surfaces (`{ degreeU, degreeV, points[i][j], weights?, knotsU, knotsV }`) as plain data,
with standard NURBS algorithms: `point`, `derivatives` (rational, any order),
`surfacePoint`, `surfaceDerivatives`, `closest` (point inversion), `insertKnot`,
`refine`, `elevate` (exact, A5.9: each interior knot keeps its multiplicity plus the
raise), `normalize` and `compatible`. Construction: `interpolate(points, { degree?, parametrization?,
parameters? })` (global interpolation, centripetal by default), `approximate(points,
{ controlPoints })` (least squares, fixed ends), `loft(curves, { degree?, parameters? })`
(skinning: section k is the isoparm v = parameters[k]), `grid(rows)` (surface through
a point grid) and `network(uCurves, vCurves)` (Gordon surface: each curve is refit so
the intersections land on shared isoparms; curves that miss each other are
`model-precondition`). Failures are structured: malformed knots or weights
`model-invalid-argument`, singular fits `model-degenerate`.

`nurbs.surface` is the surface algebra a patch layout needs, each
acting along one direction `'u'` or `'v'` and returning a Result: `insertKnot(s, dir, t,
times?)`, `refine(s, dir, knots)`, `elevate(s, dir, by?)` (A5.9 per control line),
`split(s, dir, t)` (two patches on the original parameters; `t` strictly inside the
domain, else `model-invalid-argument`), `extend(s, side, length, { continuity? })` and
`compatible(surfaces, dir)` (domain [0, 1], the highest degree and the union of the
knots). All but `extend` keep the shape exactly (tests: at most 1e-12 m at 2048 random
points), and the halves of a split are one polynomial, so the cut is as smooth as the
patch there. `extend` grows the domain past a side so the mean distance between the old
and the new side is `length` meters: `'G2'` (default) continues the boundary span's own
polynomial (the net keeps its size), `'G1'` continues along the cross-boundary tangent
(one more span); the original domain keeps its parameters and shape.

`nurbs.fitSurface(rows, { degree?, net, maxError?, maxNet?, fair?, boundaries?,
parametrization?, parameters? })` approximates a point grid `rows[i][j]` (i along u) by a
much smaller net instead of interpolating it (standard least-squares approximation with variational terms): least squares on averaged chord parameters (default), plus optional
fairing `{ stretch, bend, rate }` (dimensionless weights on the integrated squared first,
second and third derivatives over the unit parameter square; the data term is the mean
squared error) and fixed boundary curves per side (the side's control row becomes the
curve, raised to the fit degree; a curve whose knots the fit lacks is
`model-precondition`). `net: [nu, nv]` is the control net (at most the grid size unless
faired); `net: 'auto'` starts with one span per direction and adds a span where the error
is largest until `maxError` (meters, required) holds or `maxNet` (default [8, 8]) is
reached (`converged: false`). The result carries `surface`, `rms`, `max`, `at` (grid
indices of `max`) and `net`. Curvature-rate fairing removes trace noise without the
flattening bending fairing causes; a net of the grid size without fairing is plain
interpolation and fails surface quality like `grid`.

`nurbs.match(a, sideA, b, sideB, { level, modify?, lockPosition?, opposite?, influence?,
samples? })` aligns patch `a`'s side to `b`'s at `level`
`'G0'` to `'G3'`: both sides are first made compatible along the edge (exact: same
domain, degree and knots, `b` reversed when it runs the other way), then rows 0..level of
`a` from the edge are set from `b`'s cross-edge derivatives under a constant
reparametrization (scale, then the second and third order terms) chosen by least
squares to move `a` least; no other control point changes. `modify: 'both'` moves both
patches toward a shared edge, `lockPosition` keeps the edge row, `opposite` (default
`'G0'`, or `'none'`) is the continuity `a`'s opposite side keeps (its rows stay fixed),
and `influence` (0 to 1) fades the last matched row's displacement over the free rows
behind it. A side without enough free rows or degree (G2 on both sides of a 3-row net)
is `model-precondition` with the hint to insert knots or elevate; so are rational
patches and patches that fold over at the edge. The result carries `a`, `b`, `rows`
(rows changed) and `residual`, the `measureEdge(a, sideA, b, sideB, samples?)` report:
the worst gap (m), kink (degrees), cross-edge curvature jump (1/m and relative to the
larger side, at least 0.01 1/m) and curvature-rate jump dk/ds (G3; 1/m^2 and relative),
pairing each sample of `a`'s side with the closest point of `b`'s. Matched edges meet the
`D09_CLASSES` tolerances (0.01 mm, 0.1 degree, 2 %) in the tests. `scale: 'ends'` fits
the reparametrization at the edge's two end columns only, so a side whose ends lie on
fixed curves (pieces of the same feature lines as the master's) keeps them exactly.
`nurbs.split(curve, t)` cuts a curve into its two exact pieces (feature-line pieces for
patches fit between stations).

Continuity reaches G3: where an edge is G2, the jump of the cross-edge curvature
rate dk/ds is compared with `rate` (default 0.1 of the larger side, floor 0.01 1/m^2), and
`continuity: 'G3'` (an option or a feature line) requires it. `classes: { primary?, blend?,
trim? }` sets limits per edge class (`position`, `angle`, `curvatureRatio`, `rateRatio`;
without it the defaults above apply unchanged): edges of a `transition` patch (blends) are
`blend`, patch sides `primary`, and trim edges `trim`. `D09_CLASSES` holds the
primary, blend and trim tolerance values (0.01 mm / 0.1 degree / 2 % and rate 10 %; blends 5 % without G3; trims as primary).
`m.surface` records each patch's trim loops: side samples inside a trimmed region are not
paired, and each trim loop is sampled against the sides of the other patches (an edge with
`sideA: 'trim'` and the loop index). A 0.3 degree kink passes the 0.5 degree default and
fails as a primary edge.

## Patch layout

A patch layout is the plan of a surface as data, entered
before the surface is built: `m.patchLayout({ name?, patches, featureLines?, blends? })`.
Each patch has an `id`, a `role` (`primary`, `secondary`, `transition`, `corner`,
`glass`), an optional planned `degree` and `net`, an optional `panel`, its geometry as
`surface` or `fit: { points, ...fitSurface options }` (fit with the planned degree and
net), the tessellation fields of a `surface()` patch, and one declaration per side:
`{ to: 'P02:u0' | [...], continuity: 'G0' to 'G3', feature? }` (a shared edge, declared
once on either patch; a list shares one side with several patches; `feature` names the
feature line a G0 crease lies on), `{ feature }` (on a feature line), `{ mirror: 'x' | 'y'
| 'z', continuity? }` (on the plane axis = 0, default G2) or `{ free: true }`. Unknown
references, a side declared twice and unlisted feature lines are `model-invalid-argument`.

`m.surface({ layout: name, ...tessellation options })` builds it: patches in role order
(primary, secondary, glass, transition, corner; then declaration order), each fit if
given points, its mirror sides held (`match` against its mirror image, `modify: 'both'`),
then each shared side matched to the patch built before it (`nurbs.match`, creases
first; a side shared with several patches is matched part by part against the exact
piece of the master beside it). The opposite side keeps its own level, and when both
neighbouring sides are fixed the reparametrization is fit at the edge's ends. The
layout's `blends` follow; a blend only trims the two patches beside its crease, so every
smooth shared edge stays as matched.

`validate({ layout })` reports `patch-layout` warnings (`detail.check`): the plan
(`layout-rows`: a direction with fewer control rows than its matched sides need, level + 1
per matched side, 2 per feature side, 1 per free side; `layout-net`: a primary over 8 per
direction, or a built net other than planned; `layout-degree`: matched sides of different
degree along the edge; `layout-feature-unplaced`: a listed feature line on no side;
`layout-unbuilt`: the layout, or a patch without geometry, was not built, so nothing was
measured), and once built: `layout-fit` (a patch fit to points that did not converge or
leaves them by more than its `maxError`, else `fitTolerance`, 1 mm; the residuals are also
in the surface operation's journal), `layout-continuity` (shared and mirror sides against
their level at the limits of `D09_CLASSES`, on the built patches, which the
blends trim and never move),
`layout-feature-unplaced` (a feature side more than `featureTolerance`, 0.1 mm, off its
line, or a part of a listed line farther than that from every side declared on it),
`layout-highlight` (an invisible boundary, a smooth matched edge, whose worst quarter runs
at 10 to 60 degrees to the highlight band direction, anisotropy-weighted, where the
surface is curved beyond R100 m and anisotropy reaches 0.2; feature lines, fillets, shut
lines and trims define the bands and are exempt; a layout rule) and
`layout-degenerate-corner` (a primary corner collapsed or within 20 degrees of straight or
folded, or a side shorter than 5 % of its opposite: a wedge).
A layout from a published surfacing table enters directly.

`m.surface({ patches })` tessellates patches into the editable mesh. Each direction's
isoparms start at the knots and split until every segment stays within `chord` meters
(default 0.001) of the surface and turns its tangent by at most `angle` degrees
(default 12), up to `maxSegments` per direction (a warning reports the cap). Patches join
edge first (`src/surface-seams.ts`): each call keeps a seam table of the side pairs
that share a part within the larger of `weld` and `snap` (found geometrically, so calls
without a layout weld too; with `layout`, its declared side pairs as well; a side part pairs
with its closest partner only, so a thin blend band pairs with both its neighbours, not they
with each other). The patch emitted first owns each seam: its side takes the other side's
isoparms there (both sides' demand; a demanded point within `snap` of an existing isoparm
pairs with it), samples the seam once, and the other patch emits those points with the same
vertex ids. Its own evaluation's distance there is the seam's measured gap (the
`measureEdge` gap): within the model tolerance the seam is valid; within twice the tolerance
or within `sew` (meters, capped at a tenth of the seam length) it is sewn with a `warn`
naming it; a larger gap is `model-precondition` (detail `seam`, `gap`, `at`, `limit`). Seam
samples that meet at one patch point (corners of three or four patches) or within `snap` on
one patch become one vertex. An `info` diagnostic and `m.diagnostics().surfaces[].seams` (on
the owner) report every seam as `{ a, sideA, b, sideB, gap, weldMove, weldAt? }`, `weldMove`
being the largest positional merge on it. The positional weld remains only within one patch
(`snap`) and, capped at the model tolerance (`weld`, at most), for coincidences no seam pairs;
so closed seams and poles weld, and adjacent patches must agree in orientation (`flip`
reverses one). `trims` cut holes and `imprints` split faces into
their own `role`, `tag` and `material` slot; both are regions of the normalized domain
(`{ uv }`, [0, 1] x [0, 1]) or outlines in an orthographic view projected onto the patch
(`{ view, region }`, Newton inversion, clamped to the domain; a fender-like patch folds over in a
side view, so a view trim lands on the side facing that view). Build adjacent patches from shared
section data (same stations and parameters) so their boundaries coincide. Their edges are refined
to the chord, cut through the `region` compute job, and the cut cells become triangles
(ear clipping, then Delaunay flips in meters) while the other cells stay quads; cells
whose diagonals leave the chord (measured along the surface normal) split further. Where
a trim or imprint crosses a patch side, that point becomes a sample of the seam there (the
partner's side faces split at it), so cuts across a seam stay watertight; on a side no seam
pairs, it is inserted into every patch boundary within reach, and a crossing within the chord
of another patch's boundary but off it is a `warn` (the seam may crack). Watertight joins
hold only inside one `surface` call: separate calls never weld, which `validate` reports as
`t-junction`. Vertices of one patch closer than `snap` (default a quarter of `chord`) merge,
so a trim passing near a grid node leaves no sliver, and quads
bending out of plane by more than five times the model tolerance (half the validate limit, so shell walls stay under it) split along their shorter
diagonal (`nonPlanar: 'keep'` keeps them for later subdivision; an `info` diagnostic
counts the split). uv0 is the domain in meters (mean isoparm lengths), uv1 the
normalized domain for decals and text. The journal records a summary of each control
net.

`region2d` covers 2D outlines with holes for contours, text and panel layouts:
`union`, `difference`, `intersection`, `xor`, `offset(region, delta, { join, miterLimit,
arcTolerance })` (`round`, `miter`, `bevel`; holes move opposite to outlines) and
`stroke(polylines, halfWidth, { cap, join })` (`round`, `butt`, `square` caps), plus
`area`, `contains`, `bounds`, `encode` and `decode`. Inputs may overlap and use either
orientation; results are disjoint shapes (outlines counter-clockwise, holes clockwise,
rings starting at their lowest-then-leftmost point). All run as the `region` compute job
on one arrangement: edges split at exact-predicate intersections, welded within
`tolerance`, and each piece kept with the result's inside on its left (raw
offsets regularized by positive fill). The result carries the job report and per-edge
provenance (operand, ring, edge; -1 for joins and caps); `compute: { policy: 'native' }`
is `model-capability-unavailable` until a native backend exists.

## Surface quality: views and checks

Silhouette and dimensions do not show whether a body surface is fair. These views and
checks (feature lines, fairness, continuity) make it
visible and gate it. They evaluate the exact NURBS geometry: `m.surface()` records each
patch (`diagnostics().surfaces`, named by patch `name`, repeats `.1`, `.2` ...), and
`m.featureLine({ name, curve, continuity?, inflections? })` records a styling line
(`featureLines`) without changing the mesh. `inflections` declares designed S-curves:
normalized parameter ranges that each hold one inflection. Fairness reports those as
`designed` and accepts them; a second inflection in a range, or any outside the ranges,
is still a `curve-inflection` issue (so an accidental wiggle on a designed S still fails).

| Surface | Contract |
|:--|:--|
| `surfaceField(mesh, surfaces?, { tolerance? })` | Normal, Gaussian and mean curvature of every render vertex. A vertex whose `uv1` (the normalized patch domain `m.surface` writes) maps onto a given patch within `tolerance` (default 2e-5 m) is exact (one Gauss-Newton step removes the float32 rounding; its normal keeps the mesh side). Elsewhere: the exported vertex normal and a quadric `z = ax^2 + bxy + cy^2` fitted over the one-ring (two-ring below five neighbours), vertices welded by position and normal so UV seams do not cut the neighbourhood and sharp edges do. Mesh estimates depend on the tessellation (about 4 % of the mean curvature on a 2 mm chord) and amplify facet noise; mirrored or later-edited vertices fall back to them |
| `zebraStripes(field, surfaces, { eye \| direction, right, up, width?, orientation?, refine? })` | Reflected parallel light tubes: the view ray reflected about the normal, its angle around the stripe axis (`orientation` degrees from screen right, default 0) in stripes of `width` degrees (default 4). Triangles split exactly on the stripe borders of the linearly interpolated angle; a triangle spanning more than two stripes subdivides (up to `refine`, default 3) and re-evaluates exact patch points and normals when its corners share a patch |
| `highlightLines(surfaces, { field: 'reflection', eye \| direction, right, up, width?, orientation? } \| { field: 'isophote', direction, step }, weld?)` | Highlight lines as curves: `reflection` uses the zebra's own phase (one definition), so the lines are the stripe borders at multiples of `width`; `isophote` the view-independent lines where the angle between the patch normal (dS/du x dS/dv) and `direction` is a multiple of `step` degrees (n · direction = cos(k · step), `step` in (0, 90]). Each patch is sampled on a 64 x 64 parameter grid, marching squares find the level crossings, each is bisected onto the exact level, polylines chain across patches where their ends meet within `weld` (default 1e-6 x the scene diagonal), and each chain (8 points and 1 % of the diagonal at least) is fit with a cubic `approximate` (a control point per 3 points, at most 48). Returns `{ lines: { curve, level (degrees), patches (crossed, in order) }[] }`, deterministic |
| `curvatureShading(field, { kind: 'gaussian' \| 'mean', range? })` | Diverging blue (negative), white, red (positive) per vertex; `range` (1/m^2 or 1/m) maps to the ends, default per scene: the 95th percentile of the absolute value. Colors are linear (display color squared) |
| `curvatureComb(curve, { samples?, scale? })` | Line list: a tooth per sample away from the center of curvature, curvature x `scale` long (default: the longest tooth is 15 % of the curve, less on gentle lines whose curvature stays below 1 / length, so a straight line shows no noise), and the envelope through the tips. Teeth change side at an inflection |
| `coloredMesh(triangles)` | The colored triangles as a MeshAsset (slot `analysis`) for an unlit vertex-color material |
| `checkSurfaceQuality({ surfaces, curves }, options?)` | The report below; `m.validate({ surfaceQuality: true \| options })` runs it on the session's patches and feature lines |
| `curveFairness(line, fairness?)` | One curve's arc length, curvature, inflections, spikes and curvature rate |

`checkSurfaceQuality` returns `{ pass, thresholds, surfaces, edges, curves, issues }`;
every issue is an `Issue` (`code`, `severity` `warn`, `detail`); `detail.subject` is the id it
concerns and the rest its located detail:

| Code | Check | Default threshold |
|:--|:--|:--|
| `surface-density` | control net per patch, compared as [longer, shorter] direction | `maxNet` [8, 6]; a 10 x 8 net fails |
| `surface-continuity` | every shared edge (`a:side\|b:side`, sides `u0 u1 v0 v1`): G0 largest gap, G1 largest kink between the cross-edge tangents, G2 largest jump of the cross-edge normal curvature; `achieved` (`none`, `G0`, `G1`, `G2`) below `required` fails | `position` 1e-4 m, `angle` 0.5 degrees, `curvature` per scene (5 % of the larger curvature, at least `curvatureFloor`, default 0.01 1/m) or absolute; `continuity` G1 |
| `curve-inflection` | the binormal of a feature line turns over between samples whose curvature exceeds 1 % of the line's maximum, away from the outer 1 % at each end | `maxInflections` 0 |
| `curve-spike` | a curvature peak rising above both neighbouring valleys by `spike` x the median curvature (at least 1 / length) over less than a fifth of the line | `spike` 0.5 |
| `curve-curvature-rate` | largest \|dk/ds\| and its ratio to max curvature / length | `maxRateRatio` 15 (a fair arc is under 1, a quarter ellipse of axis ratio 3.3 is 8, a densely interpolated noisy trace over 50; near-straight lines with max curvature x length below 0.05 report 0); `maxCurvatureRate` (1/m^2) per scene |
| `surface-fairness` | interior isoparms of every patch (`isoparms` per direction, default 5 at 1/6 ... 5/6; 0 turns it off) run the curve fairness checks above: a sparse net can still ripple (an 8 x 6 panel with interior points alternating 2 mm, or a 1.5 mm zig-zag loft section, fails); detail `along`, `parameter`, inflections, spikes, rate ratio and the point | the `fairness` thresholds; a patch's own `inflections: { u?, v? }` (declared on the `m.surface` patch, for example `{ v: 1 }` for a wheel-arch flare) sets `maxInflections` for its isoparms in that direction only, so a designed S-shape passes while ripples (extra inflections, spikes, the other direction) still fail |
| `highlight` | opt-in with `highlights` (the `highlightLines` options, for example `{ field: 'reflection', eye, right, up, width: 3 }`): `curveFairness` on every fitted highlight line, one issue per failing line with `level`, `patches`, `point`, `inflections`, `spikes`, `rateRatio`, `curvatureRate` and `rateAt`. Designed shapes are exempt only by declaration. Inflections: each crossed patch's `inflections` in the direction the line runs on it, plus one per feature-line `inflections` range whose middle lies on that patch, allow that many over the line's part on the patch (summed per patch run, not per line). Tangent breaks: the line is split, each side judged alone, where it crosses a shared edge a feature line declares `G0`/`G1`, or a contact edge of a blend band whose `transition.continuity` is `G1` (`blends` record their `continuity` there; a layout `transition` patch takes its layout blend's, else `G1`) or that realizes a declared crease (a `G0`/`G1` feature line runs inside it; the band's own lines are the crease's rounding and are not judged). Adjacency and measured angles never exempt a joint, so a kink on a G2 joint is reported; a narrow undeclared G2 band still turns lines sharply and may flag | the `fairness` thresholds; the `quality-body` example: the right body 0 findings, the densely interpolated trace 105 of 107 lines, a 0.2 mm bump (sigma 20 mm) on a crowned panel 4 |
| `nothing-checked` | no patches and no feature lines were recorded, so nothing was checked (a mesh-only session never passes vacuously); with `highlights`, also when no highlight line was extracted (check the view or field) | - |

Sides pair when two samples of one side (`samples` per side, default 16) project within
`adjacency` (default 1 mm) onto a side of another patch running the same way; a closed
patch's seam pairs with itself. A feature line with a `continuity` sets `required` for the
edges lying along it, and `G0` tags them a designed break (`designedBreak`, the crease a
later fillet or support loop holds). Each edge reports the parameter range, sample count
and the worst value, parameter and point of each measure. In `m.validate`, each finding is a
`surface-quality` warning (`detail.check` is the code, `detail.point` the worst point,
`detail.opIndex` the operation that declared the patch or line, which `model.validate`
reports as the source); invalid options are an error issue (`detail.check: 'options'`).

## Edge flow: V-wire, edge-flow check and isoparm export

The exported mesh's edges must follow the feature-line network (the feature-line network): continuous
edge loops on the shoulder, waist, pillars, window frames, wheel arches and shut lines,
regular quads, triangles only at poles and ends, and support loops or creases holding each
hard line.

- **V-wire**: overlay kind `edges` draws every n-gon edge (the edge flow, not the export
  triangulation), lifted along its faces' normals over the shaded body;
  `projectOverlay(mesh, 'edges', bounds)` keeps only edges with an end inside `bounds`, and
  `model.render --overlays '["edges"]' --frame [...]` uses the frame for a close-up.
- **`checkEdgeFlow(mesh, featureLines, options?)`** (also `m.validate({ edgeFlow })`):
  `feature-loop` (warn): a feature line whose on-line edges (both ends within `tolerance`,
  default 0.5 mm, spanning their own length along it) cover less than `coverage` (default
  0.98) of it or form more than one chain, with the uncovered ranges and points;
  `aspect` (warn): faces whose principal in-plane extents differ by more than `maxAspect`
  (default 4); `size-ratio` (warn): neighbours whose linear sizes differ by more than
  `maxSizeRatio` (default 2); `triangles` and `poles` (info): counts with located examples
  (interior valence other than 4, boundary valence above 3). Faces tagged `support` (support
  strips and blend bands) are thin by design: they skip the shape limits, their triangles
  are not counted, and nor are poles on them. The cut cells along a blend's seam (tagged
  `trim`) are their own group with looser limits: `trim-aspect` (warn) above `maxTrimAspect`
  (default 8) and `trim-size-ratio` (warn) above `maxTrimSizeRatio` (default 4), twice and
  four times the quad limits since a cut cell is about half a quad (a clean seam measures
  aspect p95 4.6, max 5.2 and size ratio max 2.9); slivers where an outline grazes a grid
  line are findings. Their triangles and poles are not counted. The report also has the aspect and size
  distributions (max, p50, p95, over), the `trim` group's (`faces`, `triangles`, `aspect`,
  `sizeRatio`) and quad/triangle/n-gon counts.
- **`m.meshQuality(faces?, limits?, { flow? })`** (also `m.validate({ quality: [{ part, limits? }] })`):
  triangle tiling quality for stylized faceting, where the ideal is
  the equilateral tiling rather than quads. Over the triangles of the faces (n-gons are
  counted and skipped): aspect (longest edge squared over twice the area, 1.155
  equilateral) p50 / p90 / max and the share above 6; smallest angle p10 and min;
  interior vertices (off open boundaries, every incident face measured) by valence and the
  share of valence 3 or at least 9 (fans and spikes); the 95th-percentile and largest ratio
  of the mean edge lengths of two faces sharing an edge; triangles per square meter.
  `failed` names the `limits` exceeded (default `MESH_QUALITY_LIMITS`: aspect p50 2, p90 4,
  above 6 at most 2 %, smallest-angle p10 at least 20 degrees, bad valence at most 1 %,
  size ratio p95 at most 2; compared up to 1e-9 rounding). In `validate`, each `part` (a
  tag, else a label) that fails is a `mesh-quality` warning with `failed` and the report;
  a part that names no face is one with `reason: 'unknown-part'`.
  `m.meshQuality(faces?, limits?, { flow })` also measures how the triangles follow `flow`
  guides (the same `{ faces?, flow }` list as remesh `direction`): the angle between each
  triangle's longest edge and its guide's flow at the centroid (at most 90 degrees), over
  triangles of aspect 1.5 or more; rounder ones are the `skipped` share. `flow: { p50, p75,
  measured, skipped }`, gated by `flowP75` (20 degrees) and `flowSkipped` (0.4), so a
  near-isotropic tiling cannot pass by skipping. The one owner of the flow measure: plan
  gates and remesh reports call it.
- **Isoparm export**: `m.surface({ nonPlanar: 'keep', spacing: 'even' })` keeps the
  isoparm quads and spaces each patch's isoparms evenly in arc length at about the finer
  direction's cell size for the whole call (C0 knot lines stay), refining again where a
  tolerance fails; patches sharing a side take one isoparm distribution along it (each
  neighbour reached through a shared side adopts that side's isoparms), so a chain of
  panels and blends meets vertex to vertex and patch boundaries (the feature curves of a
  network) are continuous edge loops. A `transition: { kind: 'blend', continuity }` patch (blends set it with their `continuity`, default `G1`; corner quads are `kind: 'corner'` with the corner's `continuity`) keeps
  its refined isoparms across its band and tags its faces `support`. Faces whose cell a
  trim cuts or an imprint boundary crosses get the tag `trim` (flanges and seals select
  the cut with it). `trimRing: d` (meters, default 0) adds a ring of quads along every
  trim loop: each cut vertex moves `d` along the miter of its edge normals,
  `(n1 + n2) / (1 + n1 . n2)` capped at 4, and the grid cells meet that offset loop (a
  loop reaching past the patch's sides, as a blend's trim does, takes no ring). So
  no face at the cut has a cut vertex just above a slanted edge, which a flange or shell
  inset would fold over (Delaunay cut triangles leave altitudes of 0.17 mm on the `quality-body`
  window); one ring quad per grid column keeps them small and planar. Ring faces are
  tagged `trim` and `support`; a ring leaving the patch or folding over is
  `model-precondition`. Vertex offsets follow the surface metric at the vertex, so ring
  edges leave the cut perpendicular to it in 3D on skewed patches too. A trim reaching
  past the patch sides is clipped to the domain first: loop edges along a side get no
  ring, the cut vertex at the side slides along it (onto a grid isoparm less than half
  the depth beyond, so no cell sliver stays), cut vertices nearer the side than the depth
  are dropped where the shortened edge stays within the `snap`, and the ring face at the
  side is split so its side edge and its cut edge lie in different faces (only the cut
  one is tagged `trim`). With a ring, the grid cells beyond it are not tagged `trim`. A
  trim's own `ring` (meters) replaces `trimRing` for that trim. A patch's
  `support: { sides: ['u1'], offset: [0.002, 0.004] }` adds isoparms at those mean
  distances from its sides (closer grid isoparms give way) and tags the strips `support`;
  give both patches of a crease their side. Shared boundaries carry the support isoparms
  across neighbouring patches, so the loops run the whole line.
