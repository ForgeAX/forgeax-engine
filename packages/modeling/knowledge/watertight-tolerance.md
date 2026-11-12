# Watertightness and tolerance

A mesh is watertight when every edge is shared by exactly two faces (or is a deliberate
opening) and when the pieces of an assembly meet without cracks. In this kernel that splits
into three layers with different owners: topology (the half-edge structure never allows a
third face on an edge), geometry (gaps and overlaps measured in metres against a tolerance),
and delivery (what survives f32 export and LOD reduction). It matters most for assemblies of
separately built panels, for surfaces tessellated from NURBS patches, and before any LOD or
bake. The API owners are [`reference/validation.md`](../reference/validation.md)
(`validate`, the watertight report), [`reference/surfaces.md`](../reference/surfaces.md)
(`surface` seams), [`reference/booleans.md`](../reference/booleans.md) (cleanup and weld
helpers) and [`reference/export.md`](../reference/export.md) (`checkTopology`,
`lodTopologyReport`). Related: [uv-cuts-lowpoly.md](uv-cuts-lowpoly.md) for slivers and LODs.

## The tolerance is one number; know where it applies

The model has a single geometric tolerance in metres (`model({ tolerance })`, default 1e-5).
Coincidence tests, coplanarity, "touching" in validation and boolean classification all use
it. Considerations:

- Choose it from the smallest feature you must resolve, not from the machine epsilon. Too
  tight and rounding errors read as cracks; too loose and real gaps are welded away.
- Tolerance never grows silently. A gap you widen by moving geometry stays that wide; only
  an operation that moves vertices (weld, sew, snap) changes it, and each reports how far it
  moved. Treat any accumulated move as a budget you track by hand.
- Exact predicates (`orient2d`, `orient3d`) decide signs exactly, so orientation and
  crossing tests do not depend on tolerance; only the "close enough" tests do.

## Reading the watertight report

`m.validate({ watertight: true })` (or an options object: `open`, `radius` default 0.04 m,
`table`, `reference`) reports, per part (a `part:` tag, else the connected component), maximal
chains of **free** edges (one face) and **rim** edges (a shelled panel's skin against its
own inner, rim or flange wall, where a crack hides as two facing walls). Each `BoundaryChain`
carries `kind`, `part`, `edges`, `length`, `closed`, `at`, `bounds`, `gap` and `partner`. The
gap is the largest distance to the nearest facing chain within `radius`; `partner` names that
part, or is null when nothing faces it (a hole, not a seam).

Every chain is either designed or a defect. A chain is `designed` as `trim`, `shut-line`,
`clearance` or `open` when trim-tagged faces own at least half of its loop, when its part
carries a tag of a gap or clearance row in the `shutLines` table (or `table`) within reach of
the facing tag, or when the `open` selector names its edges. An undesigned chain is a
`mesh-open` error:

| `detail.check` | Meaning | Recovery (`repair`) |
|:--|:--|:--|
| `free-chain` | an open boundary on a part | `sew` when a `partner` exists, `fill` when not |
| `rim-chain` | a shelled panel's rim cracked against its own wall | close the wall or declare the opening |
| `cross-part` | two parts' chains face each other | declare a gap or clearance row, or sew |
| `uncovered` | a region of the reference surface has no skin near it | see coverage below |

Designed chains are `info`. T-junctions (a boundary vertex strictly inside another open edge,
within 0.2 percent of that edge's length, never less than the tolerance) are warn normally and
one error per part under `watertight`. A facing edge between `radius` and 1.5 x `radius` from
a partnerless chain is a `beyond-radius` info: widen `radius` if it is really a seam.

The decision for an artist is "is this opening intended?". If yes, say so in the model (a
trim tag, an `open` selector, a gap row), so the check passes for the right reason. If no, the
`repair` field names the family of fix.

## Repairing, from least to most invasive

| Situation | Tool | Notes |
|:--|:--|:--|
| T-junction crack along a boundary | `resolveTJunctions({ distance? })` | inserts boundary vertices on other boundary edges |
| Two facing boundary runs | `weldEdgeSequence(edges, { maxDistance? })` | stitches them, matching vertices by arc length |
| Coincident vertices | `weld` | fails `model-op-no-effect` (with the nearest distance in `detail.nearest`) if it merges nothing |
| Closed loop with nothing opposite | `fillHoles(edges, { material? })` | caps each boundary loop with one face |
| Coplanar fragments, collinear points | `cleanup.planar(faces?)` | merges into hole-free n-gons, drops collinear vertices |
| Needles and slivers | `cleanup.slivers(faces?, { width })` | keep widths at or below 2 mm |
| Voxel-level healing | `voxel.fillHoles`, `lowpoly` voxel union | rebuilds surface and loses labels and materials |

Sewing adds topology only; repair moves geometry; checking is a separate gate, so run
`validate` after each change rather than trusting the operation. A `weld` that finds nothing
is deliberately an error: the cure for "nothing merged" is to find out why the vertices are
farther apart than assumed, not to raise the distance until it does something.

## Coverage against a reference

When a skin is rebuilt from patches, "watertight" is not enough: it must also cover the
shape it replaces. `watertight.reference: { surface, tolerance, spacing }` samples the
reference every `spacing` (default 10 mm) and weighs each sample's distance to the skin.
`tolerance` is required because it bounds how far the reference itself sits from the
designed skin; measure that deviation and name it, rather than picking a convenient number.

- Resolution is limited: with the reference `d` off the skin, a hole narrower than about
  2 sqrt(tolerance^2 - d^2), or narrower than `spacing`, can pass.
- A sample is excused only when its closest skin point lies on a designed chain: gap and
  clearance rows excuse by their widest gap plus the edge round; `trim` and `open` chains
  excuse on the opening side, within the sphere around the chain's bounds grown by the
  tolerance plus edge round. An unexcused region is a `mesh-open` error with
  `detail.check: 'uncovered'` (with `area`, `maxDistance`, `at`, `bounds`, `part`); a fully
  excused region is info.
- `report.watertight.coverage` gives `samples`, `area`, p50/p95/max distance, `uncovered`
  and `excused` per reason. More than 4 million samples is `model-work-budget`; raise
  `spacing` or check by part.

## Surfaces: seams between patches

`m.surface({ patches, chord, angle, maxSegments, weld, sew, spacing, blends })` tessellates
NURBS patches and joins them edge by edge through a seam table. Patches whose sides lie
within the larger of `weld` and `snap` (snap defaults to a quarter of the chord) pair up;
the patch emitted first owns the seam, samples it once, and the other patch reuses those
vertex ids, so paired seams are watertight by construction. The seam's measured gap
classifies it:

| Gap | Result |
|:--|:--|
| within the model tolerance | valid, silent |
| within twice the tolerance, or within `sew` (capped at a tenth of the seam length) | sewn, with a `warn` naming the seam |
| larger | `model-precondition` (detail `seam`, `gap`, `at`, `limit`) |

Practical consequences: build adjacent patches from shared section data so their boundaries
coincide; do not raise `sew` to hide a patch that is really misplaced; two separate
`surface` calls never weld to each other, so a seam between them shows as `t-junction`.
The diagnostics list every seam as `{ a, sideA, b, sideB, gap, weldMove, weldAt? }`, with
`weldMove` the largest merge, so a creeping `weldMove` is the early warning. A trim or
imprint that crosses a patch side becomes a seam sample there, which keeps cut edges
watertight. Poles and closed seams weld within one patch; adjacent patches must agree on
orientation (`flip` reverses one). Gaps below the weld distance are collapsed by tessellation,
so sub-weld misalignment is invisible to the watertight report: check the patch inputs.

## Overlaps and designed contacts

A crack is a missing surface; an overlap is surplus surface. Both fail in different ways:

- `self-intersection` (confirmed or candidate) reports exact triangle contacts. Faces within
  tolerance of each other's planes count as coplanar; a coplanar overlap wider than the
  tolerance is confirmed.
- `shell-overlap` (`validate({ shells: { expected } })`) reports separately built shells that
  cross, the signature of appended instances that should have been unioned.
- `thin-wall` (`minThickness`; `detail.check: 'shell-clearance'`) reports walls that are too
  thin or shells that sit too close.
- Assemblies nest parts on purpose (a pin in a bore, a press fit). Declare them with
  `validate({ contacts: [{ parts: [a, b], kind: 'seat' | 'fit', tolerance }] })`: `seat` accepts
  penetration up to `tolerance` (default 1e-3 m); `fit` accepts none. `designed-contact`
  info lists every fit with its measured depth; it warns when a fit is exceeded.
- `mesh-inverted` flags a closed component with negative volume that nothing encloses;
  `face-flipped` flags a patch wound against its neighbours.

## Delivery: export and LODs

Geometry that is watertight in the editor can still open on the way out.

- Export positions are f32. `finish({ key, normals, checkTopology: true })` re-welds the
  source faces at distance 0 (bitwise-equal f32 positions) and reports
  `topology: { freeEdges, nonManifoldEdges, components }`, which is what a renderer-side
  re-weld of the exported buffer sees. A seam one f32 step apart is open; bitwise-equal
  duplicates are closed. Compare `freeEdges` with the openings you designed.
- A triangle that collapses or flips after rounding fails export unless it is thinner than 4
  f32 steps at its own coordinates; such a sliver of a valid face (small parts far from the
  origin) is dropped and counted in `report.slivers`. If the count surprises you, build the
  part nearer the origin and place it afterwards.
- Reduction can open seams: weld first, lock borders afterwards. `lodTopologyReport(lods)`
  returns `freeChains`, `nonManifoldEdges` and `boundarySetEqualsLod0` per LOD; a LOD passes
  with no non-manifold edge and a boundary set equal to LOD0's designed boundary. Welding
  counts bitwise-equal positions, so split normals and UVs stay closed.

## Gate evidence: what "pass" means

Validation results carry coverage: `checked` entries (code and subjects) and `unchecked`
entries with a reason (`missing-input`, `not-requested`, `unsupported`, `budget`). `pass`
requires no issue and a non-empty `checked`; unchecked entries never change `pass`, so read
them. A watertight claim with `watertight` not requested is not a claim. For naming stability
across parameter changes, `regen(job, paramSets)` reruns a build and compares its steps and
selector provenance, which is how to confirm that a repair keyed on `createdBy` or a tag
still finds its faces when a parameter moves.

## Runnable shape

```ts
import { model } from '@forgeax/engine-modeling';

const m = model({ tolerance: 1e-5 });
// ... build parts; tag each panel with part:<name>
const report = m.validate({
  watertight: { radius: 0.04 },          // add table / reference as needed
  shells: { expected: 1 },
  contacts: [{ parts: ['pin', 'lug'], kind: 'fit' }],
});
// report.issues: mesh-open { check, repair: 'sew' | 'fill' }, t-junction, shell-overlap ...
const out = m.finish({ key: 'asm', checkTopology: true });  // topology.freeEdges etc.
```

`examples/desk-lamp` and `examples/thin-vent` show finished sessions that pass these gates;
the `contacts` shape above is the one the validation reference documents for assemblies.
