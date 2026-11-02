# Sweep, loft, array, subdivision and deformation

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Sweep, loft and array

`sweep` places a closed `[x, y]` section along a path: x along the frame's x axis, y
along its up axis, the path tangent out of the section (either winding is accepted).
Paths are a bare point list (polyline) or a `path.*` spec, all plain journal data:
`path.polyline(points, { radius, segments }?)` rounds every corner into an exact circular
bend, `path.catmullRom(points, segments)` is centripetal, `path.arc({ radius, angle,
segments, axis?, center?, startAngle? })` uses the revolve convention, and
`path.helix({ radius, pitch, turns, segments, axis?, center?, handedness? })` serves
springs and threads.

- **Frames**: `frame: 'rmf'` (default) transports the initial frame (`up`, default +Y)
  with double-reflection rotation-minimizing frames; a closed path spreads the closing
  mismatch evenly by arc length, so rings have no seam twist. `frame: 'up'` keeps the
  section's y toward `up`; a path that runs along `up` is `model-degenerate`.
- **Joints**: at polyline vertices the section is stretched along the bend (miter), so
  walls keep their width. A section point that would move backwards along a span (a
  bend tighter than the section) is `model-precondition`; spans that pass closer than
  the section diameter while far apart along the path (coils that touch) are a warning.
- **Ramps**: `twist` (degrees, end value or `[start, end]`) and `scale` (`[start, end]`)
  are linear in arc length; `segments` subdivides every path span so ramps stay smooth
  on straight spans. Several sections morph by arc length after resampling onto shared
  arc-length positions, which keeps every section's corners. A `closed` sweep needs a
  constant scale, a twist change that is a multiple of 360 and one section.
- **Intent and UVs**: section corners and path joints turning more than `sharpAngle`
  (default 40 degrees) get sharp edges, cap rims are sharp, the section seam and a ring
  seam are marked. uv0 holds the section perimeter (u) against the path arc length (v)
  in meters; caps get planar section coordinates. Non-planar side quads (twist,
  morphs) are split along their shorter diagonal and reported as `info`.

`pipeNetwork` builds a tube network from a skeleton graph (T, cross, 5-way and Y nodes, one
radius). Every node of degree two or more is the convex hull of one cage ring per branch
(a sphere-like polyhedron whose ring faces are the branch openings), every strut a quad band
(`bridge`, `strutSegments` rows) between two rings of equal edge count, every leaf a flat cap;
Catmull-Clark (`levels`, default 1) rounds the cage into an all-quad, watertight mesh. `radius`
is the output radius: the cage radius compensates the shrink of the subdivision, and a
diagnostic reports the measured section radius deviation (<= 3 % on the built cases). Nodes
with branches closer than 40 degrees refine at least two levels. Branches closer than 15
degrees (`branch-angle`), struts shorter than their node openings plus three radii
(`edge-short`), struts within 3 radii of each other or of a foreign node (`strut-collision`)
and openings that are not faces of the node hull (`node-hull`) fail as `model-precondition`
with `detail.reason`, never as a self-intersecting mesh. Case C-121 is
`examples/pipe-manifold`.

Radii are per ring: `nodeRadius` (one per node) and `edgeRadius` (one per edge, a number or a
`[start, end]` pair) override `radius`, edge entries winning. A strut's section tapers linearly
between its two end radii; a node opens to its widest branch, so a thin branch leaves a fat
node through a short transition. The reported section stations stay within 3 % in the strut
middle on equal radii; next to a node, or where radii differ by more than about 3:1 (a 1:10
tee branch reads 23 %, a 1:40 leaf 77 % at `strutSegments` 4), the deviation grows with the
radius ratio and the diagnostic is a `warn` above 3 %: raise `strutSegments` or use `weld`.
The soft mesh is deterministic but not mirror-symmetric to better than about 0.05 m on unit
networks (hull triangulation tie-breaks); weld meshes are symmetric to 1e-5.
`radius` below ten tolerances is `radius-small`. Case C-127 is `examples/hair-fork` (a forking, tapering strand).

`weld: { radius, segments?, end? }` selects the hard joint: every strut is a
true cylinder of `ringSegments` sides (default 16), the tubes are unioned by exact boolean
(a hub sphere on every node that is not a straight pass or an equal-radius bend; `end:
'miter'` joins two equal struts at a node with one mitered tube, `'cope'` always uses the
hub) and a rolling-ball fillet of `weld.radius` is cut along every concave intersection
edge, `segments` rows (default 4) wide. The fillet width comes from the facet dihedral of each seam edge, so the radius is exact only
in the symmetry plane of a tee; measured over the whole curve against the analytic rolling-ball spine
(`src/__tests__/weld-measure.ts`) the section radius deviates by about 20 % on a 0.1 / 0.07 tee and far more
on an equal-radius tee (open: an analytic rolling-ball width is not implemented). Faces `weld:<n>`
belong to the joint that owns the seam. Admissible `weld.radius` is about 0.1 of the tube radius at
`ringSegments` 16 and shrinks with finer `ringSegments` (a finer ring makes the seam edges shorter than the
fillet width, so raising `ringSegments` lowers the limit); a clamp reports `detail.maxRadius`, the
largest radius that works. Joints with three or more branches at one node (5-way, 6-way, Y120) clamp at every
tested radius until the rolling-ball joint lands (`src/__tests__/pipe-weld-joints.unit.test.ts` lists them). More than 16 tubes and hubs is `weld-size`; `weld` must be an
object. `levels` is rejected. `model-precondition` reasons: `weld-radius` (fillet
larger than the smallest tube at a node), `weld-clamp` (the intersection leaves no room: lower
the radius to `detail.maxRadius`), `weld-union`, `weld-loop` (closed chain of miters),
`weld-none`, plus the soft joint's `branch-angle`, `edge-short` and `strut-collision`.
Case C-128 is `examples/pipe-weld` (soft vs welded tee, manifold and a mitered frame).

Rolling-ball strip: a joint with one straight through pair and thinner branches (tee, lateral,
unequal cross, cope tee) takes `src/weld-strip.ts` `ballStrip`: both tubes are cut along the analytic contact
curves with the face-splitting cutter (`weld-cut.ts`), the cut loops are snapped onto the exact contact
polylines, the faces between them are removed and `segments` rows of circular arcs of radius rho bridge the loops.
The weld-clamp detail reports `path: 'ball'` with `deviation` and `shift` (in rho), or `path: 'bevel'` with
`fallback`, the explicit reason the strip was not used (`hub`, `bend`, `tapered`, `no-through-pair`, `branch-thick`,
`no-junction`, or a `weld-ball` cut failure). Measured over the whole curve against the analytic spine,
on and off the symmetry plane, the strip deviates at most 0.7 % of rho (ring 16 and 32, rho 0.01 to 0.05; tee,
lateral45 at 45 degrees, unequal cross), against 23 % (tee spine) and 98 % (equal tee) before; the tee at rho 0.01
and ring 16, where a ring facet is larger than rho, is inside the same gate. The Kasa section fit of
`weld-measure.ts` overstates partial arcs (up to 0.85 on lateral45) and is not used as the gate for the strip.

Known limits of `weld`: every joint with a hub still takes the bevel path, so `weld-clamp` rejects equal-radius
tees and crosses, Y and 5/6-way nodes, thick branches, copes of equal tubes and bends at the tested radii
(tracked in the KNOWN_FAIL table of `pipe-weld-joints.unit.test.ts`; they need the cylinder/sphere pairs and
triple points of the next PR). On the bevel path the radius stays inexact off the symmetry plane (up to about
20 %, equal tee 0.979 spine and 11.9 section at rho 0.01 and ring 16).
`src/weld-ball.ts` is the internal analytic rolling-ball kernel of the weld rewrite (not exported): for a
cylinder/cylinder or cylinder/sphere pair, `cylinderPairStation` and `cylinderSphereStation` return the ball
centre at distance `radius + rho` from both surfaces for an angle around the thinner tube, with the two contact
points, and `stationCount` fixes the station count from the radii alone.

`bend: { radius, segments?, nodes? }` turns degree-two nodes into circular elbows
: the corner is replaced by a centreline arc of `radius` meters tangent to both
struts, built as `segments` quad rows (default one per 15 degrees, at least two, and more when
the sag of a row chord would exceed 3 % of the tube radius) between the end rings of the two
struts, which share one section frame carried across the bend. Fewer than one row per 30
degrees (`ceil(angle / 30)`) is `bend-segments`. The interior cage rows are solved so the
subdivided rings land on the ideal arc, with the end rings fixed and virtual straight rows beyond them.
`nodes` lists the nodes to bend (default every node that turns by more than 2 degrees).
Elbow faces are labelled `node:<i>` with role `bend`. The claim is relaxed from the earlier 1 %
to 4 %: measured on the exact plane sections normal to the arc at t = 0.02 to 0.98 of the turn
(the diagnostic samples the same stations, straight struts included, and its severity counts
roundness), a tube of radius r = 0.05 gives radius deviation / roundness of 2.8 % / 4.8 % (45 degrees,
R = 3r), 2.7 % / 4.6 % (90 degrees), 2.4 % / 4.1 % (135 degrees), 2.1 % / 4.0 % (R = 10r) and
1.6 % / 3.2 % (R = 40r), at the default level. Supported R is 1.25 r and up, with
`segments` 1 to 64; a very small R/r or tube radius against the strut length is
`edge-short`. The `bend stations` diagnostic reports each station. Combine with `levels`; `weld` is rejected. `model-invalid-argument` for
malformed options; `model-precondition` reasons: `bend-radius` (under 1.25 times the larger
tube radius at the node), `bend-straight` (also a turn too small to hold a tangent), `bend-segments` (fewer rows than
one per 30 degrees), `branch-angle` (checked before the bend is read), `bend-loop` (a closed chain of elbows whose
frame does not return) and the existing `edge-short` when a strut cannot hold both
tangent lengths. Case C-129 is `examples/pipe-bend` (elbow, tight elbow, double bend, U).

`loft({ profiles, closed?, caps?, match?, segments? })` joins two or more closed planar 3D sections
(`profiles: Tuple3[][]`, each a point loop), consistently wound about the loft
direction. With `match: 'arclength'` (default) every section is rotated to the start
that best follows the previous one and all are resampled onto the union of their
arc-length positions, so a square can loft into an octagon with all corners kept;
`match: 'index'` joins vertex `i` to vertex `i` (equal counts) exactly as written: sections are never reversed one by one (so a closed band whose inner rings run back along the path keeps its correspondence), and the whole loft is turned outward once by its signed volume. `segments` > 1 inserts
rows on a Catmull-Rom curve through the sections. Non-planar sections are
`model-precondition`.

`array` merges rigid copies of the selected faces, or of another session or FXEM
snapshot: `linear: { count, offset }`, `radial: { count, axis, angle?, center? }`
(360 degrees spaces copies evenly; less puts the last copy at `angle`) or
`onCurve: { count, path, closed?, align?, up? }` (equal arc-length spacing, local +Z
along the tangent and +Y along the rotation-minimizing up when `align`; the original
moves onto the curve as copy 0, so it must share no vertex with other faces). Copy `i`
gets tag `<label or 'copy'>:<i>`; with a `label` the new copies get role `copy`,
otherwise they keep their sources' origins. Arrays merge geometry only: instancing
belongs to Scene placement.

Known limits: sections are closed loops without holes (no open polyline sweep); twist
and scale ramp linearly; sweeps and lofts write uv0, so primitives in the same session
need their own `uv.project` (select them, for example by excluding the swept tag);
array copies of one prefix share tag names across calls.

## Subdivision and deformation

**Limit surface.** `m.limit(target?, { boundary?, budget? })` (and the standalone
`subdivisionLimit(editMesh, { vertices?, boundary?, budget? })`) returns the Catmull-Clark limit
position and unit normal of each vertex in closed form, without refining: Halstead masks on the
once-refined ring for smooth vertices (the regular case equals the bicubic B-spline mask,
`(16p + 4 sum e + sum d) / 36`; the tangent masks weight edge i by `A_n cos(2 pi i / n)` with the
Halstead constant `A_n = 1 + cos(2 pi / n) + cos(pi / n) sqrt(2 (9 + cos(2 pi / n)))`), `(a + 4p + b) / 6` along a two-crease or boundary vertex, and
the cage point for a corner. `LimitSurface` holds parallel `vertices`, `position`, `normal`,
`kind` (`smooth`, `crease`, `corner`) and `valence` arrays in ascending vertex id; crease and corner
normals are zero. Every sum is exact-then-rounded, so a cage symmetric about x = 0 gives bitwise
mirrored limit points and normals whatever its vertex or face order (`subdivide` results mirror only to about 1e-15: its plain-order sums stay as they are to keep golden bytes). Acceptance is against the extrapolated limit: the closed form must lie inside the geometric tail of the level-by-level refinement, because a finite level only approximates it. `budget` bounds work (24 units per face corner,
`model-work-budget`); a non-manifold fan, a closed fan under three edges or a lone crease end (dart,
no closed form) is `model-precondition`; unknown ids or boundary rule is `model-invalid-argument`.
Crease strength is read through one `edgeSharpness` function. `snapToLimit` moves the selected vertices onto their limit points
after evaluating all of them.

**Half-sharp creases.** `m.markCrease(edges, sharpness)` stores a DeRose crease
sharpness in the edge flags (steps of 1/4 below 10, stored in bits 2..7 next to the sharp and seam
bits; a value that is not representable warns, `Infinity` or >= 10 is infinitely sharp and equals
`markSharp`, 0 clears, negative or NaN is `model-invalid-argument`). `subdivide` applies the
semi-sharp rules: a level treats an edge of sharpness s >= 1 as a full crease and the children carry
s - 1; for 0 < s < 1 the edge and vertex rules blend between smooth and crease, and a vertex with
two sharp edges blends by their sharpness (corner rule from three). `creaseSharpness` is the
sharpness of flagged edges that store no level (default infinite). `limit` and `snapToLimit` stay
closed form: they refine the vertex one-ring locally until only sharpness 0 and infinity remain
(at most ten levels per vertex; the 24-unit budget per corner is unchanged, so a heavily half-sharp cage costs more time than it counts), then apply the Halstead or
crease/corner mask. A dart whose crease is finite is no longer a precondition (it relaxes after
the refinement); an infinitely sharp dart still is. A cage with only infinite creases keeps its
bytes through every operation. Smooth export normals break only across infinitely sharp edges
(`smoothAcross`); a half-sharp edge keeps the shared normal. Every flag merge (`markSharp`, boolean,
remesh, knife, sweep, shell, connect, panel, lift, primitives, drawing) goes through `mergeFlags` /
`setFlag`, so the larger sharpness wins, infinity never turns finite and a cleared level never
returns; remesh carries the level through its work flags. The journal records an infinite sharpness
as the string `'Infinity'`. A finite sharpness on an open-boundary edge (always infinitely sharp)
reports a `warn` diagnostic with the boundary edge count. Case C-126 (`examples/crease-neck`) shows a half-sharp rim.

`subdivide` is a compute job (design 4.1) like the booleans: the canonical FXEM goes in,
the refined FXEM and per-face provenance (`SourceFaceProvenance`: the input face of every
output face) come out, with the backend, quality, cache key and metrics in an `info`
diagnostic. The TS baseline is `quality: 'baseline'`; `compute: 'native'` (deferred) is `model-capability-unavailable`.

- **Schemes**: `catmullClark` (default) or `simple` (split only). Every refined n-gon
  becomes n quads per level; children keep the material, label, role, tags and flags of
  their face, so selectors keep working, and corner values (UVs, colors) interpolate
  linearly (face-varying, per face).
- **Creases**: sharp edges are infinitely sharp creases (crease rule, corner at three or
  more creases, a single crease is a dart), and both halves of a split sharp edge keep the
  intent. Half-sharp creases (`markCrease`) follow the DeRose rules described above.
- **Boundaries**: `edgeAndCorner` (default) keeps open-boundary vertices with one face in
  place; `edgeOnly` rounds them along the boundary curve. With a selection, vertices next
  to unselected faces stay put and the unselected neighbours only gain edge points, so no
  crack opens.
- **Budget**: the predicted face count (`corners x 4^(levels-1)`) is checked against the
  session face budget and the job reserves its work units up front, so huge `levels` fail
  with `model-work-budget` before any allocation; `levels` 0 is `model-invalid-argument`.
- **Effect assertions**: hard, every selected n-gon maps to exactly `n x 4^(levels-1)`
  output faces and every other face to one (`model-op-no-effect` otherwise, the backend
  contract); soft warnings when the result leaves the cage bounds, when Catmull-Clark of
  a closed mesh changes no volume (everything creased: it equals Simple), when Simple
  changes the volume, and when a child face folds over itself (export would reject it;
  a thin smooth band next to a crease folds at corners, add support creases or widen it).

Deformers move the vertices of a face or vertex selection and never change topology:

| Deformer | Contract |
|:--|:--|
| `lattice({ resolution: [nx, ny, nz], offsets: [{ index, offset }], bounds? })` | Sederberg-Parry FFD (Bernstein degree `n - 1`, 2 to 16 points per axis) over the selection bounds or `bounds`; vertices outside move with the nearest box point |
| `cage({ cage: { points, faces }, deformed })` | Mean value coordinates of a closed, outward cage; linear maps are reproduced exactly and the reproduction error is reported |
| `bend({ axis, toward, angle, range?, origin? })` | The `range` along `axis` becomes a circular arc of `angle` degrees curling toward `toward`; before the range nothing moves, after it the part continues straight |
| `twist({ axis, angle, range?, origin? })` / `taper({ axis, factor, axes?, range?, origin? })` | Rotation or cross-section scale about the axis line through `origin`, ramping linearly over `range` |
| `curveDeform({ path, axis, origin?, frame?, up?, stretch? })` | Distance along `axis` becomes arc length on a `path.*` spec (the sweep's sampling and rotation-minimizing frames); the other two axes follow the frame in cyclic order, so orientation is kept |
| `smooth({ iterations, lambda?, mu?, pin? })` | Taubin lambda/mu (0.5 / -0.53) umbrella smoothing; mesh-boundary and sharp-edge vertices are pinned by default |
| `smooth.implicit(target?, { lambda, iterations?, pin?, preserveVolume?, solver? })` | Backward-Euler cotangent-Laplacian fairing: `(M + lambda L) x' = M x` per step, re-assembled on the current shape; `lambda` is diffusion time in units of the mean vertex area (0.1 moderate, 1 strong). `pin` (default `['boundary', 'sharp']`, `[]` pins nothing) takes `'boundary'`, `'sharp'` and face/edge/vertex selectors; unselected vertices stay. `preserveVolume` (closed meshes) moves the free vertices along the volume gradient until the enclosed volume is restored. Reports the curvature variance before/after (warns when it does not drop) |
| `arap(target, { handles: [{ selector, translate? \| to?, rotate?: { axis, angle, origin? } }], iterations?, pin?, solver? })` | As-rigid-as-possible: handles move rigidly (rotated about `origin`, default their centroid, then shifted by `translate` or onto `to`), pins and unselected vertices stay, and local (per-vertex best rotation, Mueller et al. 2016 extraction, no SVD) and global steps alternate (default 10, at most 200). The Laplacian is assembled once; every global step is one Jacobi-PCG `solve.sparse` job per coordinate, warm-started. Reports the energy after each local step, edge strain, handle moves and solver totals; warns on faces turned against their fitted rotation. Fails with `model-op-no-effect` when no handle moves, `model-invalid-argument` for handles without motion, with both `translate` and `to`, sharing vertices, outside the selection or overlapping pin selections, and `model-precondition` when nothing is free or a free part touches no fixed vertex |

Both assembled deformers build cotangent weights on each face's export triangulation
(started at its lexicographically lowest point, so weights depend on geometry, not ids),
clamp them to [1e-3, 1e3] and solve through `solve.sparse` (`solver: { tolerance,
maxIterations, compute, budget }`); a failed solve is `model-solver-diverged` with the
step or iteration and the coordinate, and `compute: 'native'` is
`model-capability-unavailable` until the native backend exists.

Each deformer reports the largest displacement and the moved vertices (`info`), fails
with `model-op-no-effect` when nothing moves farther than the tolerance, and warns with
the faces it inverted (the Jacobian determinant of the point map is not positive at a face
vertex; for `smooth`, a face normal that reverses), collapsed or folded.
