# Detail catalog: choosing how each small feature is made

Hard-surface detail (bevels, panel lines, bolts, vents, labels, tread, weld beads, knurling)
can be real geometry, a stamped or modeled repeat, a baked normal map, a decal, or a shader
effect. The wrong choice is expensive in either direction: geometry no viewer can resolve
wastes triangles, and texture detail on a silhouette looks fake. This note gives the decision
rule, then a catalog of features with the tools that make each one, then the pitfalls and the
checks that catch them.

Owners:

| Concern | Reference |
|:--|:--|
| `bevel`, `blendSurfaces`, `supportLoops`, `panelLine`, shut lines, recipes | [detail](../reference/detail.md) |
| `inset`, `extrude`, `array`, `difference`, `markSharp`, `knife` | [operations](../reference/operations.md), [booleans](../reference/booleans.md) |
| `sweep`, `lattice`, `bend`, `smooth` | [sweep-deform](../reference/sweep-deform.md) |
| `proceduralMaterials`, textures, text, mips | [materials](../reference/materials.md) |
| Bake, trim sheets, `stamp.*`, `trimReport`, texel density | [uv-bake](../reference/uv-bake.md), [baking-uv](baking-uv.md) |
| Validation options | [validation](../reference/validation.md) |
| Low-poly delivery of the result | [uv-cuts-lowpoly](uv-cuts-lowpoly.md) |

Examples to read: `examples/panel`, `examples/housing`, `examples/crate`, `examples/bracket`,
`examples/door-hinge`, `examples/wheel-rim`, `examples/thin-vent`, `examples/armor-bake`.

## 1. The decision: pixel footprint

Work out how many pixels the feature covers at the closest realistic view, then choose.

| Footprint | Representation | Why |
|:--|:--|:--|
| Under about one pixel across | nothing, or the material (roughness, a mip-filtered normal) | it cannot be seen; modeling it adds noise and shimmer |
| A few pixels, flat on a face, off the silhouette | baked normal or height detail, or a decal | a texel costs about 4 bytes, a triangle about 100 |
| Visible in the silhouette, or a hole you can see through | geometry (possibly instanced) | a normal map cannot move an outline or open a hole |
| Large and unique (a hatch, a bumper, a handle) | modeled geometry | it is the design |
| Repeated many times (bolts, rivets, vent slots) | one modeled unit, placed with `array` or a trim sheet | one definition, many uses |

`validate({ bake: { checks: ['subpixel-bevel'], view: { distance, fov?, height? } } })`
turns the first row into a measurement: it flags a bevel narrower than a texel at the view
you give. `trimReport(sheet, meshes, { replaced, cloneLimit, bytesPerTriangle,
bytesPerTexel })` turns the second and last rows into numbers (`worthIt`, `savedBytes`,
`regionBytes`, `instancesNeeded`): a shared sheet pays only when enough instances reuse it.
Treat those as measurements and change the byte constants as arguments.

Two rules that hold across the catalog:

- Everything that is real geometry needs the edge treatment of section 2, or it renders as a
  razor edge with no highlight.
- Never bake what you could not see and never model what cannot be seen from the nearest
  camera. Decide the nearest camera first.

## 2. Edge treatment: the small radius that sells hard surfaces

A real hard edge is slightly rounded; the highlight on that radius is what reads as "metal" or
"moulded". Weigh, in order of cost:

- `bevel(edges, { width, segments })`: a flat chamfer at `segments: 1`, a tangent round for
  more. Use width around a millimetre to a few millimetres on a part metres across; keep
  widths consistent across a model, since mixed radii read as sloppy. Corners where three or
  four selected edges meet get a patched `corner` automatically. Interior edges only;
  widths past the adjacent faces are clamped with a warning. Tag/label what you bevel so a
  later pass can select the strips (`role` `bevel`, `corner`).
- `markSharp(edges)` leaves the edge crisp at export (a shading choice); `markCrease(edges,
  sharpness)` gives a finite crease for subdivision.
- `supportLoops(edges, { offset })` adds one or two edge loops beside an edge so a
  subdivision surface keeps it tight (strips tagged `support`, which the edge-flow check
  exempts). It is for the subdivided route; on a mesh exported as is, use `bevel`.
- `blendSurfaces(a, b, { radius, continuity?, ... })` rolls a constant or variable radius
  between two surface patches (G1 default, G2 for continuous curvature). It is the choice on
  automotive-style body panels where the curvature of the blend shows in reflections.
  Radius of 2 to 5 mm is typical; run-outs where the radius goes to 0 are allowed at the
  ends.

Cheap check: render with a metallic material at a grazing light. A missing radius shows as a
dead line; an uneven radius as beading. `checkEdgeFlow` (see
[surface-quality](surface-quality.md)) confirms the support loops follow the edges.

## 3. Catalog by feature

### Panel lines and seams

- Cut with `panelLine(path, { width, depth, profile })`: `square` for a machined slot, `v`
  for a scribed line, `u` for a rolled groove. Width a fraction of a millimetre to a few
  millimetres; depth about equal to the width for a visible shadow. The path is an edge
  path (it may branch or close) or a plane `{ faces, point, normal }` that cuts across a
  curved band. The rims become sharp, and `material` puts the groove in its own slot.
- Body shut lines between panels (a door, a hood) are a measured quantity rather than a
  groove: `m.shutLines({ table, ... })` checks gaps and flush against targets. See
  [detail](../reference/detail.md) for the table form.
- If a line is under a pixel wide at the nearest view, put it in a normal map instead.

### Bolts, rivets, screws

- One fastener in a repeated pattern: `recipes.hexBolt({ size, length })`, `hexNut`,
  `washer` for sized metric parts, or `stamp.boltHex`, `stamp.rivet` for a trim-sheet cell.
  Place with `array({ linear | radial | onCurve })` on a hole pattern.
- Near-camera fasteners are geometry; far ones are stamps on a trim sheet; the middle
  ground is a normal-map stamp that shares the sheet with the far ones.
- Always cut the matching hole (`difference`) or seat the head flush; a bolt that
  intersects its panel is a `self-intersection` in `validate`, and a declared pair is a
  `designed-contact` (see [mechanism-design](mechanism-design.md)).

### Holes, vents, grilles, perforation

- A hole you can see through must be geometry or an opacity bake; a normal map cannot cut
  it. `thinHole(options)` builds the base and detail sessions for a vent in `'opacity'` or
  `'recess'` mode, and `thinHoleCheck(result, plan)` verifies the hole you asked for is the
  hole the map holds (`examples/thin-vent`).
- For a regular pattern, build one slot with `extrude` / `inset`, then `array`; or use
  `stamp.slot` / `stamp.perforation` on a sheet when the pattern is far from the camera.
- Mind the wall: `validate({ minThickness })` reports `thin-wall` where the wall behind a
  face is too thin to be real.

### Tread, knurl, texture

- Tread plate and knurling are fine repeats, so they belong in a tiling strip of a trim
  sheet (`stamp.treadPlate`, `stamp.knurl`) or, for a tyre, `proceduralMaterials.tire({
  pattern: 'chevron' | 'blocks' | 'ribs', pitch })` which generates the tread normal map and
  roughness. Real tread geometry is justified only on a close hero wheel.
- Strips tile along v; keep tileable detail in strips and not in cells, which show a seam
  when repeated.

### Welds, beads, seams

- `stamp.weldBead` for a trim-sheet strip; for a hero weld, sweep a small section along the
  joint with `sweep` and smooth it, or `extrude` a path. Welds tolerate noise: add a
  `fractalNoise` height modulation in the material, not in geometry.

### Text, markings, labels

- `textStrokes(text, { height, tracking?, slant?, align? })` lays text out in a built-in
  single-stroke font (capitals, digits, `- . / + : #`); `textRegion` turns it into filled
  outlines. Use the result as a layer in `decalTexture` or as a geometric imprint with
  `m.surface`. `stamp.text` makes the same as a sheet cell.
- Large lettering on a silhouette is geometry; small marking is a decal (`proceduralMaterials`
  `decal(base, { width, height, background, layers, texture, key })` puts a decal sheet on
  `uv1`).

### Panel finishes (paint, glass, chrome, carbon)

- `proceduralMaterials` gives `carPaint`, `carbonFiber`, `metal` (chrome, brushed, satin),
  `glass`, `tire`, `emissive` and `decal`, with all their textures generated in code.
  Choose by what changes at close range: flake and weave need a texture, tint and clear coat
  do not. Recipes that use static switches render only from a cooked Pack; a runtime
  `assets.create` of one fails with `material-specialization-not-cooked`.

### Hinges, springs, bearings, gears

- Use `recipes.*` rather than hand-modeling; they are sized, bevelled, labelled and
  clearance-checked. See [mechanism-design](mechanism-design.md).

## 4. Reuse levels

From cheapest to most expensive per unit of variety:

1. One material, tiling texture: no extra geometry.
2. Trim sheet: `trimSheet({ key, size, density, modules, ... })` packs strips and cells once;
   `uv.trim({ faces, region, axis?, fit?, ... })` maps faces into a strip with correct
   density (it warns past 10 percent density deviation or 2 percent projection error). Trim
   each flat run separately, and before exporting tangents. Details in
   [baking-uv](baking-uv.md).
3. Palette swatches: `uv.swatch({ faces, region })` gives a face one flat colour.
4. Instances: `array` of one modeled unit. Copies share a definition, so a fix lands once.
5. Unique baked maps: `bakeMaps` from a detail session onto a low base. Highest cost, only
   for hero parts. Bake checks and recovery are in [baking-uv](baking-uv.md).

Move down this list when the part is seen many times or at distance; move up when it is a
single hero asset.

## 5. Verifying detail

- `validate({ texelDensity: { resolution, target, tolerance } })` flags islands whose texel
  density strays more than `tolerance` (default 0.2) from the target: a bolt head at 4x the
  density of the panel around it is visible.
- `validate({ uniqueUv: true })` reports `uv-overlap` where baked maps need unique UVs;
  tiling textures may overlap.
- `validate({ shells })` and `{ slivers: { width, part? } }` catch crossings and needle faces
  that a bevel or inset can leave behind.
- `validate({ minThickness })` reports `thin-wall`.
- `bakeMaps` returns `issues` with codes `ray-miss`, `steep-wall`, `mip-bleed`,
  `stack-conflict`, `tangent-seam`, `opacity-coverage`, `cage-clip`, `stray-detail`; each is
  a warning with a recovery in [baking-uv](baking-uv.md).
- `mipChain(texture, { layout, ... })` is the one mip filter; generate delivery mips with it
  so normal maps renormalize per level.

## 6. Pitfalls

| Symptom | Cause | Direction |
|:--|:--|:--|
| Edges have no highlight | no radius | `bevel` or `blendSurfaces`, consistent width |
| Highlight beads or varies | mixed radii | one width per model scale; one `segments` |
| Fasteners shimmer in motion | sub-pixel geometry | stamp or drop; see `subpixel-bevel` |
| Seam visible on a tiled strip | detail baked in a cell | move it to a strip |
| Normal-mapped hole looks flat from the side | normal maps cannot cut | `thinHole`, opacity, or geometry |
| Bolt cuts its panel | no seat or hole | `difference`, or declare a designed contact |
| Texture detail on a silhouette | wrong representation | geometry |
| Baked detail ghosts across a mirror | stacked samples disagree | `stack-conflict`: make symmetric or unstack |
| Texel density jumps between parts | independent unwraps | `validate({ texelDensity })`, then `uv.pack` / `uv.trim` with one target |

## 7. What the tools do not decide

- How much detail is enough for the design: the footprint rule bounds the low end, taste the
  high end.
- Paint breakup, weathering and wear: authored through `fractalNoise` and material
  parameters, not geometry.
- Tangent-space conventions of an external renderer: the kernel exports its own; see
  [baking-uv](baking-uv.md).
