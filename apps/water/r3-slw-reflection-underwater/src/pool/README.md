# Interactive Pool

Open `/pool.html` on this app's Vite server. The normal app build includes both
the existing Water R3 entry and the pool entry.

The pool is a separate optical experiment using the current Engine's pure
`forgeax_optics::interface` refraction, mapped-area and relative-concentration
primitives. It shares Water's field declarations, additive raster pass, concentration
regularization and FP32 height sampling through `@forgeax/engine/water/caustics`.
Its cooked MaterialAssets run through one ordinary RenderFeature;
the Engine retains device, graph, queue and resource lifetime ownership.
It does not change the R3 scene or its Gerstner/Deferred receiver implementation.

One 256-square CPU height/velocity field evolves at a fixed 120 Hz with reflecting
edges and damping. The ordinary AssetRegistry texture range write publishes its
native R32F heights through a byte view of the solver's Float32Array. Both the
water surface and the optical producer load this same texture and interpolate
in FP32. No packed-channel filtering, quantized zero crossing or duplicate normal
texture participates. The material declares an unfilterable-float input, so this
path needs no optional FP32 hardware filtering feature. Pool-edge samples clamp
to match the reflecting solver. The pool does not infer local disturbances from
Gerstner waves.
The CPU solver is a bounded reference implementation, not a GPU performance claim.
Startup and Reset leave the surface completely still, with gravity disabled.
Only pointer/touch disturbances and moving the sphere introduce ripples and their
changing concentration pattern. No preset disturbances or background waves run.

The 512-square optical source grid traces refracted rays to the pool box, unfolds
hits along the flat-interface refracted direction, and additively rasterizes
relative irradiance into a 1024-square RGBA16F graph target. Triangle concentration
is regularized and bounded to twelve before accumulation. Its binary spacing
aligns two optical cells per simulation texel, gives shared vertices identical
coordinates and limits a flat-interface cell to 1.5 field texels. This reduces
piecewise-constant triangle patches without changing additive energy accounting.
The source pass draws 1,572,864 vertices; the field remains 8 MiB and the height
texture remains 256 KiB. The analytic receiving
shader shares this projection across floor, walls and sphere, with sphere/rim
soft occlusion, Fresnel reflection/refraction, reference water tints and total internal
reflection. Sphere receiving remains a reference-plane projection approximation;
neither arbitrary scene geometry nor multi-bounce light transport is implied.

The host uses device pixel density up to 2x. The analytic scene integrates four
subpixel reflection/refraction rays per output pixel, so sphere and water edges
receive coverage filtering even though they are intersections inside a fullscreen
fragment (ordinary raster MSAA cannot cover these edges). Tile sampling selects
trilinear mips from an explicit ray-cone footprint instead of a fixed mip. The
after-tonemap pass writes display values directly, including the reference water
tints and a procedural sky calibrated to its muted blue reflection.

`assets/pool.pack.ts` owns fixed procedural assets, not a public configurable
generator: deterministic glazed tile pixels, initial flat water data and the two
material recipes. Pool/sphere geometry and sky are
analytic shader functions. There are no downloaded textures, meshes or sky images.
Generated Catalog/DDC/build products are derived. Load uses ordinary Pack GUIDs.

Click or drag on water to add ripples. Drag the sphere to move it. Right-drag or
drag the background to orbit, and scroll to zoom. Space pauses simulation, G
toggles gravity, C toggles caustics, L aims the light from the camera and R resets
the water and sphere. The panel also exposes gain and a caustic-field view.

`window.__poolDemo.readState()` reports completed frames, actual feature submission
count, current field identity, bounded errors and Renderer inspection. `disturb`,
`setPaused`, `reset` and `dispose` support repeatable browser acceptance.

The default camera, cutaway, water tints, peaked normal lookup and analytic soft
shadows follow Evan Wallace's [WebGL Water](https://madebyevan.com/webgl-water/).
Its MIT notice is retained beside the adapted shaders. Textures and sky images
are replaced with procedural content; this is visual/behavioral reproduction,
not identical source-image pixels. The field uses the current Engine's area and
concentration primitives with additive overlap, rather than the reference's
8-bit overwrite pass.

Run the real 60-frame browser journey against the running server:

```sh
FORGEAX_CHROME_CHANNEL=chrome FORGEAX_BROWSER_GPU=native node scripts/pool-browser.mjs http://127.0.0.1:5387
```

It checks 2x device drawing-buffer resolution and a sub-micrometre wave against
the flat caustic field (rejecting spurious bright fragments), compares caustics on/off pixels,
injects a real canvas click, drags the sphere,
orbits, toggles gravity and captures both the underwater view and projected field.
Evidence defaults to a temporary directory outside the source checkout.
