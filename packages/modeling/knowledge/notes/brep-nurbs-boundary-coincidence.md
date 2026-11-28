# Approximate NURBS boundary coincidence (design note, doc-only)

> [!IMPORTANT]
> Status: design. No NURBS code is wired by this note. Implementation waits for the coordinator's
> confirmation after this note merges. The fail-closed rule is the invariant: a NURBS boolean that
> cannot prove its contact returns `model-partial` with a reason, never a solid that might be wrong.

## Scope

Owned here: boolean contact between an approximate NURBS face and a cylinder or plane when the
two boundaries coincide within approximation error (a fitted patch seated on a machined bore, a
NURBS skin flush with a plane). Not owned here: the SSI march itself (lane `ssi`, see
[coordination](#coordination-with-lane-ssi)) and the exact analytic coaxial path already in
`boolean.ts` (PR #583).

## Current state (verified in the tree at `a3dd6405`)

| Pair | Route today | Evidence |
|---|---|---|
| NURBS x plane | Routed through `nurbsAnalyticSection` (`src/brep/intersect-nurbs-analytic.ts`) | `boolean.ts` gate at the `nurbsPlane` check |
| NURBS x cylinder | Refused: `plane or cylinder faces` | `boolean.ts` gate: `nurbsPlane` is false for a cylinder |
| NURBS x NURBS | Refused, SSI `ssi-pair-unsupported` | `src/brep/ssi/types.ts` reason list |
| Coaxial analytic cylinders | Exact path (#583) | `coaxialContacts` in `boolean.ts` |

`surfaceDerivatives`, `surfacePoint` and `surfaceInverse` already evaluate NURBS
(`src/brep/surfaces.ts`), and `triangulateTrimmed` (`src/brep/tessellate-trimmed.ts`) consumes
parameter-space rings for any surface kind through the metric in `faceMetric`. So trimmed NURBS
faces can tessellate once their boundary rings exist. What is missing is the boundary itself.

## Tolerance model

Three numbers, one owner each. Do not reuse the boolean `tol` for SSI accuracy.

1. **Marching accuracy (SSI owns).** `SsiOptions.tol` (default 1e-7) bounds every marched point
   within `tol / 100` of both surfaces. Each branch carries `bound`: the largest sampled distance of
   the fitted `curve` from either surface, widened by 1.25. This is the only error source the
   boolean may read. It is the receipt.
2. **Coincidence threshold (boolean owns).** A NURBS boundary coincides with a cylinder or plane when
   every sampled point of the boundary is within `c = max(tol, 4 * bound)` of the other surface.
   Using `4 * bound` keeps the decision above the fit error (the bound already includes the 1.25
   widening, so this is a safety factor of 4 over the measured error). `tol` is the floor, so an
   exact analytic face never gets a looser test than today.
3. **Snapping (boolean owns, never widens).** Two boundary points merge only when they are within `c`.
   Points that merge keep one vertex. Nothing moves geometry, so the tolerance never grows silently
   (matching the rule in `knowledge/watertight-tolerance.md`). If merging would move a vertex by more
   than `c`, the pair fails closed.

Why not a single global tolerance: `tol` is an analytic SSI accuracy setting. The NURBS fit error is
data-dependent, so the threshold must come from the branch's own `bound`.

## Bounding-box prefilter (NURBS x cylinder)

Before any SSI call, reject unrelated pairs cheaply:

- Compute each NURBS face's control-net bounding box, inflated by `tol / 100`. This is the SSI
  marching accuracy (`SsiOptions.tol / 100`), the only error that applies before any branch exists.
- Compute the cylinder's finite bounding box from its bounded `v` extent and radius.
- If the boxes are disjoint, record no contact and continue. This keeps unrelated pairs out of the
  gate, so only pairs whose boxes overlap reach the march.

The prefilter is a necessary condition only. A pass still needs the march and the coincidence test.

## Section loops on both faces

When a NURBS face meets a cylinder along a seated boundary, each operand gets a section loop:

- **Cylinder side.** Its loop is a circle or the boundary's projection onto the cylinder `(theta, h)`
  domain. It is emitted as a `circleOnCylinder`-style pcurve when it is a circle, and as an SSI
  `onB` pcurve otherwise.
- **NURBS side.** Its loop is the SSI branch's `onA` pcurve. Each branch closes or ends on a boundary
  (`SsiEnd`); only `closed` loops are emitted as face loops. An open branch splits the face (below).

## Open sections split a face

If a branch ends at `boundary` rather than `closed`, the NURBS face is split along the open
section. The split is accepted only when both endpoints lie on the face's own boundary within
`c`. Otherwise it fails closed with `brep-ssi-unsupported`. Splitting uses the existing trim
machinery (`faceTrim`, `classifyOnFace`). It does not add a new trim representation.

## Fail-closed conditions

Return `model-partial` (with the reason stated in the message) when any holds:

- Any SSI branch ends `near-tangent`, `singular`, `step-limit`, or `boundary` with no matching
  endpoint on the face boundary (`ssi-near-tangent`, `ssi-singular`, `ssi-step-limit`, or
  `brep-ssi-unsupported`).
- `branch.bound > tol * 1e3`, meaning the fit is looser than the accuracy target. Treat it as
  `ssi-fit-tolerance`.
- A snapping merge would move a vertex more than `c`.
- The NURBS face is a trimmed or non-manifold NURBS face (not yet supported).
- The open-section split endpoints are not on the face boundary within `c`.
- Any `IntersectionPartial` with code `brep-ssi-coincident` and `gap === null` (no measurable gap).

Never emit a face from a partial result, and never drop a branch silently.

## What `boolean.ts` must change (later slices, not this PR)

1. Extend the `nurbsPlane` gate to a `nurbsCylinder` case that calls the new prefilter and then
   `nurbsAnalyticSection` with the cylinder as analytic face.
2. Thread the branch `bound` into the coincidence test instead of the global `tol`.
3. Emit section loops on both faces through the existing `Copier` and `keep`/`flip` path.
4. Keep the refusal branches (`plane or cylinder faces`, `ssi-pair-unsupported`) for every case not
   yet covered, so an unknown pair still refuses.

## Ordered slices and estimates

| # | Slice | Hours | Owner | Gate |
|:-:|---|:-:|---|---|
| 1 | Coincidence threshold and prefilter as pure functions with unit tests (no boolean wiring) | 3 | this lane | falsifiers F1, F2 |
| 2 | NURBS x cylinder: call SSI, closed loops only, fail-closed on open ends | 5 | this lane + ssi | F3, F4, F5 |
| 3 | Open section split on the NURBS face | 4 | this lane | F6 |
| 4 | Wire into `booleanSolids` and emit loops on both faces | 5 | this lane | F7 render + digest |
| 5 | Showcase: S-bend and transition joins (currently refused) | 3 | this lane | showcase count drops |

Estimate total about 20 hours, with separate PRs for each slice. Each slice self-merges pinned to its
tested SHA, per lane rules. Slice 1 has no boolean change and can run before ssi finishes.

## Falsifier tests (smallest set)

- **F1 (threshold):** a NURBS boundary offset from a cylinder by `2 * c` is not coincident; by
  `c / 2` it is. Expect the decision to flip between those.
- **F2 (prefilter):** two disjoint boxes (NURBS and cylinder far apart) do not call SSI; the call
  counter stays zero.
- **F3 (closed loop):** a NURBS patch seated on a cylinder with a closed section unions with volume
  matching the sum within a stated tolerance and `validate` ok.
- **F4 (fail closed, tangent):** a patch tangent to a cylinder returns `model-partial` with
  `ssi-tangent-contact`.
- **F5 (fail closed, fit):** a branch whose `bound` exceeds `tol * 1e3` returns `ssi-fit-tolerance`.
- **F6 (open section):** an open section with endpoints off the boundary refuses; with endpoints on
  the boundary it splits and validates.
- **F7 (render):** the fused render has no visible crack along the seat (checked by eye, saved under
  `_scratch/viz-out/brep-nurbs-seat/`).

## Coordination with lane ssi

Interface I need from ssi (to relay through main):

1. `SsiBranch.bound` stays populated for every returned branch, including closed ones (it already is;
   keep it as the receipt).
2. `SsiIssue.reason` keeps the exact reasons listed above; do not merge `ssi-near-tangent` into a
   generic code.
3. `IntersectionPartial.gap` is non-null for `brep-ssi-coincident` (the boolean needs a measurable
   gap to decide whether to refuse or accept).
4. NURBS x cylinder enters `intersectFaces` as NURBS first (the existing convention), so `onA` is
   always the NURBS pcurve.

The SSI side is relayed through the coordinator; this note does not claim ssi has agreed to items
1 to 4 until the coordinator confirms.

Falsifiers are a minimum. A failing F-test blocks its slice; it is never replaced by a weaker mock.
