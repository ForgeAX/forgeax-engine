# Exact stage (B-rep shapes)

Part of the [`@forgeax/engine/modeling` reference](../README.md).

An opt-in stage for parts whose truth is analytic: plane, cylinder, cone, sphere and torus faces trimmed by
loops of edges. A `Shape` is frozen integer-index POD (faces, loops, coedges, edges, vertices, curves, surfaces)
with f64 tolerances. `tessellate` is the only crossing into the editable mesh. Nothing in the exact stage
is imported by the mesh kernel, and the main bundle never reaches it.

## Use

```ts
import * as exact from '@forgeax/engine/modeling/brep';
import { model } from '@forgeax/engine/modeling';

const m = model({ exact });
m.brep.box('plate', { size: [2, 3, 4], label: 'plate', role: 'body' });
m.brep.cylinder('post', { radius: 0.5, height: 2 });
m.fromShape('plate');
m.fromShape('post', { angle: Math.PI / 8 });
```

- Without `exact` the `brep.*` ops and `fromShape` fail with `model-capability-unavailable` and change nothing.
- `m.brep.box|cylinder|cone|sphere|torus|extrude|revolve(name, options)` store a named Shape in the session and
  leave the mesh unchanged. Names are unique. A Shape above 4096 faces or 4096 edges is `model-work-budget`.
- `m.fromShape(name, { angle?, chord?, crease? })` appends the tessellation beside authored geometry. Faces keep the
  Shape's label and role, analytic creases carry `EDGE_SHARP`, and `uv0` is metric (see Metric uv0). Tessellation has
  no resolution cap: a very small `chord` produces a very large mesh.
- Role to material slot: each distinct face role becomes one export material slot. Its index is the role's index in
  `roleNames` (first use in Shape face order), and its name is the role. Faces with no role share slot 0, named
  `Default`; export emits only slots that some face uses. A role named `Default` is rejected (`model-invalid-argument`).
  The rule lives in `tessellateSampled` (`src/brep/tessellate.ts`), so booleans, bevel and export all see it unchanged.
- The journal records the name and plain parameters, never Shape bytes. Replay rebuilds the Shape.
  Per-step renders start at `fromShape`, because build steps change no face.
- Direct (session-free) use: `exact.box(...)` etc. return `Result<Shape, ModelingError>`; `exact.validate`,
  `exact.measure` (area, volume, per-shell facts) and `exact.tessellate` take a Shape.

## Conventions

- Frames are right-handed orthonormal (`x cross y = z`, unit axes, within 1e-9); scaled, skewed or mirrored frames
  are `brep-bad-argument`. Scale the options, not the frame.
- Outward normal = `dp/du x dp/dv` (a face's `reversed` flips it). Loops are counter-clockwise outer and clockwise
  inner in (u, v). A degenerate edge (cone apex, sphere pole) has `curve = -1`.
- Tolerance defaults to `1e-6 * max(1, diag)` of the part's own bounding box (never of its offset) and never below
  1e-9. `tol` and `maxTol` can be passed.
- `extrude({ profile, holes?, depth })` and `revolve({ profile })` accept only simple regions: no crossing or
  touching edges, no repeated points, holes inside the outline and outside each other, a revolve profile that
  touches the axis only at its ends. A violation is `brep-bad-argument` with `detail.reason`
  (`self-intersecting-outline`, `self-intersecting-profile`, `hole-outside-outline`, `hole-inside-hole`,
  `degenerate-edge`, `profile-touches-axis`). A frame origin so far from the part that its offset exceeds the
  tolerance (`origin * 1e-15 > tol`) is rejected with `reason: origin-too-far`.
- `revolveProfile` takes free-form `nurbs` segments built by `nurbsSegment(points, { degree })`, which interpolates
  the points (`interpolate`). A NURBS segment is an exact rational surface of revolution and needs a full turn
  (`nurbs-partial-turn`), matching end points (`nurbs-endpoint-mismatch`), control radii `>= 0` (`nurbs-radius`) and
  no crossing of the axis (`nurbs-crosses-axis`); lines and arcs may be mixed with it. Ring edges stay analytic
  circles parameterised by angle. The NURBS face's pcurve is a degree-7 fit of angle to parameter, refined over
  1, 2, 4 or 8 sub-intervals per quarter; the first rung whose 3D error `radius * chord` is within `tol * 0.25`
  is used. If none is, the result is `brep-tol-exceeded` with `detail.measured` (`model-partial`).
  `nurbsSegment` passes the curve through each given point (`interpolate`; centripetal parameters, or explicit
  `parameters`); it has no end-tangent option, and there is no public control-point constructor, so a
  control-point curve must be built as a literal `NurbsCurve`.

## Metric uv0

`tessellate` and `fromShape` take `uv?: { zones?, gutter? }`. Every face is one chart in metres (plane: frame
coordinates; cylinder `r u, v`; cone, sphere and torus use the first fundamental form at the face's parameter
centre), shelf-packed per zone cell and divided by one shared period `P` (the packed side plus a gutter, default 1%
of the largest chart side). `local = metres / P` is one scale for every face, and no uv0 triangles of different faces
overlap. The metric is per face in parameter space, not per triangle: texel density is constant on planes and
cylinders and varies across cones, spheres and tori, because a face keeps one chart in its parameter box with the mean
metric. Measured per-face quad uv/world area spread (max over min; re-measured 2026-11-13 and pinned by `metric-uv.unit.test.ts`): sphere about 5.1,
cone about 2.0, torus (major 3, minor 1) about 2.0, torus (major 1, minor 0.8) about 8.6; the unit test pins these.
`validate({ texelDensity })` measures one island per face and cannot see it. An area-based per-triangle
parameterization is the planned fix (X1a-followup). The layout depends on the Shape and `uv` only, never on `angle` or
`chord`. `zones` maps a face role to an integer cell `[i, j]`, each within +-1024 (default `[0, 0]`; a role with no
zone entry, including a role named like an Object.prototype member, uses the default cell, and a zone naming a role no
face has is ignored). Each zone cell holds its own pack, and `P` is the largest pack, so `validate({ surface })`
reports no `zone-straddle` and an assigned `zone-unknown` cell matches. Faces with no zone share cell `[0, 0]`
within one `fromShape` call; two calls that both use default zones overlap each other in uv0, so give each shape its
own zone cell when their uv0 must not collide. Invalid `uv` (non-object, `zones: null`, non-integer or out-of-range
cell) is `brep-bad-argument`. A cylinder or torus seam is a chart edge, so the two sides of a seam are not continuous.
A face whose chart is curved is stretched by the mean metric, not conformal.

## Normals contract

`exportMesh(..., { normals: { mode: 'smooth' } })` gives a vertex normal that matches the analytic normal of its
B-rep face to within the tessellation error, away from sharp edges. Measured over the primitive corpus (plane box,
cylinder, cone, sphere, torus, revolve, extrude-holed, `filletBox`, `filletCylinder`) at the tessellation step
`angle = pi / 64`, the largest error is 2 degrees or less (fillet-box 0.99 deg, fillet-cylinder 0.71 deg, sphere
0.03 deg, torus 0.03 deg). Error falls with the step (fillet-box 3.97 deg at the default `pi / 16`, 0.99 deg at
`pi / 64`, 0.50 deg at `pi / 128`), so the 2 degree bound is a tessellation-step claim, not a default-step claim.
At the default `pi / 16` the fillet shapes exceed 2 degrees and are not certified.

Vertices on an `EDGE_SHARP` edge keep split normals, one per face group (a box corner exports three distinct
normals). They are checked crease-aware: each must match one of its incident faces within 2 deg, so a blended
normal fails (a 20 deg tilt of them fails the falsifier). Vertices on a soft crease are excluded too: a tangent break of more than 1 deg that is below
the export `crease` (default 30 deg) is not `EDGE_SHARP`, so smooth export averages the two faces there by design.
Its deviation from each face is about half the break (a 20 deg ring measures 9.97 deg, asserted by the contract
test, which is why the exclusion is needed). Breaks of 1 deg or less are tessellation noise and stay
checked (fillet-box corners, 0.99 deg max). A cone apex is excluded because its analytic normal is taken at a
singular parameter.
Planes, cylinders, cones and revolve faces have no interior samples off their sharp edges, so the smooth bound is
not exercised on them; their sharp vertices carry the check. Every corpus shape has a measured floor of checked
vertices, and every exported vertex must lie on the B-rep within a tolerance scaled by the shape diagonal (a 1000x
fillet-box keeps all 9520 vertices on-surface). The contract is `src/brep/__tests__/normals-contract.unit.test.ts`.

## Selecting faces

`selectFaces(shape, query)` and `selectFace(shape, query)` work on a Shape alone. Every given key must match:
`label`, `labelPrefix`, `role`, `surface` (kind), `normal: { dir, angle? }` (outward normal at the face's
representative point) and `near: { point, radius }`. `selectFace` requires exactly one match.
`faceReference(shape, f)` returns the representative point and normal the selectors use; for a planar face with
holes or a concave outline the point lies strictly inside the face region (never on a loop edge). `normal.dir`, `near.point` and `near.radius` must
be numbers and finite (a direction is nonzero); otherwise the query is `brep-bad-argument`, never a match-all.

## Limits

`BREP_LIMITS` caps a Shape at 4096 faces and 4096 edges. Extrude build time scaled about linearly with profile points in that measurement (4x points gave about 4x time).
Measured 2026-11-13 on the pub server (load average about 20, not a dedicated host), median of three runs of
`extrude({ profile: circle(n), depth: 1 })`: 1024 points 0.64 s, 2048 points 1.22 s, 4096 points 2.57 s. A 4096-point
outline with one 4096-point hole takes 5.8 s. These are wall-clock figures for orientation, not a gate: the test suite
asserts only the op-count baseline and a loose bound.

Cost is gated by the operation counts listed here and by nothing else: `countOps(run)` (`src/brep/ops.ts`, internal
to the package) returns ten counters. `segmentPairs` (segment pairs the ring precondition examined, one per inner
iteration, so an early exit counts only what ran), `segmentGaps` (segment-gap calls that passed the box test),
`surfaceEvals`, `curveEvals`, `quadratureEvals` (Gauss-Legendre integrand evaluations), `triangulations` and
`triangulationPoints` (planar faces sent to the general triangulator and their outline and hole points),
`vertexCalls` and `vertexProbes` (`ShapeAssembler.vertex` calls and the weld candidates they compared) and
`finiteChecks` (numbers visited by the structural finite-value scan). Work that no counter sees is not gated: the
ear-clipping and Delaunay-flip steps inside `polygon2d` (outside the exact closure), the boolean, intersection, trace
and NURBS paths beyond their measured cases (the 'Booleans and fillets' scope below), and heap use. Wall time stays with `perf-tiers`.
`reports/brep-ops.json` records the counts for eight primitive and extrude/revolve cases; `brep-ops.unit.test.ts`
fails a count more than 10 % above it. The baseline does not ratchet: a smaller count never fails, so after an
intended speed-up run `node scripts/brep-ops-baseline.ts` and commit the lower numbers, otherwise a later regression
back to the old value still passes. After any other intended change run the same script and review the diff.

## Injection

`model({ exact })` takes the complete module namespace of `@forgeax/engine-modeling/brep`. A null or partial
stage poisons the session at construction with `model-invalid-argument` (`detail.option: exact`).

## Surface views on a Shape

`shapeSurfaces(shape, options?)` on `@forgeax/engine/modeling/brep` returns named NURBS patches for Shape faces, plus the source `faces` indices and any `skipped` faces with reasons. Plane, cylinder, cone, sphere and torus carriers convert exactly as NURBS patches (curved carriers use rational patches); full turns split into arcs no wider than `arcDegrees` (default 90; 120 is also supported). Curved inner trims are sampled polylines. NURBS-carrier trims and non-rectangular outer boundaries are not masked.

The patches have the shape of `NamedSurface`, so pass them directly to `checkSurfaceQuality({ surfaces }, { classes: D09_CLASSES })`, `highlightLines` or `surfaceDeviation`. There is no separate Shape quality function, and `measureContinuity` is unchanged.

## Surface intersection

`intersectSurfaces(a, b, tol, { window?, ids? })` returns `{ branches, partials }` for two analytic surfaces. This
release covers a plane against a plane, sphere, cylinder, cone or torus (a torus section must be parallel or
perpendicular to the axis). A branch has its `curve` and parameter interval, `closed`, one trim per surface
(`onA`, `onB`: a closed-form pcurve, or `{ kind: 'lifted', at }`) and a `receipt`: `'closed-form'` for a line,
circle or ellipse, or `{ bound }`, the largest sampled distance from either surface times `BOUND_SAFETY` (1.25, `src/brep/intersect.ts`), for a fitted
NURBS (parabola, hyperbola, toroidal lobes, spiric loop). A section whose measured deviation exceeds `tol` is
`brep-tol-exceeded`, never a wider receipt. An open branch needs `window` and covers that ball.

A pair the route does not trace is never dropped: `partials` names it with `surfaces` (the `ids`, default
`[0, 1]`), a code and the distance `gap` to the degenerate configuration. `brep-ssi-tangent` is `|gap| <= tol`
(a contact point, `contact`), `brep-ssi-coincident` is two coincident planes, `brep-ssi-unsupported` is every
pair of two non-plane surfaces and an oblique plane against a torus.

## Failures

`ModelingError.detail.brep` carries the exact code under an existing outer code: `brep-bad-argument`
(`model-invalid-argument`), `brep-index-range`, `brep-loop-open`, `brep-edge-use`, `brep-pcurve-mismatch`,
`brep-vertex-mismatch`, `brep-orientation`, `brep-self-intersection` (`model-precondition`),
`brep-face-unsupported`, `brep-pcurve-unsupported`, `brep-tol-exceeded`, `brep-ssi-tangent`,
`brep-ssi-coincident`, `brep-ssi-unsupported` (`model-partial`) and `brep-seam-mismatch`
(`model-internal`). `validate` never throws: a malformed Shape reports issues with ids.

## Booleans and fillets

`booleanSolids(a, b, op)` (`union`, `difference`, `intersect`) handles closed solids whose faces are planar or
cylindrical, plus a NURBS operand against a plane or cylinder (union only for NURBS). Two all-planar solids go
through the planar-cross path, which accepts repeated identical cuts (a section that starts on a vertex or runs
along an edge) and coplanar faces under the regularized rule: a shared face with the same outward normal stays once
in a union or intersection, opposite faces vanish from a union, and a difference keeps the first solid's face only
where the tool's face opposes it. Two cubes joined at a face therefore union into one solid, and the difference of
the second from the first returns the first unchanged. Results that are not one closed manifold shell still refuse:
an empty intersection (`planar-cross-empty-result`), solids meeting only along an edge or at a point
(`planar-cross-non-manifold-contact`) and a result in several pieces (`planar-cross-multi-component-result`). A
a solid whose only curved faces are drilled through holes crosses an all-planar solid when no face of that solid
comes within a hole's radius of its axis: each hole keeps its circle loops and wall, attached to the cap region that
contains it. Any other plane/plane chord inside a solid that also has a curved face returns `model-partial` with
`planar-chord-with-curved-solid`: a chord that splits a circle loop needs arc cells, which are not built yet. Any other face kind and a curved operand outside these families return `model-partial`
(`brep-ssi-unsupported`, `brep-ssi-tangent` or `brep-ssi-coincident`) with a structured reason; they never return
an open shell.

Fillets are closed-form primitives, not a general Shape operation: `filletBox`, `filletCylinder` and `filletPrism`
build their rounded solids directly, and `filletBetween` / `chamferBetween` give the blend geometry of one edge for a
topology rebuild. There is no fillet that takes an arbitrary `Shape` and rounds chosen edges.

## Not covered yet

- Trimmed non-rectangular curved faces in `tessellate` (`brep-face-unsupported`).
- NURBS faces in the boolean beyond the plane and cylinder pairs above.
- Booleans of a NURBS-of-revolution face against a box: every operation returns `model-partial`
  (`brep-ssi-unsupported`, `clip-crossing-count`), so the NURBS body clip is the gap. Quadrangulation of the same
  face works with the default source (`quadrangulate(shape, { size })`). `measure` integrates NURBS faces by grid
  quadrature. Measured 2026-11-13: relative volume error 0.18 % on a degree-1 NURBS line revolved to a frustum
  (re-run of the check in `revolve-nurbs.unit.test.ts`); the test comment also records 0.31 % on its area. Both sit
  under the test's 0.5 % bound.
- End tangents for `nurbsSegment` (no interpolation option exists for them).
- Fillets on an arbitrary Shape's edges.

Concave planar faces are triangulated.
