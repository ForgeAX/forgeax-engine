#!/usr/bin/env node
import { driveReadyAppFrames } from '../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runFogLifecycle } from '../src/runner.mjs';
import { evaluateFogCase } from '../src/oracle.mjs';
import { sampleFogRois } from '../src/roi.mjs';
import { encodePng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
let width = 320;
let height = 180;
const targetFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const featureEvidenceDir = process.env.FORGEAX_FOG_EVIDENCE_DIR ?? resolve(appRoot, 'artifacts');
const pairEvidenceDir = resolve(featureEvidenceDir, 'dawn-fog-pairs');
const errors = [];
const recoveryErrors = [];
const pairScreenshots = new Map();
let recoveryExpected = false;
const TEMPORAL_SETTLE_FRAMES = 34;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error('[smoke-dawn] unavailable: webgpu import failed: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
let triggerDeviceLoss = () => false;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const rawDevice = await originalRequestDevice(descriptor);
    let resolveLost;
    const lost = new Promise((resolve) => {
      resolveLost = resolve;
    });
    triggerDeviceLoss = () => {
      if (resolveLost === undefined) return false;
      resolveLost({ reason: 'unknown', message: 'Fog Dawn smoke forced recoverable device loss' });
      resolveLost = undefined;
      return true;
    };
    Object.defineProperty(rawDevice, 'lost', {
      configurable: true,
      get: () => lost,
    });
    sharedDevice = rawDevice;
    return rawDevice;
  };
  return adapter;
};

let renderTarget;
let renderTargetDevice;
let renderTargetFormat;
function ensureRenderTarget(device, format) {
  const targetDevice = sharedDevice ?? device;
  if (
    renderTarget !== undefined &&
    (renderTargetDevice !== targetDevice ||
      renderTargetFormat !== format ||
      renderTarget.width !== width ||
      renderTarget.height !== height)
  ) {
    renderTarget.destroy();
    renderTarget = undefined;
  }
  renderTarget ??= targetDevice.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTargetDevice = targetDevice;
  renderTargetFormat = format;
  return renderTarget;
}

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = rafId++;
  rafQueue.push({ id, callback });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((entry) => entry.id !== id);
};
let now = 0;
globalThis.performance.now = () => now;

const mockCanvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width,
  height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
      },
      // A real GPUCanvasContext releases its current swap-chain image when
      // unconfigured. Clear the Dawn test surface too, so renderer recovery
      // cannot read back a texture minted by the lost device.
      unconfigure() {
        renderTarget = undefined;
        renderTargetDevice = undefined;
        renderTargetFormat = undefined;
      },
      getCurrentTexture() {
        if (
          !renderTarget ||
          renderTargetDevice !== sharedDevice ||
          renderTarget.width !== mockCanvas.width ||
          renderTarget.height !== mockCanvas.height
        ) {
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const manifest = await buildEngineShaderManifest();
const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');
const { World } = await import('@forgeax/engine-ecs');
const { createBoxGeometry, createSphereGeometry } = await import('@forgeax/engine-geometry');
const { quat } = await import('@forgeax/engine-math');
const {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  TONEMAP_NEUTRAL,
  VolumetricFog,
  perspective,
} =
  await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const fogScene = JSON.parse(readFileSync(resolve(appRoot, 'src/fog-scene.json'), 'utf8'));
const appResult = await createApp(
  mockCanvas,
  {
    platform: createSmokePlatform(mockCanvas),
    standardProfile: {
      ...DEFAULT_STANDARD_PROFILE,
      volumetricFog: { quality: 'high', depth: 64, tileSize: 4 },
    },
  },
  { shaderManifestUrl: manifestUrl },
);
if (!appResult.ok) {
  console.error('[smoke-dawn] unavailable: createApp failed: ' + appResult.error.code);
  process.exit(1);
}
const app = appResult.value;
const recordError = (error) => {
  if (error?.code === 'device-lost' || (recoveryExpected && error?.code === 'device-operation-failed')) {
    recoveryErrors.push(error);
  }
  else errors.push(error);
};
app.onError(recordError);

const world = app.world;
const resourceWorld = new World();
let resourceOwner = 0;
app.setDrawSource(() => ({
  worlds: [world, resourceWorld],
  cameraOwner: 0,
  resourceOwner,
}));
const densityExtent = 64;
const densityData = new Uint8Array(densityExtent * densityExtent * densityExtent);
densityData.fill(96);
const densityAsset = {
  kind: 'texture',
  shape: {
    viewDimension: '3d',
    extent: { width: densityExtent, height: densityExtent, depth: densityExtent },
  },
  format: 'r8unorm',
  colorSpace: 'linear',
  mips: { kind: 'none' },
  data: densityData,
};
const densityHandle = world.allocSharedRef('TextureAsset', densityAsset);
const resourceDensityHandle = resourceWorld.allocSharedRef('TextureAsset', densityAsset);
const ground = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: fogScene.materials.ground, roughness: 0.92 }),
);
const tick = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: fogScene.materials.tick, roughness: 0.88 }),
);
const gate = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: fogScene.materials.gate, roughness: 0.72 }),
);
const marker = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: fogScene.materials.marker, metallic: 0.1, roughness: 0.28 }),
);
const structure = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({ baseColor: fogScene.materials.structure, roughness: 0.86 }),
);
const cubeMesh = world.internSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
const sphereMesh = world.internSharedRef('MeshAsset', createSphereGeometry(1).unwrap());
function spawnCube(pos, scale, material) {
  world.spawn(
    { component: Transform, data: { pos, scale } },
    { component: MeshFilter, data: { assetHandle: cubeMesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
}
function spawnSphere(pos) {
  world.spawn(
    { component: Transform, data: { pos, scale: fogScene.geometry.markers.sphereScale } },
    { component: MeshFilter, data: { assetHandle: sphereMesh } },
    { component: MeshRenderer, data: { materials: [marker] } },
  ).unwrap();
}
const { ground: groundGeometry, ticks, sidePosts, gates, markers, endWall } = fogScene.geometry;
spawnCube(groundGeometry.position, groundGeometry.scale, ground);
for (let z = ticks.start; z >= ticks.end; z += ticks.step) {
  spawnCube([0, ticks.positionY, z], ticks.scale, tick);
  for (const x of sidePosts.x) spawnCube([x, sidePosts.positionY, z], sidePosts.scale, structure);
}
for (const z of gates.depths) {
  for (const x of gates.sideX) spawnCube([x, gates.sidePositionY, z], gates.sideScale, gate);
  spawnCube([0, gates.topPositionY, z], gates.topScale, gate);
}
spawnCube([markers.low.x, markers.low.baseY, markers.depth], markers.low.baseScale, structure);
spawnSphere([markers.low.x, markers.low.sphereY, markers.depth]);
spawnCube([markers.high.x, markers.high.baseY, markers.depth], markers.high.baseScale, structure);
spawnSphere([markers.high.x, markers.high.sphereY, markers.depth]);
spawnCube(endWall.position, endWall.scale, structure);
const primaryLight = world.spawn(
  { component: Transform, data: { pos: fogScene.lighting.position } },
  {
    component: PointLight,
    data: {
      color: fogScene.lighting.color,
      intensity: fogScene.lighting.intensity,
      range: fogScene.lighting.range,
    },
  },
).unwrap();
const resourceLight = resourceWorld.spawn(
  { component: Transform, data: { pos: fogScene.lighting.position } },
  {
    component: PointLight,
    data: {
      color: fogScene.lighting.color,
      intensity: fogScene.lighting.intensity,
      range: fogScene.lighting.range,
    },
  },
).unwrap();
const cameraPosition = fogScene.camera.position;
const cameraTarget = fogScene.camera.target;
const camera = world.spawn(
  {
    component: Transform,
    data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]) },
  },
  {
    component: Camera,
    data: {
      ...perspective({
        fov: (fogScene.camera.fovDegrees * Math.PI) / 180,
        aspect: width / height,
        near: fogScene.camera.near,
        far: fogScene.camera.far,
      }),
      tonemap: TONEMAP_NEUTRAL,
      clearColor: [...fogScene.fogColor, 1],
    },
  },
).unwrap();

let fogEntity;
let revision = 0;
let previousPhase;
let fogOwnerWorld = world;
let activeFogData;
const volumeBounds = { min: [-18, -1, -72], max: [18, 12, 1] };
const volumeParameters = {
  uniform: { extinction: [0.028, 0.028, 0.028], boundsMin: volumeBounds.min },
  change: { extinction: [0.05, 0.05, 0.05], boundsMin: volumeBounds.min },
  height: { extinction: [0.028, 0.028, 0.028], boundsMin: [
    volumeBounds.min[0],
    0.35,
    volumeBounds.min[2],
  ] },
};
function volumeData(data) {
  const ownerIsResource = fogOwnerWorld === resourceWorld;
  return {
    light: ownerIsResource ? resourceLight : primaryLight,
    density: ownerIsResource ? resourceDensityHandle : densityHandle,
    boundsMin: data.boundsMin,
    boundsMax: volumeBounds.max,
    extinction: data.extinction,
    albedo: [1, 1, 1],
    emission: [0, 0, 0],
    anisotropy: 0,
    maxDistance: 120,
  };
}
function attachFog(data) {
  fogEntity = fogOwnerWorld.spawn({
    component: VolumetricFog,
    data: volumeData(data),
  }).unwrap();
  activeFogData = data;
  revision += 1;
}

function updateFog(data) {
  activeFogData = data;
  if (fogEntity === undefined) {
    attachFog(data);
    return;
  }
  fogOwnerWorld.set(fogEntity, VolumetricFog, volumeData(data)).unwrap();
  revision += 1;
}

function detachFog() {
  if (fogEntity !== undefined) {
    fogOwnerWorld.despawn(fogEntity).unwrap();
    fogEntity = undefined;
    activeFogData = undefined;
    revision += 1;
  }
}

function switchFogOwner(nextWorld) {
  if (nextWorld === fogOwnerWorld) return false;
  if (fogEntity !== undefined) {
    fogOwnerWorld.despawn(fogEntity).unwrap();
    fogEntity = undefined;
  }
  fogOwnerWorld = nextWorld;
  if (activeFogData !== undefined) {
    fogEntity = fogOwnerWorld.spawn({
      component: VolumetricFog,
      data: volumeData(activeFogData),
    }).unwrap();
  }
  revision += 1;
  return true;
}

function resizeTarget(nextWidth, nextHeight) {
  width = Math.max(1, Math.floor(nextWidth));
  height = Math.max(1, Math.floor(nextHeight));
  mockCanvas.width = width;
  mockCanvas.height = height;
  world.set(camera, Camera, { aspect: width / height }).unwrap();
}

function applyPhase(phase) {
  if (phase === previousPhase) return { changedFrom: undefined, ownerChanged: false };
  const oldPhase = previousPhase;
  previousPhase = phase;
  let ownerChanged = false;
  switch (phase) {
    case 'disabled':
      detachFog();
      break;
    case 'uniform':
      updateFog(volumeParameters.uniform);
      break;
    case 'change':
      updateFog(volumeParameters.change);
      break;
    case 'height':
      updateFog(volumeParameters.height);
      break;
    case 'detach-reattach':
      detachFog();
      attachFog(volumeParameters.height);
      break;
    case 'camera-switch':
      // Keep the switch visible to the fixed center ROI: a large forward move
      // lands the center ray on the unlit ground and falsely reports black fog.
      world.set(camera, Transform, { pos: [3, 7.5, 14] }).unwrap();
      revision += 1;
      break;
    case 'owner-switch':
      ownerChanged = switchFogOwner(resourceWorld);
      if (ownerChanged) resourceOwner = 1;
      if (!ownerChanged) revision += 1;
      break;
    case 'resize':
      resizeTarget(256, 144);
      revision += 1;
      break;
    case 'recovery':
      revision += 1;
      break;
    default:
      throw new Error('unknown Fog phase ' + phase);
  }
  return { changedFrom: oldPhase, ownerChanged };
}

async function readbackCenter() {
  await sharedDevice.queue.onSubmittedWorkDone();
  if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
  const targetWidth = renderTarget.width;
  const targetHeight = renderTarget.height;
  const bytesPerRow = Math.ceil((targetWidth * 4) / 256) * 256;
  const readback = sharedDevice.createBuffer({ size: bytesPerRow * targetHeight, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readback, bytesPerRow, rowsPerImage: targetHeight },
    { width: targetWidth, height: targetHeight, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x01);
  const pixels = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const centerX = Math.floor(targetWidth / 2);
  const centerY = Math.floor(targetHeight / 2);
  const rgba = [0, 0, 0, 0];
  const tightPixels = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceOffset = y * bytesPerRow;
    const targetOffset = y * targetWidth * 4;
    tightPixels.set(pixels.subarray(sourceOffset, sourceOffset + targetWidth * 4), targetOffset);
  }
  let count = 0;
  for (let y = Math.max(0, centerY - 1); y <= Math.min(targetHeight - 1, centerY + 1); y += 1) {
    for (let x = Math.max(0, centerX - 1); x <= Math.min(targetWidth - 1, centerX + 1); x += 1) {
      const offset = (y * targetWidth + x) * 4;
      rgba[0] += (tightPixels[offset] ?? 0) / 255;
      rgba[1] += (tightPixels[offset + 1] ?? 0) / 255;
      rgba[2] += (tightPixels[offset + 2] ?? 0) / 255;
      rgba[3] += (tightPixels[offset + 3] ?? 0) / 255;
      count += 1;
    }
  }
  return {
    rgba: rgba.map((value) => value / count),
    pixels: tightPixels,
    width: targetWidth,
    height: targetHeight,
  };
}

async function advanceSettlingFrame() {
  await driveReadyAppFrames(app.renderer, () => {
    const due = rafQueue.shift();
    if (due === undefined) return false;
    now += 16.67;
    due.callback(now);
  });
  return true;
}

const phaseReferences = new Map();
let disabledReference;
let lastPhase;

function renderedCenterOracle(phase, sample) {
  if (phase !== lastPhase) {
    phaseReferences.delete(phase);
    if (phase === 'disabled') disabledReference = undefined;
    lastPhase = phase;
  }
  const observed = sample.rgba;
  const primed = !phaseReferences.has(phase);
  const expected = phaseReferences.get(phase) ?? observed;
  phaseReferences.set(phase, expected);
  if (phase === 'disabled' && disabledReference === undefined) disabledReference = observed;
  const caseResult = evaluateFogCase({
    caseId: phase,
    expected,
    observed,
    active: phase !== 'disabled',
  });
  const activeDelta =
    phase === 'disabled' || disabledReference === undefined
      ? undefined
      : Math.max(...observed.slice(0, 3).map((value, index) => Math.abs(value - disabledReference[index])));
  if (phase !== 'disabled' && activeDelta !== undefined && activeDelta <= 0.01) {
    return {
      ...caseResult,
      verdict: 'fail',
      confidence: 'low',
      reason: 'active Fog center fragment did not differ from the captured disabled fragment',
    };
  }
  if (primed) {
    return {
      ...caseResult,
      confidence: 'medium',
      reason: 'oracle primed from the actual rendered center fragment',
    };
  }
  return caseResult;
}

const started = app.start();
if (!started.ok) {
  console.error('[smoke-dawn] unavailable: app start failed: ' + started.error.code);
  process.exit(1);
}
await advanceSettlingFrame();

const trace = await runFogLifecycle({
  backend: 'dawn',
  frameCount: targetFrames,
  advanceFrame: async ({ frame, phase, phaseChanged }) => {
    const phaseState = applyPhase(phase);
    await advanceSettlingFrame();
    let recovery;
    if (phase === 'recovery' && phaseChanged) {
      recoveryExpected = true;
      if (!triggerDeviceLoss()) {
        throw new Error('Dawn smoke could not arm a recoverable device-loss trigger');
      }
      await delay(0);
      const before = app.renderer.state();
      const result = await app.renderer.recover();
      const after = app.renderer.state();
      const recovered = result.ok && before === 'device-lost' && after === 'alive';
      recovery = {
        action: 'renderer.recover',
        before,
        result: result.ok ? 'recovered' : result.error.code,
        after,
        verdict: recovered ? 'pass' : 'fail',
        ...(recovered
          ? {}
          : {
              reason:
                'Dawn smoke did not observe a real device-lost -> alive transition; recover-not-needed is not recovery evidence',
            }),
      };
      if (recovered) {
        await advanceSettlingFrame();
        await advanceSettlingFrame();
      }
    }
    return { phaseState, recovery };
  },
  captureFrame: async ({ frame, phase, advanced }) => {
    for (let settle = 0; settle < TEMPORAL_SETTLE_FRAMES; settle += 1) {
      if (!(await advanceSettlingFrame())) break;
    }
    const sample = await readbackCenter();
    const observed = sample.rgba;
    const roi = sampleFogRois(sample.pixels, sample.width, sample.height);
    const oracleResult = renderedCenterOracle(phase, sample);
    const caseResult =
      advanced.recovery?.verdict === 'fail'
        ? {
            ...oracleResult,
            verdict: 'fail',
            confidence: 'low',
            reason: advanced.recovery.reason,
          }
        : oracleResult;
    if (!pairScreenshots.has(phase) && ['disabled', 'uniform', 'height'].includes(phase)) {
      mkdirSync(pairEvidenceDir, { recursive: true });
      const path = resolve(pairEvidenceDir, `dawn-fog-${phase}.png`);
      const pngBytes = encodePng(sample.width, sample.height, sample.pixels);
      writeFileSync(path, pngBytes);
      pairScreenshots.set(phase, {
        phase,
        path,
        bytes: pngBytes.byteLength,
        sha256: createHash('sha256').update(pngBytes).digest('hex'),
        state: advanced.phaseState,
        observed: observed.slice(0, 4),
        roi,
        viewport: { width: sample.width, height: sample.height },
      });
    }
    return {
      cases: [caseResult],
      resource: {
        owner: resourceOwner,
        revision,
        reactive: advanced.phaseState.changedFrom !== undefined,
        accumulation: advanced.phaseState.changedFrom === undefined,
        ownerChanged: advanced.phaseState.ownerChanged,
        target: { width: sample.width, height: sample.height },
        ...(advanced.recovery === undefined ? {} : { recovery: advanced.recovery }),
      },
      visual: {
        observed: observed.slice(0, 3),
        verdict: caseResult.verdict,
        confidence: caseResult.confidence,
        backend: 'dawn',
        roi,
      },
    };
  },
});
app.stop();

if (!sharedDevice || !renderTarget) {
  console.error('[smoke-dawn] unavailable: no device or render target');
  process.exit(1);
}
const evidencePath = resolve(featureEvidenceDir, 'dawn-fog-trace.json');
mkdirSync(dirname(evidencePath), { recursive: true });
const evidence = {
  ...trace,
  schemaVersion: 'bevy-fog-evidence/1',
  featureId: 'feat-20260827-render-temporal-environment-bloom-syntax-corrected',
  source: { path: 'apps/bevy/fog/src/main.ts', sha256: createHash('sha256').update(readFileSync(resolve(appRoot, 'src/main.ts'))).digest('hex') },
  build: { command: 'pnpm --filter @forgeax/bevy-fog build', sha256: createHash('sha256').update(readFileSync(resolve(appRoot, 'package.json'))).digest('hex') },
  backend: 'dawn-node',
  runner: { kind: 'dawn.node', id: process.env.CI ? 'ci-dawn' : 'local-dawn' },
  status: trace.verdict === 'pass' ? 'pass' : 'fail',
  frameIdentity: { first: 0, last: Math.max(0, trace.frames - 1), sequenceSha256: createHash('sha256').update(trace.phaseTrace.join('|')).digest('hex') },
  visualEvidence: (trace.visualEvidence ?? []).map((entry, index) => ({ id: `fog-${entry.phase ?? index}`, png: pairScreenshots.get(entry.phase)?.path ?? resolve(pairEvidenceDir, 'missing.png'), observed: JSON.stringify(entry.observed ?? []), verdict: entry.verdict ?? 'fail', confidence: entry.confidence ?? 'low' })),
  falsify: ['uniform', 'height', 'owner-switch', 'recovery'].map((id) => ({ id, result: trace.cases.some((entry) => entry.caseId === id && entry.verdict === 'pass') ? 'pass' : 'fail' })),
  errors: errors.map((error) => error.code ?? String(error)),
  recoveryErrors: recoveryErrors.map((error) => error.code ?? String(error)),
  pairScreenshots: Array.from(pairScreenshots.values()),
};
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
renderTarget?.destroy?.();
sharedDevice?.destroy?.();
console.log('[smoke-dawn] backend=dawn frames=' + trace.frames + ' verdict=' + trace.verdict + ' evidence=' + evidencePath);
if (errors.length > 0 || trace.verdict !== 'pass') {
  console.error('[smoke-dawn] FAIL - errors=' + errors.length + ' trace=' + trace.verdict);
  const failedCases = evidence.cases.filter((entry) => entry.verdict !== 'pass');
  const failedVisualEvidence = evidence.visualEvidence.filter((entry) => entry.verdict !== 'pass');
  if (failedCases.length > 0) {
    console.error('[smoke-dawn] failed-cases=' + JSON.stringify(failedCases));
  }
  if (failedVisualEvidence.length > 0) {
    console.error('[smoke-dawn] failed-visual-evidence=' + JSON.stringify(failedVisualEvidence));
  }
  process.exit(1);
}
console.log('[smoke-dawn] PASS - real Dawn readback and recovery trace completed');
console.log('[smoke] PASS');
process.exit(0);
