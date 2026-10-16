#!/usr/bin/env node
// hello-scene-nesting headless smoke — dawn-node structural smoke.
//
// This script boots dawn-node WebGPU, creates a renderer with inline
// SceneAsset PODs (outer scene with keyed instance -> inner cube scene), renders
// 60 frames and verifies content appeared (pixel readback per-site
// distance from clear color exceeds threshold on at least one mesh site).
//
// Structural-only smoke: no committed baseline.png yet. AC-33 v1 lock
// permissive meshed-site gate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const WIDTH = 800;
const HEIGHT = 600;

// Dawn-node binding setup.
let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
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
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
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
    return dev;
  };
  return rawAdapter;
};

// Mock canvas with offscreen render target.
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

// Import engine.
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { Materials, renderComponentsPlugin, SceneInstance } = await import('@forgeax/engine-render');
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Name, Transform, scenePlugin } = await import('@forgeax/engine-scene');
const { worldDespawnScene, worldInstantiateScene, worldSetSceneAssetResolver } = await import(
  '@forgeax/engine-scene',
);
const { err: errResult, ok: okResult } = await import('@forgeax/engine-types');

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

let renderer;
let assets;
try {
  const host = await constructRuntimeRendererHost(
    mockCanvas,
    {},
    { shaderManifestUrl: MANIFEST_URL },
  );
  if (!host.ok) throw host.error;
  ({ renderer, assets } = host.value);
} catch (err) {
  console.error(
    `[smoke] FAIL - constructRuntimeRendererHost failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry unavailable');
  process.exit(1);
}


// Mint a user-tier column handle for the unlit material so the inline
// SceneAsset materials array references a real shared-ref id.
const world = new World();
const worldContext = await createWorldContext(world, [
  renderComponentsPlugin(),
  scenePlugin(),
]);
void worldContext;
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const unlitMatHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.4, 0.2, 1]));
const cubeGuid = AssetGuid.parse('cbe42beb-8975-5096-b3a1-3dda4cb4c077');
if (!cubeGuid.ok) throw new Error('cube GUID parse failed');
const cubeResult = await assets.loadByGuid(cubeGuid.value);
if (!cubeResult.ok) {
  console.error(`[smoke] FAIL - builtin cube loadByGuid: ${cubeResult.error.code}`);
  process.exit(1);
}
const meshHandle = world.allocSharedRef('MeshAsset', cubeResult.value);

// R2/B-5: bind a real material to the cube so the smoke produces a
// non-black frame when the engine is healthy. Empty materials [] (the
// previous shape) renders nothing, so pixel readback was [0,0,0]
// regardless of B-1's hierarchy state — the gate could not distinguish
// engine-broken from intentionally-empty.
const innerScene = {
  kind: 'scene',
  entities: {
    cube: {
      components: {
        Transform: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]},
        MeshFilter: { assetHandle: Number(meshHandle) },
        MeshRenderer: { materials: [Number(unlitMatHandle)] },
      },
    },
  },
};

const outerScene = {
  kind: 'scene',
  entities: {
    sibling: {
      components: {
        Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
        MeshFilter: { assetHandle: Number(meshHandle) },
        MeshRenderer: { materials: [Number(unlitMatHandle)] },
      },
    },
    inner: {
      components: {},
      instance: {
        source: 'inner-scene',
        overrides: [{
          target: ['cube'],
          components: {
            Transform: { pos: [1.0, 0, 0] },
            Name: { value: 'm30-mounted-member' },
          },
        }],
      },
    },
  },
};

const innerHandle = world.allocSharedRef('SceneAsset', innerScene);

const outerHandle = world.allocSharedRef('SceneAsset', outerScene);
const sceneChildren = new Map([[Number(outerHandle), innerHandle]]);

worldSetSceneAssetResolver(world, (sourceKey, parentHandle) => {
  void sourceKey;
  const child = sceneChildren.get(Number(parentHandle));
  return child === undefined ? errResult({ code: 'asset-not-found' }) : okResult(child);
});

// A single world camera keeps the pixel proof self-contained. The mounted
// scene's add override supplies a non-rendering Name component.
world.spawn(
  { component: Transform, data: { pos: [0, 1, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1]} },
  { component: Camera, data: { fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 } },
);

const instRes = worldInstantiateScene(world, outerHandle);
if (!instRes.ok) {
  console.error(`[smoke] FAIL - instantiateScene: ${instRes.error.code}`);
  process.exit(1);
}

// feat-20260713 M6 / w23: verify the component-add override (Name without
// `field`) took effect on the member entity.
const rootEntity = instRes.value.root;
const baselineEntityCount = world.inspect().entityCount;
const sceneInst = world.get(rootEntity, SceneInstance);
const baselineMountedMember = sceneInst.ok ? sceneInst.value.mapping[2] : undefined;
let addOverrideVerified = false;
if (sceneInst.ok) {
  const mapping = sceneInst.value.mapping;
  const memberEntity = mapping[2];
  if (memberEntity !== undefined && memberEntity !== 0) {
    const name = world.get(memberEntity, Name);
    if (name.ok) {
      if (name.value.value === 'm30-mounted-member') {
        addOverrideVerified = true;
      }
    }
  }
}

if (addOverrideVerified) {
  console.log(`[smoke] add-override + field-patch override semantics verified`);
}

const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

// R2/B-5: hook console.error so RhiError(hierarchy-broken) lines emitted
// by propagateTransforms (which write through console.error rather than
// Renderer error event stream) are counted into the failure gate. The
// previous gate counted only renderer-propagated errors, so a flood of
// per-frame hierarchy-broken errors masked the true demo state (PASS
// while pixelSamples were [0,0,0] all-black).
const consoleErrorOriginal = console.error.bind(console);
let consoleErrorRhiCount = 0;
const RHI_ERROR_PATTERN =
  /(RhiError|hierarchy-broken|RhiError\(hierarchy-broken\)|propagateTransforms.*hierarchy-broken)/;
console.error = (...args) => {
  const joined = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
    .join(' ');
  if (RHI_ERROR_PATTERN.test(joined)) consoleErrorRhiCount += 1;
  consoleErrorOriginal(...args);
};

const TARGET_FRAMES = SMOKE_MIN_FRAMES;
const frameStart = Date.now();
let framesObserved = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const r = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  else void renderer.observe(r.value, { include: ['draws'] });
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(`[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`);

// Pixel readback.
if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readback = async () => {
  const readbackBuffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  try {
    await readbackBuffer.mapAsync(0x01);
  } catch (err) {
    console.error(`[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const mapped = readbackBuffer.getMappedRange();
  const output = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  return output;
};
let bytes = await readback();

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  return [
    srgbToLinear((bytes[off + 2] ?? 0) / 255),
    srgbToLinear((bytes[off + 1] ?? 0) / 255),
    srgbToLinear((bytes[off + 0] ?? 0) / 255),
  ];
};

const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.05, 0.05, 0.08];

const sites = [
  { name: 'center', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'left', x: Math.floor(WIDTH * 0.25), y: Math.floor(HEIGHT / 2) },
  { name: 'right', x: Math.floor(WIDTH * 0.75), y: Math.floor(HEIGHT / 2) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);

const region = (x0, x1) => {
  let count = 0;
  let sum = 0;
  let sumSquared = 0;
  let maxLuma = 0;
  for (let y = 0; y < HEIGHT; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const r = bytes[off] ?? 0;
      const g = bytes[off + 1] ?? 0;
      const b = bytes[off + 2] ?? 0;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      count += 1;
      sum += luma;
      sumSquared += luma * luma;
      maxLuma = Math.max(maxLuma, luma);
    }
  }
  const meanLuma = sum / count;
  return {
    meanLuma,
    stddevLuma: Math.sqrt(Math.max(0, sumSquared / count - meanLuma * meanLuma)),
    maxLuma,
  };
};
const pixelRegions = {
  left: region(0, Math.floor(WIDTH / 2)),
  right: region(Math.floor(WIDTH / 2), WIDTH),
};
const meshedRenderCount = Object.values(pixelRegions)
  .filter((stats) => stats.stddevLuma > 2 && stats.maxLuma > 20).length;

// M30 same-World recovery: clone the loader-shaped scene POD, inject one stale
// field, observe the contextual rejection, then repair it without
// disturbing the healthy baseline instance.
const m30Failures = [];
const faultyInner = structuredClone(innerScene);
faultyInner.entities.cube.components.Transform.unknownField = 'M30-unknown-field';
const faultyOuter = structuredClone(outerScene);
const faultyInputSnapshot = JSON.stringify(faultyInner);
const faultyInnerHandle = world.allocSharedRef('SceneAsset', faultyInner);
const faultyOuterHandle = world.allocSharedRef('SceneAsset', faultyOuter);
sceneChildren.set(Number(faultyOuterHandle), faultyInnerHandle);
const faultyResult = worldInstantiateScene(world, faultyOuterHandle);
const faultyEntityCount = world.inspect().entityCount;
const faultyDetail = faultyResult.ok ? undefined : faultyResult.error.detail;
const rejectedBeforeSpawn = !faultyResult.ok
  && faultyResult.error.code === 'asset-package-invalid'
  && faultyDetail?.reason === 'unknown component field'
  && faultyDetail?.component === 'Transform'
  && faultyDetail?.field === 'unknownField'
  && faultyDetail?.entity === 'cube';
const inputUnchanged = JSON.stringify(faultyInner) === faultyInputSnapshot;
const noOrphanAfterFault = faultyEntityCount === baselineEntityCount;
const healthyRetainedAfterFault = world.get(rootEntity, SceneInstance).ok;
if (!rejectedBeforeSpawn) {
  m30Failures.push(`wrong rejection: ${JSON.stringify(faultyResult)}`);
}
if (!inputUnchanged || !noOrphanAfterFault || !healthyRetainedAfterFault) {
  m30Failures.push(
    `fault rejection invariant failed: ${JSON.stringify({ inputUnchanged, noOrphanAfterFault, healthyRetainedAfterFault, faultyEntityCount, baselineEntityCount })}`,
  );
}
sceneChildren.delete(Number(faultyOuterHandle));
world.sharedRefs.release(faultyInnerHandle);
world.sharedRefs.release(faultyOuterHandle);

const correctedInner = structuredClone(faultyInner);
delete correctedInner.entities.cube.components.Transform.unknownField;
const correctedOuter = structuredClone(faultyOuter);
const correctedInputSnapshot = JSON.stringify(correctedInner);
const correctedInnerHandle = world.allocSharedRef('SceneAsset', correctedInner);
const correctedOuterHandle = world.allocSharedRef('SceneAsset', correctedOuter);
sceneChildren.set(Number(correctedOuterHandle), correctedInnerHandle);
const correctedResult = worldInstantiateScene(world, correctedOuterHandle);
if (!correctedResult.ok) {
  m30Failures.push(`corrected instantiate failed: ${correctedResult.error.code}`);
} else {
  const correctedRoot = correctedResult.value.root;
  const correctedState = world.get(correctedRoot, SceneInstance);
  const correctedMember = correctedState.ok ? correctedState.value.mapping[2] : undefined;
  const correctedEmpty = correctedResult.value.diagnostics.length === 0;
  const correctionInputUnchanged = JSON.stringify(correctedInner) === correctedInputSnapshot;
  const freshIdentity = Number(correctedRoot) !== Number(rootEntity)
    && correctedMember !== undefined
    && baselineMountedMember !== undefined
    && Number(correctedMember) !== Number(baselineMountedMember);
  const healthyRetained = world.get(rootEntity, SceneInstance).ok;
  for (let i = 0; i < 60; i += 1) {
    world.update().unwrap();
    const draw = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!draw.ok) m30Failures.push(`corrected draw failed: ${draw.error.code}`);
    else void renderer.observe(draw.value, { include: ['draws'] });
  }
  await device.queue.onSubmittedWorkDone();
  bytes = await readback();
  const repairedPixelSamples = {};
  for (const site of sites) repairedPixelSamples[site.name] = readRgba(site.x, site.y);
  const repairedPixelRegions = {
    left: region(0, Math.floor(WIDTH / 2)),
    right: region(Math.floor(WIDTH / 2), WIDTH),
  };
  const repairedMeshedRenderCount = Object.values(repairedPixelRegions)
    .filter((stats) => stats.stddevLuma > 2 && stats.maxLuma > 20).length;
  const firstCleanupCount = worldDespawnScene(world, correctedRoot).unwrap();
  const secondCleanup = world.get(correctedRoot, SceneInstance).ok
    ? { changed: true, count: worldDespawnScene(world, correctedRoot).unwrap() }
    : { changed: false, count: 0 };
  const healthyRetainedBeforeFinalTeardown = world.get(rootEntity, SceneInstance).ok;
  sceneChildren.delete(Number(correctedOuterHandle));
  world.sharedRefs.release(correctedInnerHandle);
  world.sharedRefs.release(correctedOuterHandle);
  if (!correctedEmpty || !correctionInputUnchanged || !freshIdentity || !healthyRetained) {
    m30Failures.push(
      `corrected recovery invariant failed: ${JSON.stringify({ correctedEmpty, correctionInputUnchanged, freshIdentity, healthyRetained })}`,
    );
  }
  if (repairedMeshedRenderCount === 0) {
    m30Failures.push(`corrected pixels blank: ${JSON.stringify(repairedPixelRegions)}`);
  }
  if (firstCleanupCount !== 5 || secondCleanup.changed || !healthyRetainedBeforeFinalTeardown) {
    m30Failures.push(
      `corrected cleanup invariant failed: ${JSON.stringify({ firstCleanupCount, secondCleanup, healthyRetainedBeforeFinalTeardown })}`,
    );
  }
  globalThis.__m30DawnRecovery = {
    rejectedBeforeSpawn,
    error: faultyResult.ok ? undefined : faultyResult.error,
    faultyEntityCount,
    baselineEntityCount,
    noOrphanAfterFault,
    healthyRetainedAfterFault,
    correctedDiagnostics: correctedResult.value.diagnostics,
    correctedEmpty,
    correctionInputUnchanged,
    freshIdentity,
    healthyRetained,
    firstCleanupCount,
    secondCleanup,
    healthyRetainedBeforeFinalTeardown,
    repairedPixelSamples,
    repairedPixelRegions,
  };
}

const failures = [];
if (framesObserved < SMOKE_MIN_FRAMES) failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (errors.length > 0) {
  failures.push(`(d) Renderer.onError fired ${errors.length} times: [${errors.map((e) => e.code).join(', ')}]`);
}
if (consoleErrorRhiCount > 0) {
  // R2/B-5: console.error path RhiErrors (propagateTransforms hierarchy-broken etc.)
  // are routed through console.error rather than Renderer error events, so the
  // (d) gate alone does not see them; this (e) gate catches them.
  failures.push(`(e) console.error emitted ${consoleErrorRhiCount} RhiError-shaped lines (propagateTransforms / hierarchy-broken signals)`);
}
if (meshedRenderCount === 0) {
  failures.push(`(f) expected a nonblank lit scene in at least one half, regions=${JSON.stringify(pixelRegions)}`);
}
for (const failure of m30Failures) failures.push(`(m30) ${failure}`);
if (!addOverrideVerified) {
  failures.push('(g) component-add override (Name, no field) not verified on member entity');
}

const evidenceDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
const dawnEvidence = {
  status: failures.length === 0 ? 'pass' : 'fail',
  framesObserved,
  baselineEntityCount,
  pixelSamples,
  pixelRegions,
  addOverrideVerified,
  rendererErrors: errors,
  consoleErrorRhiCount,
  recovery: globalThis.__m30DawnRecovery ?? null,
  failures,
};
if (evidenceDir !== undefined) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    resolve(evidenceDir, 'scene-nesting-dawn-evidence.json'),
    `${JSON.stringify(dawnEvidence, null, 2)}\n`,
  );
}

if (failures.length > 0) {
  consoleErrorOriginal(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) consoleErrorOriginal(`  ${f}`);
  await delay(0);
  device.destroy?.();
  process.exit(1);
}

console.log(`[smoke] PASS - frames=${framesObserved}, Renderer.onError count=0, console.error RhiError count=0; lit regions=${meshedRenderCount}/2, pixelRegions=${JSON.stringify(pixelRegions)}, M30 recovery green`);

worldDespawnScene(world, rootEntity).unwrap();
world.sharedRefs.release(innerHandle);
world.sharedRefs.release(outerHandle);
world.sharedRefs.release(meshHandle);
world.sharedRefs.release(unlitMatHandle);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
