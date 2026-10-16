---
name: forgeax-engine-vfx
description: ForgeaX code-first GPU VFX authoring, cooking, playback, and rendering. Use when creating, loading, debugging, or extending particle, ribbon, trail, beam, billboard, or mesh effects.
---

# ForgeaX VFX

## Render happy path

VFX is a producer of a closed `RenderFeaturePlan` in the single
`RenderScene -> Standard Pipeline -> DeviceScope -> FrameReceipt`
path. The host performs `attach` and `draw`; use receipt-bound `inspect`,
`observe`, and `recover` for diagnostics. VFX never owns device, queue,
encoder, finish, or submit.

Use one path:

1. Author schema-v3 emitter metadata with `program: { module }`, required fixed bounds, schedule, and renderer GUIDs.
2. Author `vfx_spawn` and `vfx_update` in WGSL; import `forgeax_vfx::prelude` and shared shader modules with `#import`.
3. Cook with `createParticleCodeNativeCooker(modules)`; publish payload and `particle-effect/program.json` atomically.
4. Create one `createVfxRuntimeHost({ camera })`, attach each `{ world, assets }`, and register `host.feature` with the Renderer.
5. Load by GUID with `loadVfxGpuEffect`, allocate a shared `ParticleEffectAsset` ref, and spawn `ParticleEffectPlayer`.

Read [`packages/vfx/README.md`](../../packages/vfx/README.md) for the author ABI and lifecycle, [`packages/vfx-compiler/README.md`](../../packages/vfx-compiler/README.md) for reflection and cook errors, and [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md) for GPU/render ownership.

Every particle topology fogs at its own depth through the shared
`translucent_fog`; alpha blending adds in-scattering and additive blending only
attenuates. Particles never need an effect-side fog term.

> [!IMPORTANT]
> Behavior belongs in WGSL code, not a node/operator graph. Do not add CPU mirrors, runtime compilation, backend-name checks, direct RHI access, particle readback, or demo-side render workarounds.

Switch on structured error codes and use `detail` plus `hint`. Unknown source fields fail closed. Batch B accepts executable billboard advanced fields and independent ribbon, trail, and beam topologies. It does not add CPU fallback, runtime compilation, raw author bindings, CPU particle mirrors, gameplay readback, graph authoring, or VFX RPC.

For static-scene collision, import `forgeax_vfx::data::scene_sdf` and supply
`createVfxRuntimeHost({ camera, sceneSdf: { read(world) } })` with a fixed World
range and explicit budgets. Cook geometric fields on ordinary Mesh GUIDs through
Import; sampled-visibility data cannot qualify collision. Renderer owns retained
scene projection, sharing, graph production and fence retirement. Follow
[the host contract](../../packages/vfx-render/README.md#managed-scene-sdf-collision)
for bounded response, approximation error and structured unavailable results.
Use RHI Debug to inspect the actual producer/consumer work before changing the
collision shader; a successful replay alone does not establish collision quality.

For editor/tool inspection, narrow registry payloads with `isVfxGpuEffectAsset`
and project them through `describeVfxGpuEffect`. The immutable descriptor owns
the emitter tree, timeline, dependencies and executable/partial/unavailable
capability truth without exposing compiler objects or raw WGSL bytes.

For wind, attraction or vortex motion, declare emitter `forceFields` and import
`forgeax_vfx::data::force_fields`; call `vfx_apply_force_fields` before the authored
integration. Produce saved constant/radial/vortex textures with build-time
`createVfxVectorFieldTexture` from `@forgeax/engine/vfx-compiler`, publish ordinary
texture GUIDs, and load the effect GUID. The owning [field contract](../../packages/vfx/README.md#managed-force-fields)
defines transforms, units, sampling and limits. Diagnose a failed field through
its structured plan cause and the ordinary asset producer. Run
`smoke:fields` for the bounded independent trajectory/capture probe and
`scripts/smoke-fields-browser.mjs` against the prepared DEV/build server for
transport and paired pixels; use the maintained per-owner GPU lease entry.

Inspect runtime state with `host.inspect(world)`. The aggregate is keyed by host
generation, player handle, asset GUID and emitter ID; do not collapse it back to
one latest intent or treat a realm-local handle as cross-World identity. Recover
through the owning generation/LKG path. For asset changes, run
`node scripts/asset-cook-contract.mjs`; a package-local scripts path is invalid.
For a live, same-generation preview control, acquire `host.acquireControl(world)`
and use its typed `patchPlayerParameters` or `submitChannel` methods. Their
generation and structured errors are the evidence boundary; do not reach
through `VFX_GPU_RUNTIME_RESOURCE_KEY` to mutate an instance directly.
Verify with:

```sh
pnpm --filter @forgeax/hello-boss-lightning smoke:browser
pnpm --filter @forgeax/hello-boss-lightning smoke
pnpm --filter @forgeax/hello-boss-lightning smoke:falsify
node apps/hello/boss-lightning/scripts/smoke-public-only.mjs
pnpm metrics:check
pnpm metrics:run
```

Browser and Dawn are required because Null structural success cannot prove compute validation, topology draws, or pixels. Visual evidence records `advanced-renderers-visible`, `live-patch-continuity`, `event-sub-emitter-visible`, and `hmr-last-known-good-visible` with a PNG and falsifier result. Program v3 custom billboard sorting is executable only when the source declares one typed `VfxCustom` sort field; the compiler and managed GPU pass reject ambiguity instead of silently falling back to emitter order.
