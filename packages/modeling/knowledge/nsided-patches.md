# N-sided patches and corners

Part of the [`@forgeax/engine/modeling` knowledge notes](../README.md).

A four-sided NURBS patch cannot cover every place a surface needs to go. Where three, five or more
smooth surfaces meet, where three fillets meet at a vertex, or where a hole is bounded by an odd
number of sides, the surface needs an n-sided patch, or a layout that avoids one. This note covers
when that happens, what the kernel offers, what it enforces, and how to plan around the cases it
refuses.

Owners: [`../reference/detail.md`](../reference/detail.md) (setback corners, `nurbs.surface.fillN`,
`blendSurfaces`), [`../reference/surfaces.md`](../reference/surfaces.md) (patch layout, seams,
`measureEdge`, edge flow) and [`surface-quality.md`](surface-quality.md) (continuity levels and the
quality checks the result is judged by). Worked example:
[`../examples/blend-corner`](../examples/blend-corner) step `corner`.

Sections:

1. Where n-sided holes come from, and whether to avoid them
2. The tools: setback corner, `fillN`, and the layout-level alternatives
3. What `fillN` builds and measures
4. Setback corners in detail
5. Planning boundaries so the corner works
6. Failure codes and recovery
7. What it costs downstream (nets, edge flow, poles)
8. Judgements the tools do not make

## 1. Where n-sided holes come from

- **Three fillets at one vertex.** Three creases meeting at a box-like corner each get a rolling-ball
  blend; their ends do not meet. The gap bounded by the three blend ends and the three faces is a
  six-sided hole in the faces' own isoparms (face isoparm, blend end section, face isoparm, ...),
  which the corner fills.
- **A vertex of valence 3, 5 or more** where surfaces meet smoothly. With four patches around a
  point the layout is regular; with three or five the surfaces cannot simply be matched pairwise.
- **A hole bounded by trims or openings** that do not form four sides.
- **A tapered tip** where two sides of a quad collapse: do not build this as a degenerate patch.

Whether to accept an n-sided patch is a layout decision. Fewer is better: each one is a place where
the flow of isoparms (and thus the edge flow of the exported mesh) turns. Where the design allows, a
different layout removes the hole: split a primary exactly at a station (`nurbs.surface.split`) so a
three-way meeting becomes a regular four-way one, move a feature line so two creases do not end on
the same vertex, or run a blend out to zero before the corner (a run-out). Where it does not allow
it, an n-sided fill with a measured result is the sound choice, not a distorted four-sided patch.

## 2. The tools

| Need | Tool | Notes |
|:--|:--|:--|
| Three or more blends meeting at one vertex | `corners: [{ blends, setback, continuity?, name? }]` in `m.surface({ patches, blends, corners })` (also in `patchLayout({ corners })`) | Builds the blends, splits the faces, fills the hole; `SurfaceCorner` in `src/blend.ts` |
| A hole bounded by 3 to 8 patch sides or curves | `nurbs.surface.fillN({ boundaries, continuity?, tolerance? })` | Returns quads, residuals, `normalSpread` |
| A fillet that must end before a vertex | blend radius stations ending at 0 (run-out) | Keep the crease as a `G0` feature line; see [`surface-quality.md`](surface-quality.md) |
| Several patches meeting along one side (the T-junction case) | a layout side `{ to: [...], continuity }` listing several partners | A side shared with several patches is matched part by part against the exact piece of the master beside it |
| Splitting a side so that partners line up | `nurbs.surface.split(s, dir, t)` | Exact: both halves are one polynomial on the original parameters |
| Reading how well an edge closed | `nurbs.measureEdge(a, sideA, b, sideB)` and `FillResidual` | gap, kink, curvature jump, rate jump |

There is no T-spline or local-refinement surface type. T-junctions are avoided by a layout that
splits both neighbours, or by the multi-partner side declaration above.

## 3. What `fillN` builds and measures

`nurbs.surface.fillN({ boundaries, continuity?, tolerance? })` fills a hole of n sides, 3 to 8, in
loop order. Each side is:

- `{ surface, side, range? }`: a patch side (`'u0' | 'u1' | 'v0' | 'v1'`), optionally a normalized
  sub-range; the neighbour's normals and curvature are the continuity target.
- an array of consecutive pieces joined G1 (for example face isoparm, blend end section, face
  isoparm); a piece may run either way, each must end where the next begins.
- `{ curve }`: a bare curve, G0 only.

The method is the midpoint scheme: the center O sits on the loop's normal, and n quads
`[O, e(k-1), c(k), e(k)]` join the side midpoints `e` and hole corners `c`. All quads are fit as
one fair surface under penalty rows for the continuity to the neighbours, so the spokes between quads
close around O instead of being matched pairwise. Spans grow until every G1 angle is at most 0.1
degrees. `continuity` is `'G1'` (default) or `'G2'` along the outer sides; the interior spokes and
the center are G1 by design. `'G0'` ignores the neighbours' tangents.

The result carries:

- `patches`: the n quads, normals oriented with the neighbours.
- `residual`: a `FillResidual` per outer side and spoke (`edge: 'side' | 'spoke'`, `index`, and the
  `measureEdge` fields gap, angle, curvature jump).
- `normalSpread`: the worst angle between a quad normal and the boundary-oriented reference
  (the bilinear blend of the normals at the quad corners), on a 41 x 41 grid per quad, in degrees.
  A spread near 90 or above means the quad turned over.

```ts
// from src/__tests__/surface-fill.unit.test.ts (shape of the call)
const r = nurbs.surface.fillN({ boundaries: [ /* 3..8 sides in loop order */ ], continuity: 'G1' });
if (!r.ok) throw r.error;                       // model-degenerate or model-precondition
const worstSide = Math.max(...r.value.residual.filter((x) => x.edge === 'side').map((x) => x.angle));
// worstSide <= 0.1 degrees, r.value.normalSpread < 90
```

A planar regular polygon is filled exactly in its plane; a sphere octant between three cylinders
shows neither bulge nor flat spot. These are the checks to imitate when a boundary set is unusual:
fill it, then look at the residual and the spread before using it.

## 4. Setback corners

For fillets, use the corner rather than calling `fillN` by hand; it prepares the boundaries.

```ts
// examples/blend-corner/body.ts (buildCorner), trimmed: three planar faces, three G2 rolls
m.surface({
  patches: cornerFaces(),            // 'tail', 'side', 'deck'
  blends: [
    { between: ['tail', 'side'], radius: 0.012, continuity: 'G2', name: 'tail-side' },
    { between: ['side', 'deck'], radius: 0.012, continuity: 'G2', name: 'edge' },
    { between: ['deck', 'tail'], radius: 0.012, continuity: 'G2', name: 'tail-deck' },
  ],
  corners: [{ blends: ['tail-side', 'edge', 'tail-deck'], setback: 0.006, continuity: 'G2', name: 'corner' }],
  chord: 0.0002, weld: 5e-5, tag: 'tail',
});
```

What the corner does, in order:

1. Splits each face at the isoparm `setback + contact width` from the vertex, where contact width is
   `r cot(opening / 2)` for the widest blend of the corner. The strips are exact pieces of the face.
2. Blends each strip with the unchanged `blendSurfaces` (each blend keeps its own options).
3. Trims the contact regions and the corner square from each face; the face keeps its own surface.
4. Fills the hole with `fillN`: one quad per side (`${name}-${k}`, default `corner`), tagged
   `transition: { kind: 'corner', continuity }`.

Requirements the kernel states: n at least 3 blends, each with a unique `name` and a constant
radius, cycling through faces around one vertex. Corners resolve before plain blends.

Continuity: the quads meet faces and blends at `continuity` (default `'G1'`). The spokes between
quads and the center are G1 by design; for a corner quad pair the layout and quality checks require
exactly G1, so a G2 validation does not flag the spokes while a real break still fails.

The `info` diagnostic lists, per corner, the split distance, the face/blend end kink and the fill
residuals (`sideAngle`, `spokeAngle`, `normalSpread`, `gap`). The example's test holds the closed
corner to 0.1 degrees on sides and spokes, normal spread below 90 degrees, and a 1e-6 m gap. Read
that diagnostic rather than trusting the picture.

Choosing `setback`: a larger value gives the hole more room (a rounder, more evenly proportioned
fill) and pushes the faces' exact strips further from the vertex; it must stay inside the face. Zero
or negative is refused. A very small setback leaves a thin, nearly three-sided hole, which is where
folds happen.

## 5. Planning boundaries so the corner works

- **Isoparms orthogonal to the blended edge.** The face isoparm used as the hole side must lie in
  the normal plane of the blended edge, within 1 degree; the end kink of the blend is then about twice
  the tilt. If the faces' own isoparms meet the crease at an angle (a skewed loft), the corner is
  refused with a `tilt` and `kink` in its detail. Rebuild the faces so their section lines cross the
  crease squarely, or use planar stand-in faces at the corner and keep the real faces away from it.
- **Same radius, comparable widths.** A corner between a 3 mm and a 12 mm roll has a lopsided hole;
  step radii down before the corner with a run-out rather than inside it.
- **Contact width plus setback must fit.** If `width + setback` reaches the face's side, the corner is
  refused (`model-precondition` with `{ face, radius, setback, width }`) before splitting. Reduce the
  radius or the setback, or enlarge the face.
- **Neighbours must agree at the hole corners.** The normals of two neighbouring boundary pieces at
  the point they share need to agree (G1 between them). `cornerMismatch` in an error lists those
  angles; a large one means the faces themselves are not G1 at the corner.
- **Aspect of the hole.** The midpoint scheme needs a hole that is not extremely thin: a 1:6 triangle
  fills; a thinner one folds. Split the hole, or widen the short side, rather than forcing it.
- **Valence and poles.** An n-sided fill puts a pole of valence n at O in the exported mesh. Place
  the corner where that pole is acceptable (a hidden or low-curvature region), and keep it away from
  the sweep of a highlight line.

## 6. Failure codes and recovery

| Code and detail | Meaning | Recovery |
|:--|:--|:--|
| `model-invalid-argument` | setback at or below 0; fewer than 3 blends; fewer than 3 or more than 8 sides; duplicate blend names; options not finite | correct the argument; a zero setback leaves a degenerate three-sided corner |
| `model-precondition` `{ face, radius, setback, width }` | the blend contact plus setback reaches a face side | smaller radius or setback, larger face |
| `model-precondition` `{ tilt, kink }` | a face isoparm is more than 1 degree off the blended edge's normal plane | rebuild the face or use a planar stand-in at the corner |
| `model-precondition` (blends do not cycle) | the named blends do not meet around one vertex through consecutive faces | check the `between` pairs and names |
| `model-precondition` (boundary pieces) | a piece does not start where the previous ends, or the loop does not close within `tolerance` | order the sides around the hole; raise `tolerance` only for a real rounding gap |
| `model-precondition` with residuals and `cornerMismatch` | after the last span increase a G1 angle is still above 0.1 degrees | if `cornerMismatch` is large the neighbours disagree at the corners: make them G1; otherwise request `'G1'` instead of `'G2'`, or split the hole |
| `model-degenerate` `{ quad, angle, point, u, v }` | a quad folds against the boundary orientation (spread above 90 degrees) | the hole is too thin: split it into better-proportioned holes or widen its short side |

Fill errors raised inside a corner carry the corner index.

## 7. What it costs downstream

- **Control nets.** G2 quads are biquintic 10 x 10 nets, which exceeds the default `maxNet` [8, 6]:
  `surface-density` flags them. A G1 corner has smaller nets. Either accept the finding on the
  corner quads (they are a transition role) or use G1 when the corner is small.
- **Fairness.** Corner quads typically report `surface-fairness`: the curvature goes from the blend
  arc into the flat face piece within one isoparm. The zebra and the continuity numbers are the
  evidence that matters there; do not distort the quad to silence this check.
- **Edge flow.** The quads are `corner` transition patches whose faces are tagged `support`, so the
  shape limits of `checkEdgeFlow` skip them. The pole at O is counted under `poles` (info).
- **Seams.** The corner is built inside one `m.surface` call, so all joins weld; building the
  fillet pieces in separate calls leaves `t-junction`.

## 8. Judgements the tools do not make

- Whether an n-sided patch is the right answer, versus re-planning the layout so one is not needed.
- Where the pole should sit relative to the visible highlight flow.
- Whether a corner reads as a deliberate design detail: radii stepping, setback relative to radius
  and the way the three rolls meet are visual decisions; the tools only guarantee the closed numbers
  (gap, 0.1 degree angles, no fold).
- Per-edge setback: `setback` is one scalar for the whole corner.
