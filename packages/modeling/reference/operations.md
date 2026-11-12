# Operations

Part of the [`@forgeax/engine/modeling` reference](../README.md).

## Operation table

| Operation | Roles | Required magnitudes |
|:--|:--|:--|
| `box`, `plane`, `polygon`, `sphere`, `torus` | `face` | sizes, radii, segment counts |
| `cylinder`, `cone`, `revolve`, `extrudePolygon` | `side`, plus `top`/`bottom` caps (`hole` walls for `extrudePolygon` holes) | radii, height or depth, segment counts |
| `extrude(faces, { distance, region })` | `top`, `side` | `distance` (non-zero) |
| `extrude(faces, { path, frame?, up?, scale?, twist? })` | `top`, `side` | a path of non-zero length; `scale` > 0 at every station |
| `offset(faces, { distance, region })` | `top`, `side` | `distance` (non-zero) |
| `inset(faces, { thickness, region })` | `inner`, `rim` | `thickness` (> 0) |
| `shell(faces, { thickness, direction?, open?, clamp?, flange?, taper? })` | `inner`, `rim`, `flange` (the outer surface keeps its identity; no `rim` with `taper`) | `thickness` (> 0); `faces` are whole parts; `flange: { reach, depth, radius?, round?, at? }` or an array of them; `taper` (> 0, not with `flange`) |
| `duplicate(faces)`, `disconnect(faces)` | `copy`; none | none |
| `append(model or FXEM, { translate? })` | `part` (with `label`) or the operand's own origins | none |
| `bridge(edges, { segments?, material? })` | `side` | two closed boundary loops of equal size |
| `loopCut(edges, { cuts })` | none | `cuts` (>= 1); a ring crossing no face is `model-op-no-effect` |
| `supportLoops(edges, { offset })` | none (strips tagged `support`) | one or two rising offsets below half of each rung; side faces with one selected edge |
| `bevel(edges, { width, segments, material? })` | `bevel`, `corner` | `width` (> 0), `segments` (1 to 64); interior edges only |
| `panelLine(edges or { faces, point, normal }, { width, depth, profile?, material? })` | `groove`, `lip` | `width`, `depth` (> 0); `profile` `square` (default), `v` or `u` |

| `sweep({ profile, path, frame?, up?, twist?, scale?, closed?, caps?, segments?, sharpAngle? })` | `side`, `start`, `end` | a closed `[x, y]` section (or several), a path of non-zero length |
| `loft({ profiles, closed?, caps?, match?, segments?, sharpAngle? })` | `side`, `start`, `end` | two or more closed planar 3D sections (three when `closed`) |
| `pipeNetwork({ nodes, edges, radius, nodeRadius?, edgeRadius?, ringSegments?, strutSegments?, levels?, weld?, bend? })` | labels `node:<i>` (roles `node`, or `cap` on a leaf) and `strut:<e>` (role `strut`); with `weld`, also `weld:<nearest node>` (role `weld`); with `bend`, a bent degree-two node is labelled `node:<i>` with role `bend` | a skeleton graph of finite nodes and distinct edges; every node on an edge; branches at a node at least 15 degrees apart; `nodeRadius[i]` overrides `radius` at node i, `edgeRadius[e]` (a number, or `[atStart, atEnd]`) overrides both ends of strut e; all positive |
| `surface({ patches, chord?, angle?, maxSegments?, weld?, sew?, spacing?, blends? })` | each patch `name` (default `surface`), each imprint's `role` (default `imprint`) | NURBS patches that pass `nurbs.checkSurface`; `chord`, `angle` (> 0) |
| `array(faces or model or FXEM, { linear \| radial \| onCurve })` | `copy` (with `label`) or the sources' origins; `moved` | `count` (>= 2; onCurve >= 1), non-zero `offset` or `axis` |
| `bisect({ point, normal })` | none | non-zero `normal` |
| `planeCut({ point, normal, keep, fillHoles?, material? })` | `cap` when filled | `keep: 'positive' or 'negative'` |
| `dissolve(edges)`, `split(edges)` | none | interior edges |
| `orient(faces)`, `triangulate(faces)` | none | none |
| `fillHoles(edges, { material? })` | `cap` | boundary edges |
| `lift(meshAsset)` | `face` | float32 positions, a triangle-list submesh |
| `subdivide(faces?, { levels, scheme?, boundary?, creaseSharpness?, compute? })` | none (children keep their face's role) | `levels` (integer >= 1) |
| `markCrease(edges, sharpness)` | none | `sharpness` >= 0 (0 clears, `Infinity` = `markSharp`); warns on open-boundary edges for finite values; journal arg `'Infinity'` |
| `snapToLimit(faces or vertices, { boundary?, budget? })` | none | every vertex on a manifold fan of 3+ edges (or open); no lone infinitely sharp crease end (dart) |
| `lattice`, `cage`, `bend`, `twist`, `taper`, `curveDeform`, `smooth` (faces or vertices) | none | resolution and offsets, cage points, `angle`, `factor`, a path, `iterations` |
| `smooth.implicit(faces or vertices?, { lambda, iterations?, pin?, preserveVolume? })`, `arap(faces or vertices, { handles, iterations?, pin? })` | none | `lambda`; at least one handle that moves |
| `shrinkwrap(faces or vertices, { onto, mode?, direction?, offset?, maxDistance?, falloff? })` | none | `onto` (session, FXEM or faces of this session the wrapped vertices do not touch); at least one vertex with a surface point |
| `strands(faces, { count, path, comb, combFrame?, rootFaces?, scale?, vary?, seed? })` | `strand`, `tip` (tag `strand:<i>`) | `count` 1 to 512; a region with `count x rootFaces` faces; a path of 2+ points; non-zero `comb` |
| `spherize(faces or vertices, { factor, center?, radii?, falloff? })` | none | a finite `factor`; positive `radii`; at least one vertex moves |
| `layer(faces, { offset, thickness?, rim?, conform?, clamp?, taper? })` | `layer`, `inner`, `rim` (none with `taper`) | a finite `offset`, `thickness` >= 0, not both 0 |
| `mirror({ axis })` | `mirrored` | mesh must lie on one side of the plane |
| `translate`, `scale`, `rotate` (faces or vertices, optional `{ falloff?, symmetry? }`), `flip`, `delete`, `weld` | none | offsets, positive scale factors, distance; a soft edit moves at least one vertex |
| `knife({ points, direction?, closed?, through?, snap?, sharp?, seam?, faces? })` | `inside` (closed paths) | 2+ points (3+ closed), a segment length across the sweep, at least one face cut from edge to edge or an edge followed |
| `tag`, `assign`, `markSharp`, `markSeam`, `uv.project` (`box`, `planar`, `cylinder`) | none | projection `scale` |
| `featureLine({ name, curve, continuity?, inflections? })` | none (records a feature line; no geometry) | a unique name, a valid NURBS curve, continuity `G0`, `G1` or `G2`; `inflections` ranges `[t0, t1]` with 0 <= t0 < t1 <= 1 |
| `uv.unwrap({ faces?, method?, seams?, pins?, refine? })`, `uv.pack({ faces?, resolution, padding, rotate?, normalize? })` | none | atlas `resolution` and `padding` (texels) |
| `uv.auto({ faces?, maxCharts?, maxDistortion?, maxNormalDeviation?, respectSharp?, method?, refine?, resolution, padding, pack? })` | none (role `charted`) | atlas `resolution` and `padding` (texels) |
| `voxel.fromMesh(faces?, { voxelSize, band, sign? })` returns an `SdfGrid`; `voxel.toMesh(grid, { iso?, smooth?, sharp? })` | `surface` (toMesh) | `voxelSize` (> 0), `band` (voxels, >= 1); a non-empty grid |
| `voxel.union(faces?, { voxelSize, radius })`, `voxel.offset(faces?, { voxelSize, distance })`, `voxel.fillHoles(faces?, { voxelSize })` | `surface` | `voxelSize`, `radius` (>= 0), non-zero `distance` |
| `simplify(faces?, { targetFaces?, maxError?, quadric?, clearance?, maxAspect?, maxValence?, silhouette?, preserve? })` | none (triangles keep their face's role) | `targetFaces` (export triangles; a quad counts 2) or `maxError` (meters) |
| `cleanup.quads(faces?, { maxAngle?, maxPlanarity? })` | none (quads keep their triangles' attributes) | `maxAngle` in [0, 90) degrees, `maxPlanarity` >= 0 |
| `lowpoly(faces?, { targetFaces, union?, hardAngle?, silhouette?, quads?, slivers?, uv?, tags? })` | `lowpoly` (every output face) | `targetFaces` (integer >= 4, export triangles), `hardAngle` in (0, 180), every part closed with positive volume |
| `remesh(faces?, { targetEdgeLength, iterations, smoothing?, clearance?, adaptive?, preserve? })` | none (triangles keep their face's role) | `targetEdgeLength` (> 0), `iterations` (1 to 100) |
| `cleanup.tiling(faces?, { maxError, maxAspect?, iterations?, clearance?, preserve? })` | none (triangles keep their face's role) | `maxError` (> 0), `maxAspect` (> 0), `iterations` (1 to 100) |

## Selector vocabulary

Faces: `sel.all()`, `tag`, `createdBy(label, role?)`, `material(slot)`, `mirrored()` (faces
a `mirror` copied), `facing(axis, deg)`, `extreme(axis)`, `inBox`, `side`, `near(point, k)`,
`thin(maxWidth)`. Face modifiers: `.largest()`, `.smallest()`, `.grow(n)`, `.shrink(n)`,
`.connected('any' | 'smooth')`, `.boundary()`, `.toEdges(include)`, `.toVerts(include)`.
Edges: `sel.edges.parallel(axis)`, `perpendicular`, `dihedral('>', deg)`, `concave`,
`sharp`, `meshBoundary`, `all`; `.loop()`, `.ring()`, `.toFaces()`. Any selector combines
with `.and/.or/.minus/.not` and asserts its size with `.one()`, `.exactly(n)` or
`.atLeast(n)`.

## Primitives

Primitives use conventional parameter names, shapes and orientation, and the kernel
conventions: magnitudes are required, angles are degrees (`angle`, never radian),
and `center` offsets the result. Degrees are a kernel-wide decision,
shared by `facing`, `dihedral`, `rotate`, `autoSmooth` and `revolve`/`torus`, so an
author never mixes units between selectors and operators. `revolve` and `extrudePolygon` have
no `center`: their profile coordinates place them.

| Primitive | Shape |
|:--|:--|
| `plane({ width, height, widthSegments?, heightSegments? })` | quad grid in XY facing +Z |
| `cylinder({ radiusTop, radiusBottom, height, radialSegments, heightSegments?, openEnded? })` | along +Y; a zero radius ends in a pole |
| `cone({ radius, height, radialSegments, heightSegments?, openEnded? })` | apex at +height/2 |
| `sphere({ radius, widthSegments, heightSegments })` | quad bands, triangle fans at the poles |
| `torus({ radius, tube, radialSegments, tubularSegments, angle? })` | ring in XY around +Z, starting at +X |
| `revolve({ points, segments, angle? })` | `[radius, y]` profile about +Y, starting at +Z |
| `extrudePolygon({ points, holes?, depth, steps? })` | `[x, y]` outline and hole outlines, z = 0 to depth |

- `cylinder`, `cone`, `sphere` and `torus` are profiles of the one `revolve` kernel.
  A profile listed bottom to top faces outward; ends on the axis become poles, and an
  end segment that is also perpendicular to the axis becomes one n-gon cap with a
  sharp rim. Only profile ends may touch the axis; a last point equal to the first
  closes the profile.
- `extrudePolygon` accepts either winding and a closing duplicate point; caps are
  n-gons with sharp rims, walls are smooth. Self-crossing outlines are rejected.
  `holes` are outlines strictly inside `points` and outside each other (crossing,
  touching or nested holes are `model-invalid-argument`); they become through holes
  with `hole` walls, and each cap becomes a convex partition of the domain (earcut-style
  hole bridging, ear clipping, then Hertel-Mehlhorn merging), so every cap face is
  convex and both caps carry the same faces.
- Closed results assert a positive enclosed volume. An inside-out profile fails with
  `model-degenerate` and a hint to reverse the point order.

## Region operators

`extrude`, `inset` and `offset` share one base, `extrudeRegion` (disconnect ->
displace -> stitch): region vertices shared with the rest of the mesh are duplicated
at their new position, the others move in place, and one wall quad grows from every
region boundary edge. Walls copy the material, flags and tags of the face they grow
from (role identity only from a `label`); both strip
boundaries keep their edge intent and the new rung edges are smooth. `region` is
`merged`, `perFace` or `perIsland` (each edge-connected group of selected faces).

- `extrude` moves a group along its area-weighted normal; `offset` solves each vertex
  displacement against its incident region face planes (exact for up to three
  directions, least squares on curved regions), clamped at 4 x `distance`, so every
  face plane moves by `distance` where it can. Faces whose plane moved otherwise are
  reported in `diagnostics` with the moved range and how many touch clamped corners.
- `extrude` asserts its effect (design 7.4, soft): each group moves by `distance` along
  its normal within `tolerance`, and a closed mesh's volume changes with the sign of
  `distance`; otherwise a warning reports the measured move or volume change (for
  example f64 rounding far from the origin).
- `disconnect` detaches faces in place; it fails with `model-op-no-effect` when they
  already form a separate island. `duplicate` copies them as a new island.
- `append` copies another session or an FXEM snapshot; tags, labels, roles and material
  slots merge by name. A poisoned operand is `model-precondition`.
- `bridge` joins two closed boundary loops (delete faces first, then select
  `sel.edges.meshBoundary()`); the pairing rotation minimizes squared distances. Strip
  faces inherit the tags both sides share; when the sides use different material
  slots, pass `material`.

## Shell

`shell` thickens whole parts into walls. `faces` must
be complete parts (no edge borders an unselected face, else `model-precondition`); `open`
faces among them are removed first, so the top of a box or a vent slot becomes a rimmed
opening. `direction` is `in` (default), `out` or `both`.

- Each vertex moves along its angle-weighted pseudo-normal. Where at most three distinct
  face planes meet, the displacement solves them exactly, so every planar wall is exactly
  `thickness`; more planes (curved parts) use the angle-weighted least-squares length
  along the pseudo-normal. Displacements are clamped at 4 x `thickness` and reported.
- The selected faces stay the outer surface and keep their tags, labels and roles (moved
  for `out` and `both`); a reversed copy gets role `inner` (copying corner values, edge
  intent, material and tags) and one `rim` quad closes each open boundary edge (a rim that
  twists out of plane splits into two triangles along its shorter diagonal, reported as
  `info`). Rim borders
  are marked sharp; rims carry no corner values, so re-project UVs afterwards.
- Local feature size: before changing anything, a ray from every moving vertex finds the
  nearest wall ahead (another shelled wall meets it halfway, any other face at the full
  distance), and a bisection finds the thickness at which an offset face would collapse,
  invert or overlap itself. A thickness beyond that fails with `model-precondition`,
  `detail.maxThickness`, `limitedBy` (`clearance` or `collapse`) and the vertices or faces
  and a point; `clamp: true` shells with 95 % of `maxThickness` instead and warns.
- A band tighter than the thickness (a fillet or roll of radius r < t, a run-out to a
  crease) is mitered before that check fails: its collapsing faces, grown while their
  neighbours still collapse, move by the miter of the two planes that bound them (the
  inner surface trims to a crease as in CAD), blended with their own offset for r between
  t and 2t, and an `info` lists them. Keyed on geometry only; when faces still collapse
  (a genuinely thin body), the error above is unchanged, and shells that fit already
  are byte-identical. The miter takes two planes per vertex, so a corner where three
  bands meet (a box with every edge rounded below t) still collapses (`limitedBy:
  'collapse'`): give such corners a radius of at least t.
- Parts of one call should keep `thickness / 3` apart wherever their skins are that far
  apart, checked face to face on the planned walls (so a crease corner beside a neighbour's
  corner counts); near walls are a located thickness warning (`detail.nearWalls`: inner vertex,
  thickness, wall distance, partner face), which `validate()` repeats as a `thin-wall` issue
  with `detail.check: 'shell-clearance'`. Only `clamp: true` with direction `in` relieves them
  (`detail.relieved`): the near vertices are thinned by bisection to at least a third, or the
  call fails with the located `clearance` error; otherwise the walls stay as planned.
- Effect assertions (design 7.4, soft): each outer face plane is `thickness` from its inner
  copy within `tolerance` plus 0.1 % (curved walls), otherwise a warning lists the faces
  and the measured range; crossings between the shell's faces and any face are detected
  exactly afterwards (hard): the call fails with `model-degenerate` (`detail.pairs`, and
  `detail.at`, the crossing midpoints) and leaves the mesh unchanged.

### Return flange

`flange: { reach, depth, radius?, round?, at? }` turns open edges under the panel instead of capping them
with a flat rim, as pressed body panels are hemmed (`at` limits it to the open edges of
those faces; default every open edge). The outer wall runs `depth + thickness` down each
folded edge; under the panel the faces within `reach` of the fold (whole faces, at least
one ring, plus the faces between where the band would touch itself at a vertex, as on a
fan of long cells) are copied at `depth` (top, facing the panel) and `depth + thickness`
(bottom), the gap is `depth - thickness`, and the fold's inner side is inset by the
thickness across the edge (mitered at corners), so the fold keeps the wall thickness. End
walls close the band where it stops, and a cap closes a fold where it meets a plain rim.
Faces get role `flange`; their borders are sharp. Corners mitered across a crease are
triangulated.

It fails with `model-precondition` (`detail.point`), before changing anything except for the last case, when:

- the band's offset folds or reaches another wall at `depth + thickness` (as for the shell
  itself): `detail.maxDepth` and `limitedBy`; reduce the depth or keep the flange off the
  blend with `at`;
- a fold ends at a concave corner, or a corner between two folds turns its faces by more
  than 90 degrees (the cap would lie on the plain rim, or the mitered inner side would
  leave the panel): flange both edges of the corner or end the flange one face earlier;
- a ring along a folded edge is narrower than the thickness (a support loop or a cut's
  sliver), so the fold's inner side would pass its far side: `detail.width`; remove the
  narrow ring, thin the shell, or keep the flange off it (a trimmed panel's cut needs a
  `trimRing`, see Surfaces);
- a flange's band covers its whole connected panel while `reach` is at least the panel's
  extent from the folded edges (`detail.panelReach`): the flange would be a second skin;
- a fold ends where the panel's open edge runs back over its cap (a straight junction on
  a tight blend): end the flange where the edge runs straight or turns away, or flange the
  neighbouring edge too. The last check runs on the built faces, so the session is
  poisoned as for any failure.

`depth` must exceed the thickness and `clamp` is refused with a flange.

`radius` (default 0, the square fold above, unchanged) rounds the fold: both bends turn on
concentric arcs of inner radius `radius` and outer radius `radius + thickness` (six faces
per quarter turn), so the fold keeps the wall thickness. A hem is the largest radius: half
the gap less a straight wall of 2% of the fold's height on each side, `detail.maxRadius` of
the `model-invalid-argument` a larger one fails with (for `direction: 'in'`,
`(depth - thickness) / 2 - (depth + thickness) / 50`); `reach` must exceed
`radius + thickness`. `round` (not with `radius`) rounds only the skin edge of a square
fold, tangent to the skin and the outer wall; past the thickness the fold's inner corner
rounds by `round - thickness`. Both go through the bevel engine on the built faces: the
skin-side arc gets role `bevel` (`corner` where two meet), so it is part of the skin for
`shutLines` (a round widens the visual gap, not the gap on the theoretical line), and the
other bends get role `flange`; all bends of one shell call round in one bevel. A radius the
bevel would clamp (faces along the edge, the flange or the wall too narrow) fails with
`model-precondition` and `detail.minWidth` instead of a thinner round. A rounded fold must
end at another flange (or close its loop): where a plain rim goes on it fails with
`model-precondition` before changing anything, so give the neighbouring edges a square
flange in an array.

An array gives each flange its own `reach`, `depth`, `radius` and `round`, each limited by
its `at` to the open edges of those faces. An open edge claimed by two flanges (two
overlapping `at`, or one without `at`) is `model-invalid-argument`, as is a flange whose `at`
holds no face with an open edge (`detail.flange`), and flanges whose bands share a vertex
must have the same `depth`.

## Cutting

Cuts rewrite faces through one helper: inserted vertices interpolate the corner values
of the edge they split, pieces of a split edge keep its intent, and new cut edges are
smooth. Existing UVs therefore survive a cut without re-projection.

- `loopCut` walks the edge ring through each selected edge: across every even-sided
  n-gon it leaves by the opposite edge (an octagon cap is crossed like a quad), and
  odd-sided faces and boundaries end the ring; those faces only gain the new
  vertices, also from several rings (the five rim rings of a pentagonal cylinder all
  end at its caps). A face crossed by two rings is `model-precondition`. Pick seed edges with
  `sel.edges.parallel(axis)`, `sharp()` or `dihedral()`.
- `bisect` splits every face the plane crosses (vertices within `tolerance` count as
  on it), pairing crossings along the section line so concave faces split correctly.
- `planeCut` bisects and deletes the side opposite `keep` (`positive` is the side the
  normal points to). Openings stay open unless `fillHoles: true`, which closes each
  opening with an n-gon `cap` (sharp rim; rim material inferred, or `material`
  when the rim uses several slots, otherwise `model-invalid-argument`). Effect assertion: no vertex remains on the
  removed side.

## Topology cleanup

- `dissolve` removes interior edges and merges the faces on each side into one n-gon
  per connected group (attributes of the lowest face, union of tags, boundary corner
  values kept, orphan vertices removed). Unselected interior edges of a merged group
  are removed too and reported, with how many were sharp. A merge that would need a hole or pinches its
  boundary is `model-precondition`; mixed material slots are `model-invalid-argument`.
- `split` rips the mesh along interior edges: corners around each touched vertex form
  fans that do not cross a selected edge, and extra fans get vertex copies. Edges whose
  cut neither reaches a boundary nor closes a loop stay joined and are reported.
- `orient` flips inside-out closed components touched by the selection; open
  components have no inside and are left unchanged.
- `triangulate` produces exactly the triangles export would: it starts at the same
  canonical corner, fans strictly convex faces and ear-clips the rest in the best-fit
  plane. A face ear clipping cannot resolve overlaps itself and is `model-degenerate`,
  in `triangulate` and in export alike (no fallback fan: in 300k random lattice loops
  that ear clipping rejected, a fan always contained an inverted triangle).
- `fillHoles` closes every boundary loop containing a selected boundary edge with one
  `cap` n-gon (sharp rim; rim material inferred or `material`). Loops are traced from
  the selected edges only, so unrelated openings never fail it, and a pinched vertex
  (two holes meeting at a point) separates the loops there. Non-planar caps are
  reported.

## Lifting existing meshes

`lift(meshAsset)` brings an ordinary triangle-list `MeshAsset` into the session:
positions weld by exact f32 value (no tolerance), `uv`..`uv7` and `color` splits
become corner values, material slots merge by name, and an edge whose two faces carry
different normals at either end becomes a sharp edge, so exporting the lifted mesh
reproduces the source hard edges. Triangles that would put a third face on an edge or
oppose a neighbor's orientation are detached onto their own vertices, and triangles
collapsed by welding are skipped; both are reported as warnings. Merge the triangles
back into n-gons with `dissolve(sel.edges.dihedral('<', degrees))`.
Vertices where corner fans meet only at a point (bowties) are split into one vertex
per fan and reported. The design's per-vertex `sourceVertex` mapping is deferred until
the kernel has vertex scalar layers; lift reports split counts only.
