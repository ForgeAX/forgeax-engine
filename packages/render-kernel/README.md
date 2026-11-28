# `@forgeax/engine-render-kernel`

Switchable TypeScript and Rust (WASM / native) rendering kernel implementing the
ForgeAX RenderKernel V1 binary ABI:

- 32-bit generational handles (`generation:12 | slot:20`, `0` invalid sentinel).
- Binary `SceneDelta` (`FXK1`) incremental scene, transform, skin, light, material
  parameter, and `DynamicTextureId` revision synchronization.
- Fixed 4-BGL layout contract (`[view, material, mesh-array, instances]`) with
  128-bit integer `PsoKey` lookup.
- Synchronous `cull()` returning a frame-scoped `CullId` and lightweight summary.
- Zero-allocation imperative `FrameRecorder` writing a compact `Uint32Array`
  command stream with two-pass linear transient RT pooling, conflict detection,
  compatible raster pass batching, `CMD_DRAW_RENDERERS` sorting/instancing, and
  shared-handle RHI passthrough.
- Linear physical command replay onto any `@forgeax/engine-rhi` device (WebGPU,
  Dawn, `RhiNull`, and `@forgeax/engine-rhi-debug` capture/replay).
- Native `wgpu` 30 desktop backend (`@forgeax/engine-render-kernel/native`,
  `rust/crates/kernel-wgpu`, `rust/crates/kernel-napi`): dedicated OS render
  thread with `winit` window/surface presentation, 4-BGL PBR + TBN normal maps +
  2x2 CSM shadows + GPU skinning + custom WGSL hot reload + Fog/Skybox/Bloom/FXAA
  + 3D DebugDraw lines + RGBA UI overlay + live GPU memory budgets & device-lost
  recovery.
