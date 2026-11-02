# Stylized characters: form, edge flow and faceted tilings

A stylized character (large head, short limbs, simplified clothing and hair) is read through
its silhouette and a few clean planes. This note covers how to decompose such a figure, where
edge loops and poles belong, how to build garments and hair as layered parts, and how to
produce a faceted (low-poly) tiling that looks planned rather than reduced. It matters
whenever a figure has to deform in a rig, survive a poly budget, or look deliberate under flat
shading.

The tools live in these references; this note only says what to weigh when using them:

| Concern | Owner |
|:--|:--|
| `shrinkwrap`, `layer`, `shell` taper, `strands`, `spherize`, `knife`, soft transforms | [artist-editing](../reference/artist-editing.md) |
| `simplify`, `remesh`, `cleanup.tiling`, `lowpoly` | [voxels-remesh](../reference/voxels-remesh.md) |
| `checkEdgeFlow`, `meshQuality` | [surfaces](../reference/surfaces.md) |
| `rig`, `bindAuto`, `poseReport` | [rig](../reference/rig.md) |
| `uv.swatch`, texel density, bake | [uv-bake](../reference/uv-bake.md), [baking-uv](baking-uv.md) |
| Where the decisions live, levels of work | [design-methodology](design-methodology.md) |

Runnable shapes come from `examples/maid-whale` (a stylized character built in layers, then
faceted).

## 1. Decompose before modeling

Work in three tiers and write down, for each piece, its form type (sphere, tube, sheet, cone,
shell), its main direction (hair along growth, a skirt along waist-to-hem, a sleeve along the
arm) and its structure lines (outline, turn, seam, ridge).

- Big forms decide silhouette and proportion: head mass, hair mass, torso, skirt bell, tail.
- Medium forms are sub-blocks: hair clumps, garment panels, puffed sleeves, bow wings.
- Small forms are repeated or incidental: hem teeth, buttons, hair tips.

In a super-deformed figure of roughly 2 to 3.5 heads tall the head and hair take more than half
the silhouette, so face, fringe and hands deserve the finest tiling and large back surfaces
the coarsest. Keep proportions, landmarks and pivot positions in one data module (see
[design-methodology](design-methodology.md)) so every part reads the same numbers; the
`maid-whale` example keeps them in `forms.ts`, `reference.ts` and `plan-units.ts`.

Squint test: blur or shrink the render until only value groups remain. If the hair mass, the
head and the garment do not separate as three shapes, fix the big forms before any detail.

## 2. Order of construction: structure first

Build from the inside out and from large to small:

1. Body blockout (volumes, landmarks), then body skin with clean edge flow.
2. Garments as offset sheets of the body, then thickened (section 4).
3. Hair as a cap plus clumps, then tips.
4. Attachments (bows, props, fins) seated on their parents.
5. Faceting and cleanup, last.

Why this order: every later layer is derived from the one under it (`layer` and `shrinkwrap`
read the body surface), so a body edit afterwards moves everything. When the body must change
late, wrap garments to a frozen snapshot of the body (`onto` accepts another session or an FXEM
snapshot) and re-derive them. Use `m.checkpoint(name)` at each stage boundary so a failed stage
is inspected without rebuilding the earlier ones. The first failed operation poisons the
session; use `m.try(fn)` only for steps whose failure you handle (for example
`model-op-no-effect`).

Close-up local edits beat global ones. A fix to one cuff should be a selector on that cuff
(`sel.createdBy('cuff-l', 'layer')`, `sel.inBox(...)`, `sel.tag(...)`), never a global
parameter change that shifts neighbours. Label every operation (`label:`, `tag:`) so a later
stage can address its output.

## 3. Edge loops and poles

For a mesh that deforms (face, joints, shoulders) the quad cage's loops are the animation.
What to weigh:

- Eyes and mouth want concentric loops that close back into the larger face loops; radial
  loops push poles onto the cheeks.
- A bending joint wants at least two full loops, dense on the compressed side and sparse on the
  stretched side, each bound to its joint when binding rigidly.
- Shoulders, armpits and hips are the hardest regions: several directions of rotation share few
  loops. Plan them explicitly.
- A pole (valence other than 4) is unavoidable. Put it on flat, low-deformation, low-highlight
  regions, never in the middle of a cheek, crease or hinge.
- Triangles are fine on rigid, static regions; avoid them where the surface deforms or where
  shading is smooth.

Tools that help:

- `spherize(faces, { factor, center?, radii?, falloff? })` turns a subdivided box into a ball
  cage with no 32-valence poles; use it for heads, joints and knuckles instead of a UV sphere.
  See `hair.ts` in `examples/maid-whale` for a falloff band blending a spherized cap into the
  rest.
- `checkEdgeFlow(mesh, featureLines)` (also `m.validate({ edgeFlow })`) answers "do the edges
  follow the feature lines I declared": `feature-loop` (warn) when on-line edges cover less
  than `coverage` 0.98 of a line or break into several chains within `tolerance` 0.5 mm;
  `aspect` (warn, `maxAspect` 4) and `size-ratio` (warn, `maxSizeRatio` 2) for shape and
  neighbour size; `triangles` and `poles` (info) with located examples. Faces tagged `support`
  skip the shape limits, and cut cells tagged `trim` have looser limits (`trim-aspect` 8,
  `trim-size-ratio` 4).
- The `edges` overlay (`projectOverlay(mesh, 'edges', bounds?)`, or `forgeax model render
  --overlays '["edges"]'`) draws the n-gon edge flow over the shaded body; read it for pole
  placement before skinning. See [tools](../reference/tools.md).

## 4. Garments: panels, thickness, layers

Think in panels. A seam is a structure line and a natural tiling boundary; a skirt's gore edges
run from waist to hem and the tiling should follow them.

The recipe that holds up:

1. `layer(region, { offset, conform: true, label, tag, material })` makes one offset sheet of
   a body region. `conform` keeps a constant gap on curved regions; `detail.gap` is the range
   reached, and a gap more than 10 percent off the request warns (inner elbows and the small
   of the back pull the sheet closer).
2. Shape the single sheet: `shrinkwrap` with a `falloff` band (a skirt conforming at its
   waistband and free below), soft `translate` / `scale` with `{ falloff, symmetry: 'x' }`,
   local `smooth`.
3. Thicken last with `shell(sheet, { thickness, direction: 'in' | 'out', clamp, open })`.
   Thickening first and then wrapping one side folds the wall, because the two sheets stop
   moving together.

Cloth edges that thin to nothing are a style choice with a tool: `taper: d` on `shell` or
`layer` scales each vertex offset by its distance to the open boundary over `d`, so the
two walls meet in a sharp crease with no rim faces and no sliver strip for faceting to fight.
Refused: a closed surface (nothing to taper) and a `d` at least the boundary-to-farthest
distance (`detail.maxTaper`). `garments.ts` in the example wraps this in a small `walled`
helper that picks tapered or plain walls per style.

Openings and cuts: `knife({ points, closed: true, faces, label, seam: true })` then `delete`
or `extrude` on `sel.createdBy(label, 'inside')`. A surface path (no `direction`) cuts only
the sheet connected to it, so a garment cut does not reach the body below. Joining a grown part
(sleeve, tail) into a body: delete its end cap, knife the opening, delete the inside, `bridge`
the two loops.

```ts
// examples/maid-whale: bodice offset sheet, wrapped skirt hem, then a wall
m.layer(REGION.collar(), { offset: 0.007, conform: true, label: 'collar', tag: 'collar', material: 'white' });
m.shell(sel.createdBy('collar'), { thickness: 0.005, direction: 'out', clamp: true, label: 'collar-wall' });
m.shrinkwrap(skirtHem, { onto: sel.tag('body'), offset: 0.004, falloff: { radius: 0.04, distance: 'connected' } });
```

Fold vocabulary is a judgement: stylized clothing keeps a few clear tube folds and half-lock
folds. Repeated frills are a small unit plus `array({ onCurve })` or a `bend`/`curveDeform`
along the hem, not hand-placed geometry. Layers must not touch: leave a clearance of a few
millimetres and let the `clearance` option in `simplify`, `remesh` and `cleanup.tiling` hold
it through faceting (section 6).

## 5. Hair

Decompose volume to clump to lock to tip. Look for the part split, the flow from the crown
whorl, and the order of overlap. Named parts of anime-style hair are front fringe, back mass,
side locks and an ahoge (a single curled tuft); each can be its own labelled part.

- Cap: `layer(scalp, { offset, conform: true })`, then `spherize` with a falloff band to round
  it, then `shrinkwrap` the fringe onto the skin with a small `offset` (`hair.ts`).
- Clumps: `strands(region, { count, path, comb, combFrame?, rootFaces?, scale?, vary?, seed? })`
  grows `count` strands (1 to 512) from face roots spread by farthest-point order. The `path`
  is in the root frame (x across, y along the normal, z along the projected `comb`);
  `combFrame: 'world'` lets long hair fall from upward-facing roots. A comb within about 6
  degrees of the normal warns. Walls get role `strand`, ends `tip`, and each strand is tagged
  `strand:<i>`, so one clump can be soft-moved or smoothed alone. Crossing strands are
  reported as a warning with the pair and face ids.
- Layer front and back: alternate lengths, ragged outer edge, outermost layer decides the
  silhouette.
- A clump section should be a flat lens tapering along its length, ending in a point; make
  grooves between clumps fall on tiling edges (section 6).

## 6. Faceted (low-poly) tilings

A good faceted figure is a planned tiling of planes, not a decimation result. The tools give
you both a reducer and a measuring stick; use the measuring stick to decide.

Preferences that make a tiling read as intended:

1. Put edges on outlines, turns, seams, clump grooves and fold ridges; planes sit between them.
2. Run long faces along the low-curvature direction (clump length, sleeve axis, skirt
   generatrix) and short faces around the high-curvature direction. A moderate, deliberate
   anisotropy (aspect 2 to 3, aligned with the flow) is fine; needles are not.
3. Keep neighbouring face sizes within a factor of 2, change density gradually, spend density
   on focal regions (face, fringe, hands, bows) and save it on back hair and skirt faces.
4. Aim for interior valence near 6; valence 3 (spikes) and 9 or more (fans) are defects.
5. Choose each quad's diagonal along the form: diagonals decide nose ridges and cheek planes
   at low counts.
6. Under flat shading every face is one normal; strong specular fights the facets, so pair
   them with plain or simple lighting.

`meshQuality(faces?, limits?, { flow? })` (also `m.validate({ quality: [{ part, limits? }] })`)
measures exactly this over triangles. Defaults in `MESH_QUALITY_LIMITS`: aspect p50 at most 2,
p90 at most 4, share above 6 at most 2 percent, smallest-angle p10 at least 20 degrees, share
of bad valence (3 or at least 9) at most 1 percent, neighbour size ratio p95 at most 2.
With `flow` guides it also reports how well long edges follow the guide (`flow.p75` limit
`flowP75` 20 degrees; triangles rounder than aspect 1.5 are `skipped`, limited by
`flowSkipped` 0.4, so a near-isotropic tiling cannot pass by skipping). A failing part in
`validate` becomes a `mesh-quality` warning with `failed` naming the limits.

The reducer: decimation by quadric error produces long thin triangles by construction (its
optimal triangles are anisotropic). The remedy is a short pipeline, as in
`examples/maid-whale/faceting.ts`:

```ts
const preserve = { labels: true, materials: true } as const;
m.simplify(faces, { targetFaces, maxError, clearance, preserve });          // coarse, layer-safe
m.remesh(faces, { targetEdgeLength: edge, iterations: 6, clearance,         // even the slivers
  adaptive: { error: 0.004, minEdge: 0.031 }, preserve });                   // finer where curved
m.try((t) => t.cleanup.tiling(faces, { maxError, maxAspect: 3.5, iterations: 20, clearance, preserve }));
```

What each step is for:

- `simplify` hits a count; `clearance` refuses collapses that bring a triangle nearer than that
  to another surface, so layered garments never cut through the body. `maxAspect` and
  `maxValence` refuse collapses that leave worse triangles.
- `remesh` evens edge length toward `targetEdgeLength`; `adaptive: { error, minEdge }` lets
  curved regions keep finer edges; `direction: { guides, anisotropy? }` lays long edges along a
  flow (`{ along }`, `{ around }`, `{ from }`, `{ curve }` or `'principal'`). Raising
  `anisotropy` lowers the flow angle and raises the aspect median.
- `cleanup.tiling` flips toward Delaunay and collapses needles above `maxAspect` (default 5);
  `model-op-no-effect` means the tiling was already clean, which `m.try` lets you ignore.
- `lowpoly(faces, { targetFaces, union, hardAngle, silhouette, quads, slivers, uv, tags })` is
  the all-in-one path for hard parts; see [uv-cuts-lowpoly](uv-cuts-lowpoly.md).

Derive the target facet count per group from its area and the facet size you want, and give
each group its own edge: finer for the face and fringe, coarser for back hair. Groups with
their own materials or labels keep those borders when `preserve` says so; a border that
carries no facet edge (for example the seam between a hair mass and its cap) is better not
preserved, or it pins needles. A part already near its target should skip `simplify` and go
straight to `remesh`. A needle on a group border that remesh cannot move can be removed by
collapsing its shortest edge and welding.

If a plan unit fails, change the plan (edge, group split, guide) before touching vertices.
`plan-units.ts` shows per-unit limits fed to `meshQuality` and a flow check against guide
curves.

## 7. Colour, UV and flat shading

Stylized figures usually need one flat colour per face group. `uv.swatch({ faces, region })`
maps each face to a flat region of a palette sheet, so bilinear taps never leave the region
and the face takes the colour exactly; the sheet itself comes from `trimSheet` with `flat`
modules (see [baking-uv](baking-uv.md)). This avoids UV islands, seams and texel-density
review for the whole figure. Where outlines or per-face gradients are wanted, leave them to the
material and the shader; the kernel only delivers faces, slots and UVs.

Check before export: `validate` with `{ texelDensity }` only matters for textured regions;
`{ uniqueUv }` (issue `uv-overlap`) matters when baked maps are used.

## 8. Rigging a stylized figure

- Rigid pieces (hair clumps, bows, shoes, props) go on `bindRigid(faces, joint, { part })`.
  A bow bound to a head joint moves rigidly and keeps its exact contact.
- Deforming regions (sleeve, skirt, tail, cable) use `bindAuto(faces, joints, { part,
  resolution, stiffness, smoothing, maxInfluences, prune })`. Raise `stiffness` or `prune`
  to localize influence if distant bones leak a few percent. A vertex no bone reaches makes the
  result `partial` with reason `unreached`. Auto regions export only with
  `finish({ form: 'skinned' })`, and `interference`/`scan` test rigid parts only.
- For a lower LOD, `reduceSkinForLod(input, { budget, minMass, keep })` merges leaf joints.
  Joints in `keep` (animation targets, sockets) and their ancestors never merge.
- A hero pose is judged with `rig.poseReport(pose, { front, up, ground, hips, shoulders,
  feet })`. It reports `no-contrapposto` (opposite hip and shoulder tilt, 5 to 15 degrees),
  `unbalanced`, `not-grounded` (contact 5 mm), `thin-silhouette` (fill below 0.41),
  `no-negative-space` (below 4 percent), and `straight-line-of-action` (within 1 percent of
  the height; the shape is `straight`, `C` or `S`). These are necessary, not sufficient;
  see [animation-presentation](animation-presentation.md).

## 9. What the tools do not decide

- Whether the proportions are charming, whether the face reads, whether a fold is the right
  fold: judge in renders from front, three-quarter and side.
- Style: if quality complaints appear, check the measurements first; changing the art
  direction (low-poly vs smooth) is a separate decision.
- Cloth physics, toon outlines and hair simulation are not kernel features. Model the resting
  shape and let the material or runtime handle the rest.
- Face rigs: the kernel binds joints and weights; blend shapes and expression sets are not
  produced here.
