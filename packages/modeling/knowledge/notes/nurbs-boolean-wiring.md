# NURBS boolean wiring: design note (not implemented)

Time-boxed. Scope: how SSI branches and `joinBranches` chains plug into `booleanSolids`
for NURBS x analytic and NURBS x NURBS faces, and what stays fail-closed. Read-only survey of
trunk at 14699bb4 plus the coordinator's #609 hygiene merge.

## Current state (measured from source)

| Stage | Owner | Today |
|---|---|---|
| Face pair dispatch | `src/brep/boolean.ts` `booleanSolids` (~L606-760) | NURBS enters only against a plane (`nurbsPlane`). NURBS x cylinder and NURBS x NURBS return `brep-ssi-unsupported` |
| Pair intersection | `intersectSurfaces` (`src/brep/intersect.ts` L187) | Dispatches NURBS x analytic to `nurbsAnalyticSection` (L225-227); NURBS x NURBS to `nurbsNurbsSection` (`intersect-nurbs-nurbs.ts`) |
| Marching | `src/brep/ssi/intersect-faces.ts` `intersectFaces` (L256), `march`, `fitBranch` | Yields `SsiBranch` with `closed`, `ends`, `bound` |
| Section conversion | `sectionFromSsi` (`intersect-nurbs-analytic.ts` L142) | Builds the `IntersectionBranch` list used by the boolean |
| Chain closure | `joinBranches(branches, eps)` (`src/brep/query/stitch.ts` L114) | Pairs open ends within eps; reasons gap-over-tol / junction / boundary / open |
| Trim loops | `trim-span.ts` `cutBranch`, `planar-split.ts`, `trim-face.ts` `faceTrim` | Planar and cylinder faces split by cut branches; NURBS trim is not wired |
| Face classification | `classifyOnFace` (`trim-face.ts` L265) + ray parity (`boolean.ts` `insideSolid`) | Used for in/out/on of pieces |

Known open cut: the transition-torus chains (CHAIN-CLOSURE.md) are 0 closed of 8. 12 ends are
model seams (1e-2 gap), 4 are rim-only contacts, and the 5/14 pairs are now measured (see #609).
These give the fail-closed classes the wiring must keep.

## Design

1. Accept NURBS x analytic in `booleanSolids` only through a chain-level route. For each cut
   surface pair, collect `sectionFromSsi` branches, run `joinBranches(eps)`, and require every
   chain to be `closed` with no `ends` reason other than `junction` (paired). Anything else fails
   closed with `brep-ssi-unsupported`, with the reason in `detail`.
2. Closed chains become trim loops by the existing `cutBranch` path. The NURBS face gets a
   parameter-space loop (pcurve per branch via `branchPCurvePoint`), and in/out is decided by
   `classifyOnFace` in the NURBS face's own UV trim. Open chains that reach the face boundary
   (`boundary` reason) split the face the same way as planar cut lines.
3. Keep fail-closed: NURBS x NURBS stays refused until step 5. Any chain with `gap-over-tol` is
   refused, never bridged. Tangent or coincident pairs keep their existing `partial.code` refusal.
4. Face splitting for NURBS uses the planar split owner, so plane and NURBS share one split
   contract. The trim routine is not duplicated.

## Ordered slices

| # | Slice | Gate | Rendered example |
|---|---|---|---|
| S1 | Chain-level acceptance for NURBS x plane. Measured on 14699bb4 + #610: 16 face-by-plane rows (sweep stub and loft flange, 2 planes each). 12 rows have chains; all chain ends reach `boundary`, 0 `gap-over-tol`, 0 `junction`, 0 closed chains. 4 rows are faces the plane misses. Gate: chain ends all `boundary`, no gap or junction. | unit: chain-closure on the sweep stub and loft flange cuts (test to be added in slice 1 PR) | `_scratch/viz-out/nurbs-boolean/s1-chains.png` (not yet rendered) |
| S2 | NURBS x plane trim loops for a sweep stub union plate | union volume within 1e-3 of analytic; 60-frame smoke not needed (no Engine change) | `s2-sweep-stub-union-plate.png` |
| S3 | Loft elbow union flange (NURBS x plane, two planes) | same volume gate; fail-closed on a gap chain | `s3-loft-elbow-flange.png` |
| S4 | NURBS x analytic cylinder: chains from `nurbsAnalyticSection`, fail-closed on any gap-over-tol | unit + refusal test | `s4-nurbs-cylinder-hole.png` |
| S5 | NURBS x NURBS: needs `nurbsNurbsSection` closed chains and a two-sided trim | design review first; not before S1-S4 are green | `s5-nurbs-nurbs.png` (deferred) |

Each slice is a separate PR. Render paths are targets; none are produced yet.

## Hooks needed from e1 (boolean.ts owner)

- A chain-level entry point in `booleanSolids` that accepts a `joinBranches` result instead of raw
  `SsiBranch` (so the NURBS route does not re-derive chain logic).
- A way to route NURBS trim loops into `planar-split.ts` without e1 changing planar behaviour
  (so plane x NURBS shares the planar owner).
- Permission to relax the `nurbsPlane` refusal only behind a feature gate per slice, so S4 and S5 do
  not reopen the plane path.
- The `coplanar` and `sameSideAbsorbed` logic at L528-546 must stay untouched for NURBS faces.

## Trunk status for the union (measured)

Both unions still fail: `booleanSolids(stub, plate, union)` and `booleanSolids(flange, cube, union)` return `brep-ssi-unsupported` with "a cylinder in the index" at boolean.ts L810. The plane-vs-non-plane branch assumes the non-plane face is a cylinder, so a NURBS face has no lateral entry and is refused, even though the pair dispatch at L708 admits it. S2 and S3 therefore need the NURBS cut kind added, not only the gate change.

## Not in scope

No code change. No digest change. No change to boolean.ts. The note lists hooks only.
