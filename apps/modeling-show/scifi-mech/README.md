# scifi-mech

Case C-410 (T1 sci-fi mech, high-to-low bake) on the Show turntable: the Warden's low meshes with
their baked normal, albedo, ORM and emissive maps, and the decimated detail preview. It is the `c-410`
subject of the interactive 3D pages (`../scripts/show-rebuild.mjs`). The Pack is forgeax-modeling
`examples/scifi-mech/scifi-mech.pack.ts`; its meshes and textures are `modeling-mesh-job` cook
sources of the show jobs (`show-job.ts`), registered by `assets/build.ts`.

The debug panel's Bake row switches Low mesh / High mesh and Baked maps / Plain (`bake` control,
`../README.md`). The map-channel viewer of the `bake` schema is not built. Shading modes and the part
list are the common ones.
