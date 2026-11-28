# Hard-surface detail

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Bevel

`bevel(edges, { width, segments })` replaces every selected interior edge by a strip of
`segments` faces (role `bevel`) between two new edges, each `width` from the edge inside
one adjacent face: `segments: 1` is a flat chamfer, more segments a round whose profile
is tangent to both faces (the tangent at each end is the other end projected onto that
face's plane; a right angle with equal widths gives a circular arc).
The skeleton follows four phases: every position is computed first (as linear
forms of the per-edge widths), then the touched faces are disconnected, the new points
placed and the gaps filled, so a failure leaves the mesh unchanged.

`width` may also be a list of `{ edges, width }` entries: each selected edge takes the width
of the first entry whose `edges` contain it, and selected edges no entry contains stay
unbevelled. An entry holding no selected edge is `model-selection-empty` (`detail.entry`),
an empty list or a width that is not positive `model-invalid-argument`. One width applies on
both sides of its edge. Positions are linear forms of the per-edge widths, so mixed widths
change no topology: a chamfered corner of three widths a, b, c is the exact intersection of
the offset planes (one triangle), and a round corner keeps the 3- or 4-edge patch, projected
on the sphere about the mean profile centre while its arc radii stay within 3x of each other.
A list whose widths are all equal gives the same bytes as the scalar width. Change the width
at a sharp corner rather than along a smooth rim: where offset lines meet almost parallel
the corner point moves by the width difference over the sine of their angle, and the chain
clamps together. The [shaping](../examples/shaping/) example bevels a saw plate with a
gradient over its teeth and a box with one width per edge direction.

Around each vertex of a selected edge, every unbevelled edge gets a point sliding along
it where the offset line of a neighbouring bevel crosses it (edges no offset line reaches
slide like the reachable edges of their run, unless that runs off the edge where the line,
continued past a flat edge such as a triangulated cell's diagonal across faces within about
11 degrees of the bevelled face, crosses it in reach); on an open boundary fan, edges no
bevel reaches keep the vertex. What happens at the vertex depends on how many selected
edges meet there:

| Selected edges at a vertex | Result |
|:--|:--|
| 1 (terminator) | three edges: the far face loses its corner (a deterministic split along the strip end, which is the round's arc for `segments` > 1, kept in that face's plane); more edges: one n-gon `corner` face tapering into the unbevelled edges; a two-edge vertex tapers to a point |
| 2 | the strips share their end chain (pass-through or corner turn) |
| 3 or 4, round | a patterned `corner` patch: three corner grids meeting at a centre (with one-quad strips and a centre triangle for odd `segments`), or a `segments` x `segments` Coons grid; projected onto the common sphere when all arcs share one (equal widths) |
| otherwise | one n-gon `corner` face |

- **Planar regions**: coplanar faces split only by flat, unflagged edges (the convex
  pieces of a holed `extrudePolygon` cap, the strips a boolean cuts through a holed face)
  are bevelled as one polygon with holes. Where a bevel corner leaves such an edge's line,
  the region is partitioned again after the fill (convex pieces, inserted collinear points
  and runs within the tolerance of a chord kept on the piece edges), so partition edges
  neither clamp the width nor leave corner faces or slivers. A region stays within 5
  tolerances of one plane (neighbours just under the coplanar angle can bend a long chain,
  such as walls along a curve), and a face whose UVs leave its neighbour's UV map by 2 % of
  its own UV width (a sliver cell) stays out of it, so merged UVs never fold along a short
  edge. Other operators' faces are not changed.
- **Clamp**: widths shrink, per constraint, until every touched face (or
  planar region) keeps 2 % of each edge, its orientation and a simple outline; bevelled
  edges meeting at a shallow angle (a hole rim) shrink together. At a vertex joining five
  or more bevelled edges each corner may use half of the edge it runs along (offset
  overlap, so a sharp apex is not cut far down its sides). The per-edge clamp never goes
  below the largest uniform scale all constraints accept. After the fill, a written face
  that folds or a bevel face that crosses another face halves the widths that place it and
  the fill is repeated (at most 16 rounds; a crossing the last round still makes fails with `model-degenerate`, `detail.at` locating it, and the mesh is unchanged). While
  those widths differ, only the wider ones halve, down to the narrowest: where a short wall
  face clamps one edge of a round corner far below its neighbours, their profiles cross at
  any common scale, so only evening the widths out removes the crossing. Clamped
  edges, their actual widths and the smallest width are a `warn` diagnostic; a width that
  would fall to the tolerance is `model-degenerate`.
- **Effect assertion** (hard, design 7.4): every selected edge is replaced by faces of
  non-zero area, otherwise `model-op-no-effect` (an edge whose ends have no room to slide).
  A selected boundary edge is `model-precondition`, as is a pinched
  vertex.
- New faces copy the material and the tags both (strip) or all (corner) neighbouring faces
  share; differing material slots need `material`, otherwise `model-invalid-argument`.
  Roles `bevel` and `corner` only come with a `label`. Non-planar new faces (curved
  corner patches, twisted strips) are split into triangles and reported as `info`.
- **Edge intent**: a chamfer keeps the bevelled edge's flags on both rails and its sharp
  bit on the strip ends; a round is tangent to its faces, so its rails stay smooth, only
  the first rail keeps the seam, and the strip ends are sharp only where the round ends
  against a face. New faces carry no corner values (re-project UVs); cut faces keep
  theirs, interpolated.
- The spike set `src/__tests__/bevel-spike.ts` (design 16: 305 parametric hard-surface
  variants: boxes, extruded L/U/T/star profiles, plates with pockets and bosses, frames,
  revolved rims, apex junctions, triangulated parts, double bevels and holed plates from
  `extrudePolygon` holes or `difference`, with widths past the clamp) records in
  `reports/bevel-spike.json` that every selected edge took effect in all 305 variants
  (11979 edges, 36 clamped) and that all validate without an error or confirmed defect.
  The same report's `booleanSet` bevels every crease above 30 degrees of all 290 boolean
  spike results (width 15 % of the smallest extent, one to three segments): 97.9 % take
  effect and validate (plate holes, slots, nested, coplanar, radial and radial
  windows 100 %, freeform 88 %); both rates are gated at 95 %. The freeform misses are
  clamps that reach the tolerance where tilted tools leave edges or wedges far narrower
  than the width.

Known limits: a bevel clamps rather than consuming a short unbevelled edge or an acute
wedge narrower than its width, so it fails as `model-degenerate` where such features are
below about 1/400 of the width; a mixed convex/concave corner (a rounded pocket rim meeting a filleted
wall) gets a relaxed patch that follows the sharp rail corner rather than a toroidal
sweep; there is no vertex-only bevel; new faces get no UVs.

## Fillets, blends and support loops

Every hard feature line needs a controlled transition (card lines): a small-radius
NURBS blend, or support loops (or a crease) on the subdivision route.

- **`blendSurfaces(a, b, { radius, continuity?, sides?, stations?, controlPoints?, tolerance? })`**:
  a rolling-ball blend where two patches meet at a crease along one whole shared side
  (found by matching side ends and middles within `tolerance`, default 1e-5 m, or given
  as `sides`). `radius` is constant or `[t, r]` stations along `a`'s side (variable
  radius, typically 0.002 to 0.005). At each of `stations` (default 17) planes across
  the edge, damped Newton places the ball touching both patches; the section leaves each
  contact tangent (`G1`, a cubic near the circular arc, default) or also with the
  patch's cross curvature (`G2`, a quintic). Both patches stay exactly as designed
  style): the result gives each a trim outline in its own normalized domain, `trimA` and
  `trimB` (the strip from its exact contact curve over the shared side, closed 1e-3 outside
  the domain, counter-clockwise; a `{ uv }` trim), and only the blend is fit (u along the
  edge, v from `a` to `b`). `controlPoints` sizes the blend along the edge; by default it is
  adaptive: 8, 12, 16 ... (stations raised to 2 x controlPoints + 1, at most 129) until
  `gap`, the largest distance of the blend's contact sides from the trim edges (257 samples
  each), is at most `tolerance / 2` (5 um at the default), keeping the last fit whose
  isoparms along the edge stay fair where more control points would ripple the band (a held
  slanted end). The result also reports `setback` (contact distance from the edge) and
  `sides`. A tangent joint (no kink), a ball that leaves a patch, or patches without one
  shared side are `model-precondition`.
- **Run-outs and sub-range blends**: leading and trailing radius stations may be 0. The blend
  then covers only the range from the last leading zero to the first trailing zero
  (`[[0, 0.012], [0.8, 0.012], [1, 0]]` runs a roll out at a T-corner;
  `[[0.2, 0], [0.35, 0.01], [0.7, 0.01], [0.85, 0]]` blends part of a side). A segment
  ending at 0 eases with a C2 cubic step (radius, slope and curvature vanish there), so the
  contact curves leave the crease with G2; the blend's u spans only its range and collapses
  to one point at a zero end, while each trim covers only the range and closes at the side in
  a cusp at a zero end (the original crease stays outside). `stations` and `controlPoints`
  then count over the range, the rest of the side takes the same spacing, and each run-out
  gets knots at its sixths, so the fit holds the step and the tip does not cross the crease.
  The faces keep their nets, and a blend's along-edge net is exempt from `surface-density`
  (only its across count is judged against `[8, 6]`). Costs: an isoparm beside a run-out follows the contact's
  S-shape (rate ratio about 6 L / l for side length L and run-out length l), so a run-out
  shorter than 0.4 L reports `surface-fairness` on that isoparm (the geometry and zebra
  are unaffected). Keep the crease outside the range as a `G0` feature line. Surface-quality checks skip a blend band at its run-out tip: only from an end where it collapses to a point, while it stays under 1 % of its widest station (its normals there are fit noise), and only where the band's middle lies within the class position limit of its chord and its side on the neighbour (within the blend's gap on a trim edge) (a bulge or gap there is measured). A band that only narrows has no tip. Each edge counts the samples left out (`skipped`), a shared part left out entirely is `nothing-checked` (from one skipped sample on), never a pass, and edges of a run-out band are sampled four times as densely (at least 64). A side clearly nearer than another patch's wins inside the position limit too, so the converging sides at a tip pair with the blend, not with each other; a `G2` request may still read G1 where a curved run-out is under about 1 mm wide. A zero between
  positive stations, all-zero stations, or a zero station at its positive neighbour's
  `t` is `model-invalid-argument`.
- **`m.surface({ blends: [{ between: ['hood', 'fender'], radius, continuity?, name? }] })`**
  applies blends before tessellation: each named patch keeps its surface and gains the
  blend's trim (its own trims and imprints, `{ uv }` or `{ view }`, keep their meaning, and
  several blends on one face add several trims), and the blend patch (default name `blend`,
  the first patch's `flip`) joins them. The tessellation welds the blend to the trim edges:
  an outline run that another patch's side follows thins to the chord, the outlines take a
  vertex where they cross an isoparm or each other, the blend's columns adopt the outline
  vertices, its side vertices join the outline they run along (or weld to a kept vertex
  within the chord), and the cut cells along the seam stay quads where four corners remain
  and carry `trim` (edge flow's own group, above; never `support`). `src/surface-seams.ts`
  owns this seam conformity. An `info`
  diagnostic lists each blend's setback and gap, and a `warn` reports a gap above
  `tolerance / 2`; the recorded surfaces are the designed faces with their trim outlines
  (overlapping trims recorded as their union) and the blends (transition `{ kind: 'blend',
  continuity, gap: tolerance / 2 }`), and `validate({ surfaceQuality })` judges a trim edge
  along a blend at class `blend` with that gap as its position limit, so a fit that stops
  above it is a `surface-continuity` issue on that edge with the measured gap. Every edge of a
  blend is held to the continuity its transition declares (else the requested one), and a
  failing edge reports `band` (`width`, `widest`, `share`, `f`) at its worst sample. A fillet across a feature curve inside
  one patch: split the patch on that isoparm (two patches from the curve network), then blend.
- **Setback corners**: `m.surface({ patches, blends, corners: [{ blends: ['knee', 'edge', 'tail'], setback: 0.005, continuity?: 'G1' | 'G2', name? }] })`
  (`SurfaceCorner`; also `patchLayout({ corners })`) builds the named blends (n >= 3, each
  with a unique `name` and a constant radius, meeting at one vertex) the class-A way.
  The face strips up to the isoparms `setback + contact width` (r cot(opening / 2), the
  widest of the corner's blends) from the vertex are exact pieces of each face
  (`surfaceSplit`), blended with the unchanged `blendSurfaces` (each keeps its options); each
  face keeps its surface and name and trims the strips' contact regions and its corner square,
  and the n-sided hole, whose sides are face isoparm + blend end section + face isoparm (the
  isoparm an exact split piece carries, never tessellated), is filled with n quads by
  `nurbs.surface.fillN`. The quads are `${name}-${k}` (default `corner`) with `transition: { kind: 'corner', continuity }`.
  Corners resolve before the plain blends. The quads meet faces and blends at `continuity`
  (default `G1`); the interior spokes and the center are G1 by design, and
  `transition.kind: 'corner'` makes `validate({ surfaceQuality })` and `validate({ layout })`
  require exactly G1 between two corner quads, so a G2 validation does not flag the spokes
  while a real spoke break still fails. The `info` diagnostic lists per corner the split
  distance, the face/blend end kink and the fill residuals (`sideCurvatureRatio` is the worst
  cross-side curvature jump times the side's blend radius: about 0 at G2, of order 1 at G1). A setback <= 0 is
  `model-invalid-argument` (hint: a zero setback leaves a degenerate three-sided corner);
  contact width + setback at or beyond a face side is `model-precondition`
  `{ face, radius, setback, width }` (checked before splitting); blends that do not cycle
  through faces around one vertex, or a face isoparm more than 1 degree off the normal plane
  of its blended edge (the end kink is then about twice that), are `model-precondition`
  (`{ tilt, kink }`); fill errors propagate with the corner index. Costs: G2 quads are
  biquintic 10 x 10 nets (`surface-density`), and the quads report `surface-fairness` (the
  curvature runs from the blend arc into the flat face piece within one isoparm).
- **`nurbs.surface.fillN({ boundaries, continuity?, tolerance? })`** fills a 3- to 8-sided hole
  bounded by patch sides (`{ surface, side, range? }`, an array of consecutive pieces per side
  joined G1) or bare curves (`{ curve }`, G0) with n quads `[O, e(k-1), c(k), e(k)]`
  (midpoint scheme): O on the loop normal at the circular-spoke height, equiangular spokes,
  all quads faired together (the `fitSurface` energy) under penalty rows for outer G1 (and G2
  on a second stage with biquintic quads) and scalar-weight spoke G1, spans growing until
  every G1 angle is <= 0.1 degree and no quad folds. It returns the quads, a `FillResidual` per
  outer side and spoke (the `measureEdge` fields) and `normalSpread`, the worst angle between
  a quad normal and the boundary-oriented reference (the bilinear blend of the normals at the
  quad corners) on a 41 x 41 grid per quad. A quad still folding (spread above 90 degrees, as
  in a thin 1:10 triangle) is `model-degenerate` `{ quad, angle, point, u, v }`; a G1 angle still above 0.1 degree (neighbour normals that
  disagree at the hole corners, listed in `cornerMismatch`) is `model-precondition` with the
  residuals. Pairwise matching cannot close the spokes around O; the simultaneous solve does.
- **`m.supportLoops(edges, { offset })`**: one or two edge loops at `offset` meters (one
  or two rising values) on both sides of the selected edges, measured along the rungs
  leaving them; side faces split into strips tagged `support` (the edge-flow check exempts
  them), faces beyond gain only the rung vertices. A side face holding two selected edges
  (a corner, or a strip one face wide) and an offset reaching half a rung are
  `model-precondition`. Subdivision then keeps the edge crisp (a 40 degree crease of a
  4 x 4 panel sags 5 times less with a 1 cm loop); `markSharp` is the infinitely sharp
  alternative.

## Panel lines

`panelLine(path, { width, depth, profile? })` cuts a groove into the surface. `path` is
an interior edge path (the strip is a flat `bevel` of `width / 2` on each side, so paths
may branch, cross and close like bevels), or `{ faces, point, normal }`: the plane cuts
the strip from the selected faces only (faces outside the selection only gain the cut
vertices), which follows curved surfaces such as a cylinder band. `square` sinks the strip
as a floor (role `groove`) between walls (role `lip`); `v` and `u` keep the strip rim and
sink every strip vertex along the surface normal by the profile depth at its distance
from the centre line (V flanks are `groove`; for U the rim bands are `lip`). Where the
strip ends on a face beyond the selection, that face gains the groove notch: a square end
wall lying in its plane merges into it, otherwise the end stays closed by a `lip` wall;
faces that would turn non-planar are split into triangles and reported as an info.
Rim edges become sharp; `material` puts the groove faces in their own slot.

Effect assertion (hard): every groove face keeps a non-zero area and its facing, else
`model-degenerate`; a plane that crosses no selected face is `model-op-no-effect`. On a
closed mesh the volume must shrink (soft: a warning otherwise); a square floor that sinks
by other than `depth` (corners, curved strips) is reported. Edge paths share the bevel
preconditions (interior edges, clamped widths are warnings). Known limits: no curve
targets yet (planes and edge paths only), and a plane groove crossing an earlier groove is
not merged with it.

## Shut lines (DTS)

`m.shutLines({ table, step?, reach?, ends? })` (and `measureShutLines(mesh, options)`)
measures the shut lines of a DTS table: each row `{ id, parts: [tagA, tagB], zone?,
limits?, mirror?, break?, exception? }` names two panels by face tag. Every face carrying a part's
tag belongs to that part, whatever other tags it carries (a band tag over a panel's faces is its
own part); a row whose two parts share a face is `model-invalid-argument`. Stations sit every `step` (10 mm) along each
panel's outer edge (skin against its own shell wall, `SHELL_WALL_ROLES`, or an open skin edge),
and at each edge vertex where the distance to the other panel peaks or dips (a pinch or flare
narrower than the spacing), each pairing with the other panel's edge within `reach` (12 mm). The
section is square to the edge; at a vertex it points at the nearest point of the other edge. In
the section, each panel is probed along its own edge normal every 0.25 mm from 10 mm back toward
its edge; its **skin** runs from the first skin hit toward the edge up to edge treatment (faces
flagged `FACE_EDGE_ROUND`: a bevel's rounds, chamfers and corner caps, labeled or not, and surface
blend bands), a miss, or a turn of 45 degrees or more between neighbouring faces (a turned
edge). Its **skin line** is the skin's tangent at its
last point, from a least-squares quadratic over the skin's last 2 mm, so a skin rolling tightly
right past its edge is followed while rounds and chamfers are stepped over. The **gap** is
measured on the theoretical line, each skin line extended to its own wall face (a hit beyond the
face's end slides back along the edge, and the gap is then the distance between the two
theoretical points), along the two skin lines' mean direction (their bisector frame), so edge
rounds and chamfers do not change it; the **visual gap** between the points where each section,
walking from its skin's last point, falls 0.1 mm below its skin line (larger rounds widen it);
**flush** is the larger of the step between the two theoretical edges along the bisector of the
skin lines' normals (0 for a crease centred in the gap; a lip tilting the skin before its edge
lifts the edge) and a section standing proud of its skin line at its visual edge (a lip); **parallelism** is
gap max - min away from `ends` (10 mm) at each end; **symmetry** (`symmetryDelta`) compares the mean gap with the `mirror` row's, which must name
this row back (a self or one-way mirror is `model-invalid-argument`). **Coverage**: an edge chain
belongs to the line from its first to its last station with the other panel in reach (on a loop,
all but its longest stretch out of reach); stations within `ends` of those ends (three-panel
corners) are left out, and of the rest, those that cannot be measured (other edge beyond reach,
less than 2 mm of skin, a wall within 45 degrees of its own skin line, a theoretical edge over
3 mm from the physical one, the other edge's nearest point more than 45 degrees off the section
square to the edge, past that panel's end, or an open side: an open skin edge of an edge chain
with walls elsewhere, which is not a partner edge either) are `skipped`; `coverage` is the measured share. Limits come from the
row's zone (`DTS_ZONES`, defaults from a proposed car shut-line table: A 3.5 +- 0.25 mm, flush /
parallelism / symmetry 0.3 mm; B +- 0.4 and 0.5 mm; C +- 0.5 and 1 mm, no symmetry; `visualGap`,
the band's top plus two of the table's largest edge radii A 1.2 / B 1.5 / C 0.5 mm: A 6.15, B 6.9,
C 5.0 mm). `limits` may only tighten them: finite values inside the zone's (a gap band lo <= hi
within the zone band, the rest at most the zone's), else `model-invalid-argument`. A row fails
with `unmeasured` (fewer than 3 stations), `gap`, `flush`, `parallelism`, `symmetry`,
`coverage` (below 0.98, `LINE_COVERAGE`) or `visual-gap`. A row with `clearance: { min }` is a
clearance item instead (a designed separation, such as a tyre in its arch): the smallest
distance between the faces of its two tags, searched up to max(reach, 2 x min), must be at
least `min` (`clearance` check, `row.clearance: { min, distance, at }`), else it is
`unmeasured`; it takes no `limits`, `exception` or `mirror`.

An accepted deviation is a row `exception: { limits, reason, date }`: `limits` names only `gap`,
`flush`, `parallelism`, `symmetry` and `visualGap` (`coverage`, `unmeasured` and `break` are never
excepted), each finite and strictly looser than the row's effective limit (a gap band containing
it); `reason` is non-empty and `date` an ISO `yyyy-mm-dd`; anything else is
`model-invalid-argument`. Measurement is unchanged: a check failing the row's limits but inside
the exception's bound is listed in `row.excepted`, one beyond it in `row.failures`. `row.status` is
`fail` with any failure, `unmeasured` with fewer than 3 stations, `excepted` when every deviation
is excepted, else `pass`. The report's `pass` means no row is `fail` or `unmeasured` (excepted rows
pass); `counts: { pass, fail, excepted, unmeasured }`, and a stricter gate checks
`counts.excepted === 0`. `validate({ shutLines })` reports each `fail` or `unmeasured` row as a
`shut-line` error, so `pass` is false; an `excepted` row is a `shut-line` warning
(`detail.check: 'excepted'`, with the row's measurements, `excepted` and `exception`), and an
exception limit whose check passes the row's limits is a stale `detail.check: 'exception-unused'`
warning (`unused`). ("Seam" in this kernel means a UV seam.) A row's `break: { drawing, item }` names the `break` curve of an
attached drawing the seam realises: the seam's centre line, seen in that view, is compared
with the drawn break both ways over the span both share, at the item's tolerance and covering at
least 0.98 of it (inside its `inset`); a miss is the `break` check, and `row.break` carries
`{ max, back, coverage }`.

`splitAlong(patch, cut, { gap, names, ring? })` splits one `SurfacePatch` along a shut line
into two patches `a` and `b` named `names[0]` / `names[1]` (role and tag, so a DTS row can
name them; flip, inflections, imprints and support carry over) with a constant gap. `cut` is
`{ iso: 'u' | 'v', t }` (the surface's own parameter, strictly inside the domain): the
surface is split exactly (`nurbs.surface.split`) and each half is trimmed back by gap / 2;
or `{ curve, tolerance? }`, a 3D curve lying on the patch from boundary to boundary: each
half keeps the whole surface and trims away the other side plus its half of the gap. The
trim boundaries are offset lines of the cut, gap / 2 along the surface perpendicular to the
cut in the tangent plane (not in parameters), sampled until each lies within 1 micrometer
of its polyline, so the gap stays constant on doubly curved, skewed patches (tests: 3.5 mm
+- 0.05 mm by `m.shutLines` after `m.surface` and `m.shell`). Tessellate the halves with
a `snap` well under the gap tolerance (the tests use 0.02 mm): the default, chord / 4, may
move a trim vertex up to 0.25 mm onto a grid node. Half `a` lies on the lower
parameter side of an iso cut, or left of the curve's direction in the (u, v) domain.
A curve farther than `tolerance` (default 0.1 mm) from the surface anywhere, or one that
ends inside the patch, is `model-precondition` with the location: the curve is never
projected silently. The result carries `deviation`, the largest curve-to-surface distance
(0 for an iso cut). A non-positive gap, a parameter outside the open domain, or names that
are not two distinct non-empty strings are `model-invalid-argument`. The trims lie inside
the (u, v) domain: each half's edge along a patch side is the patch boundary and its edge
along the cut is the offset polyline. The cut must leave each half one non-empty piece (its
offset line crosses the patch once; `detail.pieces`) and turn no tighter than gap / 2
(otherwise an offset runs backwards: `detail.radius`, `detail.minRadius`), and neither
offset line may cross itself; all three are `model-precondition` with the location. End
samples of a curve overshooting a side within `tolerance` clamp onto it and are dropped.
`ring` (meters) gives each half's cut trim a ring of quads (the trim's `ring`, default the
surface call's `trimRing`): a flange or hem on the cut needs one, since the cut cells alone
leave faces narrower than a shell thickness along the fold. Edge rounds and returns are
the shell's job, not the split's: a square or rounded flange (`radius`, `round`; per edge
through the `trim` faces, or on every open edge) builds on ringed halves with the gap kept
(3.5 mm +- 0.05 in the tests). A ring narrower than the round's width (`radius +
thickness`, or `round`) fails with the shell's no-clamp precondition. In zone A of
`m.shutLines` a fold radius whose skin round (`radius + thickness`) exceeds the zone's edge
radius fails `visual-gap`; a `round` of 1 mm passes.

## Holes and threads

`m.hole(faces, options)` cuts one revolved cutter per center with a single difference, so a
plate takes a whole pattern in one operation. `faces` are coplanar planar faces; `centers`
are `[u, v]` pairs in the face frame: `u` is the next world axis after the normal's
dominant one (X, Y, Z cyclic) made perpendicular to the normal, `v = normal x u`, and the
origin is the world origin projected onto the face, so a +Z face reads centers as world
`(x, y)`. Kinds: `simple`, `counterbore { diameter, depth }`, `countersink { diameter,
angle? }` (rim diameter at the face, 90 degrees included by default) and `tapped { thread }`,
which bores the thread's tap drill. `depth` is below the face, or `'through'`.

`threads.lookup(designation)` returns the typed facts of a catalogue thread (ISO metric
coarse M1.6 to M64, UNC and UNF #2 to 1-1/2, pipe G and Rp 1/16 to 4: major diameter, pitch,
tap drill, flank angle in meters and degrees); `threads.all()` lists every designation. The
tap drill is major - pitch for metric, about major - 0.9743 pitch for UN, the minor
diameter for pipe threads. Considerations:

- A cut whose face leaves no material around the thread major diameter is `tap-wall`; move the centre inward or pick a smaller thread rather than a smaller tap.
- Several centers cut a plate that already has holes more reliably in one call than one centre at a time; a part with many holes in many faces cuts each in its own session and appends.
- A `through` cut reaches past every solid along its axis, including other components in the same session; cut a part alone and append it.
- Counterbores and countersinks keep the op label; ask `sel.createdBy(label, 'countersink')` for the cone and `'hole-wall'` for the bore.
- Cosmetic thread rings (`hexBolt` default) cost a handful of faces; a modeled helix costs hundreds per turn, so reserve it for a close-up or an interference check.
- `threadGeometry: 'modeled'` on a tapped hole sweeps a real helical groove into the bore (role `hole-thread`); the hole must be at least one pitch long (`thread-length`) and the cut leaves a margin of two pitches, so a through cut of a 20 mm plate takes about a second and a half per 12 mm of thread and adds on the order of 500 faces at 4 mm, 1600 at 12 mm and 2700 through.
- A modeled bolt fits a modeled hole of the same size when both use the same `segments`; at a seat height `y` above the hole's face the bolt turns `360 y / pitch` degrees about Y, and a seat of a whole number of pitches needs no turn. Check the fit with `rig` interference rather than by eye.
- A `through` bore cuts every component along its axis, so add an upper plate after the hole, not before.

## Mechanical recipes

`recipes.*` (also exported as plain functions) build parametric parts as ordinary
sessions: each returns `Result<RecipePart>` with the `model`, named `anchors` (pin axes,
seats) and derived `dimensions`, or the first `ModelingError`. Parameters are checked
against declared ranges (`*_RANGES`; dependent limits scale with the main size and the
error detail carries `min`/`max`). Labels are `<name>-<feature>`, every face is tagged
`<name>`, crease edges are sharp, UVs are box-projected and material slots are named, so
an assembly appends parts with `append(part.model, { translate, tag })` and turns them with
`rotate(sel.tag(name), ...)`.

| Recipe | Part | Labels (slots) |
|:--|:--|:--|
| `gear({ module, teeth, width, bore?, pressureAngle?, webHoles?, chamfer?, hubLength?, hubDiameter? })` | involute spur gear along Z (standard addendum and dedendum, radial flanks below the base circle), chamfered tooth rims and bore, optional hub standing out of both faces with chamfered rims | `<name>`, `-chamfer`, `-bore-chamfer`, `-hub`, `-hub-chamfer` (`steel`) |
| `rack({ module, teeth, width, height?, pressureAngle?, backlash?, chamfer? })` | involute spur rack along X (straight flanks, pitch pi x module, teeth toward +Y, pitch line y = 0, each tooth thinned by `backlash`), chamfered tooth rims, caps cut at every tooth gap so a turned rack exports without slivers; pairs with `gear` of the same module: gear centre at ((k + 1/2) x pitch, module x teeth / 2), turned -90 degrees about Z, and a turn of theta rad moves the rack by r x theta along +X | `<name>`, `-chamfer` (`steel`) |
| `hydraulicCylinder({ bore, rod, stroke, extension?, pin? })` | barrel with gland and seam groove, piston and rod at the extension, clevis eyes with pin holes along Z | `-barrel` (`paint`), `-rod` (`chrome`), `-eye`, `-rod-eye` (`steel`) |
| `ballBearing({ bore, outer, width, balls? })` | deep-groove races and balls with 3 % groove clearance | `-inner`, `-outer` (`steel`), `-ball` (`chrome`) |
| `hexBolt({ size, length, thread?, threadGeometry?, segments? })`, `hexNut({ size })`, `washer({ size })` | ISO M3 to M24 (diameter and pitch from the thread catalogue): chamfered hex head welded to the shank, cosmetic V thread rings (`panelLine`) or, with `threadGeometry: 'modeled'`, a swept helical ridge on a root-diameter shank (`-thread`), chamfered nut, plain washer | `-head`, `-shank`, `-thread`, `-chamfer` (`steel`) |
| `coilSpring({ radius, wire, pitch, turns })` | helical wire: the section is extruded a little and screwed to every station | `<name>` (`spring`) |
| `hinge({ length, leafWidth, thickness, pin, knuckles?, holes?, openAngle?, pinOverhang? })` | butt hinge: leaves with countersunk screw holes (`m.hole`, a true cone), alternating knuckles, headed pin; leaf B side tagged `<name>-b` | `-leaf-a`, `-leaf-b` (countersinks: role `countersink`), `-knuckle-a`, `-knuckle-b` (`steel`), `-pin` (`chrome`) |
| `slideRail({ length, width, height?, carriage?, position?, holePitch? })` | rail with chamfered mounting holes and U ball tracks (`panelLine`), carriage with clearance and end seals | `-rail` (hole chamfers: role `bevel`), `-track` (`steel`), `-carriage` (`paint`), `-seal-a`, `-seal-b` (`rubber`) |
| `pinJoint({ d, fit?, shear?, lug?: { e?, thickness?, length? }, wall?, gap?, retainer?, segments? })` | double-shear pin joint about +Y: a lug (body +X, rounded at `e` D, at least 1.5 D) in a clevis (cheeks and bridge, body -X; one cheek for `shear: 'single'`), a headed pin and, with `retainer: 'ring'`, a washer and a DIN 471-style ring in a pin groove; returns `contacts` (every pair a `fit`) | `-lug`, `-clevis`, `-washer`, `-ring` (`steel`), `-pin` (`chrome`) |
| `lug({ d, fit?, e?, thickness?, length? })`, `clevis({ d, fit?, e?, wall?, slot?, shear? })` | the joint's lug and clevis alone | `<name>` (`steel`) |
| `bushing({ d, fit?, outer?, length?, flange? })` | plain sleeve along +Y, bore at the fit's hole mid size, outside flats at `outer` / 2 for a line-to-line housing bore; length over diameter at most 2 | `<name>` (`bronze`) |
| `rodEnd({ d, fit?, clearance?, shank? })` | spherical plain bearing: ball with bore in a housing whose race keeps `clearance` across facets at any tilt, shank along -X; returns the ball-housing `fit` | `-ball` (`chrome`), `-housing` (`steel`) |
| `ratchet({ teeth, tipRadius, toothDepth, width, toothLand?, bore?, direction? })`, `pawl({ length, width, thickness, pivotRadius? })` | ratchet wheel about +Z with a radial locking face, a tip land and a ramp per tooth, and its pawl at the seated pose (tangent at the locking face, pivot one pawl length away); `direction` is the free drive; the pawl bar's reach past the face must fit within one pitch minus the land, otherwise `model-invalid-argument` (detail `clearance`, degrees). Anchors `hub`, `pawlPivot`, `pawlTip`; the wheel and pawl seat in `contacts` | `-wheel`, `-pawl` (`steel`) |
| `sprocket({ teeth, pitch, width, rollerDiameter?, bore? })`, `chainLink({ pitch, kind, width, rollerDiameter?, plateThickness? })`, `chainPlacements({ links, pitch })`, `chainClosure(placements)` | sprocket with one roller seat per tooth on the pitch circle (radius p / (2 sin(pi / teeth))), each seat 1.05 x roller radius, a tip circle at seat/2 beyond the pitch circle (a simplified outline, not the ANSI topping curve); `chainLink` is an outer link (pins pressed in outer plates) or an inner link (rollers on clear pins between inner plates) along +X with pins at +-pitch/2; `chainPlacements` returns pin positions and link angles for a closed loop of N links on an N-tooth sprocket and returns placements only; `chainClosure` measures the pitch-polygon gap. Dimensions include `pitchRadius`, `outerRadius`, `seatRadius`, `toothHalfAngle`. Link parts `-plate-a`, `-plate-b`, `-pin-a`/`-pin-b` or `-roller-a`/`-roller-b`, contacts `fit`/`seat` | `<name>` (`steel`); link parts `-plate-*` (`steel`) |
| `cam({ baseRadius, lift, motionShare, width, follower, rollerRadius?, maxPressureAngle?, bore? })` | translating cam about +Z on a cycloidal rise-dwell-return-dwell law (`motionShare` = rise and return share each, dwells fill the rest); `follower` is `flat` (face contact) or `roller` (pitch curve offset inward by `rollerRadius`). Pressure angle and radius of curvature are derived from the closed-form law, not the mesh; an undercut (`minCurvature <= 0`) or a pressure angle above `maxPressureAngle` (default 30) is refused with `model-invalid-argument` (detail `pressureAngle` or `minCurvature`). Dimensions include `maxPressureAngle`, `minCurvature`, `maxLift`. `cycloidal(t, motionShare)` exposes the lift fraction for tests and layout | `<name>` (`steel`) |
| `escapementWheel({ scoops, outerRadius, rimWidth, hubRadius, spokeWidth, width, scoopDepth?, bore? })`, `steelyardStop({ scoops, armTrip, thickness, torque, width? })` | Su Song-style bucket wheel: one extruded face set with a scalloped rim (one cup per scoop) and `scoops` spoke openings as holes, no booleans; `stepAngle` = 360 / scoops per beat. The steelyard stop is the `pawl` bar with its trip mass from the moment balance `tripMass = torque / (g * armTrip)`, g = 9.80665 (`STANDARD_GRAVITY`). Refused with `model-invalid-argument` when the spoke openings leave less than 0.02 rad each or the hub reaches the rim. Anchors `hub`; stop anchors `pivot`, `trip` | `<name>` (`steel`) |
| `overCenterLock({ span, overCentre, width, thickness, stopGap? })` | over-centre (toggle) lock at its locked pose: link A from pivot A (origin) to the middle pivot M, which rests `overCentre` past the line A-B (-Y), link B from M to B one thickness above, and a ground stop `stopGap` (0.2 mm) under link A; `overCentre <= 0` is refused (a toggle at or before its centre line is pushed open). Anchors `a`, `m`, `b`, `stop`; dimensions `linkLength`, `lockAngle`; the links' seat in `contacts` | `-a`, `-b`, `-stop` (`steel`) |
| `pushClip(options)`, `weldNut(options)`, `blindRivet(options)`, `grommet(options)` | Panel hardware: a fir-tree trim clip, hex or square projection weld nut, installed blind rivet, and grooved rubber grommet or blanking plug. Linear dimensions are meters; counts are integers and the weld-nut `size` is a metric designation. Feature and dependent ranges are checked. Weld-nut height defaults to nominal size and projections to 3 hex / 4 square; its optional pilot locates the nut. Rivet head diameter, head height and upset bulb default to 2, 0.5 and 1.5 x shank diameter. Grommet flange diameter defaults to 1.8 x hole diameter and thickness to half the panel thickness; `bore: 0` makes a plug. | `<name>` (`nylon`: push clip; `steel`: weld nut and rivet; `rubber`: grommet) |
| `tyreSize(code)`, `tyre(options)`, `wheelRim(options)` | Parses ISO metric tyre designations to meter dimensions, builds a hollow grooved tyre, or builds a barrel, drilled hub and straight-spoke rim. Both tyre and rim use axle +Y with contact at -Z. `tyreSize` accepts forms such as `225/45R17`; recipe dimensions are meters and tyre aspect ratio is a fraction. `wheelRim.offset` is ET toward the outboard/street side (+Y); `backspacing` is measured from the inboard flange inner face to the mounting plane. | `-tread`, `-sidewall`, `-bead`; `-barrel`, `-hub`, `-spoke-*` |
| `catenary(a, b, { sag } \| { length }, options?)`, `cable(options)` | Computes a catenary from either positive sag or cable length and builds a cable bundle along a polyline, optionally with twisted strands, wrap and end fittings. Lengths are meters; catenary `down` defaults to `[0, -1, 0]` and sampling to 33 points. `cable` uses 16 polygon sides by default; strand counts 8 to 19 remain a single ring, leaving a central lumen rather than adding inner layers. | `-strand`, `-wrap`, `-fitting-*` |

Multi-body parts keep their bodies apart by clearances (pins in bores, balls in grooves,
eyes stand off their faces), so each recipe validates without errors or warnings across
its declared ranges (`recipes.unit.test.ts` sweeps every range corner). Known limits:
threads are rings, not helices; gear chamfers are 45 degree flats of one width (no tip
relief), and a hub is a plain tube unioned with the web.

**Fits.** `isoFit(d, fit)` returns the ISO 286 limits of the clearance fits
`H7/h6`, `H7/g6`, `H8/f7` and `H11/c11` from 1 to 180 mm (hole basis, diameters in meters,
diametral clearance and the mid-band sizes). The pin-joint recipes cut every bore at the
hole mid size and turn pins at the shaft mid size, measured across flats: pin and bore share
segment count and phase, so at rest their flats stand exactly `radialGap` apart, and
`fitSegments` picks the fewest segments (at least 32) for which a turned pin's vertices take
at most half the gap. Nothing penetrates: heads, washers and rings sit flush, the lug clears
each cheek by `gap` and the bridge by a quarter diameter (`swing` is how far the lug turns
before its corners reach the bridge). `contacts` declares the joint's own pairs as `fit`s;
bind each label as a rig part of the same name (the lug on the moving joint) and pass them
to `scan` and `validate`. A lug below e/D = 1.5 is refused: shear-out and hoop tension
would govern it.

## Timber construction

Traditional Chinese timber parts (营造法式 卷四, 卷五) are sized in 分, the fen unit of
the 材分制. `caiFen(grade)` (grades 1 to 8) returns the fen length and the 材, 栔 and 足材
sizes in meters. The 15-fen 广 and the 10-fen 厚 are verified against 卷四; the eight-grade
寸 table is secondary (zh.wikipedia 材分制) and the metric scale assumes 1 cun of 0.0316 m,
which no checked source states. Every ratio is exact.

| Helper | Output | Notes |
|:--|:--|:--|
| `caiFen(grade)` | `fen`, `width` (广, 15 fen), `depth` (厚, 10 fen), `xieWidth` / `xieDepth` (栔, 6 by 4 fen), `zuCai` (足材, 21 fen) | `CAI_GRADES` holds the 寸 table; grades outside 1..8 are refused with `model-invalid-argument` |
| `timberJoint({ postWidth, kind?, beamHeight?, tenonLength?, clearance? })` | Post `<name>-post` (mortise cut) and beam tenon `<name>-beam`; `fit` contact band [clearance / 2, 2 clearance]; dimensions include `measuredClearance` from `partDistance` | `kind`: `through` or `blind` only; `dovetail` and `shoulder` are refused as not modeled. Default clearance 0.5 mm; `TIMBER_JOINT_RANGES` bounds every option; a blind tenon that would break the post's back is refused |
| `dougong({ puzuo?, grade?, juanshaFen? })` | Lu dou `ludou`, per step `xie-hua-<k>-<±x>`, `huagong-<k>-<±x>`, `nidaogong-<k>-<±z>`, `san-dou-<k>-*`, `jiao-hu-dou-<k>`, then `xie-man` and `mangong`; anchors per placement and `seat-<k>`, `top` | `puzuo` 4 or 5 sets `steps = puzuo - 3`. Lu dou is 32 by 20 fen, huagong 72, nidaogong 62, mangong 92 fen (verified, vol. 4). San dou and jiao hu dou reuse the lu dou size (design choice). Stack height is 41 + 41 * steps fen. Members touch on coplanar faces and are declared `seat` contacts; no interior boolean |
| `juzheRoof({ kind?, run?, spans?, length? })` | Closed prism `<name>` over the purlin polyline, ridge along Z from z = 0 to `length`; anchors `ridge`, `ridge-end`, `purlin-<p>-right` / `purlin-<p>-left` at z = 0 | `kind`: `pavilion` (ridge rise 1/3 of the run) or `hall` (1/4), both secondary. Each lower 架 has twice the rise of the one above (`juzhePurlins`, secondary zh.wikipedia summary). Equal runs per 架 are a design choice. Hip (歇山) ends and eave upturn (起翘, recorded as `eaveUpturn` 0) are not modeled; the 起翘 value is not located in the checked sources |
| `tileRows({ purlins, length?, tileWidth?, exposure?, lap?, thickness?, ridgeHalf?, ridgeHeight?, coverWidth? })` | Pan plates `<name>-<R\|L><facet>-r<row>-c<col>` in sawtooth rows (bedding, head at one thickness, butt at two), mitred at every fold by the bisector of the two outward normals; cover strips `<name>-<R\|L><facet>-r<row>-k<col>` (loft of two planar end rings, half-round top); ridge cap `<name>-ridge`; `seat` contacts between neighbours | Input is one roof side from `juzhePurlins`. Closed form only: no tilted plates and no boolean. Row pitch is at most `exposure`; `lap` is the covered tail, a layout dimension, not a stacked volume, so overlapping shells are never modeled (`tileLength = pitchMax + lap`). Tile sizes are design choices. Eave end caps (瓦当, 滴水) are not modelled |
| `latticePattern({ pattern?, width?, height?, thickness?, cell?, bar?, border?, seed? })` | Rectangular panel `<name>` extruded from z = 0, pierced by one lattice; anchors `origin` and `center` | `pattern`: `bubujin` (stepped squares, four corner notches), `guibeijin` (flat-top hexagons), `binglie` (seeded irregular rectangles; `seed` is required), `huiwen` (stepped squares with alternating diagonal notches). Openings sit `border + bar/2` inside the outline and share `bar` between neighbours. Dimensions include `openArea`, `openRatio` and `minBar`. Pattern names are design choices, not source values. Open area matches the kernel's volume-based measure within a relative 1e-9 of the panel area on every pattern (tests). |
