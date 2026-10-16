# Hello Cinder Fall

This is the small downstream consumer for the shared Program v3 VFX baseline.
`CinderFallCast` owns only gameplay phase, fixed-tick timing, the impact anchor,
and one-shot hit observation. Particle simulation, materials, meshes, camera,
lighting, shadows, and submission remain Engine owners.

The source declares three effect emitters (`cinder.travel`, `cinder.impact`,
and `cinder.burn`) and keeps the existing bounded channel/event/sub-emitter
shape. It does not introduce an app-local shader loader, raw RHI access, a CPU
particle mirror, or a second submit path.

The five status checkpoints are stable text states: `release`, `mid-travel`,
`impact`, `burn`, and `fade`. The original reference frames are not available
in this checkout, so this app proves structure, timing, replay, and cleanup;
it does not claim pixel parity with the source material.

The Browser smoke drives the public App fixed-frame path and captures five
bounded canvas checkpoints. It fails closed on missing VFX pixels, failed
RenderFeature diagnostics, missing reflected `camera`/`scene-depth`/`noise`,
missing custom ascending/descending sort declarations, an uncommitted
parameter patch, or an unconsumed impact channel. It closes the Playwright
lease after dispose; the Dawn smoke remains the 60-frame compute/raster
validation.
