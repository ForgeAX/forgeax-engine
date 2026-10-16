# @forgeax/hello-fbx-skin

FBX producer/import/load carrier for the prepared animated-skin path. The
source `humanoid.fbx` is imported through `fbxImporter`, retains GUID identity,
and instantiates multiple `Skin` entities with distinct animation clips.

## GPU-driven FBX carrier

`FbxRawSkeleton.bounds` or the explicit
`importSettings.conservativeAnimatedBounds` row is the producer-owned
conservative animated local bound. Missing or malformed bounds intentionally
keep the skin on the CPU deformation lane; this carrier never substitutes a
bind-pose AABB. Follow the shared offline route:

```text
renderer.inspect().renderScene.gpuDriven.channels -> repair FBX/import/shader producer -> recook -> retry
```

The owner navigation is [`render`](../../../packages/render/README.md#gpu-driven-pbr--shadow--skin-navigation),
[`runtime`](../../../packages/runtime/README.md#gpu-driven-pbr--shadow--skin-navigation),
and [`shader`](../../../packages/shader/README.md#gpu-driven-pbr--shadow--skin-navigation).

## Smoke

```bash
pnpm --filter @forgeax/hello-fbx-skin smoke
pnpm --filter @forgeax/hello-fbx-skin smoke:browser
```

The Dawn carrier proves deterministic import, scene instantiation, and palette
activity; the browser carrier owns delivery/readback evidence. Neither is a
physical-adapter performance claim.
