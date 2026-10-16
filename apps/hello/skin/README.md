# `@forgeax/hello-skin`

Khronos `Fox.glb` Standard PBR carrier: three independent instances play the
`Survey`, `Walk`, and `Run` animation clips through the imported glTF scene,
`Skin`, and `AnimationPlayer` path. The carrier exercises the same
`forgeax::pbr-skin` material route used by a production skinned model; it is
not a synthetic unlit cube.

## Quick start

```bash
pnpm --filter @forgeax/hello-skin dev
```

Expected first frame: three lit Fox models, one per clip, under a shared
parented rig. Use `[1] Survey`, `[2] Walk`, `[3] Run`, `[4] Walk -> Run blend`,
`[5]` three-way blend, and `[Space] Pause` to exercise the variable animation
slot columns.

## GPU-driven skin carrier

The browser path loads the scene and clips by GUID, then the glTF importer
projects the material with `toMaterialAsset(..., { skinned: true })`. That
producer fact selects `forgeax::pbr-skin`, while the renderer owns the
prepared Standard PBR pipeline and the persistent palette address. The
headless carrier follows the same path in
[`smoke-dawn.mjs`](scripts/smoke-dawn.mjs), including the real Fox source and
the three independent `AnimationPlayer` handles.

| Carrier fact | Evidence / owner |
|:--|:--|
| Standard PBR animated material | `toMaterialAsset(..., { skinned: true })` -> `forgeax::pbr-skin`; bridge route is covered by [`bridge-skin-shader-route.unit.test.ts`](../../../packages/gltf/src/__tests__/bridge-skin-shader-route.unit.test.ts) |
| Persistent palette address | `SkinPaletteReceipt.customDataStart` remains stable for an unchanged generation |
| Stable pose | allocator receipt reports `dirtyRanges=[]` and `uploadBytes=0`; see [`skin-palette-persistent.unit.test.ts`](../../../packages/render/src/__tests__/skin-palette-persistent.unit.test.ts) |
| Changed pose | changed joints are merged into one minimal dirty range and upload only that range; the same test proves `startJoint`/`jointCount` |
| Missing producer bounds | the candidate stays on `cpu-deformation` with `reason=skin-bounds-missing`; the render integration regression covers this recovery lane |

The source Fox metadata currently has no producer-authored conservative skin
bounds. That is an honest CPU recovery case: the importer does not invent a
bind-pose AABB. A producer that supplies finite animated bounds can be
admitted to the GPU skin/shadow lane; the bounds schema and loader preserve
that explicit fact.

## Smoke and palette evidence

```bash
pnpm --filter @forgeax/hello-skin smoke
```

The Native Dawn smoke runs 60 frames, reads pixels, checks renderer errors,
and intercepts the real `skin-palette` queue writes. After the animated
window it pauses all three players, settles one frame, and requires two
unchanged frames with `stableWriteBufferDelta=0`; it then resumes and requires
a dirty write. This is write-payload evidence for the runtime receipt contract,
not a claim of physical GPU timing. The RhiNull unit gate is the direct proof
of `uploadBytes=0` and merged dirty ranges.

## Fresh worktree prerequisite

If you cloned a fresh contributor worktree, hydrate the binary asset sidecar
and build the workspace before starting Vite. The worktree bootstrap is
deliberately explicit so a missing package declaration cannot be mistaken for
an `asset-not-imported` runtime failure:

```bash
git submodule update --init --recursive
cp <main-tree>/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm packages/wgpu-wasm/pkg/
pnpm install --frozen-lockfile
pnpm build
pnpm -F @forgeax/hello-skin dev --strictPort
```

## Pipeline

```text
Fox.glb -> glTF parse/import -> GUID Catalog -> SceneAsset instantiate
-> Skin + AnimationPlayer -> transform propagation
-> persistent SkinPaletteReceipt -> forgeax::pbr-skin Standard PBR draw
```

`SkinPaletteAllocator` owns the persistent storage slice. A generation
replacement uploads every joint into its new address; an unchanged pose emits
zero bytes; a changed pose emits only coalesced dirty ranges. Missing bounds
remain an explicit CPU deformation lane until the source producer publishes a
finite conservative animated bound.

Further owner navigation: [`packages/render/README.md`](../../../packages/render/README.md#gpu-driven-pbr--shadow--skin-navigation),
[`packages/runtime/README.md`](../../../packages/runtime/README.md#gpu-driven-pbr--shadow--skin-navigation),
and the importer bridge tests linked above.
