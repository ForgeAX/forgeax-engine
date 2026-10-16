#!/usr/bin/env node
// hello-fbx-skin dawn smoke (M4 / T18): structural gate + multi-frame skin
// animation proof (the FBX skinning chain animates, not a frozen T-pose).
//
// Self-contained in-memory import (mirror of fbx-cube's smoke, T17): the smoke
// imports humanoid.fbx through fbxImporter at run time and COOKS the resulting
// ImportedAsset[] into an in-memory pack (a `{ assets: [...] }` body + a
// pack-index array), then serves both through a thin globalThis.fetch shim.
// loadByGuid<SceneAsset> then runs the exact CANONICAL pack-fetch decode over
// that in-memory pack:
//   - parseScenePayload decodes the scene's numeric refs-index handle fields
//     (MeshFilter.assetHandle, MeshRenderer.materials[], Skin.skeleton) into
//     GUID strings and resolves the SceneAsset.skinGuids cross-edge;
//   - loadByGuid recursively catalogues the scene's mesh / material / skeleton /
//     skin sub-assets (envelope.refs walk);
//   - instantiate's _resolveSceneGuids mints user-tier handles for those GUID
//     strings and postSpawnResolveJoints wires Skin.joints from the SkinAsset.
// This is the same decode a real FBX skin ships on -- the ONLY difference from
// the deployed dev-server/build path is where the pack bytes come from (a fresh
// in-memory import here vs. a build-time pre-import into dist/).
//
// Why this replaced the old "read dist/pack-index.json" path: the CI
// build-artifacts job checks out with `submodules: false`, so humanoid.fbx
// (a forgeax-engine-assets submodule file) is absent at fbx-skin's vite build,
// its build-time forgeax-pack pre-import finds no source, and dist/pack-index.json
// ships EMPTY (0 entries). smoke-fleet (which checks out `submodules: recursive`)
// then downloaded that empty pack and loadByGuid<SceneAsset> failed with
// asset-not-imported. Importing in-memory at smoke time -- where the submodule
// IS present under smoke-fleet's recursive checkout -- removes the hidden
// dependency on the submodules:false build's pack and makes fbx-skin as
// self-contained as fbx-cube already is.
//
// Two layers:
//   1. Structural: backend=webgpu, scene instantiates (skin joints resolve),
//      >=SMOKE_MIN_FRAMES frames, zero RhiError. After the defect-B fix
//      (bridge.c skin influences corner-expand) the skinned mesh carries
//      skinIndex/skinWeight, so a forgeax::pbr-skin draw no longer trips
//      RuntimeError material-skin-attr-missing -- the zero-error gate covers
//      that regression.
//   2. Multi-frame animation proof (AC-19 / E9): drive the AnimationPlayer over
//      the run via world.update(1 / 60).unwrap() (ticks advanceAnimationPlayer, which writes
//      the joint Transforms the SkinPaletteAllocator uploads each frame) and
//      hash each per-frame skin-palette writeBuffer payload. Assert the joint
//      palette takes on >=3 distinct values across the run: the pose is genuinely
//      moving frame to frame, not a frozen T-pose. The palette upload IS the
//      skinned-draw path (the render-system builds + writes it per skinned draw),
//      so its distinctness proves both that the skinned mesh is drawn AND that it
//      animates.
//   3. Falsification (plan-strategy §5.4): FALSIFY=static pauses the
//      AnimationPlayer so world.update(1 / 60).unwrap() cannot advance time. The joint palette
//      is uploaded with the same t=0 pose every frame -> distinct-hash count
//      collapses to 1, and the "pose animates" assertion trips -> non-zero exit.
//      This proves the gate is sensitive to the animated pose (not vacuously
//      true against any rendered humanoid). FALSIFY is a local discrimination
//      tool only; CI runs with no env.
//
// Why not a pixel-colour diff: the dawn-node offscreen readback returns a
// UNIFORM frame regardless of rendered geometry (verified: apps/hello/skin's
// glTF Fox smoke reads back 30000/30000 identical pixels too). The
// skin-palette write hash is the same deterministic dawn signal apps/hello/skin
// uses; the actual on-screen pixel proof lives in the browser smoke path.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

// CI (smoke-fleet) sets SMOKE_MIN_FRAMES=100; local default matches the other
// dawn smokes' 60-frame per-frame-leak soak. Frame-count-independent gates
// (palette distinctness, FALSIFY) hold at either depth.
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 200;
const HEIGHT = 150;
// Minimum distinct skin-palette write hashes across the run. The running clip
// re-poses the joints every world.update(1 / 60).unwrap(), so the uploaded palette differs
// frame to frame; a frozen pose (FALSIFY=static) repeats one hash. >=3 parallels
// the apps/hello/skin smoke's 3-sample lower bound.
const PALETTE_MIN_DISTINCT = 3;

const SCENE_GUID = '019ecd87-179b-7eb3-a37d-391f05c61e52';
const RUN_CLIP_GUID = '019ecd87-179b-71f7-b9f8-4c8518326b65';

const FALSIFY = process.env.FALSIFY ?? '';
if (FALSIFY !== '' && FALSIFY !== 'static') {
  console.error(`[smoke] FAIL - unknown FALSIFY mode '${FALSIFY}' (expected '' or 'static')`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(here, '..', 'dist');
// humanoid.fbx lives in the forgeax-engine-assets submodule (present under the
// smoke-fleet `submodules: recursive` checkout). Same 4-hop climb fbx-cube uses.
const HUMANOID_FBX = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'forgeax-engine-assets',
  'vendor',
  'fbx-test',
  'humanoid.fbx',
);

// --- 1. dawn.node binding setup ---
let create, globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(`[smoke] FAIL - dawn.node import: ${err instanceof Error ? err.message : String(err)}`);
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
  console.error(`[smoke] FAIL - dawn-node create: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// Capture the raw GPUDevice createRenderer ends up using so the readback runs on
// the same device (mirror of fbx-cube smoke). Also intercept device.queue.
// writeBuffer for the SkinPaletteAllocator's `skin-palette` GPUBuffer and hash
// each payload: the palette IS the per-frame joint-matrix upload, so a moving
// pose produces distinct hashes and a frozen pose repeats one hash. This is the
// DETERMINISTIC animation-motion signal (mirror of apps/hello/skin smoke-dawn
// m4-4). A whole-frame pixel diff is NOT usable as the motion gate here: the
// dawn render path has a ~1200px frame-to-frame nondeterminism floor even with
// zero state change, which would swamp a per-sample colour delta. The pixel
// readback below is kept only as a coarse "the humanoid actually renders
// non-black" proof (AGENTS.md LO 5.1 black-screen lesson).
let sharedDevice;
const skinPaletteWrites = [];
const fnv1a32 = (bytes, start, end) => {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    h ^= bytes[i] ?? 0;
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    try {
      const origCreateBuffer = dev.createBuffer.bind(dev);
      const paletteBuffers = new WeakSet();
      dev.createBuffer = (cdesc) => {
        const buf = origCreateBuffer(cdesc);
        if ((cdesc.label ?? '') === 'skin-palette') paletteBuffers.add(buf);
        return buf;
      };
      const origWriteBuffer = dev.queue.writeBuffer.bind(dev.queue);
      dev.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
        try {
          if (paletteBuffers.has(buffer)) {
            const u8 = data instanceof Uint8Array
              ? data
              : data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : data?.buffer != null
                  ? new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength)
                  : null;
            if (u8 !== null) skinPaletteWrites.push(fnv1a32(u8, 0, u8.byteLength));
          }
        } catch {}
        return origWriteBuffer(buffer, offset, data, dataOffset, size);
      };
    } catch {}
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ---
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
  width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. In-memory import of humanoid.fbx + cook an in-memory pack ---
// Import the FBX in-memory (mirror of fbx-cube). The importer honours the GUID
// import-stable iron law: it only emits sub-assets declared in ctx.subAssets[],
// read from the meta sidecar (SSOT) so this smoke exercises the same declared-
// GUID set as the dev server / build pre-import.
const { fbxImporter } = await import('@forgeax/engine-fbx');
const HUMANOID_META = JSON.parse(readFileSync(`${HUMANOID_FBX}.meta.json`, 'utf8'));
let imported;
try {
  imported = await fbxImporter.import({
    source: HUMANOID_FBX,
    readSource: async () => ({ ok: true, value: new Uint8Array(readFileSync(HUMANOID_FBX)) }),
    readSibling: async () => ({ ok: false, error: { code: 'source-read-failed' } }),
    decodeImage: async () => ({ ok: false, error: { code: 'image-decode-failed' } }),
    subAssets: HUMANOID_META.subAssets,
    importSettings: {},
  });
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : String(err);
  console.error(`[smoke] FAIL - fbxImporter.import threw: ${code}`);
  process.exit(1);
}

// Use the same import-to-wire projection and finalizer as Vite. Importer POD
// stays available to import consumers; the package carries only one Mesh source.
if (!imported.ok) {
  console.error(`[smoke] FAIL - fbxImporter failed: ${imported.error.code}`);
  process.exit(1);
}

const { projectImportProductForBuild } = await import('@forgeax/engine-import');
const { finalizePackageTransportSource } = await import('@forgeax/engine-pack/build');
const importedAssets = imported.value.assets;
const PACK_URL = '/humanoid.pack.json';
const PACK_INDEX_URL = '/pack-index.json';
const artifactBytes = new Map();
const packIndex = importedAssets.map((a) => ({
  guid: a.guid,
  packageUrl: PACK_URL,
  kind: a.kind,
  sourcePath: HUMANOID_FBX,
  ...(a.name !== undefined ? { name: a.name } : {}),
}));
const finalized = await finalizePackageTransportSource(
  projectImportProductForBuild(imported.value),
  {
    base: '/',
    packagePath: 'humanoid.pack.json',
    artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
  },
);
for (const artifact of finalized.artifacts) {
  artifactBytes.set(`/${artifact.path}`, artifact);
}
const packBody = JSON.stringify(finalized.pack);
console.log(`[smoke] cooked in-memory pack: ${packIndex.length} entries from fbxImporter.import`);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const urlStr = typeof url === 'string' ? url : String(url);
  // data: URLs (e.g. the shader manifest passed via shaderManifestUrl) and any
  // other non-pack URL fall through to the real fetch.
  if (urlStr.startsWith('data:')) return originalFetch(url, ...rest);
  if (urlStr === PACK_INDEX_URL) {
    return Response.json(packIndex);
  }
  if (urlStr === PACK_URL) {
    return new Response(packBody, { headers: { 'content-type': 'application/json' } });
  }
  const artifactPath = new URL(urlStr, 'http://asset.local').pathname;
  const artifact = artifactBytes.get(artifactPath);
  if (artifact !== undefined) {
    return new Response(artifact.bytes, { headers: { 'content-type': artifact.mediaType } });
  }
  return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
};

// --- 4. Engine bootstrap ---
const { createWorldContext, ENTITY_NULL_RAW, World } = await import('@forgeax/engine-ecs');
const { scenePlugin, Transform } = await import('@forgeax/engine-scene');
const { Camera, DirectionalLight, renderComponentsPlugin } = await import('@forgeax/engine-render');
const { Skin, skinningPlugin } = await import('@forgeax/engine-skinning');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { SceneInstance } = await import('@forgeax/engine-render');
const {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
  animationPlugin,
} = await import('@forgeax/engine-animation');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');

const MANIFEST_PATH = resolve(DIST_DIR, 'shaders', 'manifest.json');
let MANIFEST_URL = '';
try {
  MANIFEST_URL = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
} catch {}

let renderer;
let assets;
try {
  const constructed = await constructRuntimeRendererHost(mockCanvas, {}, MANIFEST_URL ? { shaderManifestUrl: MANIFEST_URL } : {});
  if (!constructed.ok) throw constructed.error;
  renderer = constructed.value.renderer;
  assets = constructed.value.assets;
} catch (err) {
  console.error(`[smoke] FAIL - createRenderer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log('[hello-fbx-skin] Standard pipeline active');
if (!assets) { console.error('[smoke] FAIL - AssetRegistry null'); process.exit(1); }

// --- 5. Canonical load: configurePackIndex + loadByGuid<SceneAsset> ---
const world = new World();
await createWorldContext(world, [
  renderComponentsPlugin(),
  scenePlugin(),
  animationPlugin(),
  skinningPlugin(),
]);
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
assets.configurePackIndex(PACK_INDEX_URL);

const sceneGuidRes = AssetGuid.parse(SCENE_GUID);
if (!sceneGuidRes.ok) { console.error('[smoke] FAIL - AssetGuid.parse(scene)'); process.exit(1); }
const sceneRes = await assets.loadByGuid(sceneGuidRes.value);
if (!sceneRes.ok) {
  console.error(`[smoke] FAIL - loadByGuid<SceneAsset>: ${sceneRes.error.code} - ${sceneRes.error.hint ?? ''}`);
  process.exit(1);
}
const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
const instRes = assets.instantiate(sceneHandle, world);
if (!instRes.ok) {
  console.error(`[smoke] FAIL - instantiate scene (skin joints unresolved?): ${instRes.error.code} - ${instRes.error.hint ?? ''}`);
  process.exit(1);
}
const sceneRoot = instRes.value;
console.log('[smoke] scene instantiated via loadByGuid<SceneAsset> (skin joints resolved)');

// Locate the Skin-bearing entity and attach an AnimationPlayer on the run clip.
const inst = world.get(sceneRoot, SceneInstance);
if (!inst.ok) { console.error('[smoke] FAIL - scene root has no SceneInstance'); process.exit(1); }
let skinEnt;
const animationTargets = [];
for (const raw of inst.value.mapping) {
  if (raw === undefined || raw === ENTITY_NULL_RAW) continue;
  if (world.get(raw, AnimationTargetId).ok) animationTargets.push(raw);
  if (skinEnt === undefined && world.get(raw, Skin).ok) skinEnt = raw;
}
if (skinEnt === undefined) { console.error('[smoke] FAIL - no Skin entity in instantiated scene'); process.exit(1); }

const clipGuidRes = AssetGuid.parse(RUN_CLIP_GUID);
if (!clipGuidRes.ok) { console.error('[smoke] FAIL - AssetGuid.parse(clip)'); process.exit(1); }
const clipRes = await assets.loadByGuid(clipGuidRes.value);
if (!clipRes.ok) { console.error(`[smoke] FAIL - loadByGuid(clip): ${clipRes.error.code}`); process.exit(1); }
const clipHandle = world.allocSharedRef('AnimationClip', clipRes.value);

// FALSIFY=static: pause the player so world.update(1 / 60).unwrap() cannot advance time; the
// joint palette is re-uploaded with the same t=0 pose every frame, so the
// distinct-hash count collapses to 1 and the "pose animates" gate trips.
world.addComponent(sceneRoot, {
  component: AnimationPlayer,
  data: {
    // feat-20260713 M1 / w8: variable N-slot SoA. Single active slot -- all
    // four parallel columns written length-synced at length 1 (D-5, no tail
    // pad; speeds no longer defaults to [1,1,1,1] per D-6).
    clips: [clipHandle],
    times: new Float64Array([0]),
    weights: new Float32Array([1]),
    speeds: new Float32Array([1]),
    paused: FALSIFY === 'static',
    looping: true,
  },
});
const bound = bindAnimationTargets(world, sceneRoot, animationTargets);
if (!bound.ok) {
  console.error('[smoke] FAIL - bindAnimationTargets:', bound.error.code);
  process.exit(1);
}

// Camera + directional light. humanoid.fbx is in cm; ~150-unit body.
world.spawn(
  { component: Transform, data: { pos: [0, 90, 250], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 1, far: 1000 } },
);
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
});

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push(event.error.code);
});


const device = sharedDevice;
if (!device) { console.error('[smoke] FAIL - no shared device captured'); process.exit(1); }

// --- 6. Render loop: drive the animation, collect per-frame palette hashes ---
// Each world.update(1 / 60).unwrap() ticks advanceAnimationPlayer (moves joints), then
// renderer.draw builds + uploads the joint palette (hashed by the writeBuffer
// hook) as part of the skinned-draw path.
let framesObserved = 0;
for (let i = 0; i < SMOKE_MIN_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  if (!r.ok) errors.push(r.error?.code ?? 'unknown');
  framesObserved++;
}
await device.queue.onSubmittedWorkDone();
if (!renderTarget) { console.error('[smoke] FAIL - renderTarget never allocated'); process.exit(1); }
globalThis.fetch = originalFetch;

const distinctPaletteHashes = new Set(skinPaletteWrites).size;
console.log(`[smoke] frames=${framesObserved} errors=${errors.length}`);
console.log(
  `[smoke] skin-palette writes=${skinPaletteWrites.length} distinctHashes=${distinctPaletteHashes} (min ${PALETTE_MIN_DISTINCT}, falsify=${FALSIFY || 'none'})`,
);

// --- 7. Verdict ---
const failures = [];
if (!sharedDevice) failures.push('(a) Dawn device was not created by the host-owned Standard pipeline');
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) failures.push(`(c) errors=${errors.join(',')}`);
// (d) the skinned-draw path must run: >=1 skin-palette upload means the pbr-skin
// mesh was drawn (defect-B: with skin attrs missing this draw was skipped with
// material-skin-attr-missing, so the allocator never engaged).
if (skinPaletteWrites.length < PALETTE_MIN_DISTINCT) {
  failures.push(`(d) skin-palette write count=${skinPaletteWrites.length} < ${PALETTE_MIN_DISTINCT} (skinned draw path not exercised; skin attrs dropped?)`);
} else if (distinctPaletteHashes < PALETTE_MIN_DISTINCT) {
  // (e) AC-19: the joint palette must take on >=3 distinct values -- the pose
  // animates. FALSIFY=static freezes the palette, collapsing distinctHashes to 1.
  failures.push(`(e) pose did not animate: distinct palette hashes=${distinctPaletteHashes} < ${PALETTE_MIN_DISTINCT} (joints frozen at one pose)`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}

console.log(`[smoke] PASS - backend=webgpu, frames=${framesObserved}, errors=0, distinctPaletteHashes=${distinctPaletteHashes}`);
emitSmokeReceipt('hello-fbx-skin/smoke', framesObserved);
process.exit(0);
