# Skinning and FBX troubleshooting

Use this reference for skinned pipeline, browser pack, animation, and FBX failures.

## pbr-skin pipeline build fail

**Signal**: browser console reports these failures in order; earlier messages are closer to the cause:

```
1) Binding doesn't exist in [BindGroupLayoutInternal "pbr-mesh-array-bgl"].
   - While validating vertex stage [ShaderModule "module-forgeax::pbr-skin#..."]
   - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor "pbr-pipeline-forgeax::pbr-skin"])
2) Vertex attribute slot 5 used in [ShaderModule "module-forgeax::pbr-skin#..."]
   is not present in the VertexState.
3) RhiError: limit-exceeded ... Invalid RenderPipeline "pbr-pipeline-forgeax::pbr-skin" is invalid due to a previous error.
4) [Invalid CommandBuffer from CommandEncoder "render-system-frame"] is invalid due to a previous error.
```

Messages 3/4 are consequences. Inspect preceding binding/vertex errors 1/2 for the pipeline rejection cause.

**Check**: use the Playwright browser probe to observe createRenderPipeline and uncapturederror. The direct Dawn fixture bypasses development Pack transport and cannot replace this browser validation path. Example: apps/hello/skin/scripts/smoke-browser.mjs.

**Two repair layers**:

| Layer | Cause | Repair | Status |
|:--|:--|:--|:--|
| L1 BGL shape | pbr-skin group 2 needs mesh binding 0 and palette binding 1, but receives standard PBR's one-binding layout. | buildPbrSkinLayouts creates the two-binding BGL; PipelineState stores pbrSkinPipelineLayout; layout selection accepts pbr-skin; record propagates materialShaderId into buildPipelineContext. | Fixed in bug-20260611. |
| L2 vertex attributes | Import omits JOINTS_0/WEIGHTS_0; upload/layout hardcode unskinned attributes, leaving shader slots 4/5 absent. | Carry skinAttrs through parser/bridge, support skinned upload and render-data layout, deriveVertexBufferLayout, and validate skinned mesh/material co-presence in extraction. | Fixed across bug/feat-20260611. |

**Call chain**:
```
render-system-record:3539  materialShaderId = entry.skin !== undefined ? SKIN_MATERIAL_SHADER_ID : ...
  ↓
createRenderer.ts buildAndCachePipeline(materialShaderId)
  ↓
buildPipelineContext(variantSet, materialShaderId)
  ↓
selectPipelineLayoutForVariant(state, variantSet, layoutKind = 'pbr-skin')
  ↓
state.pbrSkinPipelineLayout    <- L1: two-binding mesh-array BGL.
   +
ctx.vertexBuffers              <- L2: six-attribute layout.
```

Do not replace the demo's skin shader with unlit; repair the skinning owner.

---

## skin vertex attribute chain

**Signal**: browser reports missing vertex slot 5 or a 768-byte VBO (16 vertices at 48 bytes), while the skin shader needs 72-byte stride. Dawn passes 300 frames but browser output is black.

**Dependency chain**: JOINTS_0/WEIGHTS_0 must survive every stage:

```
parse-gltf MeshIr.skinAttrs (Float32Array x2)
  -> bridge.ts 18F interleave (4 pos + 4 normal + 4 uv + 4 idx + 4 weight)
  -> mesh-loader dual contract (Float32Array AND number[] both produce skin slots)
  -> render-data layout '12F' | '18F' + gpu-resource-store divisor=18
  -> buildPipelineContext deriveVertexBufferLayout(map) (no hardcode)
  -> render-system-extract fail-fast: 18F mesh ↔ pbr-skin material co-presence
```

A break can leave the direct Dawn path green because it bypasses development Pack serialization.

**Check**: smoke:browser layer 3 observes createBuffer/writeBuffer for vertexCount*72 skinned bytes versus *48 unskinned, plus skin pipeline variants. Historical green witness: 21 pipelines, one skin variant, Float32Array VBO with 1152 bytes.

**Repair**: follow L2 above across all six owners. Changing only buildPipelineContext leaves upstream 768-byte data and out-of-bounds skin attributes.

Dawn PASS does not prove browser Pack transport, typed-array survival, BGL shape, or vertex attributes. Run the real browser probe required by AGENTS.md.

---

## Fox development loading: asset-not-imported

**Signal**: after pnpm -F @forgeax/hello-skin dev, browser console reports:

```
[skin] loadByGuid<SceneAsset> failed: AssetError code=asset-not-imported
  expected="import transport to fetch pack for GUID 019eb2ce-..."
```

Fox stays black/placeholder while Dawn smoke passes 300 frames with near-zero pixelDelta.

Check environment hypotheses before source bisection:

| Priority | Hypothesis | Signal |
|:--|:--|:--|
| H-env-1 | Missing build causes glTF package resolution/optimizeDeps failure; browser reaches a stale sibling server. | Vite stderr reports failed package entry resolution. |
| H-env-2 | Another worktree owns port 5173. | Without strictPort, Vite selects 5174/5175; page title is another demo. |
| H-env-3 | Missing asset submodule means Fox.glb/sidecars never enter Pack index. | git submodule status has a leading '-'. |
| H-src | Actual import/loader defect | Investigate after disproving environment hypotheses. |

**Check and repair in order**:

```bash
# 1. Inspect Vite stderr for optimizeDeps failure.
pnpm -F @forgeax/hello-skin dev --strictPort 2>&1 | head -50
# Build the root if package entries cannot resolve.
pnpm build                                    # Produce both .mjs and declarations.
pnpm -F @forgeax/hello-skin dev --strictPort  # Fail instead of silently selecting another port.

# 2. Verify submodule initialization.
git submodule status forgeax-engine-assets    # Nonzero SHA, no '-' prefix.
git submodule update --init forgeax-engine-assets

# 3. Hydrate the fresh worktree's wgpu WASM payload.
cp <main-tree>/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm packages/wgpu-wasm/pkg/

# 4. Run the browser /__import positive probe.
pnpm -F @forgeax/hello-skin smoke:browser     # importProbeHits >= 3; kindUnion includes scene.
```

**Gate**: smoke-browser.mjs fails if import hits <3 or kindUnion lacks scene. Clearing Pack roots or removing sidecars must falsify it. The direct Dawn gltfDocToSceneAsset/register path bypasses this transport.

**Related**:
- [Fresh worktree failures](assets-and-ci.md#fresh-worktree-environment-failures): missing submodule/build.
- [Edge environment](backends-and-ci.md#edge-webgpu-disabled): verify host capabilities before Engine repair.
- [Vertex attribute chain](#skin-vertex-attribute-chain): another browser-only transport failure.

Historical seven-GUID HTTP/browser/bisection evidence: Harness forgeax-loop/bug-20260612-skin-fox-loadbyguid-asset-not-imported-in-dev/, PR [#368](https://github.com/ForgeaX-Games/forgeax-engine/pull/368).

> [!CAUTION]
> asset-not-imported is correct fail-fast behavior for missing shipped/DDC data. Disprove environment and development transport issues before modifying AssetRegistry's failure branch.

---

## Skin entity stays static

**Signal**: browser Fox meshes stay in bind pose despite hasSkin, advancing AnimationPlayer, updated joint TRS, and propagated world matrices. A Dawn smoke without palette-byte inspection can miss it.

**Historical repair layers**:

| Layer | Cause | Repair | Delivery |
|:--|:--|:--|:--|
| L1 | Static 16320-byte identity palette stub remains disconnected from allocator. | Replace stub with createSkinPaletteAllocator stored in PipelineState and consumed by record. | M1 |
| L2 | Extraction hardcodes jointCount/byteOffset=0. | resetForFrame, allocateSlice, writeJointPalette using Skin.joints' world-matrix views. | M2 |
| L3 | group2DynamicOffsets[1] is always zero. | Use entry.source.skin.byteOffset so entities have independent slices. | M3 |
| L4 | MAX_JOINTS=256 requests 16384 bytes, exceeding 16320-byte BGL capacity. | Align MAX_JOINTS=255 with the declared capacity. | M4 |

**Check**: run hello-skin smoke and inspect palette readback counters:

```bash
pnpm -F @forgeax/hello-skin smoke 2>&1 | grep -E "paletteWrites|distinctFullHash"
# Expected paletteWrites >= 900 (300 frames * 3 Fox); distinctFullHash >= 3.
# Zero writes or one hash indicates an incomplete layer above.
```

The browser probe observes queue.writeBuffer palette bytes and distinct frame hashes. Replacing writeJointPalette with identity matrices must make it fail.

**Repair**: inspect L1-L4 and history; ensure skinPaletteIdentityBuffer has not returned.

Historical delivery reference: feat-20260612.

Do not add manual demo rAF mutations or respawn entities to bypass allocator defects; repair the owning layer.

---

## Historical FBX skin deformation

> [!NOTE]
> This entry describes a bug that existed in the **removed Autodesk FBX SDK
> native addon** era (`packages/fbx` pre-feat-20260704). With the migration to
> the ufbx WASM parser, animation extraction runs through `bridge.c` (not
> `binding.cc`), and the quad-correctness checks from M1 cover the equivalent
> paths. This entry is retained for historical reference; new animation
> regressions go through the parity snapshot gate (see §parity snapshot diff).

**Signal**: humanoid.fbx with 80 joints and run/punch/shot clips renders distorted, flipped, or erratic.

**Cause, repaired**: the removed SDK binding.cc interpreted Euler degrees as quaternions and read only X curves. ufbx bridge.c uses ufbx_evaluate_transform/ufbx_evaluate_quat for real quaternions through the same authority as bind pose.

**Check current ufbx output** with parity snapshots:
```bash
pnpm --filter @forgeax/engine-fbx test -- parity-snapshot
```
Snapshots freeze cube/humanoid animation baselines; differences indicate bridge semantics changed.

**Stale build trap**: after changing bridge.c, run pnpm --filter @forgeax/engine-fbx build:wasm and build; otherwise dist consumers load old WASM.

## FBX parity snapshot differences

**Signal**: parity-snapshot.test.ts fails because cube/humanoid snapshot JSON differs from current bridge.c output.

**Cause**: axis conversion, material classification, node filtering, or animation extraction changed POD output relative to the signed baseline.

**Check**:
```bash
# Inspect field-level parity differences.
node packages/fbx/scripts/parity-diff.mjs
# Inspect bridge.c changes.
git log --oneline -- packages/fbx/src/native/bridge.c
```

**For intentional semantic changes**:
1. Compare old/new bridge output field by field.
2. Update snapshot JSON.
3. Update test expectations.
4. Record the required human sign-off in human-inputs.jsonl (architecture principle 8).

For unintended refactor drift, restore semantic equivalence.

## Missing FBX WASM payload

**Signal**: initFbxWasm reports ENOENT for pkg/fbx-wasm.wasm or fbx-wasm.mjs.

**Cause**: a contributor checkout lacks generated WASM payloads; public SDK archives carry them.

**Check**:
```bash
ls -la packages/fbx/pkg/
# Both fbx-wasm.wasm and fbx-wasm.mjs should exist.
```

**Recovery options**:
```bash
# Option 1: fetch prebuilt WASM, without emsdk.
pnpm -F @forgeax/engine-fbx fetch-wasm

# Option 2: compile locally with emsdk.
pnpm -F @forgeax/engine-fbx build:wasm
```

fetch-wasm is anonymous for public repositories and needs GITHUB_TOKEN for private ones. build:wasm needs emcc on PATH. Toolchain error details: packages/fbx/README.md, Contributor toolchain.

## FBX Node WASM initialization failure

**Signal**: initFbxWasm throws Module.instantiateWasm/WebAssembly.instantiate errors in Node while browsers work.

**Cause**: Emscripten ENVIRONMENT flags do not match the runtime. build-wasm.mjs uses web,node; stale web-only glue skips Node filesystem loading and breaks locateFile.

**Check**:
```bash
# Inspect generated glue environment detection.
head -20 packages/fbx/pkg/fbx-wasm.mjs | grep ENVIRONMENT
# It should include both Node and web support.
grep "ENVIRONMENT_IS_NODE\|ENVIRONMENT_IS_WEB" packages/fbx/pkg/fbx-wasm.mjs | head -5
```

**Repair**:
```bash
# Rebuild with the correct ENVIRONMENT flags.
pnpm -F @forgeax/engine-fbx build:wasm

# Upgrade obsolete Node versions below 18.
node --version  # Expected >= 18 for this historical toolchain.
```

If still failing, verify initFbxWasm locateFile resolves pkg relative to import.meta.url. build-wasm.mjs owns ENVIRONMENT=web,node; do not hand-edit generated glue.

---

## SkinPaletteOverflowError needs 16384 B exceeds 16320 B

**Signal**: hello-skin browser fails at the first frame:

```
RhiError: 'webgpu-runtime-error'
detail.error.name = 'SkinPaletteOverflowError'
detail.error.message = 'Skin palette allocation needs 16384 B exceeds device max binding size 16320 B'
```

All 300-frame smokes fail with onError and no Fox rendering.

**Cause**: MAX_JOINTS=256 times MAT4_BYTES=64 requests 16384 bytes, above the 16320-byte group-2 binding-1 contract. Initial allocator growth uses that constant regardless of actual joint count, so the first allocation fails.

**Check** the allocator constant:

```bash
grep -n "MAX_JOINTS" packages/runtime/src/systems/skin-palette-allocator.ts
# MAX_JOINTS should be 255, matching the 16320-byte BGL capacity.
# A value of 256 identifies this defect.
```

**Repair**: MAX_JOINTS=255 makes initial capacity equal 255*64=16320. Changing BGL capacity would require coordinated pipeline-layout changes; this repair preserves the existing BGL authority.

Historical delivery reference: feat-20260612 palette-capacity hotfix.

**Related**:
- [Static skin](#skin-entity-stays-static), layer L4.
- [Skin pipeline](#pbr-skin-pipeline-build-fail), the original palette-capacity contract.

---
