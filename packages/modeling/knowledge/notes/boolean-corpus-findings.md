# Boolean corpus findings

> [!NOTE]
> Source of truth: `src/brep/__tests__/corpus/` (cases, observer, pinned table, runner). Baseline
> commit 3802d7e9. Recorded with `vitest run src/brep/__tests__/corpus/boolean-corpus.unit.test.ts`.
> The baseline table below was recorded before any kernel change. The K1 fix (repeated identical cuts
> and face-touching contacts) follows in "After K1"; the refusal table keeps the original causes and
> marks the rows that K1 removed.
>
> Current totals (measured 2026-11-13 by running `boolean-corpus.unit.test.ts` at main 76581473): 46 cases, 28 ok,
> 18 refused, 0 wrong, 0 slow. The per-round tables below are dated snapshots and each keeps its own totals.

## Outcome by class (baseline)

| Class | Cases | ok | refused | wrong | slow |
|:--|--:|--:|--:|--:|--:|
| A box/box planar crossings | 5 | 5 | 0 | 0 | 0 |
| B repeated pockets on one rail | 5 | 1 | 4 | 0 | 0 |
| C cylinder crossings | 7 | 1 | 6 | 0 | 0 |
| D sphere, torus, cone vs half-space | 4 | 0 | 4 | 0 | 0 |
| E extruded profiles | 2 | 2 | 0 | 0 | 0 |
| F circular and linear patterns | 2 | 1 | 1 | 0 | 0 |
| G chained operations | 2 | 0 | 2 | 0 | 0 |
| H contact, nesting, disjoint | 5 | 2 | 3 | 0 | 0 |
| **Total** | **32** | **12** | **20** | **0** | **0** |

No case returned a wrong result. Every ok result is validated (`validate`), has no open boundary
edge, and matches its analytic volume (planar cases within 1e-9 relative, curved within 1e-6).

## After K1 (repeated identical cuts, touch-only contacts)

| Class | Cases | ok | refused | wrong | slow | Change |
|:--|--:|--:|--:|--:|--:|:--|
| A box/box planar crossings | 5 | 5 | 0 | 0 | 0 | none |
| B repeated pockets on one rail | 11 | 11 | 0 | 0 | 0 | B1 to B4 fixed; B5 to B10 added |
| C cylinder crossings | 7 | 1 | 6 | 0 | 0 | none |
| D sphere, torus, cone vs half-space | 4 | 0 | 4 | 0 | 0 | none |
| E extruded profiles | 2 | 2 | 0 | 0 | 0 | none |
| F circular and linear patterns | 2 | 1 | 1 | 0 | 0 | none (F1 has a different cause) |
| G chained operations | 2 | 0 | 2 | 0 | 0 | none (G2 has a different cause) |
| H contact, nesting, disjoint | 7 | 4 | 3 | 0 | 0 | H1 fixed; H2 now a non-manifold refusal; H6, H7 added |
| **Total** | **40** | **24** | **16** | **0** | **0** | |

Fix:

- `src/brep/planar-section.ts` sections one simple polygon by a plane. Vertices are on, above or
  below the plane (the existing rounding band; the grey zone up to `tol` still refuses). A vertex on
  the plane is reused as a section site, crossings are inserted only on strict sign changes, and the
  sites are ordered along the section line. A stretch between consecutive sites becomes a chord only
  when it runs through the interior (exact `orient2d` winding test on the dominant-axis projection);
  a stretch that is a boundary edge contributes no split, a stretch outside is skipped. Each piece
  must end up on one side.
- `boolean-planar-cross.ts` classifies pieces on the other solid's boundary with the regularized
  rule (`keepOnBoundary`): the first solid's copy stays when the outward normals agree (union,
  intersect) or oppose (difference); the second solid's copy is always dropped. The face carrying
  the piece is found by `containingFaces` in `planar-cross-nonconvex.ts`; no face or disagreeing
  faces refuse `planar-cross-coplanar-or-tolerance-contact`.
- `boolean.ts` routes every all-planar pair to the planar-cross path, including coplanar ones.
- Result checks in order: no kept piece refuses `planar-cross-empty-result`; an edge used by more
  than two faces refuses `planar-cross-non-manifold-contact` (edge or point touch: the kernel never
  carries a third face on an edge); several components refuse `planar-cross-multi-component-result`.

New cases (all validated, zero open edges, analytic volume within 1e-9):

| Case | Volume | Notes |
|:--|--:|:--|
| B5 30 through mortises, one linear pattern | 0.09216 - 30 x 0.000576 = 0.07488 | 126 faces, 372 edges |
| B6 the same 30 as 30 sequential `booleanSolids` | 0.07488 | same face and edge counts; volumes differ < 1e-15 (vertex numbering differs, so the serializations are not equal) |
| B7 10 blind pockets from the rail bottom | 0.09216 - 10 x 0.00009 | |
| B8 10 top pockets crossed by 10 side pockets inside the rail | 0.09216 - 10 x (0.000576 + 0.000256 - 0.000064) | |
| B9 10 notches whose wall lies in the rail side face | 0.09216 - 10 x 0.000288 | open to top and side |
| B10 3 mortises, then the matching tenons unioned back | 0.09216 | original volume |
| H6 two cubes sharing a face, intersect | refused `planar-cross-empty-result` | |
| H7 two cubes sharing a face, difference | 1 | first cube unchanged |

Time per cut grows linearly with the faces of the host (every host face is sectioned by every tool
plane). Measured on a 2.6 rail with 0.01 x 0.06 through mortises: cut 1 36 ms, cut 30 186 ms,
cut 60 388 ms, cut 120 849 ms (48 s for all 120). Each through mortise adds 4 faces and 12 edges
(measured to 120), so `BREP_LIMITS` (4096 faces, 4096 edges) binds on edges at 340 mortises
(12 + 12n <= 4096); reaching it was not run (extrapolated about 400 s cumulative).

Mutation checks (each restored): the difference rule set to `same` makes B4, B9 and H7 refuse
(`model-precondition`: the result fails validation, `brep-edge-use` for H7); removing the boundary-edge skip in `sectionPolygon` makes B1 to B3
and B5 to B10 refuse (`planar-cross-chord-split`); flipping the union/intersect rule fails B10, H1,
H6 and the coplanar union test. The runner fails on each.

Still refused after K1, with traced causes:

- F1, G2: a plane/plane crossing inside a solid that also has a cylinder face (flange or bored
  plate). The planar-cross path takes only all-planar solids, and the general path supports a
  plane/plane pair only as a coplanar contact, so both reach `unsupported('planar faces that meet
  along a line')`. Not related to repeated cuts (F1 fails at copy 1).
- H3: the cube top and bottom are coplanar with the cylinder caps and overlap only in part, and
  the cylinder touches the cube side along a line. Same mixed-solid refusal as F1 and G2.
- H2: edge-only touch has no manifold union in this kernel; refused by design.
- H5 intersect (disjoint, general path, not a corpus case) returns `model-precondition:brep-orientation`
  rather than an empty-result refusal; the kernel has no empty shape value.

## After K1 round 2 (planar chords inside solids with curved faces)

Round 2 adds no intersection geometry. A plane chord that crosses a planar face bounded by or containing
circle loops (cylinder caps and holes) needs a circle-aware cell assembly that shares edges with the lateral
faces. That is new geometry, so the kernel refuses it with a named code instead of guessing:
`model-partial : planar-chord-with-curved-solid` (raised in `boolean.ts:booleanSolids` when `hasOnlyPlanarFaces`
is false and the planar pair loop finds a chord). All-planar solids still take the planar-cross path.

| Class | Cases | ok | refused | wrong | slow | Change |
|:--|--:|--:|--:|--:|--:|:--|
| A box/box planar crossings | 5 | 5 | 0 | 0 | 0 | unchanged |
| B repeated pockets on one rail | 11 | 11 | 0 | 0 | 0 | unchanged |
| C cylinder crossings | 8 | 1 | 7 | 0 | 0 | +C8 hub keyway refused (`planar-chord-with-curved-solid`) |
| D sphere, torus, cone | 4 | 0 | 4 | 0 | 0 | unchanged |
| E extruded profiles | 2 | 2 | 0 | 0 | 0 | unchanged |
| F patterns of tools | 2 | 1 | 1 | 0 | 0 | unchanged (F1 still `pattern-step`) |
| G chained operations | 6 | 0 | 6 | 0 | 0 | +G3 to G6 (all refused) |
| H contact, nesting, disjoint | 8 | 4 | 4 | 0 | 0 | +H8 tenon on drilled plate (refused); H3 re-pinned |
| **Total** | **46** | **24** | **22** | **0** | **0** | 40 to 46 cases; 16 to 22 refused |

New cases (all refusals, pinned so a later fix must change the pin on purpose):

| Case | Shape | Pinned result |
|:--|:--|:--|
| C8-hub-keyway | cylinder hub minus a keyway block | `planar-chord-with-curved-solid` |
| G3-slot-then-hole | plate, slot, then hole | `brep-ssi-unsupported` |
| G4-hole-then-slot-clear | r0.1 hole, then a slot clear of it | `planar-chord-with-curved-solid` |
| G5-four-holes-then-slot-clear | four r0.1 holes, then the same slot | `planar-chord-with-curved-solid` |
| G6-hole-then-slot-through-hole | r0.2 hole, then a slot through it | `planar-chord-with-curved-solid` |
| H8-tenon-on-drilled-plate | drilled plate, union with a tenon block | `planar-chord-with-curved-solid` |

Re-pinned: G2-hole-then-slot and H3-tangent-cylinder-union moved from `brep-ssi-unsupported` to
`planar-chord-with-curved-solid`. F1 keeps `pattern-step`.

Smallest reproducer: plate `block([2,2,0.5])` minus `cyl(0.1,2,[-0.5,0,0])`, then minus
`block([0.9,0.2,2],[0.75,0,0])`. Refused with `planar-chord-with-curved-solid`.

Mutation checks (each restored byte-identical after the run):

| Id | Mutation | Result |
|:--|:--|:--|
| M1 | flip `keepOnBoundary` in `boolean-planar-cross.ts` | corpus red |
| M2 | force `hasOnlyPlanarFaces` to true | red, planar-cross-face-loop keys |
| M3 | flip the union classification (`'outside'` to `'inside'`) | red, A1 and A5 wrong volumes |

## After K1 round 3b (planar crossings that carry whole circle holes)

A solid whose curved faces are all drilled through holes (a cylinder wall whose two circle edges are single-coedge
inner loops of planar faces perpendicular to its axis) now crosses an all-planar solid through the planar-cross
path, provided no face of the planar solid comes within the hole radius of the hole axis. The test is on the
bounded faces projected along the axis, not on their infinite planes, so the G4 slot wall that is tangent to the
hole only as an infinite plane passes. The circle loops stay circle loops (same curve, same edge as the cylinder
wall) and are attached to the merged cap region that holds the circle centre; the wall passes through unchanged
when the hole's side of the other solid is kept. Entry: `booleanPlanarCrossCarryingHoles` in
`boolean-planar-cross.ts`, helpers in `planar-cross-circles.ts`, dispatched from the existing refusal site in
`boolean.ts`. Everything outside that scope still refuses with `planar-chord-with-curved-solid`.

| Class | Cases | ok | refused | wrong | slow | Change |
|:--|--:|--:|--:|--:|--:|:--|
| A box/box planar crossings | 5 | 5 | 0 | 0 | 0 | unchanged |
| B repeated pockets on one rail | 11 | 11 | 0 | 0 | 0 | unchanged |
| C cylinder crossings | 8 | 1 | 7 | 0 | 0 | unchanged (C8 keyway crosses the hub circle) |
| D sphere, torus, cone | 4 | 0 | 4 | 0 | 0 | unchanged |
| E extruded profiles | 2 | 2 | 0 | 0 | 0 | unchanged |
| F patterns of tools | 2 | 1 | 1 | 0 | 0 | unchanged |
| G chained operations | 6 | 3 | 3 | 0 | 0 | G2, G4, G5 ok; G3, G6 and G1 unchanged |
| H contact, nesting, disjoint | 8 | 5 | 3 | 0 | 0 | H8 ok; H3 unchanged |
| **Total** | **46** | **28** | **18** | **0** | **0** | 22 to 18 refused |

G2 and H8 were not targets of this round. Both are clear of their hole (G2: slot x 0.6..1.2 against an r 0.3
hole at the origin; H8: tenon x 0.5..0.9, y 0.4..0.8), so the same builder handles them; the round 3 probe note
that G2 needs arc cells was wrong. G3 (slot first, then the hole) still refuses in the cylinder path, and the
exact reverse order of G4 refuses there with `brep-ssi-tangent` because the hole is tangent to the slot's
infinite side planes; that is a ruling/tangency fix in the cylinder path, not this builder.

Extra checks in `src/brep/__tests__/planar-cross-circles.unit.test.ts` (validate, watertight tessellation,
volume and area against closed forms at 1e-9 relative):

| Check | Result |
|:--|:--|
| G4 geometry: volume `2 - pi*0.01*0.5 - 0.7*0.2*0.5`, area `12 - 2*pi*0.01 + pi*0.1 + 0.42` | exact; two circle loops, one cylinder |
| G4 result drilled again (r 0.1 at (-0.5, 0.6)) | exact |
| Order independence with the hole at (-0.5, 0.5): hole then slot equals slot then hole | exact both ways |
| Tenon union in both operand orders | exact both ways |
| Intersection where the hole lies outside the other solid | wall and circles dropped, exact |
| Slot reaching the hole (tangent bounded chord) | refuses `planar-chord-with-curved-solid` |

Mutation checks (each restored byte-identical after the run):

| Id | Mutation | Result |
|:--|:--|:--|
| M4 | drop the circle loops from the cap faces | red: G2, G4, G5, H8 `brep-edge-use` |
| M5 | assign each hole to the next region instead of its own | red: G2, G4, G5, H8 `planar-cross-loop-assembly` |
| M6 | skip the bounded-chord test | red: G6 re-keyed to `planar-cross-circle-hole-contact` (the region test catches the chord) |
| M7 | invert the hole-wall keep rule | red: G2, G4, G5, H8 `planar-cross-circle-hole-inconsistent` |

A weaker M3 variant (a `tol * 1000` locate tolerance) stayed green, so it was not counted.

Digests at the round 3b commit: `BREP_KERNEL_DIGEST` `50a0931139fa0b11` to `ee9dd95912489554` (`brep/boolean.ts`
`a8b126e4` to `41ba93e9`); `TS_KERNEL_DIGEST` `1790251ce46e70b4`. These are historical. Current values, read from
`src/brep/kernel-digest.ts` and `src/compute/kernel-digest.ts` on 2026-11-13: `BREP_KERNEL_DIGEST` `a699b72219f73940`,
`TS_KERNEL_DIGEST` `626900df3b1ceec2`.

Still refused, and what is missing: a planar chord across a face with circle loops needs circle-edge sharing
between cell faces and laterals (new arc-aware cell assembly). Hole after slot in the same plate also hits
`closed circle branch`. Tenon on a drilled plate fails because coplanar partial overlap returns null from
`planarContactEither`. Multi-hole slots and hub keyways need the same circle-aware assembly.

## Refusal classes (baseline)

Code and reason are the refusal as the caller sees it. `file:function` is where it is raised.

| Class | Cases | Code : reason | Raised at | Root cause | Fix size | Owner |
|:--|:--|:--|:--|:--|:--|:--|
| Pocket row: vertex on the section (fixed by K1) | B1 B2 B3 B4 (B3 probed at copy 2) | `model-partial : planar-cross-section-through-vertex` (surfaces as `pattern-step`) | `boolean-planar-cross.ts:splitPolygon` | The second identical pocket's walls lie on the same planes as the first pocket's walls. The infinite-plane section then ends exactly on a polygon vertex (the notch corner), which is a valid split point. The guard refuses any endpoint that coincides with a vertex. | Medium | `boolean-planar-cross.ts`, `splitPolygon` and `splitAgainst` |
| Pocket row: collinear section edge (fixed by K1) | B1 (after vertex fix) | `planar-cross-section-collinear-edge` | `boolean-planar-cross.ts:splitPolygon` | The cutting chord runs along an existing boundary edge of the face, so the section cannot be a simple chord. Probe: removing the vertex check moves the refusal to edge 4 for B1. | Medium to large (sections must pair chords with boundary edges, not just split) | `boolean-planar-cross.ts`, `planar-cross-nonconvex.ts:splitAlongChords` |
| Plane/plane contact in a pattern | F1 | `model-partial : brep-ssi-unsupported` with `kinds: plane/plane` (no reason; probed at copy 1) | `boolean.ts:booleanSolids` (planar pair loop, `unsupported('planar faces that meet along a line')`) | Traced in K1: the flange has a cylinder face, so the planar-cross path is not taken, and the general path supports plane/plane only as a coplanar contact. | Large (planar-cross for mixed solids) | `boolean.ts:booleanSolids` |
| Coplanar touch union (fixed by K1; H2 now refuses as non-manifold) | H1 H2 | `model-partial : planar-cross-coplanar-overlap` | `boolean.ts:booleanSolids` (~line 860) | A union whose operands only touch (shared face or shared edge) is treated as a coplanar overlap. The contact is a legal result (the union of two touching solids), not an unsupported case. | Small to medium (a touch-only contact should yield a union or refuse with a touch code) | `boolean.ts:booleanSolids` |
| Cylinder crossing, tangent | C3 C4 C5 | `model-partial : brep-ssi-tangent` (via `booleanSolids` surface-pair loop, `boolean.ts` ~line 821) | `intersect-quadric.ts` / `intersect-nurbs-analytic.ts` (tangent classification) | Equal-radius perpendicular cylinders touch along the Steinmetz curves, so the SSI classifies the pair as tangent. Reading the code only; the classifier path was not traced. | Large (tangent-curve SSI, unverified) | `intersect-quadric.ts` |
| Cylinder crossing, circle partly inside | C2 C6 C7 G1 | `model-partial : brep-ssi-unsupported` (`a circle partly inside the planar face`, `a closed circle branch`) | `boolean.ts:circleOnCylinder` (lines ~587, ~608) | The intersection circle or branch is only partly inside the planar face; the case needs a splitting of the circle against the face boundary. | Large | `boolean.ts:circleOnCylinder` |
| Sphere, torus, cone vs half-space | D1 D2 D3 D4 | `model-partial : brep-ssi-unsupported` (`plane or cylinder faces`) | `boolean.ts:booleanSolids` (lines ~735, ~737) | Sphere, torus and cone faces against a plane are not dispatched; only plane and cylinder pairs are. | Large (new quadric/torus-plane SSI) | `intersect-quadric.ts` and `boolean.ts` |
| Tangent cylinder against a face | H3 | `model-partial : planar-chord-with-curved-solid` (round 2; was `brep-ssi-unsupported`, `planar faces that meet along a line`) | `boolean.ts:booleanSolids` (~line 864) | Traced in K1: cube faces coplanar with the cylinder caps overlap only in part, plus a tangent line contact; the mixed-solid plane/plane refusal. | Large (planar-cross for mixed solids) | `boolean.ts:booleanSolids` |
| Slot after a bore | G2 | `model-partial : planar-chord-with-curved-solid` (round 2; was `brep-ssi-unsupported`, `planar faces that meet along a line`) | `boolean.ts:booleanSolids` (~line 864) | Traced in K1: the slot walls cross the bored plate's planar faces in a solid with a cylinder face; same cause as F1. | Large (planar-cross for mixed solids) | `boolean.ts:booleanSolids` |

Ordering by scene parts blocked: the pocket row (B) blocks any repeated cut, so it comes first;
the coplanar touch (H1 H2) blocks assemblies that join at a face; the cylinder and quadric classes
(C, D) block round features and need new SSI code. F1, G2 and H3 were traced in K1 and share one
cause (planar crossings in a mixed solid).

## Next most valuable fix

Planar crossings inside solids that also carry curved faces (F1, G2, H3): run the planar-cross
sectioning on the planar faces of a mixed solid and keep the curved faces whole when they lie
entirely on one side.
