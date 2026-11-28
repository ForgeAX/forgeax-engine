# Boolean arc cells: planar chords across circle-loop faces

> [!NOTE]
> Scope: K1 round 3. Lifts the "no new geometry" limit for one bounded case. Code path:
> `src/brep/boolean.ts` (planar pair loop, the `planar-chord-with-curved-solid` refusal),
> `src/brep/planar-section.ts`, `src/brep/planar-split.ts`, `src/brep/face-chord.ts`,
> `src/brep/assembler.ts`. Baseline commit 6e65580c (round 2).

## Admitted input

Both operands are closed solids. Every curved face in both operands is a right circular cylinder whose
axis is perpendicular to the planar face it meets (drilled plates, bosses, hubs). Each planar cut is one of:

- a plane parallel to the cylinder axis: the cylinder is cut along straight rulings;
- a plane perpendicular to the axis: the cylinder is cut along a full circle or an arc.

New edge geometry is limited to three kinds: line segments on planes, straight rulings on cylinders, and
circular arcs (`Curve` kinds `line` and `circle`). No ellipse, cone, sphere, torus, or NURBS.

Anything else refuses with its current named code (`planar-chord-with-curved-solid`, `brep-ssi-unsupported`,
`brep-ssi-tangent`, `brep-ssi-coincident`). No new refusal code is added unless a named sub-case needs one.

## Probe findings (round 3, before implementation)

Measured on commit 8ea86cf2 (`c.run()` per case; the refusal the caller sees):

| Case | Current refusal | Reason and what it means |
|:--|:--|:--|
| G3 slot then hole | `brep-ssi-unsupported`, `a closed circle branch` | The slot wall is parallel to the hole axis, so the plane/cylinder branch is two rulings, not a circle. `circleOnCylinder` checks `closed` before testing whether the branch lies inside the planar face. Fix point: test face membership first, and skip a branch that is provably outside the bounded face. |
| G4 hole then clear slot | `planar-chord-with-curved-solid` | The slot wall `y=0.1` is tangent to the r 0.1 hole only as an infinite line. The real cut is the bounded segment `x in [0.3, 1.0]`, which does not reach the hole. Tangency must therefore be tested on the bounded chord, not the infinite plane (corrects section 5). |
| G5 four holes then clear slot | `planar-chord-with-curved-solid` | Same as G4: no chord touches a circle. Needs no arc geometry, only a notch in the outer loop with whole inner circle loops. |
| G6 hole then slot through hole | `planar-chord-with-curved-solid` | The chord crosses the circle, so arc cells are required (section 1). Out of reach for this step. |
| C8 hub keyway | `planar-chord-with-curved-solid` | The keyway walls cross the hub circle caps: arc cells required. |
| H8 tenon on drilled plate | `planar-chord-with-curved-solid` | The tenon bottom lies wholly inside the plate top. This is a coplanar contact that removes an interior rectangle from the top face, which leaves a face with an inner rectangle loop plus the hole. It is not a partial overlap along an edge (corrects the H8 entry in section 7). |
| G2 and H3 | `planar-chord-with-curved-solid` | G2's slot (x 0.6..1.2) is clear of the r 0.3 hole, so it is a G4-type case (corrected in round 3b, where it turned ok). H3 is a tangent cylinder union (a tangent case, refuse per section 5). |

Ordering implication: G4 and G5 need the outer-loop notch plus whole circle holes; G3 needs the bounded
ruling test. G6, C8, G2 need arc cells. H8 needs the interior coplanar rectangle. H3 stays refused as tangent.

## 1. Planar face with circle loops split by chords

The planar face `F` is bounded by one outer loop plus zero or more inner circle loops (cylinder holes).
A chord is the intersection of a cutting plane with `F`, a line segment `L` in the face plane.

1. Intersect `L` with each circle loop `C` in the plane. Solve the 2D line/circle quadratic in closed form
   (`intersect2` in section.ts takes its own `Element2` type, so it is not reused directly). Keep only roots with
   `|d - r| > tol` (a chord crossing a circle transversally). A chord that is tangent to `C`
   (|d - r| <= tol) refuses with `planar-cross-tangent-circle`.
2. Intersect `L` with the outer loop with the existing `sectionPolygon` rule (vertex, edge crossing, or
   interior chord). A chord that passes through an existing vertex of `F`'s outer loop refuses with
   `planar-cross-section-through-vertex` (already the refusal today; this note does not widen it).
3. Each chord becomes a set of sub-segments between consecutive sites. Sites are circle intersection points
   and outer-loop crossings, sorted along `L`. Sub-segments whose midpoint is inside `F` (inside the outer
   loop and outside every hole disc) are kept as cut edges. The rest are dropped.
4. Each kept chord pair of sites becomes a boundary edge shared by two cap pieces. Arc pieces (the parts of
   a circle loop between two sites on the same loop) become cap boundary edges.
5. Piece membership: a closed cell is traced over outer-loop segments, cut segments, and arc segments.
   Its loop kind is determined by the ring it comes from. A cell bounded by an inner circle loop
   contains that circle as a hole, so the cell's inner loop is the arc sequence of that circle.
   Pieces are closed with `ShapeAssembler.loop` (edge chaining already checks head-to-tail).

Only the sub-case where every circle site is a crossing of the chord with the circle is in scope
(a chord with both ends on one circle, or a circle entirely inside a cell, is handled by step 5 with no
new site).

## 2. Lateral cylinder faces split by rulings and arcs

For a cylinder `K` whose axis is perpendicular to `F`:

- A cutting plane parallel to the axis hits `K` along two straight rulings (u-constant lines). A ruling
  is a `line` curve on the cylinder with parameter-space pcurve `line` (`PCurve` kind `line`).
- A cutting plane perpendicular to the axis (a cap plane of another solid) hits `K` along a full circle
  or arc. The arc is a `circle` curve with a pcurve of kind `circle`.

The lateral face is split by these edges with the existing parameter-space loop assembly
(`ShapeAssembler.loop` with `pcurveFor`). Seam crossing is handled by the private `ShapeAssembler.normalizePeriod` method.

## 3. Shared edges: one edge, two coedges

Each new cut or arc is created once with `ShapeAssembler.edge(curve, t0, t1)` (one `Edge`, one `Curve`).
It is then referenced from both the planar cap piece loop and the lateral piece loop through two
`LoopEdge` entries with opposite traversal. This is how the existing planar-cross path already shares a
chord (`face-chord.ts`: "used once by each piece, opposite ways"). The validator checks that every edge
has exactly two coedges with opposite senses.

Vertices are shared through `ShapeAssembler.vertex` (bucketed by tolerance), so a circle/chord site on the
cap and on the lateral resolves to one `Vertex`.

## 4. Classification of cells

Cells are the connected pieces produced in sections 1 and 2. Classification reuses the existing
machinery; nothing new is written:

- `insideSolid` (ray parity, boolean.ts) for the interior point of each cell (`planarInterior`).
- `keepOnBoundary` for cells lying on the other solid's boundary (coplanar contact). The rule is applied
  unchanged, and for union/difference/intersect the existing keep table decides.
- Cells are merged with `mergeCoplanarCells` (planar-cross-merge.ts) when two pieces share a plane and an
  edge that the boolean removes.

A cell whose interior point is ambiguous (within `EDGE_BAND` of a face) refuses with the existing
`planar-cross-tolerance-contact` code.

## 5. Tolerance handling

- A chord tangent to a circle loop (`|d - r| <= tol`): refuse `planar-cross-tangent-circle`. Do not guess
  which side the arc lies on.
- A chord through an existing vertex of the outer loop: existing refusal (unchanged).
- A circle site within `tol` of an outer-loop vertex: refuse `planar-cross-site-coincident`.
- A ruling within `tol` of a seam on the cylinder: the existing `u-seam` split handles it; a ruling exactly
  on the seam refuses `planar-cross-ruling-on-seam`.
- Arc endpoints that coincide with another arc endpoint (two cutting planes through one point) refuse
  `planar-cross-site-coincident`.

Every refusal uses `brepFail` with the named code. None returns an open shell.

## 6. New functions and where they live

| Function | File | Purpose |
|:--|:--|:--|
| `chordCircleSites(line, circle, tol)` | `planar-arc-cells.ts` (new) | Intersection parameters of a planar chord with a circle loop; refuses tangency. |
| `arcSegmentsOnCircle(circle, sites)` | `planar-arc-cells.ts` (new) | Arcs of a circle loop between consecutive sites, with their owning interval. |
| `cutFaceWithHoles(face, chords, tol)` | `planar-arc-cells.ts` (new) | Cells of a planar face with circle loops, from chords and arcs. |
| `ruleLateral(cyl, plane, tol)` | `planar-arc-cells.ts` (new) | Rulings or arc edges a plane cuts on a perpendicular-axis cylinder. |
| `buildArcCellShape(...)` | `boolean-arc.ts` (new) | Calls the assembler to produce cap and lateral loops and faces from the cells. |
| `booleanArcCross(solids, tol, op)` | `boolean-arc.ts` (new) | Entry, dispatched from `booleanSolids` where `planar-chord-with-curved-solid` is raised today. |

Reused without change: `sectionPolygon`, `splitPlanarPolygon`, `splitFaceAlongChord`, `splitEdgeAt`,
`ShapeAssembler` (`vertex`, `edge`, `loop`, `face`, `shell`, `finish`), `pcurveFor`, `cutBranch`,
`insideSolid`, `planarInterior`, `keepOnBoundary`, `mergeCoplanarCells`, `Copier`, `validate`.

Each new file stays under 4096 lines; both are expected to be a few hundred lines. The only change to
`boolean.ts` is the dispatch line at the existing refusal site. No changes outside `src/brep/boolean*.ts`,
`planar-*.ts`, and the two new files.

## 7. What stays refused

- A chord tangent to a circle, or a chord through a vertex of the outer loop.
- A cutting plane that is neither parallel nor perpendicular to a cylinder axis.
- Any curved face that is not a perpendicular-axis right circular cylinder (cone, sphere, torus, NURBS,
  an ellipse-producing oblique cylinder cut).
- A circle loop that intersects a second circle loop of the same face (overlapping holes).
- Coplanar partial overlap of two planar faces that also carry circle loops, unless section 4 classifies
  it without a new edge kind (see H8 in the implementation log).
- Any case that needs a general face-face intersection curve beyond line, ruling and arc. Those stop and
  are reported (the coordinator's stop rule).

## Implementation order

G4, G5, G3, G6, C8, H8, then G2 and H3. The corpus is re-run after each. A case that cannot be done within
this scope stays a pinned refusal with its reason.
