# Artist editing

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Artist editing: shrinkwrap and layers

Garments over a body, a hair cap on the scalp, armor plates on a limb member: these tools
work on parts that already exist, structure first. They never change the source surface.

- **Falloff** (`Falloff`, shared with the soft transforms below): selected vertices weigh 1,
  other vertices closer than `radius` to a selected one weigh `curve(1 - d / radius)`,
  with `curve` `smooth` (default, 3x^2 - 2x^3), `linear`, `sharp` (x^2) or `constant`, and
  `d` either `euclidean` (default) or `connected` (shortest path along edges, so a falloff
  stays on its own surface and does not jump a gap). Weights are deterministic (ties by
  vertex id).
- **`shrinkwrap(target, { onto, ... })`** moves the selected vertices
  onto `onto`, which is another session, an FXEM snapshot (a frozen body), or faces of this session
  the wrapped vertices (with their falloff) do not touch. `nearest` (default) takes the closest
  point's interpolated normal and follows it to the surface. A cloth finer than the body
  therefore spreads over a convex corner instead of collapsing onto its vertex. `project`
  takes the nearest hit along `direction` (a world vector, or `normal`: each vertex's own
  angle-weighted normal) in both directions. `offset` is signed along the surface's interpolated
  angle-weighted normal (outward > 0, a garment's clearance). A `falloff` blends nearby
  unselected vertices by their weight, for example a skirt conforming at its waist band and
  free below. Topology never changes. A vertex without a surface point within `maxDistance`
  stays, and a warning reports the missed count, ids and points. When nothing moves, the
  call is `model-op-no-effect` with `detail.missed`. The `info` diagnostic reports moved
  vertices, the largest move, wrapped, missed, the farthest surface distance and the blended count.
  Faces the wrap inverts, collapses or folds are a warning, as for the deformers.
- **`layer(faces, { offset, thickness?, rim?, conform? })`** is the region offset shell. A copy
  of the faces moves `offset` along their normals (the shell's per-vertex plane solve; exact
  for up to three planes) and becomes role `layer`. With a `thickness`, the copy grows a wall
  outward: the copy becomes the outer wall (still `layer`), its reversed copy `inner` sits at
  the offset, and `rim` quads close the openings. `rim: 'open'` leaves the two sheets apart.
  `conform: true` wraps the offset copy to exactly `offset` from the source surface (nearest
  point, as shrinkwrap), so curved regions keep a constant gap. `detail.gap` is the range
  actually reached; a concave region (an inner elbow, the small of the back) pulls the layer
  closer than `offset`, and a reached gap more than 10 % off warns. The source faces
  stay as they are. The copies keep material slots, corner values and edge intent, and drop
  the source tags (a garment is a new part), taking the placement `tag` and `material` instead.
  Existing ops cannot do this in place: `offset` on a duplicated island grows walls on its
  boundary, and `shell` needs whole parts. A thickness beyond the local feature size is the
  shell's `model-precondition` (or `clamp`). `taper` passes through to the shell (a closed
  layer with a thickness only). After soft edits vertices move across `inBox` limits, so
  select region bands with `{ by: 'centroid' }` instead of the default hit rule.
- **Tapered shells** (`shell` / `layer` `taper: d`): the wall thins to nothing at open
  boundary edges, as stylized cloth and hair edges do. Each vertex's offset scales by its
  distance along the surface (edge paths) to the open boundary over `d` (at most 1), so
  boundary vertices stay put and the outer and inner walls share the boundary loop: a sharp
  crease, no `rim` faces, and no strip of thickness-wide slivers for faceting to fight (a
  1 cm plate's rim triangles have aspect 5.2; tapered over 10 cm the triangulated plate
  stays below 4). So that the two walls share nothing but the boundary loop, interior edges
  between two boundary vertices (narrow strips) first get a midpoint, and faces with two
  boundary vertices that are not loop neighbours (panel corners, quads an outline crosses)
  are split into a fan around their centroid; opening faces are removed, never walled.
  Only boundary vertices are shared (a vertex reached over a zero-length edge still moves),
  and the feasibility check (opposite walls, collapsing faces) uses the tapered offsets. Refused: a closed
  surface (`model-precondition`, nothing to taper), a `d` at least the distance from the
  boundary to the farthest vertex (`detail.maxTaper`: the wall must reach full thickness
  somewhere), and `taper` with `flange`. The thickness assertion covers the full-thickness
  faces.

```ts
m.layer(sel.tag('body').and(sel.inBox([-1, 0.4, -1], [1, 0.75, 1])), {
  offset: 0.004, thickness: 0.002, conform: true, label: 'bodice', tag: 'dress', material: 'cloth',
});
m.shrinkwrap(sel.createdBy('skirt', 'side').and(sel.inBox([-1, 0.42, -1], [1, 1, 1], { by: 'any' })), {
  onto: sel.tag('body'), offset: 0.004, falloff: { radius: 0.04, distance: 'connected' },
});
```

## Artist editing: strands (hair cards)

`strands(region, { count, path, comb, combFrame?, rootFaces?, scale?, vary?, seed? })` grows `count`
strands (hair clumps, cards, quills) from a face region such as a scalp. Roots spread
evenly: farthest-point order over the face centroids, starting from the largest face. Each
root grows a patch of `rootFaces` free faces over shared edges, nearest first and without
a vertex where the patch meets itself (a root that finds fewer warns), and extrudes it along
one authored `path`, given in the root frame: x across, y along the surface normal, z along
`comb` projected onto the surface (a comb within about 6 degrees of a root's normal warns
and combs that root sideways). `combFrame: 'world'` keeps the comb as given instead: the path
lifts off the surface along y and runs along the comb along z, so long hair falls from
upward-facing roots rather than fanning out across them. `scale` is applied root to tip (default `[1, 0.2]`). `vary` gives
seeded per-strand length factors and comb turns. The output is deterministic for a seed.
Walls get role `strand`, ends `tip`, and every strand tag `strand:<i>` so it can be shaped
on its own afterwards (soft moves, smoothing). Strands that cross each other are reported as a warning
(strand pairs and face ids), checked on the strand faces alone.

## Artist editing: spherize

`spherize(target, { factor, center?, radii?, falloff? })` moves each
selected vertex along its direction from `center` (default: the selection's bounds center)
toward an ellipsoid with `radii`. The default is a sphere at the mean distance of the
selected vertices, so the volume barely changes. The move is `factor` (0 keeps the shape,
1 lands on the surface) times the vertex's falloff weight. A subdivided box spherized to a
ball is a pole-free quad cage for heads and joints, unlike a UV sphere with its
32-valence poles. It reports and asserts like the other deformers; a vertex at the center
stays.

## Artist editing: extrude along a path

`extrude(faces, { path, frame?, up?, scale?, twist? })` grows a region along a path:
limbs from a trunk band, a tail root from the lower back, hair clumps from the scalpextrude along a curve). The path (points or a `path.*` spec, sampled as for `sweep`) is moved
so it starts at the region's area-weighted centroid. Station 0 is the region where it is. At
every later station the region's boundary ring is placed in that station's frame
(rotation-minimizing by default, `frame: 'up'` keeps `up`), so the ring stays aligned with
the region and does not snap onto the path. `scale` and `twist` (degrees) ramp like sweep's:
an end value, `[start, end]` linear in arc length, or one value per sampled station. One
wall strip per span gets role `side` (with a label also tag `<label>:ring:<k>` for span k, so a
later edit can address one ring), and the region ends at the last station as `top`.
Walls copy the region faces' material and tags, and boundary edge intent carries over, as
for a plain extrude. A path that starts against the region normal warns (the first walls
fold back into the part), and folded walls are listed with, per span, the turn into its end
station, the span length and how far the section reaches from the path there. A section that
reaches farther than a tight turn leaves room for folds: lengthen the span before the turn,
turn less, or narrow the region (a staircase row cut diagonally across a grid reaches
farther than an aligned one). A scale of 0 is rejected; a scale
near 0 that collapses faces below the tolerance warns (end a tip on a small scale and close
it separately). A straight path along the normal gives exactly a plain extrude with more rings.

## Artist editing: recipes

- **Garment over a body** (structure first): `layer(region, { offset })` as a single sheet
  (no thickness) → shape the sheet with `shrinkwrap` (with a falloff band) or soft
  `translate`/`scale`, and `smooth` locally → `shell(sheet, { thickness, direction: 'in' })`.
  Thickening first (`layer` with `thickness`) and then wrapping or soft-moving one side
  folds the wall, because both sheets no longer move together.
- **Openings** (collars, cuffs, apertures): `knife({ closed: true, faces, label })`, then
  `delete` (an opening) or `extrude` (a recess) of `createdBy(label, 'inside')`.
- **Joining a grown part** (a limb or a garment edge into the body): delete the part's end
  cap, knife the opening into the body and delete its inside, then `bridge` the two
  boundary loops (`segments` for a smooth shoulder); unequal loops split the shorter one,
  spread by arc length so the rungs stay within half a segment of their partners.

## Artist editing: soft selection and knife

- **Soft selection**. `translate`, `rotate` and `scale` take
  face or vertex selectors and an optional last argument `{ falloff?, symmetry? }`. With a
  falloff, each vertex within the radius takes the transform at its weight: the offset times
  w, the angle times w, the factor 1 + (factor - 1) x w. `symmetry: 'x'` completes the
  selection with its mirror image across x = 0 (vertices matched within the tolerance; a
  warning lists selected vertices without a mirror). Each side of the plane takes the
  transform of the selection on that side, mirrored. Vertices on the plane average both
  sides, so they stay on it. Soft edits report like deformers: an `info` diagnostic with the
  largest move, the moved and weighted vertex counts, `model-op-no-effect` when nothing
  moves, and warnings for inverted, collapsed or folded faces. They are journaled as one
  operation with their options. Without the options argument the transforms keep their
  exact earlier behavior and journal form.
- **`knife({ points, direction?, closed?, through?, snap?, sharp?, seam?, faces? })`**
  Each path segment sweeps a curtain along a direction,
  and the faces split along the curtain's chords.
  - **Projection**: with `direction` (from the viewer into the scene), the points can lie
    anywhere along the view, and the visible layer is cut (`through: true`: every layer).
  - **Surface path**: without `direction`, the points snap to their nearest surface points,
    each segment sweeps along the averaged surface normal, and only the sheet connected to the
    path is cut, so a garment cut does not reach the body underneath.
  - **Splitting**: crossed faces become valid n-gons through one face rewrite. Crossed edges
    gain vertices with interpolated corner values (UVs and colors survive), and points inside
    faces get barycentric corner values.
  - **Snapping**: a crossing within `snap` of a vertex (default 1 % of the crossed edge, at
    least the tolerance) goes through that vertex. A path through vertices or along existing
    edges adds no slivers; followed edges only receive the edge intent. The cut is atomic: if snapping
    would put two crossings on one vertex or across another chain, the mesh is restored and
    the cut repeats with a quarter, a sixteenth, then no snap (an `info` names the scale
    used), so `snap` never creates crossings.
  - **Open path ends**: an end inside a face is trimmed to that face's boundary (`info`).
  - **Closed paths**: the enclosed faces get role `inside` (with a label) and the placement
    `tag`, ready for `delete`, `extrude` or `panelLine`. A projection takes the faces whose
    centroids project inside the outline, reached from the cut without crossing it; without
    `through` only faces turned to the viewer are cut or taken, so an outline that overhangs a
    panel edge leaves the faces beyond it alone. A surface loop takes its left side:
    counter-clockwise seen from outside encloses the inside; when that side has more faces than
    the other, it warns (reverse the points for the other side). Stretches along existing edges
    count as cut edges, oriented by the path. A loop that does not separate warns and assigns no
    role.
  - **Edge intent**: `sharp`/`seam` mark the cut edges. `faces` limits the cut (and the
    surface the points snap to).
  - **Errors**: a path crossing itself inside a face is `model-precondition`. A path that
    meets no face is `model-op-no-effect`.

```ts
// Window aperture drawn in the side view, cut into the visible body panel, then sunk.
m.knife({ points: windowOutline, direction: [-1, 0, 0], closed: true, sharp: true, label: 'window' });
m.extrude(sel.createdBy('window', 'inside'), { distance: -0.004, region: 'merged' });
// Collar seam on the dress surface, then a soft puff of the sleeve with x symmetry.
m.knife({ points: collar, closed: true, seam: true, faces: sel.tag('dress'), label: 'collar' });
m.scale(sel.createdBy('sleeve', 'layer'), [1.15, 1.1, 1.15], shoulder, { falloff: { radius: 0.05, distance: 'connected' }, symmetry: 'x' });
```
