#!/usr/bin/env node
// hello-skin writeback headless smoke (feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha M4 / m4-w1).
//
// End-to-end scene writeback round-trip proof:
//   1. Load Fox.glb, instantiate scene.
//   2. Spawn a prop entity parented to a bone joint via ChildOf.
//   3. Save the forest with rootsToSceneAsset(registry, world, [foxRoot, prop]).
//   4. Serialize with serializeSceneAssetToPack.
//   5. Catalog the saved SceneAsset, re-instantiate.
//   6. Assert: (a) the prop is still parented to the correct bone;
//             (b) the prop Transform data survived round-trip.
//
// Pure data assertions — no pixel readback, no render loop.
//
// Output literals (grep-friendly):
//   [writeback] save: OK
//   [writeback] serialize: OK, refs=<N>
//   [writeback] reload: OK
//   [writeback] parent check: OK (bone joints[0] in new instance)
//   [writeback] transform check: OK (pos y=10 preserved)
//   [writeback] PASS

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Use a hardcoded UUID for the writeback scene: dawn-node's webgpu module
// replaces globalThis and corrupts crypto.randomUUID / node:crypto in this
// context. A static UUID works because this smoke script owns the asset
// registry for its entire lifetime.
const writebackGuid = '019eb2cf-0001-7000-8000-deadbeef0001';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const FOX_GLB_PATH = resolve(repoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb');
const FOX_META_PATH = resolve(repoRoot, 'forgeax-engine-assets/khronos-gltf-samples/Fox/Fox.glb.meta.json');

const WIDTH = 200;
const HEIGHT = 150;

// --- 1. dawn.node binding setup (same as smoke-dawn.mjs) -------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[writeback] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[writeback] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);

// --- 2. Mock canvas (minimal, no render target needed) ----------------------

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) throw new Error('no render target');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Engine + Fox.glb pipeline (load side, mirrors smoke-dawn.mjs) ------

const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { animationPlugin } = await import('@forgeax/engine-animation');
const { renderComponentsPlugin } = await import('@forgeax/engine-render');
const { ChildOf, scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { rootsToSceneAsset, serializeSceneAssetToPack } = await import('@forgeax/engine-runtime');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { SceneInstance } = await import('@forgeax/engine-render');
const { Skin, skinningPlugin } = await import('@forgeax/engine-skinning');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
// Fox scene nodes carry AnimationTargetId; importing the animation entrypoint
// registers that component before SceneAsset instantiation resolves its names.
await import('@forgeax/engine-animation');
const { gltfDocToSceneAsset, meshIrToMeshAsset, parseGlb, toMaterialAsset } = await import(
  '@forgeax/engine-gltf'
);

const MANIFEST_PATH = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;

let renderer;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  var hostAssets = constructed.value.assets;
} catch (err) {
  console.error(
    `[writeback] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

const assets = hostAssets;

// --- Fox.glb parse + POD register (mirrors smoke-dawn.mjs exact logic) -----

const meta = JSON.parse(readFileSync(FOX_META_PATH, 'utf8'));
const subs = meta.subAssets;

function subGuid(kind, sourceIndex) {
  const e = subs.find((s) => s.kind === kind && s.sourceIndex === sourceIndex);
  if (!e) throw new Error(`Fox.glb.meta.json missing ${kind}/${sourceIndex}`);
  const r = AssetGuid.parse(e.guid);
  if (!r.ok) throw new Error(`AssetGuid.parse(${e.guid}) failed`);
  return r.value;
}

const meshGuid = subGuid('mesh', 0);
const materialGuid = subGuid('material', 0);
const sceneGuid = subGuid('scene', 0);
const skeletonGuid = subGuid('skeleton', 0);
const skinGuid = subGuid('skin', 0);

const glbBytes = readFileSync(FOX_GLB_PATH);
const glbAb = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength);
const docResult = await parseGlb(glbAb, FOX_GLB_PATH);
if (!docResult.ok) {
  console.error('[writeback] FAIL - parseGlb failed:', docResult.error);
  process.exit(1);
}
const doc = docResult.value;

const skeletonRec = doc.skeletons[0];
if (!skeletonRec) {
  console.error('[writeback] FAIL - Fox.glb GltfDoc.skeletons[0] missing');
  process.exit(1);
}

const world = new World();
const worldContext = await createWorldContext(world, [
  renderComponentsPlugin(),
  scenePlugin(),
  animationPlugin(),
  skinningPlugin(),
]);
assets.catalog(skeletonGuid, {
  kind: 'skeleton',
  inverseBindMatrices: skeletonRec.inverseBindMatrices,
  jointCount: skeletonRec.jointCount,
});
assets.catalog(skinGuid, {
  kind: 'skin',
  skeletonGuid: AssetGuid.format(skeletonGuid),
  jointPaths: skeletonRec.jointPaths,
});

const meshIrs = doc.meshes.filter((m) => m.meshIndex === 0);
const meshResult = meshIrToMeshAsset(meshIrs);
if (!meshResult.ok) throw meshResult.error;
const meshAsset = meshResult.value;
assets.catalog(meshGuid, meshAsset);
const meshHandle = world.allocSharedRef('MeshAsset', meshAsset);

const matAsset = toMaterialAsset(doc.materials[0], { skinned: true });
assets.catalog(materialGuid, matAsset);
const matHandle = world.allocSharedRef('MaterialAsset', matAsset);

const bridgeCtx = {
  meshHandles: new Map([[0, meshHandle]]),
  materialHandles: new Map([[0, matHandle]]),
  skeletonGuidBySkinIndex: new Map([[0, AssetGuid.format(skeletonGuid)]]),
};
const scene = gltfDocToSceneAsset(doc, bridgeCtx);
assets.catalog(sceneGuid, scene);

const sceneRes = await assets.loadByGuid(sceneGuid);
if (!sceneRes.ok) {
  console.error('[writeback] FAIL - loadByGuid<SceneAsset> failed:', sceneRes.error);
  process.exit(1);
}
const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);

// --- 3b. Instantiate Fox scene into world ----------------------------------

const instRes = assets.instantiate(sceneHandle, world);
if (!instRes.ok) {
  console.error('[writeback] FAIL - instantiate Fox scene:', instRes.error.code);
  process.exit(1);
}
const foxRoot = instRes.value;

const inst = world.get(foxRoot, SceneInstance);
if (!inst.ok) {
  console.error('[writeback] FAIL - foxRoot has no SceneInstance');
  process.exit(1);
}

// Find the Skin-bearing entity in the instantiated scene.
let skinEnt = undefined;
for (let i = 0; i < inst.value.mapping.length; i++) {
  const e = inst.value.mapping[i];
  if (e === 0) continue;
  if (world.get(e, Skin).ok) {
    skinEnt = e;
    break;
  }
}
if (skinEnt === undefined) {
  console.error('[writeback] FAIL - no Skin entity in Fox scene');
  process.exit(1);
}

const skinVal = world.get(skinEnt, Skin);
if (!skinVal.ok) {
  console.error('[writeback] FAIL - Skin component read failed');
  process.exit(1);
}

// Skin.joints is stored as Uint32Array (ECS typed column for array<entity>).
const jointsRaw = skinVal.value.joints;
const jointCount = jointsRaw?.length ?? 0;
if (jointCount === 0) {
  console.error('[writeback] FAIL - Skin.joints is empty');
  process.exit(1);
}
const boneEntity = jointsRaw[0]; // root joint (head/root bone of Fox skeleton)

if (typeof boneEntity !== 'number' || boneEntity === 0) {
  console.error('[writeback] FAIL - boneEntity (joints[0]) is invalid');
  process.exit(1);
}

// --- 4. Writeback round-trip -------------------------------------------------

// 4a. Spawn prop entity under the bone.
const PROP_POS_Y = 10;
const propTr = {
  pos: [0, PROP_POS_Y, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],};
const propRes = world.spawn({ component: Transform, data: propTr });
if (!propRes.ok) {
  console.error('[writeback] FAIL - prop spawn:', propRes.error.code);
  process.exit(1);
}
const propEntity = propRes.value;

const addChildRes = world.addComponent(propEntity, { component: ChildOf, data: { parent: boneEntity } });
if (!addChildRes.ok) {
  console.error('[writeback] FAIL - addComponent ChildOf on prop:', addChildRes.error.code);
  process.exit(1);
}

// 4b. Save the forest: foxRoot only. The prop is auto-discovered via
// collectSubtree BFS through Children.entities (prop has ChildOf(parent=bone)).
const saveRes = rootsToSceneAsset(assets, world, [foxRoot]);
if (!saveRes.ok) {
  console.error('[writeback] FAIL - rootsToSceneAsset:', saveRes.error.code);
  process.exit(1);
}
const savedScene = saveRes.value;
console.log('[writeback] save: OK');

// UUID generated at top of file (dawn-node corrupts crypto.randomUUID).

// 4c. Serialize: verify the round-trip produces valid pack JSON.
// Pass a real UUID; serializeSceneAssetToPack uses crypto.randomUUID()
// which is shadowed by dawn-node's global crypto (different from Node crypto).
const serRes = serializeSceneAssetToPack(savedScene, world.components.entries(), writebackGuid);
if (!serRes.ok) {
  console.error('[writeback] FAIL - serializeSceneAssetToPack:', serRes.error.code);
  process.exit(1);
}
const pack = serRes.value;
const refs = Array.isArray(pack.assets) && pack.assets[0]?.refs;
const refsCount = Array.isArray(refs) ? refs.length : 0;
console.log(`[writeback] serialize: OK, refs=${refsCount}`);

// Verify refs[] contains at least one GUID (skeleton or material).
if (refsCount === 0) {
  console.error('[writeback] FAIL - serialize refs[] is empty (expected shared asset GUIDs)');
  process.exit(1);
}

// 4d. Despawn existing scene, catalog saved scene, re-instantiate.

// Despawn the foxRoot so the world is clean for re-instantiate.
// foxRoot has no parent (we never added one), so world.despawn on it directly.
world.despawn(foxRoot);
// The prop had ChildOf(parent=bone), which has linkedSpawn=true, so despawn
// of bone cascades to prop. Verify world is clean.
// We don't verify here -- just proceed.

// Catalog the saved SceneAsset under the same GUID used for serialize.
// catalog accepts string; loadByGuid needs AssetGuid (Uint8Array).
assets.catalog(writebackGuid, savedScene);

const writebackAssetGuid = AssetGuid.parse(writebackGuid);
if (!writebackAssetGuid.ok) {
  console.error('[writeback] FAIL - AssetGuid.parse(writebackGuid):', writebackAssetGuid.error);
  process.exit(1);
}
const loadRes = await assets.loadByGuid(writebackAssetGuid.value);
if (!loadRes.ok) {
  console.error('[writeback] FAIL - loadByGuid of saved scene:', loadRes.error);
  process.exit(1);
}
const newSceneHandle = world.allocSharedRef('SceneAsset', loadRes.value);

const newInstRes = assets.instantiate(newSceneHandle, world);
if (!newInstRes.ok) {
  console.error('[writeback] FAIL - instantiate saved scene:', newInstRes.error.code);
  process.exit(1);
}
const newRoot = newInstRes.value;
console.log('[writeback] reload: OK');

// 4e. Assertions: verify the prop survived the round-trip and its parent is
// still the correct bone entity. With mount-collapse, the saved scene is a
// wrapper SceneAsset with mounts[{ source: Fox scene GUID }] + owned entities
// (prop). The reloaded tree has nested sub-instances; use iterDescendants to
// search the full tree including mount sub-instance members.

// Find Skin entity and prop via recursive descent.
let newSkinEnt = undefined;
let foundProp = undefined;
for (const e of world.iterDescendants(newRoot)) {
  if (newSkinEnt === undefined && world.get(e, Skin).ok) {
    newSkinEnt = e;
  }
  if (foundProp === undefined) {
    const tr = world.get(e, Transform);
    if (tr.ok && Math.abs(tr.value.pos[1] - PROP_POS_Y) < 0.001) {
      foundProp = e;
    }
  }
  if (newSkinEnt !== undefined && foundProp !== undefined) break;
}

if (newSkinEnt === undefined) {
  console.error('[writeback] FAIL - no Skin entity in reloaded tree');
  process.exit(1);
}

const newSkinVal = world.get(newSkinEnt, Skin);
if (!newSkinVal.ok) {
  console.error('[writeback] FAIL - Skin read in reloaded tree failed');
  process.exit(1);
}

const newJoints = newSkinVal.value.joints;
if (!newJoints || newJoints.length === 0) {
  console.error('[writeback] FAIL - Skin.joints empty in reloaded scene');
  process.exit(1);
}
const newBoneEntity = newJoints[0]; // root joint in reloaded instance

// Assertion (a): the prop (found by pos y) must be parented to the bone entity.
if (foundProp === undefined) {
  console.error('[writeback] FAIL - prop entity not found in reloaded tree');
  console.error('  expected: entity with Transform.pos[1] === PROP_POS_Y');
  process.exit(1);
}

const propChildOf = world.get(foundProp, ChildOf);
if (!propChildOf.ok || propChildOf.value.parent !== newBoneEntity) {
  console.error('[writeback] FAIL - prop parent mismatch');
  process.exit(1);
}
console.log('[writeback] parent check: OK (bone joints[0] in new instance)');

// Assertion (b): prop Transform survived round-trip (local pos y preserved).
const propTransform = world.get(foundProp, Transform);
if (!propTransform.ok) {
  console.error('[writeback] FAIL - prop has no Transform in reloaded tree');
  process.exit(1);
}
const reloadedPosY = propTransform.value.pos[1];
if (Math.abs(reloadedPosY - PROP_POS_Y) > 0.001) {
  console.error(
    `[writeback] FAIL - prop pos y changed: expected ${PROP_POS_Y}, got ${reloadedPosY}`,
  );
  process.exit(1);
}
console.log(`[writeback] transform check: OK (pos y=${PROP_POS_Y} preserved)`);

// Assertion (c): refs[] contains fox-related GUID (material or skeleton).
let foundSkeletonGUID = false;
for (const ref of refs) {
  if (typeof ref === 'string' && ref.includes('019eb2ce')) {
    foundSkeletonGUID = true;
    break;
  }
}
if (!foundSkeletonGUID) {
  console.error('[writeback] FAIL - refs[] does not contain any fox GUID (expected skeleton/material)');
  process.exit(1);
}
console.log('[writeback] refs integrity: OK');

// --- 5. Done ---

console.log('[writeback] PASS - writeback round-trip GREEN');
process.exit(0);
