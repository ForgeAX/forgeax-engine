# M-QF7 design note: user guide curves as feature constraints

> [!IMPORTANT]
> Design note only. No code is proposed for merge until the coordinator confirms. Status of the claims below:
> **[C]** read in the current source, **[P]** proposal.

## 1. Why, and what exists today

Today a quad layout is driven only by facts the B-rep already holds: trim loops, sharp edges, G1 chains
(`deriveFeatureConstraints`, `src/brep/feature-constraints.ts`) **[C]**. Two gaps matter for guides:

1. `deriveFeatureConstraints` has no consumer yet: only its own unit test calls it. `quadrangulate` builds
   counts through `edgeCounts` and lays out faces through `layoutFace`; neither reads a `FeatureConstraintSet` **[C]**.
   M-QF7 therefore cannot land before one consumer reads the set (the M-QF2 re-pointing step in the research doc).
2. The row front (`rowFrontInner`, `quad-row.ts`) takes only rings (`TrimRing {uv, ids}`) and offsets every ring
   inward by a fixed depth. Nothing outside a ring can request a row. The iso layout
   (`quad-iso-quadric.ts`) lays a far-field iso grid and carves one block per hole; the grid axes are fixed by the
   surface chart **[C]**.

A guide is the smallest user input that fills the gap: "run a row of quads along this curve on this face".
The plate-hole gap that PR #625 measured (`rowOnly = 0.20` under `quad-dominant`) is not a guide-curve item: PR #627
closes it with `isoQuadric` on holed planes (`rowOnly = 1.00`, 0 triangles, rectangular outers only). The M-QF7
example therefore uses a curve that is **not** a trim loop, and iso planes (section 4.2) now apply to planes too.

## 2. Inputs **[P]**

```ts
interface GuideCurve {
  readonly id: string;                 // user-chosen, unique; becomes part of the constraint id
  readonly face: number;               // B-rep face the guide lies on
  readonly uv: readonly P2[];          // polyline in the face's (u,v), at least 2 points, in order
  readonly closed?: boolean;           // default false
  readonly hard?: boolean;             // default true: unmet -> fail closed
}
quadrangulate(shape, { ..., guides?: readonly GuideCurve[] })
```

Decisions and the reason for each:

- **uv polyline, one face per guide.** A guide in (u,v) needs no projection and no tolerance policy; a 3D curve
  would need a projection whose failure modes (`guide-off-face`) would then sit inside the kernel. A helper that
  projects a 3D polyline onto a face can live outside the kernel as a recipe.
- **No strength or influence radius.** Only "a row runs here". A soft density hint is a different feature
  (sizing field) and would add a second concept.
- **One kind.** A guide yields `align-tangent` only. `even-count` and `continue-across` stay derived from the B-rep.
  Cross-face guides are out of scope: they would need `continue-across` plus edge splitting.

## 3. From guide to `FeatureConstraintSet` **[P]**

The set stays closed in `kind`; only `ConstraintOrigin` grows by `'guide'` (informational, no consumer switches on
it, per the file header). A guide becomes:

```
{ id: 'align-tangent:guide:<guide.id>', kind: 'align-tangent', origin: 'guide',
  edges: [], faces: [guide.face], hard: guide.hard ?? true }
```

`edges` is empty because a guide is not a B-rep edge. That breaks the stated invariant "every consumer samples these
edges once and publishes the same mesh ids to every face in `edges`". Two ways to resolve it:

| Option | Change | Concepts added |
|:--|:--|--:|
| A. Add optional `curve?: readonly P2[]` to `FeatureConstraint`, `edges` empty for guides | one field | 1 |
| B. Split the guide at the face boundary, insert it as real B-rep edges | edge insertion in `Shape`; touches files this lane does not own | 3+ |

Recommendation: **A**. A guide that never leaves its face needs no shared mesh ids, so ring-id sharing does not apply.
Guides that end on a boundary edge are accepted only when the end lies on an existing sample (see
`guide-end-off-sample`); otherwise the neighbouring face would see an unmatched T vertex.

## 4. How the layouts consume it **[P]**

### 4.1 Row front (trimmed planar faces)

`rowFrontInner(rings)` gets a second input `guides: readonly P2[][]` (already in the face's uv). The guide is treated as
a degenerate ring that is *two-sided*:

1. Resample the guide to the face's target spacing, so its points are the "boundary" of a slit of zero width.
2. Offset it to both sides by `ROW_DEPTH * shortest` (same depth rule as rings, same `ROW_CLEAR` and `WEB_SHARE`
   checks against every other ring and guide).
3. The slit is a ring after the offset (left side up, right side back down, end caps by the miter rule already used
   for ring corners); the CDT of the interior then sees the guide as one more hole, whose inner ring is the two offset
   sides. Row quads are emitted between the guide polyline and each side.
4. The guide polyline vertices are real mesh vertices shared by the two row strips, so the guide appears as a mesh
   feature line (aligned edge sequence).

The interior triangulation and matching stay unchanged; guides only add rings.

### 4.2 Iso layout (holed faces: quadrics and, since #627, rectangular planes)

The iso grid axes come from the chart, so a guide can be honoured exactly in two cases only:

- the guide runs along a grid line (constant u or constant v within `1e-9`): snap the nearest grid line to it
  (one extra row position in the existing 1D position list), no new structure;
- the guide is a closed loop inside the far field: treat it like a hole whose block is a rectangle around it (the
  existing carve-and-annulus path), with the guide as the block's inner ring.

Any other guide direction fails closed with `guide-not-iso-aligned`. We do not shear or rotate the grid: that would
change the far-field cells and break the minSJ floor that PR #622 established (`STRIP_MIN_SINE = 0.3`).

## 5. Fail-closed reasons **[P]**

All surface as `brep-face-unsupported` with `detail.reason`, so `src/errors.ts` is untouched:

| reason | Invariant it protects |
|:--|:--|
| `guide-off-face` | every guide uv point lies inside the face's trimmed domain (point-in-loop test) |
| `guide-degenerate` | at least 2 distinct points; no segment shorter than `1e-9` of the face extent |
| `guide-self-crossing` | a guide polyline does not cross itself, any ring, or another guide |
| `guide-crosses-hole` | a guide does not enter a hole's offset zone (it would collide with that ring's row) |
| `guide-end-off-sample` | a guide end on the boundary coincides with an existing edge sample id |
| `guide-parity` | the strip pair around a guide keeps the face's total sample count even |
| `guide-conflicts-row` | `ROW_CLEAR` / `WEB_SHARE` checks pass with the guide ring added |
| `guide-not-iso-aligned` | (iso only) the guide lies on a grid line or is a closed block-able loop |

A `hard: false` guide that hits one of these is dropped and recorded in the result (`featureReport` entry
`unmet`), never silently ignored.

## 6. Tests that can fail **[P]**

Each test names the deliberate break that must turn it red.

| # | Test | Red today because | Deliberate break |
|:-:|:--|:--|:--|
| 1 | Plate 3x3x1 with a hole plus a straight guide across the face: the mesh contains a chain of edges within `1e-9` of the guide, every quad touching it has a guide edge, and total `minSJ >= 0.3` | `guides` option does not exist; no chain | drop the guide ring in `rowFrontInner` |
| 2 | Same plate, guide offset sides: quads on both sides are present (strip count = 2 x guide segments) | no strips | offset only one side |
| 3 | Guide outside the face -> `guide-off-face`; guide crossing the hole's zone -> `guide-crosses-hole`; one test per reason in the table | no reasons | replace one check by `true` |
| 4 | `hard: false` guide that hits `guide-conflicts-row` returns ok and a `featureReport` entry marked `unmet` | no report | make `hard` default to true |
| 5 | Determinism: guide ids order does not change the mesh (run with the guides permuted) | n/a | sort by array index instead of id |
| 6 | Cylinder pocket plus a guide along constant u: the grid has one extra row at that u; off-grid direction -> `guide-not-iso-aligned` | no option | skip the snap |
| 7 | `BREP_KERNEL_DIGEST` and `TS_KERNEL_DIGEST` checks stay green (`check-exact-guard.ts`) | n/a | n/a |

Metric to report with the PR (same `summary.json` + `provenance.txt` discipline as #622/#624/#625): plate with guide,
quads, triangles, minSJ, twist, aspect, valence histogram, and the share of quads adjacent to the guide that have a
guide edge (target 1.0).

## 7. Cost and ownership

| Piece | File | Owned by this lane? |
|:--|:--|:--|
| `GuideCurve`, `'guide'` origin, `curve?` field | `feature-constraints.ts` | yes (new `src/brep/` file may hold the guide types) |
| ring-from-guide helper, guide validation | new `src/brep/quad-guide.ts` | yes (new file) |
| row-front hook | `quad-row.ts`, `quad-trimmed.ts` | **no**: both are listed as other lanes' files; needs a hand-over spec |
| iso snap / loop block | `quad-iso-quadric.ts` | yes |
| `guides` option, `layoutFace` hook | `quad.ts` | minimal hook only |

Open question for the coordinator: the row-front step cannot be done without editing `quad-row.ts`/`quad-trimmed.ts`.
Either the trimface lane takes that edit from a spec, or this lane is allowed one narrow exception there.

## 8. Not covered

- 3D guide projection onto a face, cross-face guides, free-form (NURBS) face guides, soft sizing hints.
- Guides on faces handled by `blossom` (non-row) trims: the guide ring needs the row front; those modes reject
  `guides` with `guide-needs-row-front`.
- No measurement exists yet; section 6 lists what would be measured.
