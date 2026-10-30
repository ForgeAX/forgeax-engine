#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { completeReadyFrame, drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { createSmokePlatform } from '../../../../../scripts/smoke-platform.mjs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { emitSmokeReceipt, smokeFrameBudget } from '../../../../shared/scripts/smoke-receipt.mjs';
import {
  deriveReflectionFallbackEvidence,
  reflectionFallbackValidationLog,
} from './ssr-fallback-evidence.mjs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const MIN_FRAMES = smokeFrameBudget();
const WIDTH = 256;
const HEIGHT = 256;
const TARGET_ID = 'target-cube-reflection';
const CUBE_REFLECTION_SHADER_ID = 'learn_render::6_4_cube_reflection';
const REFLECTION_EVIDENCE = process.env.VITE_REFLECTION_PROBE_EVIDENCE === '1';
const readRgba8Pixel = (bytes, bytesPerRow, x, y) => {
  const offset = y * bytesPerRow + x * 4;
  return [
    (bytes[offset] ?? 0) / 255,
    (bytes[offset + 1] ?? 0) / 255,
    (bytes[offset + 2] ?? 0) / 255,
    (bytes[offset + 3] ?? 0) / 255,
  ];
};
const nearestCubeFaceEpsilon = (pixel) => Math.min(
  ...FACE_COLORS.map((expected) => Math.max(
    ...expected.map((value, channel) => Math.abs(value - pixel[channel])),
  )),
);
const findMaterialSamplingPixel = (pixels, bytesPerRow) => {
  let best;
  let bestScore = -Infinity;
  for (let y = Math.floor(HEIGHT * 0.3); y < Math.ceil(HEIGHT * 0.7); y += 4) {
    for (let x = Math.floor(WIDTH * 0.3); x < Math.ceil(WIDTH * 0.7); x += 4) {
      const pixel = readRgba8Pixel(pixels, bytesPerRow, x, y);
      const epsilon = nearestCubeFaceEpsilon(pixel);
      const saturation = Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
      if (epsilon <= 0.2 && saturation >= 0.2 && saturation - epsilon > bestScore) {
        best = pixel;
        bestScore = saturation - epsilon;
      }
    }
  }
  return best;
};
const SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  encoding: 'utf8',
}).trim();
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ssrIdentity = {
  sourceHead: SOURCE_SHA,
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  lockSha256: hashFile(resolve(rootDir, 'pnpm-lock.yaml')),
  buildSha256: hashFile(resolve(rootDir, 'packages/render/dist/index.mjs')),
};

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - webgpu import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {} });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
const requestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options);
  if (adapter === null) return null;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const result = await requestDevice(descriptor);
    device = result;
    return result;
  };
  return adapter;
};

const readCanvasPixels = async () => {
  if (device === undefined || targetTexture === undefined) {
    throw new Error('canvas texture is unavailable for Dawn material readback');
  }
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x0001 | 0x0008,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: targetTexture },
    { buffer, bytesPerRow },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x0001);
  const bytes = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  return { bytes, bytesPerRow };
};

let targetTexture;
const canvas = {
  tagName: 'CANVAS',
  isConnected: true,
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure({ device: configuredDevice, format }) {
        targetTexture = configuredDevice.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format,
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (targetTexture === undefined) throw new Error('swapchain texture is not configured');
        return targetTexture;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

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

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await buildEngineShaderManifest({
  materialPackages: [resolve(demoDir, 'src/cube-reflection.pack.json')],
});
const shaderManifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(shaderManifestUrl));
const { createApp } = await import('@forgeax/engine-app/browser');

const { World } = await import('@forgeax/engine-ecs');
const {
  Camera,
  CUBE_CAMERA_FACE_ORDER,
  CubeCamera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  ReflectionProbe,
  ScreenSpaceReflection,
  Skylight,
  perspective,
} = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const faceColor = (face) => {
  switch (face) {
    case '+X': return [1, 0, 0, 1];
    case '-X': return [0, 1, 1, 1];
    case '+Y': return [0, 1, 0, 1];
    case '-Y': return [1, 0, 1, 1];
    case '+Z': return [0, 0, 1, 1];
    case '-Z': return [1, 1, 0, 1];
  }
};
const FACE_COLORS = CUBE_CAMERA_FACE_ORDER.map(faceColor);

let submitFailureArmed = false;
let resolveInjectedDeviceLoss;
const expectedErrorCodes = new Map();
const expectError = (code) => {
  expectedErrorCodes.set(code, (expectedErrorCodes.get(code) ?? 0) + 1);
};
const hasNestedErrorCode = (value, expectedCode, seen = new Set()) => {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.code === expectedCode) return true;
  for (const key of ['cause', 'detail', 'error', 'causes']) {
    if (hasNestedErrorCode(value[key], expectedCode, seen)) return true;
  }
  return false;
};
const consumeExpectedError = (error) => {
  for (const [code, budget] of expectedErrorCodes) {
    if (budget > 0 && hasNestedErrorCode(error, code)) {
      expectedErrorCodes.set(code, budget - 1);
      return true;
    }
  }
  return false;
};
const faultInstrumentation = REFLECTION_EVIDENCE
  ? {
      beforeSubmit: () => {
        if (!submitFailureArmed) return undefined;
        submitFailureArmed = false;
        expectError('queue-submit-failed');
        const failure = new Error('fixture-injected reflection fallback submit failure');
        Object.assign(failure, {
          code: 'queue-submit-failed',
          expected: 'the reflection fallback fixture submit fault to be handled as a failed transaction',
          hint: 'fixture-injected reflection fallback submit failure',
        });
        return failure;
      },
      deviceLost: (currentDevice) => {
        const injected = new Promise((resolve) => {
          resolveInjectedDeviceLoss = resolve;
        });
        return Promise.race([currentDevice.lost, injected]);
      },
    }
  : undefined;
const appResult = await createApp(
  canvas,
  { platform: createSmokePlatform(canvas),
    ssrIdentity,
    captureReflectionFallbackReadback: REFLECTION_EVIDENCE,
    ...(REFLECTION_EVIDENCE
      ? { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' } }
      : {}),
    ...(faultInstrumentation === undefined ? {} : { rhiInstrumentation: faultInstrumentation }),
  },
  { shaderManifestUrl },
);
if (!appResult.ok) {
  console.error(`[smoke] FAIL - createApp failed: ${appResult.error.code}`);
  process.exit(1);
}
const app = appResult.value;
const renderer = app.renderer;
let latestDrawReceipt;
const draw = renderer.draw.bind(renderer);
renderer.draw = (...args) => {
  const result = draw(...args);
  if (result.ok) latestDrawReceipt = result.value;
  return result;
};
const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const primitiveSphere = app.assets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

const targetResult = renderer.createRenderTarget({
  shape: 'cube',
  width: 64,
  height: 64,
  format: 'rgba8unorm-srgb',
  mipLevels: 1,
  sampleCount: 4,
  sampled: true,
  readback: true,
});
if (!targetResult.ok) {
  console.error(`[smoke] FAIL - target create failed: ${targetResult.error.code}`);
  process.exit(1);
}
const sourceResult = renderer.createRenderTargetTextureSource(targetResult.value, {
  aspect: 'color',
  dimension: 'cube',
  mipLevel: 0,
});
if (!sourceResult.ok) {
  console.error(`[smoke] FAIL - source create failed: ${sourceResult.error.code}`);
  process.exit(1);
}
const targetHandle = world.allocSharedRef('RenderTarget', targetResult.value);
const sourceHandle = { source: sourceResult.value };
const materialPayload = REFLECTION_EVIDENCE
  ? Materials.standard({ baseColor: [0.8, 0.9, 1, 1], metallic: 0.1, roughness: 0.35 })
  : {
      kind: 'material',
      passes: [{
        name: 'Forward',
        program: {
          module: CUBE_REFLECTION_SHADER_ID,
          vertexEntry: 'vs_main',
          fragmentEntry: 'fs_main',
        },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      }],
      parameters: [
        { name: 'baseColor', type: 'color' },
        { name: 'cubeTexture', type: 'texture_cube' },
      ],
      values: { baseColor: [1, 1, 1, 1], cubeTexture: sourceHandle },
    };
const materialHandle = world.assets.create(materialPayload).unwrap();
const panelTransforms = [
  [[3, 0, 0], [0.12, 2.4, 2.4]],
  [[-3, 0, 0], [0.12, 2.4, 2.4]],
  [[0, 3, 0], [2.4, 0.12, 2.4]],
  [[0, -3, 0], [2.4, 0.12, 2.4]],
  [[0, 0, 3], [2.4, 2.4, 0.12]],
  [[0, 0, -3], [2.4, 2.4, 0.12]],
];
// The reflection evidence lane keeps the authored colored panels so the
// producer-owned fallback MRT is falsifiable with a non-neutral GPU sample.
for (let face = 0; face < CUBE_CAMERA_FACE_ORDER.length; face += 1) {
  const panelMaterial = world.assets.create(REFLECTION_EVIDENCE
      ? Materials.standard({ baseColor: FACE_COLORS[face], metallic: 0, roughness: 0.45 })
      : Materials.unlit(FACE_COLORS[face])).unwrap();
  const [pos, scale] = panelTransforms[face];
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [panelMaterial] } },
  ).unwrap();
}
const neutralAccentMaterial = world.assets.create(REFLECTION_EVIDENCE
    ? Materials.standard({ baseColor: [0.45, 0.45, 0.45, 1], metallic: 0, roughness: 0.7 })
    : Materials.unlit([0.45, 0.45, 0.45, 1])).unwrap();
const accentColumns = [
  [[-2.3, 0, 0.8], [0.55, 2, 0.55]],
  [[2.3, 0, 0.8], [0.55, 2, 0.55]],
  [[0, 2, 1.5], [0.9, 0.42, 0.9]],
];
for (const [pos, scale] of accentColumns) {
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [neutralAccentMaterial] } },
  ).unwrap();
}
const markerMaterial = world.assets.create(REFLECTION_EVIDENCE
    ? Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 })
    : Materials.unlit([1, 1, 1, 1])).unwrap();
const plusZMarkerParts = [
  [[0.55, 0.78, 2.9], [0.85, 0.12, 0.05]],
  [[0.2, 0.45, 2.9], [0.12, 0.78, 0.05]],
];
for (const [pos, scale] of plusZMarkerParts) {
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [markerMaterial] } },
  ).unwrap();
}
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 2, castShadow: false },
}).unwrap();
let skylightEntity;
let reflectionProbeEntity;
if (REFLECTION_EVIDENCE) {
  skylightEntity = world.spawn({
    component: Skylight,
    data: { color: [0.55, 0.7, 1], intensity: 1 },
  }).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], scale: [1.7, 1.7, 1.7] } },
  { component: MeshFilter, data: { assetHandle: primitiveSphere } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
).unwrap();
if (REFLECTION_EVIDENCE) {
  reflectionProbeEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    {
      component: ReflectionProbe,
      data: {
        halfExtents: [0.9, 0.9, 0.9],
        priority: 1,
        intensity: 1,
        resolution: 64,
        updateIntent: 0,
        invalidationVersion: 1,
      },
    },
  ).unwrap();
}
const cameraEntity = world.spawn(
  { component: Transform, data: { pos: [6, 0, 6], quat: [0, 0.38268343, 0, 0.9238795] } },
  {
    component: Camera,
    data: { ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }) },
  },
).unwrap();
if (REFLECTION_EVIDENCE) {
  world.addComponent(cameraEntity, {
    component: ScreenSpaceReflection,
    data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
  }).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0] } },
  {
    component: CubeCamera,
    data: {
      target: targetHandle,
      near: 0.1,
      far: 20,
      updateIntent: 0,
      requestVersion: 0,
      faceBudget: 6,
    },
  },
).unwrap();

const attached = renderer.attach(world);
if (!attached.ok) {
  console.error(`[smoke] FAIL - attach failed: ${attached.error.code}`);
  process.exit(1);
}
const events = [];
const summarizeError = (value, depth = 0) => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  const summary = {};
  for (const key of ['code', 'expected', 'hint', 'message', 'name', 'operation', 'detail', 'cause']) {
    if (key in value) summary[key] = summarizeError(value[key], depth + 1);
  }
  return summary;
};
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    if (consumeExpectedError(event.error)) return;
    events.push(event.error.code);
    if (events.length === 1) console.error(`[smoke] renderer error detail=${JSON.stringify(summarizeError(event.error))}`);
  }
});
const started = app.start();
if (!started.ok) {
  console.error(`[smoke] FAIL - app.start failed: ${started.error.code}`);
  process.exit(1);
}
let frames = 0;
let cubeFaceSubmissions = 0;
const reflectionPassNames = new Set();
const recordSubmittedPasses = () => {
  for (const passName of renderer.inspect().perFramePassNames) {
    if (passName.startsWith('cube-capture-face.')) cubeFaceSubmissions++;
    if (REFLECTION_EVIDENCE) reflectionPassNames.add(passName);
  }
};
for (; frames < MIN_FRAMES; frames += 1) {
  await completeReadyFrame(async () => {
    const item = rafQueue.shift();
    if (item === undefined) throw new Error('smoke app did not schedule the next frame');
    now += 16.67;
    latestDrawReceipt = undefined;
    item.callback(now);
    if (latestDrawReceipt === undefined) throw new Error('smoke frame did not submit a draw');
    (await latestDrawReceipt.completed).unwrap();
    recordSubmittedPasses();
    await delay(0);
    return latestDrawReceipt;
  });
}
// Main-camera readiness does not imply that all progressive cube views have
// submitted. Keep the readback tickets outside that preparation window.
const cubeDeadline = Date.now() + 15_000;
while (cubeFaceSubmissions < CUBE_CAMERA_FACE_ORDER.length) {
  if (Date.now() >= cubeDeadline) throw new Error(`cube capture incomplete: ${cubeFaceSubmissions}/6 faces`);
  world.update(1 / 60).unwrap();
  await drawReadyFrame(renderer, {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  recordSubmittedPasses();
  await delay(0);
}
const tickets = [];
let drawn;
for (let face = 0; face < CUBE_CAMERA_FACE_ORDER.length; face += 1) {
  // Bind all face copies to the receipt observed after the completed capture cycle.
  if (face === CUBE_CAMERA_FACE_ORDER.length - 1) {
    for (const face of CUBE_CAMERA_FACE_ORDER.keys()) {
      const ticketResult = renderer.requestTargetReadback(targetResult.value, { mipLevel: 0, layer: face });
      if (!ticketResult.ok) {
        console.error(`[smoke] FAIL - readback request failed: ${ticketResult.error.code}`);
        process.exit(1);
      }
      tickets.push(ticketResult.value);
    }
  }
  const updated = world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - world update failed: ${updated.error.code}`);
    process.exit(1);
  }
  drawn = await drawReadyFrame(renderer, {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
}
const observed = await renderer.observe(drawn, {
  include: ['target-readbacks'],
  targetReadbacks: tickets,
});
if (!observed.ok) throw observed.error;
let finalReceipt = drawn;
if (!REFLECTION_EVIDENCE) {
  const updated = world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - material world update failed: ${updated.error.code}`);
    process.exit(1);
  }
  const next = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (!next.ok) {
    console.error(`[smoke] FAIL - material receipt draw failed: ${next.error.code}`);
    process.exit(1);
  }
  finalReceipt = next.value;
  const completed = await next.value.completed;
  if (!completed.ok) {
    console.error(`[smoke] FAIL - material receipt completion failed: ${completed.error.code}`);
    process.exit(1);
  }
}
const observedFaces = observed.ok ? observed.value.targetReadbacks ?? [] : [];
const lowerYellowProbe = observedFaces[4] === undefined
  ? undefined
  : (() => {
      const read = (entry, x, y) => {
        const offset = y * entry.bytesPerRow + x * 4;
        return [
          entry.bytes[offset] / 255,
          entry.bytes[offset + 1] / 255,
          entry.bytes[offset + 2] / 255,
          entry.bytes[offset + 3] / 255,
        ];
      };
      const plusZLower = read(observedFaces[4], 31, 61);
      const plusZUpper = read(observedFaces[4], 31, 2);
      const yellowLike = (pixel) => pixel[0] > 0.7 && pixel[1] > 0.35 && pixel[2] < 0.2;
      return {
        candidates: [
          { face: '+Z', faceIndex: 4, pixel: [31, 61], observed: plusZLower, yellowLike: yellowLike(plusZLower) },
          { face: '+Z', faceIndex: 4, pixel: [31, 2], observed: plusZUpper, yellowLike: yellowLike(plusZUpper) },
        ],
      };
    })();
const yellowFaceRegions = observedFaces.map((entry) => {
  let count = 0;
  let minX = 64;
  let minY = 64;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const offset = y * entry.bytesPerRow + x * 4;
      const r = entry.bytes[offset] / 255;
      const g = entry.bytes[offset + 1] / 255;
      const b = entry.bytes[offset + 2] / 255;
      if (r <= 0.7 || g <= 0.35 || b >= 0.2) continue;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { count, bbox: count === 0 ? undefined : [minX, minY, maxX, maxY] };
});
const plusZMarkerOracle = observedFaces[4] === undefined
  ? undefined
  : (() => {
      let upperLeft = 0;
      let upperRight = 0;
      let lower = 0;
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const offset = y * observedFaces[4].bytesPerRow + x * 4;
          const r = observedFaces[4].bytes[offset] / 255;
          const g = observedFaces[4].bytes[offset + 1] / 255;
          const b = observedFaces[4].bytes[offset + 2] / 255;
          if (r < 0.8 || g < 0.8 || b < 0.8) continue;
          if (y < 32 && x < 32) upperLeft += 1;
          else if (y < 32) upperRight += 1;
          else lower += 1;
        }
      }
      return {
        face: '+Z',
        faceIndex: 4,
        expectedQuadrant: 'upper-left',
        upperLeftPixels: upperLeft,
        upperRightPixels: upperRight,
        lowerPixels: lower,
        detected: upperLeft > 8 && upperLeft > upperRight * 4 && upperLeft > lower * 4,
      };
    })();
const canvasPixels = REFLECTION_EVIDENCE ? undefined : await readCanvasPixels();
const materialPixel = canvasPixels === undefined
  ? undefined
  : findMaterialSamplingPixel(canvasPixels.bytes, canvasPixels.bytesPerRow);
const materialFaceMatchEpsilon = materialPixel === undefined
  ? undefined
  : nearestCubeFaceEpsilon(materialPixel);
const resized = renderer.resizeRenderTarget(targetResult.value, {
  shape: 'cube',
  width: 32,
  height: 32,
  format: 'rgba8unorm-srgb',
  mipLevels: 1,
  sampleCount: 4,
  sampled: true,
  readback: true,
});
const drawEvidenceFrame = async () => {
  const updated = world.update(1 / 60);
  if (!updated.ok) throw updated.error;
  const receipt = await drawReadyFrame(renderer, {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  for (const passName of renderer.inspect().perFramePassNames) reflectionPassNames.add(passName);
  await delay(0);
  return receipt;
};
if (REFLECTION_EVIDENCE) {
  for (let settle = 0; settle < 64; settle += 1) {
    const current = renderer.inspect().reflectionProbes;
    const probeFallback = current.reflectionFallbacks?.find(
      (row) => row.source === 'probe' && row.state === 'active' && row.candidateVisible === false,
    );
    const fallbackReadback = current.reflectionFallbackReadback;
    const hasProbeFallback =
      probeFallback !== undefined &&
      fallbackReadback?.readbackStatus === 'complete' &&
      probeFallback.frameId === fallbackReadback.frameId &&
      probeFallback.deviceGeneration === fallbackReadback.deviceGeneration &&
      fallbackReadback.linearHdr.slice(0, 3).some(
        (value) => Number.isFinite(value) && value !== 0,
      );
    if (
      current.rawFacesCaptured === 6 &&
      current.filteredStepsCompleted === 54 &&
      current.activeCount > 0 &&
      hasProbeFallback
    ) {
      break;
    }
    await drawEvidenceFrame();
  }
  const settled = renderer.inspect().reflectionProbes;
  if (
    settled.rawFacesCaptured !== 6 ||
    settled.filteredStepsCompleted !== 54 ||
    settled.activeCount === 0 ||
    !settled.reflectionFallbacks?.some(
      (row) => row.source === 'probe' && row.state === 'active' && row.candidateVisible === false,
    ) ||
    settled.reflectionFallbackReadback?.readbackStatus !== 'complete' ||
    !settled.reflectionFallbacks.some(
      (row) =>
        row.source === 'probe' &&
        row.state === 'active' &&
        row.candidateVisible === false &&
        row.frameId === settled.reflectionFallbackReadback?.frameId &&
        row.deviceGeneration === settled.reflectionFallbackReadback?.deviceGeneration,
    ) ||
    !settled.reflectionFallbackReadback.linearHdr.slice(0, 3).some(
      (value) => Number.isFinite(value) && value !== 0,
    )
  ) {
    throw new Error(`reflection probe baseline did not settle: ${JSON.stringify(settled)}`);
  }
}
const inspectionBeforeNeutral = REFLECTION_EVIDENCE
  ? structuredClone(renderer.inspect())
  : renderer.inspect();
let neutralInspection;
let submitFailure;
let deviceRecovery;
if (REFLECTION_EVIDENCE) {
  const stopped = app.stop();
  if (!stopped.ok) {
    console.error(`[smoke] FAIL - evidence app stop failed: ${stopped.error.code}`);
    process.exit(1);
  }
  const fallbackRow = (owner, source) => owner?.reflectionFallbacks?.find((row) => row.source === source);

  const beforeFailure = inspectionBeforeNeutral.reflectionProbes;
  const beforeRow = fallbackRow(beforeFailure, 'probe');
  submitFailureArmed = true;
  const failedUpdate = world.update(1 / 60);
  if (!failedUpdate.ok) throw failedUpdate.error;
  const failedDraw = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (failedDraw.ok) throw new Error('reflection fallback submit fault was not injected');
  const afterFailure = renderer.inspect().reflectionProbes;
  const afterRow = fallbackRow(afterFailure, 'probe');
  const failureInspection = afterFailure.reflectionFallbackInspection;
  const preservedLkg =
    beforeRow !== undefined &&
    afterRow !== undefined &&
    afterRow.state === 'lkg' &&
    afterRow.sourceGeneration === beforeRow.sourceGeneration &&
    afterRow.projectionGeneration === beforeRow.projectionGeneration;
  const candidateInvisible = (afterFailure.reflectionFallbacks ?? []).every(
    (row) => row.candidateVisible === false,
  );
  submitFailure = {
    drawError: failedDraw.error.code,
    before: beforeRow,
    after: afterRow,
    failureStage: failureInspection.failureStage,
    failureCode: failureInspection.failureCode,
    preservedLkg,
    generationStable: preservedLkg,
    candidateInvisible,
  };
  await drawEvidenceFrame();

  const beforeLoss = renderer.inspect();
  const beforeDeviceGeneration = beforeLoss.frame.deviceGeneration;
  if (resolveInjectedDeviceLoss === undefined) {
    throw new Error('reflection fallback device-loss fault resolver was not installed');
  }
  expectError('device-lost');
  resolveInjectedDeviceLoss({
    reason: 'unknown',
    message: 'fixture-injected reflection fallback device replacement',
  });
  for (let attempt = 0; attempt < 10 && renderer.state() !== 'device-lost'; attempt += 1) {
    await delay(0);
  }
  const lostState = renderer.state();
  if (lostState !== 'device-lost') throw new Error(`device-loss fault did not reach renderer: ${lostState}`);
  const recovered = await renderer.recover();
  const recoverCode = recovered.ok ? 'recovered' : recovered.error.code;
  if (!recovered.ok) throw recovered.error;
  let recoveryReceipt;
  for (let frame = 0; frame < 40; frame += 1) {
    recoveryReceipt = await drawEvidenceFrame();
  }
  const afterRecovery = renderer.inspect();
  const replacementOwner = afterRecovery.reflectionProbes;
  const replacementRow = fallbackRow(replacementOwner, 'probe');
  const replacementReadback = replacementOwner.reflectionFallbackReadback;
  const generationChanged = afterRecovery.frame.deviceGeneration > beforeDeviceGeneration;
  const matchingReplacement =
    generationChanged &&
    replacementRow?.state === 'active' &&
    replacementRow.candidateVisible === false &&
    replacementRow.deviceGeneration === afterRecovery.frame.deviceGeneration &&
    replacementReadback?.readbackStatus === 'complete' &&
    replacementReadback.deviceGeneration === replacementRow.deviceGeneration &&
    replacementReadback.frameId === replacementRow.frameId;
  deviceRecovery = {
    triggered: true,
    lostState,
    recoverCode,
    beforeDeviceGeneration,
    afterDeviceGeneration: afterRecovery.frame.deviceGeneration,
    generationChanged,
    replacementRow,
    readback: replacementReadback,
    matchingReplacement,
  };
  if (!matchingReplacement || recoveryReceipt === undefined) {
    throw new Error(`device replacement receipt mismatch: ${JSON.stringify(deviceRecovery)}`);
  }
}
if (REFLECTION_EVIDENCE && skylightEntity !== undefined) {
  if (reflectionProbeEntity !== undefined) {
    world.despawn(reflectionProbeEntity).unwrap();
  }
  const removed = world.despawn(skylightEntity);
  if (!removed.ok) {
    console.error(`[smoke] FAIL - neutral transition despawn failed: ${removed.error.code}`);
    process.exit(1);
  }
  const updated = world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - neutral transition update failed: ${updated.error.code}`);
    process.exit(1);
  }
  const next = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (!next.ok) {
    console.error(`[smoke] FAIL - neutral transition draw failed: ${next.error.code}`);
    process.exit(1);
  }
  const completed = await next.value.completed;
  if (!completed.ok) {
    console.error(`[smoke] FAIL - neutral transition completion failed: ${completed.error.code}`);
    process.exit(1);
  }
  // The first frame publishes the generation change and resets temporal history;
  // a second successful frame is required before the neutral owner can commit
  // its detached fallback receipt and the dependent temporal receipt.
  const settled = world.update(1 / 60);
  if (!settled.ok) {
    console.error(`[smoke] FAIL - neutral transition settle update failed: ${settled.error.code}`);
    process.exit(1);
  }
  const settledDraw = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (!settledDraw.ok) {
    console.error(`[smoke] FAIL - neutral transition settle draw failed: ${settledDraw.error.code}`);
    process.exit(1);
  }
  const settledCompleted = await settledDraw.value.completed;
  if (!settledCompleted.ok) {
    console.error(`[smoke] FAIL - neutral transition settle completion failed: ${settledCompleted.error.code}`);
    process.exit(1);
  }
  // Inspecting the committed source generation intentionally invalidates any
  // temporal history tied to the old projection. Submit one more frame after
  // that reset so the neutral receipt and its dependent temporal receipt are
  // both observable from the same live generation.
  void renderer.inspect().ssrDependencies;
  const recovered = world.update(1 / 60);
  if (!recovered.ok) {
    console.error(`[smoke] FAIL - neutral temporal reset update failed: ${recovered.error.code}`);
    process.exit(1);
  }
  const recoveredDraw = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (!recoveredDraw.ok) {
    console.error(`[smoke] FAIL - neutral temporal reset draw failed: ${recoveredDraw.error.code}`);
    process.exit(1);
  }
  const recoveredCompleted = await recoveredDraw.value.completed;
  if (!recoveredCompleted.ok) {
    console.error(`[smoke] FAIL - neutral temporal reset completion failed: ${recoveredCompleted.error.code}`);
    process.exit(1);
  }
  neutralInspection = renderer.inspect();
}
// Capture the evidence frame while the renderer and canvas context are still
// live. Renderer.dispose() intentionally unconfigures the surface and releases
// device-bound state; attempting a Dawn mapAsync against the old swap-chain
// texture after that teardown can leave the native async runner open forever.
// The manifest only needs the last live frame, so retain this synchronous
// readback before the healthy-recover guard and final disposal.
const evidenceCanvasPixels = REFLECTION_EVIDENCE ? await readCanvasPixels() : undefined;
const inspectionBeforeRecovery = renderer.inspect();
const recovery = await renderer.recover();
const recoveryState = renderer.inspect().state;
const destroyed = renderer.destroyRenderTarget(targetResult.value);
const inspection = inspectionBeforeRecovery;
await app.dispose();

const expectedColors = FACE_COLORS;
const faces = observedFaces.map((entry, face) => {
  const expected = expectedColors[face];
  const centerOffset = Math.floor(64 / 2) * entry.bytesPerRow + Math.floor(64 / 2) * 4;
  const pixel = [
    entry.bytes[centerOffset] / 255,
    entry.bytes[centerOffset + 1] / 255,
    entry.bytes[centerOffset + 2] / 255,
    entry.bytes[centerOffset + 3] / 255,
  ];
  const epsilon = Math.max(...expected.map((value, channel) => Math.abs(value - pixel[channel])));
  return {
    face: CUBE_CAMERA_FACE_ORDER[face],
    faceIndex: face,
    mipLevel: entry.mipLevel,
    expected,
    observed: pixel,
    epsilon,
    nearestColorIndex: FACE_COLORS.reduce(
      (best, expected, index) => {
        const distance = Math.max(...expected.map((value, channel) => Math.abs(value - pixel[channel])));
        return distance < best.distance ? { distance, index } : best;
      },
      { distance: Infinity, index: -1 },
    ).index,
    generation: entry.deviceGeneration,
    resolveIdentity: 'msaa-resolve',
  };
});
const epsilon = faces.length === 0 ? 1 : Math.max(...faces.map((face) => face.epsilon));
const distinctObservedFaces = new Set(
  faces.map((face) => face.observed.map((value) => value.toFixed(4)).join(',')),
).size;
const rejectsUniformClear = distinctObservedFaces > 1;
const swappedEpsilon = faces.length === 6
  ? Math.max(...faces.map((face, index) => Math.max(...face.expected.map((value, channel) => Math.abs(value - faces[5 - index].observed[channel])))))
  : 0;

const report = {
  stableTargetIds: [TARGET_ID],
  launchUrl: 'dawn://learn-render/6.pbr/4.render-target-reflection',
  frames,
  cubeFaceSubmissions,
  backend: inspection.capabilities.backendKind,
  device: `rhi-device:${inspection.frame.deviceGeneration}`,
  sourceSha: SOURCE_SHA,
  targetShape: 'cube',
  faceOrder: CUBE_CAMERA_FACE_ORDER,
  faceBudget: 6,
  faces,
  epsilon,
  faceContentFalsifier: { distinctObservedFaces, rejectsUniformClear },
  resolveIdentity: 'msaa-resolve',
  uncapturedGpuErrors: events,
  receiptObservation: observed.ok,
  readbackBytes: observedFaces.reduce((total, entry) => total + entry.byteLength, 0),
  ...(lowerYellowProbe === undefined ? {} : { lowerYellowProbe }),
  yellowFaceRegions,
  ...(plusZMarkerOracle === undefined ? {} : { plusZMarkerOracle }),
  ...(REFLECTION_EVIDENCE
    ? {}
    : {
        materialSampling: {
          shaderId: CUBE_REFLECTION_SHADER_ID,
          sourceShape: 'cube',
          sourceTargetId: TARGET_ID,
          sampled: materialFaceMatchEpsilon <= 0.2,
          canvasPixel: materialPixel,
          canvasFaceMatchEpsilon: materialFaceMatchEpsilon,
        },
      }),
  finalReceipt: {
    frameId: finalReceipt.frameId,
    deviceGeneration: finalReceipt.deviceGeneration,
  },
  resizeOk: resized.ok,
  recoverCode: recovery.ok ? 'recovered' : recovery.error.code,
  recoveryGuard: {
    state: recoveryState,
    code: 'renderer-state-invalid',
    reason: 'healthy-recover-guard',
  },
  destroyOk: destroyed.ok,
  errorCodes: events,
  ...(REFLECTION_EVIDENCE
    ? {
        reflectionProbe: {
          frames,
          rawFaces: new Set(
            [...reflectionPassNames]
              .map((name) => name.match(/^reflection-probe\.\d+\.capture\.(\d+)$/)?.[1])
              .filter((face) => face !== undefined),
          ).size,
          filteredSteps: [...reflectionPassNames].filter((name) =>
            /^reflection-probe\.\d+\.pmrem\.\d+\.\d+$/.test(name),
          ).length,
          mipLevels: [...reflectionPassNames]
            .map((name) => name.match(/^reflection-probe\.\d+\.pmrem\.(\d+)\.\d+$/)?.[1])
            .filter((mip) => mip !== undefined)
            .map(Number),
          insideSelection: 'probe',
          outsideSelection: 'skylight',
          owner: inspection.reflectionProbes,
          reflectionFallback: inspection.reflectionProbes.reflectionFallback,
          ssrDependencies: inspection.ssrDependencies,
          ssr: inspection.ssr,
          initialOwner: inspectionBeforeNeutral.reflectionProbes,
          initialSsrDependencies: inspectionBeforeNeutral.ssrDependencies,
          ...(neutralInspection === undefined
            ? {}
            : { neutralOwner: neutralInspection.reflectionProbes, neutralSsrDependencies: neutralInspection.ssrDependencies }),
          ...(submitFailure === undefined ? {} : { submitFailure }),
          ...(deviceRecovery === undefined ? {} : { deviceRecovery }),
        },
      }
    : {}),
};
console.log(`[render-target-reflection] report=${JSON.stringify(report)}`);
const failures = [];
if (frames < MIN_FRAMES) failures.push(`frames=${frames} < ${MIN_FRAMES}`);
if (report.backend !== 'webgpu') failures.push(`backend=${report.backend}`);
if (!report.receiptObservation) failures.push('receipt-bound observe failed');
if (report.faces.length !== 6) failures.push(`face count=${report.faces.length} != 6`);
if (!REFLECTION_EVIDENCE && report.epsilon > 0.05) failures.push(`epsilon=${report.epsilon} > 0.05`);
if (!REFLECTION_EVIDENCE && report.faces.some((face) => face.nearestColorIndex !== face.faceIndex)) {
  failures.push('face center nearest semantic color index mismatch');
}
if (!REFLECTION_EVIDENCE && !report.plusZMarkerOracle?.detected) failures.push('plus-Z L marker did not land in upper-left quadrant');
if (
  !REFLECTION_EVIDENCE &&
  !report.faceContentFalsifier.rejectsUniformClear
) {
  failures.push('cube face-content falsifier rejected uniform clear output');
}
if (!REFLECTION_EVIDENCE && swappedEpsilon <= 0.05) failures.push('swapped-face falsifier unexpectedly passed');
if (report.resolveIdentity !== 'msaa-resolve') failures.push('MSAA resolve identity missing');
if (report.sourceSha.length !== 40) failures.push('source SHA missing');
if (report.readbackBytes < 6) failures.push('readback returned no bytes');
if (!REFLECTION_EVIDENCE && !report.materialSampling.sampled) {
  failures.push(`cube material sampling epsilon=${report.materialSampling.canvasFaceMatchEpsilon} > 0.2`);
}
if (!REFLECTION_EVIDENCE && report.lowerYellowProbe?.candidates[0]?.yellowLike) {
  failures.push('lower display reflection still maps to yellow +Z edge content');
}
if (!report.resizeOk) failures.push('resize failed');
if (!report.destroyOk) failures.push('destroy failed');
if (report.recoveryGuard.state !== 'alive' || report.recoverCode !== report.recoveryGuard.code) {
  failures.push(`healthy-recover guard mismatch state=${report.recoveryGuard.state} code=${report.recoverCode}`);
}
if (events.length > 0) failures.push(`renderer errors=${JSON.stringify(events)}`);
if (REFLECTION_EVIDENCE) {
  if (report.reflectionProbe.rawFaces !== 6) {
    failures.push(`probe raw face count=${report.reflectionProbe.rawFaces} != 6`);
  }
  if (report.reflectionProbe.filteredSteps !== 27) {
    failures.push(`probe PMREM steps=${report.reflectionProbe.filteredSteps} != 27`);
  }
  if (Math.min(...report.reflectionProbe.mipLevels) !== 0 || Math.max(...report.reflectionProbe.mipLevels) !== 8) {
    failures.push(`probe PMREM mip range=${JSON.stringify(report.reflectionProbe.mipLevels)}`);
  }
  const fallbackReadback =
    report.reflectionProbe.initialOwner?.reflectionFallbackReadback ??
    report.reflectionProbe.owner.reflectionFallbackReadback;
  if (fallbackReadback?.readbackStatus !== 'complete') {
    failures.push('fallback MRT readback did not complete');
  } else if (!fallbackReadback.linearHdr.slice(0, 3).some((value) => Number.isFinite(value) && value !== 0)) {
    failures.push(`fallback MRT RGB sample is neutral=${JSON.stringify(fallbackReadback.linearHdr)}`);
  }
}
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - targetId=${TARGET_ID}, frames=${frames}, readbackBytes=${report.readbackBytes}`);
if (REFLECTION_EVIDENCE) {
  const evidence = deriveReflectionFallbackEvidence(report);
  if (evidence.status !== 'pass') {
    console.error(`[smoke] FAIL - SSR fallback evidence is blocked: ${JSON.stringify(evidence.failures)}`);
    process.exitCode = 1;
  }
  const completedFrames = report.reflectionProbe?.frames ?? frames;
  if (completedFrames < MIN_FRAMES) {
    throw new Error(`ReflectionProbe Dawn report completed ${completedFrames} frames; expected at least ${MIN_FRAMES}`);
  }
  const manifestDir = resolve(rootDir, 'artifacts/ssr-fallback/dawn');
  mkdirSync(manifestDir, { recursive: true });
  const manifestIdentity = {
    sourceHead: SOURCE_SHA,
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
    lockSha256: hashFile(resolve(rootDir, 'pnpm-lock.yaml')),
    buildSha256: hashFile(resolve(rootDir, 'packages/render/dist/index.mjs')),
  };
  writeFileSync(
    resolve(manifestDir, 'ssr-dependencies-input.json'),
    `${JSON.stringify({ identity: manifestIdentity, ssrDependencies: report.reflectionProbe.ssrDependencies }, null, 2)}\n`,
  );
  const manifestPixels = evidenceCanvasPixels;
  if (manifestPixels === undefined) {
    throw new Error('SSR fallback evidence frame was not captured before renderer disposal');
  }
  writeFileSync(
    resolve(manifestDir, 'validation.log'),
    reflectionFallbackValidationLog('dawn', report, evidence),
  );
  writeFileSync(resolve(manifestDir, 'frame.png'), encodePng(WIDTH, HEIGHT, manifestPixels.bytes));
  writeFileSync(
    resolve(manifestDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 'ssr-fallback-evidence/1',
      featureId: 'feat-ssr-reflection-probe-environment-fallback-owner-fo',
      lane: 'dawn',
      status: evidence.status,
      identity: manifestIdentity,
      fixture: { revision: 'learn-render-6.4-reflection-fallback-v1', frames: completedFrames },
      execution: {
        locator: 'artifacts/ssr-fallback/dawn/manifest.json',
        backend: 'dawn',
        frames: completedFrames,
      },
      readback: {
        locator: 'artifacts/ssr-fallback/dawn/frame.png',
        byteLength: manifestPixels.bytes.byteLength,
        validationLog: 'artifacts/ssr-fallback/dawn/validation.log',
      },
      png: { locator: 'artifacts/ssr-fallback/dawn/frame.png', width: WIDTH, height: HEIGHT },
      thresholds: { linearHdrAbsErrorMax: 0.05, hdrLumaRelativeErrorMax: 0.02 },
      expectations: evidence.expectations,
      ...(evidence.failures.length === 0 ? {} : { failures: evidence.failures }),
    }, null, 2)}\n`,
  );
}
if (!process.exitCode) emitSmokeReceipt('app-learn-render-6-pbr-4-render-target-reflection/smoke', frames);
if (device !== undefined) device.destroy?.();
// The native Dawn binding keeps its async event runner referenced after the
// final device is destroyed. This is a fixture-process boundary, not an
// engine lifecycle path: all engine resources and the device have already
// been released above, so terminate with the recorded verdict instead of
// letting the binding hold CI open indefinitely.
process.exit(process.exitCode ?? 0);
