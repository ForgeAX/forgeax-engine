# Vello preparation source

These are the crates.io releases `vello_gpu = 0.3.0`,
`vello_gpu_shaders = 0.3.0` and `vello_common = 0.3.0`. `UPSTREAM.json` records each archive URL and SHA-256;
each crate retains its original MIT and Apache-2.0 license files. No upstream Git
checkout, private fork or generated native binary is required to build them.

This is a source subset for Engine preparation. The optional upstream WebGL
self-probe feature, its helper modules/reexports, and its PNG/RGBA reference images
are omitted from `vello_common` and `vello_gpu`; Engine does not enable that
feature or call that private renderer. The active manifests expose no dangling
probe feature. `Cargo.toml.orig` retains the original release declarations for
reference. Runtime source, the rectangle/strip tests and upstream licenses remain;
Engine pixel validation uses the existing real-backend tests and independent
procedural oracles. Registry VCS metadata and the standalone common lock are also
omitted; the archive identity and owning UI Cargo lock are authoritative.

ForgeaX uses `vello_gpu` with default features disabled and only `portable` enabled.
It reuses the original scene, glyph, sparse-strip, layer allocation and filter
scheduler. `src/portable.rs` projects the schedule and shader-ready bytes through
the narrow [UI raster ABI](../rust/GPU-ABI.md). It imports no wgpu, WebGL, canvas,
surface, device or command queue. `vello_common = 0.3.0`, `glifo = 0.4.0`,
`peniko = 0.6.1` and `kurbo = 0.13.1` share the existing CPU UI release line.

The Engine delta is:

- `vello_common/src/strip.rs` handles exactly vertical, in-tile edges as
  clamped row height times signed pixel width. This 20-line specialization keeps
  coarse winding and the generic off-tile/diagonal path; it changes no strip
  bytes, GPU resource or ABI. One owning `[patch.crates-io]` entry shares the
  patched crate between GPU preparation and the CPU oracle. The upstream
  rectangle-versus-path tests run through the owning lock with
  `cargo +1.99.0 test --locked -p vello_common --lib strip_generator::tests` from
  `packages/ui-blitz/`. Because both raster paths share the kernel, also compare
  against frozen pre-change GPU outputs; mutual CPU/GPU parity alone is insufficient.
- The portable preparation module and its Cargo feature/serialization inputs.
- Exact single-contour rectangular fill and clip paths retain the existing native
  rectangle fast path after generic Shape conversion. Curves, additional contours,
  degenerate geometry and any nonzero off-axis transform coefficient retain
  sparse-strip preparation. Generic paths do not inherit the direct Rect API's
  near-axis approximation; the existing admission still handles axis-aligned
  transforms and antialiasing. This changes neither the raster ABI nor shaders.
  The public portable regression target runs with `cargo +1.99.0 test --locked
  --manifest-path vendor/vello_gpu/Cargo.toml --no-default-features --features
  portable --test rect_paths` from `packages/ui-blitz/`.
- Color-matrix support in `vello_gpu/src/filter.rs` and the matching
  `vello_gpu_shaders/shaders/filter.wesl`. Matrix payloads follow the unchanged
  48-byte filter headers in the sampled parameter texture. The existing layer
  planner supplies ordering and isolation; the new raster step uses the same
  36-byte instance layout.
- `vello_gpu_shaders/examples/export.rs` emits the version-matched linked WGSL.
  `shaders/*.wgsl` and `../src/gpu-shaders.ts` are generated companions; they are
  consumed by the existing Engine shader/RHI path without runtime filesystem
  reads or a second shader compiler.

The original wgpu backend requires wgpu 30. The portable feature does not compile
that backend or depend on wgpu; Engine owns the device through its shared pinned
wgpu source. GLSL 300 ES compatibility is verified through Engine Naga and the
real RHI path. The shaders use vertex instance buffers, uniforms and
sampled RGBA32Uint/RGBA8 textures; they do not require compute or shader storage.

CPU raster remains available as an explicit oracle. Normal GPU preparation never
produces or uploads a full-frame RGBA image. Glyph atlas caching is disabled by
the upstream default, retaining ordinary glyph-outline preparation and avoiding
the upstream atlas renderer's private submission path.
