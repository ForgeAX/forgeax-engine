# UV primitives

`assets/uv-primitives.pack.ts` is a fixed, build-time procedural Pack with exactly
three mesh outputs. It uses the project's existing white material and the normal
Pack producer, Catalog and mesh preview path. No runtime generator is installed.

| Source key | Shape | Triangles | UV0 islands |
|:--|:--|--:|--:|
| `mesh/triangular-ramp` | 2 x 2 x 2 triangular prism | 8 | 5 |
| `mesh/half-cylinder` | Radius 1, height 2, 180 degrees, 32 arc segments | 132 | 4 |
| `mesh/quarter-cylinder` | Radius 1, height 2, 90 degrees, 16 arc segments | 68 | 5 |

Y is up. Cylindrical caps retain their semicircle/quarter-circle outlines and
radial triangle fans. The curved surface unwraps by arc length into a continuous
rectangular strip with matching angular columns. Cut faces have separate planar
islands; the half-cylinder's diameter is split at the cap center to keep the solid
watertight. Normals are smooth on the arc and hard at cap/cut boundaries.

All UV0 islands are inside 0-1 without overlap, with one uniform physical scale
and 0.12 model-unit gutters before normalization. There is no extra UV channel:
select **UV channel 0** in View. The small difference between curved strip and
faceted triangle area is bounded by the 5.625-degree angular sampling.

The layout follows the seam/unwrapping/island packing principles described in
[Epic's UV tools documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/uvs-category-in-unreal-engine).
The reference images guide the shape and topology, not stored geometry data.

Template disposition: retain the existing runtime/controller, player/animation,
scene composition, materials, lighting, UI and template tests because this task
adds inspection assets to the Game 3D capability reference, not a new game.
Only the three requested meshes and their tests/documentation are added.

Local validation on 2026-10-21: all 44 project tests and `tsc --noEmit` pass.
The native producer publishes all three outputs in the live Game 3D Catalog;
View renders the half-cylinder and its four UV0 islands. `asset verify` admits
the Pack source identity, but that command alone does not execute generation.
The separate `project check` dependency-record limitation is recorded in
`feedback.md`.
