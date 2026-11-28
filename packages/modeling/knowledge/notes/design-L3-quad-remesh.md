# L3 quad-remesh: feature-constrained quadrangulation of triangle EditMesh input

Lane: L3 quad-remesh (slot 3), from `2026-11-05-quad-trim-lanes.md`. Branch `feat/mesh-l3-quad-remesh` in the kernel
repo `forgeax-modeling`, PR against `integration/v2`. Code lives in a new `src/quad/` directory outside the TS kernel
digest closure (see Digest below). Quality metrics follow the shared L4 definitions in `design-L4-quad-eval.md`.
This note describes the code as merged in the lane; where an earlier draft differed, the code is authoritative.

## Scope (v1, stated plainly)

| Item | v1 decision |
|:--|:--|
| Input | `EditMesh` faces. Only triangles are paired; any other selected face (quad, n-gon) is passed through and reported as `residual` |
| Feature input | `FeatureConstraint[]` polylines with a tolerance. The only way AI annotations enter the solver |
| Cross field (4-RoSy) | NOT in v1. Pair scoring uses face geometry only |
| Integer grid / MIQ / QuadriFlow resampling | NOT in v1. Output keeps input vertex positions. Deferred to v2 |
| Quad extraction | Feature-aware greedy triangle pairing by a geometric score (planarity, bend, squareness). Unpaired triangles are reported, not split |
| Feature check | Every constraint is measured against the output edges; the report gives the max deviation per constraint |
| Unsatisfiable constraint | Returns `model-partial` with the constraint id in `detail` |

The v1 output is a quad-dominant mesh that reuses the input vertices; no vertex is added. It is a pairing, not a
resampling remesh.

## Method sources (cited; section numbers unverified against the PDFs in this lane)

| Method | Source | Used for |
|:--|:--|:--|
| Integer-grid quadrangulation (v2) | Bommes, Zimmer, Kobbelt, "Mixed-Integer Quadrangulation", SIGGRAPH 2009 | Not in v1 |
| Orientation field and feature constraints (v2) | Jakob, Tarini, Panozzo, Sorkine-Hornung, "Instant Meshes", SIGGRAPH Asia 2015 | Not in v1 |
| Scalable quadrangulation (v2 reference) | Huang, Zhou, Niessner, Shewchuk, Guibas, "QuadriFlow", CGF 2018 | Not in v1 |
| Triangle pairing into quads | Bommes et al. 2009, as referenced by `planar.ts` `pairQuads` | Pair scoring idea; `pairQuads` itself is not reused |
| Scaled Jacobian quality | Knupp, "Algebraic mesh quality metrics", SIAM J. Sci. Comput. 2001; corner form as in `design-L4-quad-eval.md` | Quality report `scaledJacobian` |
| Semi-sharp creases | DeRose, Kass, Truong, "Subdivision Surfaces in Character Animation", SIGGRAPH 1998 | Not in v1 (no semi-sharp values) |

## Kernel reuse (checked against the code)

| Existing | Decision |
|:--|:--|
| `src/planar.ts` `quadPlanarity` | Reused for the pair planarity test |
| `src/planar.ts` `pairQuads` | Not reused: it returns a count, rewrites faces in place, and has no provenance or constraint input |
| `src/rewrite.ts` `rewriteFaces` | Reused: each pair is replaced by one quad (its first face) and the second face is removed |
| `EditMesh.clone()`, `compact()` (with `faceMap`) | Reused for output construction; provenance is mapped through `faceMap` |
| `src/dmath.ts` `cos`, `atan2` | Used for every trigonometric call so output is deterministic |
| `ModelingErrorCode` `model-partial`, `model-invalid-argument` | Reused. No new error code |
| `EDGE_SHARP` / `eFlags` | Flagged sharp edges enter the protected set. AI annotations do not enter through them |

## Data types (as in `src/quad/`)

```ts
interface FeatureConstraint {
  readonly id: string;                   // unique within one call
  readonly polyline: readonly Tuple3[];  // 2 or more points
  readonly tolerance: number;            // > 0, metres of the case
}

interface QuadRemeshOptions {
  readonly constraints?: readonly FeatureConstraint[];
  readonly sharpDegrees?: number;        // default 30, in [0, 180)
  readonly maxAngle?: number;            // default 15, in [0, 90): largest normal-to-normal angle of a pair
  readonly maxPlanarity?: number;        // default 0.02, finite and >= 0
}

interface QuadFaceProvenance {
  readonly face: number;                 // output face index after compaction
  readonly sources: readonly number[];   // input face ids: 2 for a quad, 1 for a residual
  readonly kind: 'quad' | 'residual';
}

interface QuadRemeshReport {
  readonly quality: QuadQuality;         // see table below
  readonly featureDeviation: { readonly max: number; readonly byConstraint: Record<string, number> };
  readonly unresolvedFeatures: readonly string[];
}

interface QuadQuality {
  readonly quadRatio: number;
  readonly scaledJacobian: { readonly min: number; readonly mean: number };
  readonly interiorNon4Valence: number;
  readonly boundaryEdges: number;
  readonly nonQuadFaces: number;
}
```

The result is `{ mesh, provenance, report }`. On failure the call returns `model-partial` with
`detail = { constraint, unresolvedFeatures }`, where `constraint` is the first unresolved id in sorted order.

## Algorithm (as implemented)

1. **Validate.** `sharpDegrees`, `maxAngle` and `maxPlanarity` are in range; constraint ids are unique; each
   constraint has two or more points and a finite `tolerance > 0`. Otherwise `model-invalid-argument`.
2. **Protected edges.** An input edge is protected when it is flagged sharp, when its dihedral exceeds
   `sharpDegrees`, or when both endpoints and its midpoint are each within the constraint tolerance of that
   constraint's polyline. Only these three points are tested per edge.
3. **Pairing.** Candidates are two triangles, both selected, sharing a non-protected edge, with equal material and
   label, the same corner-channel layout, normal angle within `maxAngle`, a convex quad with no near-straight corner
   (corner cosine not below -0.9848), and planarity within `maxPlanarity`. Score is
   `planarity + (1 - bend) + sum(|corner cos|) / 4`. Candidates are taken in ascending score, ties by edge id, when
   both triangles are free (greedy).
4. **Build.** `rewriteFaces` applies the chosen pairs on a clone; the result is compacted. Provenance lists every pair
   as `quad` and every other selected face as `residual`, sorted by output face. Faces not in the `faces` argument
   do not appear in provenance.
5. **Verify.** `featureDeviation` samples each constraint segment at 9 points (ends included) and records the
   distance to the nearest output edge. The max per constraint is kept. A constraint whose max exceeds its tolerance
   is unresolved, and any unresolved constraint makes the call return `model-partial`.

No centroid split is performed. Splitting one triangle would create a T-junction with its unsplit neighbours, so
unpaired triangles remain triangles and appear as `residual` provenance. That list is how the output reports which
boundary remains.

## Quality report (L4 definitions)

| Field | Definition |
|:--|:--|
| `quality.quadRatio` | quad faces over all output faces |
| `quality.scaledJacobian` | per face, min over corners of the signed sine of the corner angle (normal-oriented); min and mean over faces |
| `quality.interiorNon4Valence` | non-boundary vertices whose distinct-neighbour count is not 4 |
| `quality.boundaryEdges` | edges with exactly one incident face |
| `quality.nonQuadFaces` | faces that are not quads |
| `featureDeviation` | per constraint: max distance from its sampled points to the nearest output edge |
| `unresolvedFeatures` | constraint ids over tolerance (always empty on success) |

## Falsifiers (as implemented in `quad-remesh.unit.test.ts`)

- Sharp box (12 triangles, all 12 cube edges sharp): no unresolved features, 0 boundary edges, the six square faces
  pair across their diagonals (6 quads, 6 faces). The cube edges survive as output edges because they are protected.
- Bent square (two triangles, diagonal a-c is a real crease, bent by `degrees` = 2, 10, 40):
  - With constraint `crease` on the diagonal: its deviation is 0 to 9 decimal places.
  - Without constraints: pairing merges the two triangles, and the same polyline measured against the output drifts
    more than 1e-3 (the test fails if drift is not above tolerance), and `unresolved` equals `["crease"]`.
- Unsatisfiable constraint (polyline far off the mesh): `model-partial` with `detail.unresolvedFeatures = ["floating"]`.
- Duplicate ids and one-point polylines: `model-invalid-argument`.

**Finding that replaced the cylinder falsifier.** An earlier design used a cylinder with a 12-degree crease on a ring
boundary. Measured behaviour: pairing does not cut a ring-boundary crease (drift about 1e-16 with no constraint), so
that geometry does not demonstrate the constraint. The bent square is the geometry that pairing does cut.

## Mutation set

`scripts/mutation/sets/l3-quad.json` (20 mutations over `src/quad/remesh.ts`, `features.ts`, `quality.ts`) covers the
forbidden-diagonal check, the tolerance comparison, the scaled-Jacobian min, the non-4-valence count, the provenance
index, `model-partial` replaced by silent success, and the pairing guards. KILLED and SURVIVED are reported separately,
with reasons, in `STATUS-L3.md`.

## Digest

The new module is not imported by the TS backend closure listed in `compute/kernel-digest.ts`. The exact guard
reports the closure unchanged. If that changes, the digest is regenerated in a separate `chore: regen digest`
commit. `src/compute/kernel-digest.ts` is never hand-edited.

## Known limits (v1)

- No cross field and no integer grid. Pairing uses face geometry only; the output is a pairing of existing triangles.
- Unpaired triangles remain triangles. Quad coverage is not guaranteed.
- Only sharp, flagged and constraint-named edges are protected. An unconstrained feature that pairing cuts is not
  protected unless it is sharp.
- Constraint protection tests only endpoints and midpoint per edge, so an edge can be protected while part of it
  deviates from the polyline. The post-pairing check still catches a deviation above tolerance.
- Feature deviation is brute force over output edges (no spatial grid).
- Crease sharpness is not modeled (no semi-sharp values in v1).
- Not wired into `Model` in v1: the entry is the kernel function `quadRemesh` in `src/quad/`.
- Method section numbers are cited from the papers' structure and not re-verified against the PDFs in this lane.

## M4 Instant Meshes status: prototype (stopped)

M4 (position field and extraction) stops at **prototype**. The open-edge gate was not met: lumpy-sphere-tri
still has 630 open edges (threshold to pass: clearly below 630). Probe evidence: after the main face trace,
lumpy has 387 unused directed links whose open loops are long (24, 30, 43, 280 edges). Short-hole filling
therefore cannot close them; the defect is links the position field never produced. A hole-fill walk was
tried and was a no-op (identical output), so it was reverted.

Four-model table (`examples/instant-meshes/run.ts`, `_scratch/qfield-evidence/m4-metrics/summary.json`):

| model | quads | open edges | covered area | faces >4 edges (split) | traced | inverted | degenerate |
|:--|--:|--:|--:|--:|--:|--:|--:|
| lumpy-sphere-tri | 310 | 630 | 0.39 | 31 | 116 | 38 | 3 |
| chamfer-box | 229 | 414 | 0.95 | 11 | 88 | 17 | 2 |
| bracket | 15 | 30 | 0.04 | 3 | 3 | 4 | 2 |
| flanged-tee | 325 | 666 | 0.72 | 31 | 47 | 56 | 6 |

"Covered area" is quad area divided by input triangle area, a proxy for the expected-cell metric. A true
lattice-cell count is not implemented. Instant Meshes baselines are not available, so the M4 bound
(within 1.5x of baseline singularities) is not evaluated.

Known limits of M4 as it stands:
- Missing links: the position field does not connect every unit-offset neighbour pair, so open loops are long.
- Inverted and degenerate quads remain on every model.
- Crease-aware orientation and smoothing were not started.

## M5 integer-map quad extraction: bounded prototype

`src/quad/flow-extract.ts` reconstructs a global integer vertex coordinate from the closed edge offsets, fails closed if any cycle disagrees, and emits each source triangle pair that exactly spans one unit lattice cell. This deliberately does not fill missing cells or synthesize vertices. Results on the six closed aligned-field fixtures and the known torus rejection are in the selected output directory's `metrics.json`; renders are in its `renders/` directory. Those aligned fields are self-generated fixtures, not an Instant Meshes PositionField evaluation.

| model | quads | open edges | inverted/folded | degenerate | area ratio | sampled Hausdorff max |
|:--|--:|--:|--:|--:|--:|--:|
| sphere | 19 | 66 | 0 | 0 | 0.062 | 0.474 |
| lumpy-sphere | 9 | 34 | 0 | 0 | 0.016 | 0.612 |
| chamfer-box | 19 | 60 | 0 | 0 | 0.090 | 0.476 |
| bracket | 4 | 12 | 0 | 0 | 0.108 | 0.073 |
| flanged-tee | 6 | 24 | 1 | 0 | 0.013 | 1.051 |
| torus (aligned field) | rejected | n/a | n/a | n/a | n/a | n/a |

The Hausdorff-like metric is symmetric and sampled (details, sample count and spacing are written per case in `metrics.json`). The low area coverage is a clear prototype limitation: only existing input triangle pairs exactly aligned with complete lattice cells are emitted; this is not a complete surface remesher. Valence-3/5 are reported among interior extracted vertices; none appear in these small partial networks. The flanged tee has one inverted/folded quad and remains visibly unqualified.

Torus work is intentionally deferred. The actual M4 torus flow still reaches `integer-flow-capacity-limit`; separately, even the aligned synthetic torus can have zero reported face charge while its edge offsets fail global cycle consistency (the current reproducer reports edge `24:26`). Before torus extraction, revisit joint per-face position ranks and the signed edge-variable mapping from the QuadriFlow constraint construction; zero local face charge alone does not establish one global integer vertex map.

## M6 patch layout: skeleton status

`src/quad/patch-layout.ts` cuts a triangle mesh along its feature graph (dihedral > 30 degrees, trig-free
test by normal dot product), extends each dangling feature end by a shortest vertex path to the cut
network (the separatrix-style step, simplified), and labels patches as triangle components. Feature-graph
vertices with degree other than two are corners. Driver: `examples/patch-layout/run.ts`; renders in
`_scratch/qfield-evidence/m6/`.

| model | triangles | patches | feature edges | corners | feature coverage |
|:--|--:|--:|--:|--:|--:|
| cylinder-24 (closed) | 96 | 3 | 48 | 0 | 1.00 |
| chamfer-box | 424 | 26 | 144 | 24 | 1.00 |
| bracket | 100 | 25 | 69 | 38 | 1.00 |

Limits of the skeleton, stated plainly:
- Feature coverage is 1.0 by construction for the cut graph, and the gate counts an edge as covered when its
  two sides lie in different patches. Dangling ends were 6 percent uncovered on the bracket before the
  extension step.
- Singularities come from the feature graph only. Smooth-region singularities that a cross field would
  produce are not detected, and no separatrices are traced through smooth areas.
- The chamfer box yields many single-triangle patches from the one-segment bevel. Patch merging or
  quantization (the integer side-count step) is not implemented.
- The render legend "singular N" is the renderer's valence count on triangles, not this layout's corners.
- QuadWild baseline comparison and the M6 bound (singularities <= M5) are not evaluated.

## M6 field-driven separatrices: negative result

Status: stopped at time-box, not merged. The layout stays feature-only. The attempted tracer is saved as
`_scratch/qfield-evidence/m6/field-tracer-attempt.patch` (uncommitted, not on any branch).

What was tried, in order:

- **Spoke over-generation.** Starting one trace per incident face of each cross-field singularity produced
  spokes from the cap centre to rim vertices instead of field lines (cylinder: 41 separatrix edges, all
  spokes; patch count rose from 3 to 38).
- **Vertex-alignment walk.** Stepping to the neighbour best aligned with the carried direction zig-zagged
  and stopped after one step, because the carried direction was radial while the next wall edge is axial.
- **Segment-triangle crossing walk.** Exit edge chosen by side-of-ray tests, direction snapped to the nearest
  RoSy rotation per face. Zero-side rays along triangle edges were tie-broken as positive.
- **Wall continuation.** Every committed path must reach another singularity (or stop on a feature edge);
  walks from the cap centres exit the cap and stop at the first rim edge, which is a feature edge. Result on
  the cylinder: 0 separatrix edges, so the field-driven layout equals the feature-only layout there.

Numbers from the last full five-model run of the first tracer (before the rewrites; not re-measured on the
final tracer):

| model | feature-only patches / not-four | field-driven patches / not-four | separatrix edges | singularities |
|:--|:--|:--|--:|--:|
| cylinder-24 | 3 / 3 | 38 / 38 | 41 | 2 |
| chamfer-box | 26 / 8 | 30 / 12 | 16 | 8 |
| bracket | 25 / 7 | 34 / 15 | 20 | 34 |
| flanged-tee | 9 / 9 | 76 / 56 | 122 | 7 |
| lumpy | 1 / 1 | 104 / 31 | 420 | 8 |

Gate (cylinder and chamfer-box patch counts <= feature-only, patchesNotFour not worse on any model) fails
on every model, so the field-driven option is not shipped.

Open question: a separatrix from a cap singularity must cross the feature rim edge at the cap-wall
transition, and the current cut model treats feature edges as hard stops. Either the walk must be allowed to
cross a feature edge there (and the patch-side bookkeeping must absorb it), or the cap-wall corner needs its
own handling before separatrices can be traced across it.

## Trimmed-face Blossom feasibility (negative result)

Scope: the B-rep trimmed-face quadrangulation (`src/brep/quad-trimmed.ts`, default `trimmed: 'blossom'`), not the EditMesh L3 pipeline above. Three faces fail with `no-perfect-matching` under the default path: housing base flange, housing top plate, box minus cylinder (box 2.6 x 1 x 1, cylinder r 0.3, h 3, quad size 0.25).

Diagnosis: the strict matching admits only convex quad pairs. The failing triangles are isolated (two non-convex neighbours, no convex one), so no perfect matching exists over the strict edge set.

| Attempt | Base flange | Top plate | Box minus cylinder |
|:--|:--|:--|:--|
| Minimum-angle refinement (`minAngle`, opt-in, #550) | still rejected | still rejected | still rejected |
| Fold-aware pairing (non-convex pairs as high cost) | no positive-sine candidate: 141 non-convex pairs, corner sine in [-0.3827, 0] | not measured | not measured |
| Uniform longest-edge midpoint split, 1 round | no-perfect-matching | no-perfect-matching | no-perfect-matching |
| Uniform longest-edge midpoint split, 2 rounds | matching-too-large | matching-too-large | no-perfect-matching |

The sleeve regresses from a matching quad mesh (956 quads, minSj 0.1423) to `no-perfect-matching` after one split round. Splitting interior edges does not give isolated triangles an admissible partner, and fold-aware pairing has no candidate with positive corner sine. Neither approach reaches `minSj > 0` with `foldedPairs = 0` on the three faces. The next step, if pursued, is a boundary-local Steiner strategy or a non-quad (triangle-tolerant) output mode.

Scale note: refinement thresholds (`size = 1`, `MIN_RADIUS`, `MIN_GAP`) are in metric units normalised by `faceMetric` to the face's target spacing. The output is scale-invariant (annulus at scales 100, 1 and 0.01 gives identical triangulations), so they are not absolute physical lengths.

## Patch grid: coarsen and hole-bridge negative result

Status: stopped at time-box, not merged. `src/quad/patch-grid.ts` (PR #562) stays the grid owner. No
coarsening or bridging code is on the branch.

Before numbers (patch grid over the feature-only layout, base `integration/v2`):

| Model | Patches | Gridded | Area covered | Quads | minScaledJ | Inverted | Unmeshed reasons |
|---|---|---|---|---|---|---|---|
| chamfer box | 26 | 6 | 72.2% | 32 | 1.000 | 0 | corners-3: 8, no-interior: 12 |
| box with boss | 8 | 5 | 73.2% | 20 | 1.000 | 0 | holed-boundary: 2, corners-0: 1 |
| bracket | 25 | 0 | 0.0% | 0 | n/a | 0 | no-interior: 20, holed-boundary: 3, corners-5: 2 |
| housing (box, boss, through-bore) | 9 | 4 | 46.3% | 6 | 1.000 | 0 | holed-boundary: 5 |

Rule (a), merge a no-interior or three-corner patch across a seam that is not a feature edge. Ceiling per
model, measured on the layout:

| Model | Patches with a non-feature seam | Unmeshed no-interior or corners-3 candidates | Holed patches |
|---|---|---|---|
| chamfer box | 0 | 0 | 0 |
| box with boss | 0 | 0 | 2 |
| bracket | 4 | 3 | 3 |
| housing | 0 | 0 | 5 |

Layout property that blocks it: `layoutPatches` cuts every seam that carries a feature edge, so the
chamfer, boss and housing patch graphs have no smooth seams to merge across. Only the bracket has any.

Rule (c), bridge a holed patch into four sub-patches. Measured loop structure: every holed patch has an
outer loop and one inner loop, and the loops share no vertex. Most holed patches have zero interior
vertices (all bracket holed patches, housing patches 3, 5, 8, boss patch 6). A bridge is a cut through
the patch interior, so with no interior vertices its only admissible cuts lie on the boundary and
degenerate. Interior room exists on housing 1 and 6 (4 and 8 vertices) and boss 0 (6 vertices), but
joinability was not shown. Bridging alone cannot lift the bracket above 0%, so the 20-point acceptance
was not reachable.

Next step, if pursued: a boundary-local Steiner strategy that inserts interior vertices into holed
patches before the cut, or a layout change that keeps smooth seams as merge candidates. Either changes
`layoutPatches` and needs its own design decision.
