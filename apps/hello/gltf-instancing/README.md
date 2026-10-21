# hello-gltf-instancing

> feat-20260518-gltf-instancing-and-name-component M5 demo.

End-to-end proof of `EXT_mesh_gpu_instancing` plus the per-node `Name`
component, walking the same `assets.load(guid, 'scene')` +
`assets.instantiate` path that `apps/hello/gltf` uses (charter P4
consistent abstraction).

## What it does

1. `parseGltf(instanced-box.gltf)` decodes the glTF document, including
   the `EXT_mesh_gpu_instancing` payload (TRANSLATION accessor for N=4
   instances). The importer composes `N*16` column-major mat4 floats into
   `NodeIr.instancing.transforms` (no GPU upload yet).
2. `gltfDocToSceneAsset(doc, ctx)` converts the IR into a `SceneAsset`
   POD without a Renderer or a runtime collection-ID map. The `InstancedBox`
   node receives:
   - `Transform` (translation/rotation/scale from glTF node TRS)
   - `MeshFilter` + `MeshRenderer` (mesh / material handles from `ctx`)
   - `Instances { transforms }` (World-owned per-instance mat4 data)
   - `Name { value: 'InstancedBox' }`
3. `assets.load(sceneGuid, 'scene')` admits the imported scene and its complete asset closure; `assets.instantiate(scene, world)` creates one entity per `SceneEntity`, retaining `Instances` on the instanced node. The app starts through `app.start()`.

## Fixture layout

```text
assets/
  instanced-box.gltf            # Tier-B box mesh + EXT_mesh_gpu_instancing N=4
  instanced-box.gltf.meta.json  # subAssets[]: mesh / material / scene UUIDv7
```

## Smoke invocation

```sh
pnpm --filter @forgeax/hello-gltf-instancing smoke
```

The full-roster invocation runs 60 frames through dawn-node, asserts
`backend === 'webgpu'`, frames produced >= 60, multi-pixel readback
distance from clear color above the threshold, and zero `RhiError`
events. Single SSOT for AC-13.

## Dev server

```sh
pnpm --filter @forgeax/hello-gltf-instancing dev
# vite -> http://localhost:5173
```
