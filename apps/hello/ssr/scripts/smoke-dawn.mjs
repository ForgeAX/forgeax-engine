#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { spawnReflectionScene, resolveSsrFixture, SSR_FIXTURE_REVISION, SSR_ANTIALIAS_MODES } from '../src/reflection-scene.mjs';
import { dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  deriveReflectionFallbackEvidence,
  deriveReflectionProbeRecoveryEvidence,
  REFLECTION_PROBE_SETTLE_FRAMES,
  reflectionFallbackValidationLog,
} from './ssr-fallback-evidence.mjs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
const BUILTIN_SPHERE = createPrimitiveMesh('sphere').unwrap();


const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const PERFORMANCE = process.env.SMOKE_PERF_TIMING === '1';
const WIDTH = Number.parseInt(process.env.SMOKE_WIDTH ?? '256', 10);
const HEIGHT = Number.parseInt(process.env.SMOKE_HEIGHT ?? '256', 10);
const ANTIALIAS = process.env.SSR_ANTIALIAS ?? 'none';
const ANIMATION_AMPLITUDE = Number(process.env.SMOKE_ANIMATION_AMPLITUDE ?? 0.4);
const ANIMATION_SPEED = Number(process.env.SMOKE_ANIMATION_SPEED ?? 0.04);
if (!Number.isFinite(ANIMATION_AMPLITUDE) || ANIMATION_AMPLITUDE < 0 || ANIMATION_AMPLITUDE > 3
  || !Number.isFinite(ANIMATION_SPEED) || ANIMATION_SPEED <= 0 || ANIMATION_SPEED > 1) {
  throw new Error('Receiver animation requires amplitude in [0, 3] and speed in (0, 1]');
}
if (!SSR_ANTIALIAS_MODES.includes(ANTIALIAS)) throw new Error(`Unknown SSR antialias: ${ANTIALIAS}`);
const CAPTURE_FRAMES = Number(process.env.SMOKE_CAPTURE_FRAMES ?? 1);
if (!Number.isInteger(CAPTURE_FRAMES) || CAPTURE_FRAMES < 1 || CAPTURE_FRAMES > 8) throw new Error('SMOKE_CAPTURE_FRAMES must be 1..8');
if (CAPTURE_FRAMES > 1 && (ANTIALIAS === 'none' || process.env.SMOKE_CAPTURE_FILE === undefined)) throw new Error('A temporal cycle requires TAA and SMOKE_CAPTURE_FILE');
const CAPTURE_OBJECT_MOTION = process.env.SMOKE_CAPTURE_OBJECT_MOTION === '1';
if (CAPTURE_OBJECT_MOTION && (process.env.SSR_FIXTURE !== 'objects' || CAPTURE_FRAMES !== 8)) throw new Error('Object motion capture requires objects and eight TAA frames');
const CAPTURE_RECOVERY = process.env.SMOKE_CAPTURE_RECOVERY === '1';
if (CAPTURE_RECOVERY && CAPTURE_FRAMES !== 8) throw new Error('Recovery capture requires eight TAA frames');
const OBJECT_OFFSET = Number(process.env.SMOKE_OBJECT_OFFSET ?? 0);
if (!Number.isFinite(OBJECT_OFFSET) || (OBJECT_OFFSET !== 0 && (process.env.SSR_FIXTURE !== 'objects' || CAPTURE_OBJECT_MOTION))) throw new Error('A finite held object offset requires the static objects fixture');
const CAMERA_STEP = Number(process.env.SMOKE_CAPTURE_CAMERA_STEP ?? 0);
const CAMERA_OFFSET = Number(process.env.SMOKE_CAMERA_OFFSET ?? 0);
const DISPLAY_CAMERA_STEP = Number(process.env.SMOKE_DISPLAY_CAMERA_STEP ?? 0);
const DISPLAY_FRAMES = Number(process.env.SMOKE_DISPLAY_FRAMES ?? 9);
const DISPLAY_HOLD_FRAMES = Number(process.env.SMOKE_DISPLAY_HOLD_FRAMES ?? 160);
if (!Number.isInteger(DISPLAY_HOLD_FRAMES) || DISPLAY_HOLD_FRAMES < 160 || DISPLAY_HOLD_FRAMES > 4096) {
  throw new Error('SMOKE_DISPLAY_HOLD_FRAMES must be an integer from 160 through 4096');
}
if (!Number.isInteger(DISPLAY_FRAMES) || DISPLAY_FRAMES < 9 || DISPLAY_FRAMES > 257
  || (DISPLAY_FRAMES - 1) % 8 !== 0) {
  throw new Error('SMOKE_DISPLAY_FRAMES must cover complete eight-phase cycles: 9, 17, ..., 257');
}
const DISPLAY_OBJECT_MOTION = process.env.SMOKE_DISPLAY_OBJECT_MOTION === '1';
if (DISPLAY_OBJECT_MOTION && (process.env.SSR_FIXTURE !== 'objects'
  || process.env.SMOKE_DISPLAY_DIR === undefined || DISPLAY_CAMERA_STEP !== 0
  || CAMERA_OFFSET !== 0 || CAMERA_STEP !== 0 || OBJECT_OFFSET !== 0 || CAPTURE_OBJECT_MOTION)) {
  throw new Error('Display object motion requires the objects fixture and an isolated display journey');
}
const DISPLAY_TAPE_RECOVERY = process.env.SMOKE_DISPLAY_TAPE_RECOVERY === '1';
if (DISPLAY_TAPE_RECOVERY && (!DISPLAY_OBJECT_MOTION || process.env.FORGEAX_ENGINE_RHI_DEBUG !== '1')) {
  throw new Error('Recovery tape requires object motion display capture and RHI debug');
}
const DISPLAY_TAPE_FRAME = process.env.SMOKE_DISPLAY_TAPE_FRAME === undefined
  ? undefined : Number(process.env.SMOKE_DISPLAY_TAPE_FRAME);
if (DISPLAY_TAPE_FRAME !== undefined && (!Number.isInteger(DISPLAY_TAPE_FRAME)
  || DISPLAY_TAPE_FRAME < 0 || DISPLAY_TAPE_FRAME >= DISPLAY_FRAMES
  || process.env.SMOKE_DISPLAY_DIR === undefined || process.env.FORGEAX_ENGINE_RHI_DEBUG !== '1')) {
  throw new Error('Display tape frame requires display capture, RHI debug, and an index within SMOKE_DISPLAY_FRAMES');
}
if (!Number.isFinite(DISPLAY_CAMERA_STEP) || Math.abs(DISPLAY_CAMERA_STEP) > 0.1
  || (DISPLAY_CAMERA_STEP !== 0 && (process.env.SMOKE_DISPLAY_DIR === undefined || CAMERA_OFFSET !== 0 || CAMERA_STEP !== 0))) {
  throw new Error('Display camera step requires display-only capture, step within [-0.1, 0.1], and no other camera offset');
}
if (!Number.isFinite(CAMERA_STEP) || Math.abs(CAMERA_STEP) > 0.1
  || (CAMERA_STEP !== 0 && (CAPTURE_FRAMES !== 8 || CAPTURE_OBJECT_MOTION))) throw new Error('Camera motion requires eight TAA frames, step within [-0.1, 0.1], and no object motion');
if (!Number.isFinite(CAMERA_OFFSET) || Math.abs(CAMERA_OFFSET) > 1
  || (CAMERA_OFFSET !== 0 && CAMERA_STEP !== 0)) throw new Error('Held camera offset must be within [-1, 1], without camera motion');
if (!Number.isInteger(WIDTH) || WIDTH <= 0 || !Number.isInteger(HEIGHT) || HEIGHT <= 0) {
  console.error(`[smoke] FAIL - invalid canvas dimensions ${WIDTH}x${HEIGHT}`);
  process.exit(1);
}
const TARGET_ID = 'target-hello-ssr';
const CUBE_REFLECTION_SHADER_ID = 'hello_ssr::reflection';
const REFLECTION_EVIDENCE = process.env.VITE_REFLECTION_PROBE_EVIDENCE === '1';
const SSR_EVIDENCE = REFLECTION_EVIDENCE || process.env.VITE_SSR_EVIDENCE === '1';
// Performance compares the same authored scene with and without the SSR
// component. Keep the evidence/report surface enabled for the baseline, but
// remove only the camera request before attach so Renderer follows its normal
// not-requested zero-work path.
const SSR_DISABLED = process.env.SMOKE_DISABLE_SSR === '1';
// The SSR-off control intentionally keeps the textured reflection scene so
// that its base render path is comparable with SSR-on. It must not, however,
// run the reflection fallback fault/PMREM evidence lane: that lane requires an
// admitted SSR request and would turn a valid not-requested control into a
// false failure. Keep the two concerns explicit instead of weakening the
// reflection assertions globally.
const SSR_REFLECTION_EVIDENCE = REFLECTION_EVIDENCE && !SSR_DISABLED;
const PERFORMANCE_ONLY = PERFORMANCE && !REFLECTION_EVIDENCE;
const GPU_PASS_TIMING_ENABLED = PERFORMANCE && process.env.SMOKE_GPU_PASS_TIMING !== '0';
const CPU_PHASE_PROFILE = process.env.SMOKE_CPU_PHASE_PROFILE === '1';
// A phase capture is keyed to successful draw count. The synthetic Dawn loop
// can otherwise advance several RAF callbacks while its two receipt credits
// are still in flight, so a short diagnostic run may never reach the warmup
// threshold even though the requested callback count was met. SSR acceptance
// likewise counts completed submissions, not callbacks that hit frame-credit
// backpressure. Keep all requested frames on the real renderer path.
const WAIT_DRAW_COMPLETION = true;
const CPU_PHASE_PROFILE_WARMUP_FRAMES = Number.parseInt(
  process.env.SMOKE_CPU_PHASE_PROFILE_WARMUP_FRAMES ?? '120',
  10,
);
const CPU_PHASE_PROFILE_FRAMES = Number.parseInt(
  process.env.SMOKE_CPU_PHASE_PROFILE_FRAMES ?? '32',
  10,
);
const CPU_PHASE_PROFILE_DETAIL = process.env.SMOKE_CPU_PHASE_PROFILE_DETAIL ?? 'passes';
const CPU_PHASE_PROFILE_FILE = process.env.SMOKE_CPU_PHASE_PROFILE_FILE;
if (CPU_PHASE_PROFILE && (!Number.isInteger(CPU_PHASE_PROFILE_WARMUP_FRAMES)
  || CPU_PHASE_PROFILE_WARMUP_FRAMES < 0
  || !Number.isInteger(CPU_PHASE_PROFILE_FRAMES)
  || CPU_PHASE_PROFILE_FRAMES < 1
  || !['owner', 'passes', 'nested'].includes(CPU_PHASE_PROFILE_DETAIL))) {
  throw new Error('CPU phase profile requires non-negative warmup, positive frame count, and owner/passes/nested detail');
}
if (CPU_PHASE_PROFILE && MIN_FRAMES < CPU_PHASE_PROFILE_WARMUP_FRAMES + CPU_PHASE_PROFILE_FRAMES) {
  throw new Error('SMOKE_MIN_FRAMES must cover the CPU phase profile warmup and capture windows');
}
const RUN_ID = process.env.SMOKE_RUN_ID ?? `hello-ssr-${process.pid}-${Date.now()}`;
const RUN_MODE = process.env.SMOKE_RUN_MODE ?? (SSR_DISABLED ? 'ssr-off' : 'ssr-on');
const RUN_ORDER_INDEX = process.env.SMOKE_RUN_ORDER_INDEX === undefined
  ? null : Number.parseInt(process.env.SMOKE_RUN_ORDER_INDEX, 10);
const RUN_STARTED_AT = new Date().toISOString();
const readRgba8Pixel = (bytes, bytesPerRow, x, y) => {
  const offset = y * bytesPerRow + x * 4;
  return [
    (bytes[offset] ?? 0) / 255,
    (bytes[offset + 1] ?? 0) / 255,
    (bytes[offset + 2] ?? 0) / 255,
    (bytes[offset + 3] ?? 0) / 255,
  ];
};
const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
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
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
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
const fallbackReadbackWork = { buffers: 0, bytes: 0, maps: 0, afterSubmittedFrames: [] };
let submittedDraws = 0;
let adapterIdentity;
const requestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options);
  if (adapter === null) return null;
  const info = adapter.info;
  adapterIdentity = info === undefined || info === null
    ? null
    : {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
        isFallbackAdapter: info.isFallbackAdapter ?? null,
      };
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const result = await requestDevice(descriptor);
    device = result;
    const createBuffer = result.createBuffer.bind(result);
    result.createBuffer = (descriptor) => {
      const buffer = createBuffer(descriptor);
      // Classify the actual full-image MAP_READ allocation, independently
      // of the renderer's debug label so renaming it cannot bypass the gate.
      if ((descriptor.usage & 0x0001) !== 0 && Number(descriptor.size) >= WIDTH * HEIGHT * 8) {
        fallbackReadbackWork.buffers += 1;
        fallbackReadbackWork.afterSubmittedFrames.push(submittedDraws);
        fallbackReadbackWork.bytes += Number(descriptor.size);
        const mapAsync = buffer.mapAsync.bind(buffer);
        buffer.mapAsync = (...args) => {
          fallbackReadbackWork.maps += 1;
          return mapAsync(...args);
        };
      }
      return buffer;
    };
    return result;
  };
  return adapter;
};

const readCanvasPixels = async () => {
  if (device === undefined || targetTexture === undefined) {
    throw new Error('canvas texture is unavailable for Dawn material readback');
  }
  const readWidth = targetTexture.width;
  const readHeight = targetTexture.height;
  const bytesPerRow = Math.ceil((readWidth * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * readHeight,
    usage: 0x0001 | 0x0008,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: targetTexture },
    { buffer, bytesPerRow },
    { width: readWidth, height: readHeight, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x0001);
  const bytes = new Uint8Array(buffer.getMappedRange()).slice();
  buffer.unmap();
  buffer.destroy();
  return { bytes, bytesPerRow, width: readWidth, height: readHeight };
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
  materialPackages: [resolve(demoDir, 'src/ssr-reflection.pack.json')],
});
const shaderManifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(shaderManifestUrl));
// A dirty source checkout can share HEAD and render dist while serving a
// different trace. Bind timing evidence to the actual compiled GPU input.
const traceShader = manifest.entries.find(entry => /fn ssr_trace\s*\(/.test(entry.wgsl));
if (traceShader === undefined) throw new Error('SSR trace is missing from the shader manifest');
const traceShaderSha256 = createHash('sha256').update(traceShader.wgsl).digest('hex');
const composeShader = manifest.entries.find(entry => /fn fs_ssr_compose\s*\(/.test(entry.wgsl));
if (composeShader === undefined) throw new Error('SSR compose is missing from the shader manifest');
const composeShaderSha256 = createHash('sha256').update(composeShader.wgsl).digest('hex');
const shaderManifestSha256 = createHash('sha256')
  .update(JSON.stringify(manifest))
  .digest('hex');
const { createApp } = await import('@forgeax/engine-app/browser');
const cpuProfiler = CPU_PHASE_PROFILE
  ? (await import('@forgeax/engine-profiler')).createProfiler({
      // The Dawn harness freezes performance.now() to the synthetic RAF
      // timestamp. Use the monotonic host clock for sub-frame phase bounds.
      clock: { nowMicros: () => Math.floor(hostNowMs() * 1_000) },
    })
  : undefined;

const { World } = await import('@forgeax/engine-ecs');
const {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
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
const faultInstrumentation = SSR_REFLECTION_EVIDENCE
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
    captureReflectionFallbackReadback: SSR_REFLECTION_EVIDENCE,
    ...(GPU_PASS_TIMING_ENABLED
      ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 } }
      : {}),
    ...(SSR_EVIDENCE
      ? { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' } }
      : {}),
    ...(cpuProfiler === undefined ? {} : { profiler: cpuProfiler }),
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
const assets = app.assets;
if (assets === undefined) throw new Error('SSR requires runtime assets');
const world = app.world;
const cubeHandle = assets.create(BUILTIN_CUBE).unwrap();
const sphereHandle = assets.create(BUILTIN_SPHERE).unwrap();
const timingReceipts = [];
const timingObservations = [];
const timingFrames = [];
const drawCpuByReceipt = new Map();
const drawCpuFrameMs = [];
const drawCpuAttemptMs = [];
let latestDrawReceipt;
let latestResourceSubmission;
{
  const draw = renderer.draw.bind(renderer);
  renderer.draw = (...args) => {
    const drawStart = hostNowMs();
    const result = draw(...args);
    const drawDurationMs = hostNowMs() - drawStart;
    drawCpuAttemptMs.push(drawDurationMs);
    if (result.ok && result.value !== undefined) {
      latestDrawReceipt = result.value;
      if (process.env.SMOKE_RESOURCE_LIFECYCLE === '1') {
        const inspection = renderer.inspect();
        latestResourceSubmission = {
          frame: inspection.frame, temporal: inspection.temporal, ssr: inspection.ssr,
          boundary: 'draw-return-before-completion-wait',
        };
      }
      submittedDraws += 1;
      drawCpuByReceipt.set(result.value, drawDurationMs);
      drawCpuFrameMs.push(drawDurationMs);
      if (PERFORMANCE) {
        timingReceipts.push(result.value);
      }
    }
    return result;
  };
}
let observedTimingReceiptCount = 0;
const recordTimingObservation = (timings, drawCpuMs) => {
  timingObservations.push(timings);
  if (timings.status !== 'complete' && timings.status !== 'partial') return;
  const frame = timings.frame;
  timingFrames.push({
    schemaVersion: frame.schemaVersion,
    frameId: frame.frameId,
    deviceGeneration: frame.deviceGeneration,
    graphGeneration: frame.graphGeneration,
    backendKind: frame.backendKind,
    timestampPeriodNanoseconds: frame.timestampPeriodNanoseconds,
    passCapacity: frame.passCapacity,
    executedPassCount: frame.executedPassCount,
    measuredPassCount: frame.measuredPassCount,
    droppedPassCount: frame.droppedPassCount,
    measuredPassNanoseconds: frame.measuredPassNanoseconds,
    ...(Number.isFinite(drawCpuMs) ? { drawCpuMs } : {}),
    passes: frame.passes.map((pass) => pass.status === 'measured'
      ? {
          passName: pass.passName,
          passKind: pass.passKind,
          executionIndex: pass.executionIndex,
          status: pass.status,
          measurementSource: pass.measurementSource,
          beginningTick: pass.beginningTick,
          endTick: pass.endTick,
          durationNanoseconds: pass.durationNanoseconds,
          ...(pass.timerResolution === undefined ? {} : { timerResolution: pass.timerResolution }),
        }
      : {
          passName: pass.passName,
          passKind: pass.passKind,
          executionIndex: pass.executionIndex,
          status: pass.status,
        }),
  });
};
const collectTimingObservations = async () => {
  if (!GPU_PASS_TIMING_ENABLED) return;
  while (observedTimingReceiptCount < timingReceipts.length) {
    const receipt = timingReceipts[observedTimingReceiptCount];
    observedTimingReceiptCount += 1;
    const result = await renderer.observe(receipt, { include: ['timings'] });
    if (result.ok && result.value.timings !== undefined) {
      recordTimingObservation(result.value.timings, drawCpuByReceipt.get(receipt));
    }
  }
};
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
let skylightEntity;
let reflectionProbeEntity;
let movingObjectEntity;
let cameraEntity;
if (SSR_EVIDENCE) {
  const scene = spawnReflectionScene(world, assets, WIDTH / HEIGHT, resolveSsrFixture(process.env.SSR_FIXTURE), ANTIALIAS);
  skylightEntity = scene.skylight;
  reflectionProbeEntity = scene.reflectionProbe;
  movingObjectEntity = scene.movingObject;
  if (OBJECT_OFFSET !== 0) {
    const origin = world.get(movingObjectEntity, Transform).unwrap().pos;
    world.set(movingObjectEntity, Transform, { pos: [origin[0] + OBJECT_OFFSET, origin[1], origin[2]] }).unwrap();
  }
  cameraEntity = scene.camera;
  if (SSR_DISABLED) world.removeComponent(cameraEntity, ScreenSpaceReflection).unwrap();
} else {
const materialPayload = SSR_EVIDENCE
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
const materialHandle = assets.create(materialPayload).unwrap();
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
  const panelMaterial = assets.create(SSR_EVIDENCE
      ? Materials.standard({ baseColor: FACE_COLORS[face], metallic: 0, roughness: 0.45 })
      : Materials.unlit(FACE_COLORS[face])).unwrap();
  const [pos, scale] = panelTransforms[face];
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: { materials: [panelMaterial] } },
  ).unwrap();
}
const neutralAccentMaterial = assets.create(SSR_EVIDENCE
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
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: { materials: [neutralAccentMaterial] } },
  ).unwrap();
}
const markerMaterial = assets.create(SSR_EVIDENCE
    ? Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 })
    : Materials.unlit([1, 1, 1, 1])).unwrap();
const plusZMarkerParts = [
  [[0.55, 0.78, 2.9], [0.85, 0.12, 0.05]],
  [[0.2, 0.45, 2.9], [0.12, 0.78, 0.05]],
];
for (const [pos, scale] of plusZMarkerParts) {
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: { materials: [markerMaterial] } },
  ).unwrap();
}
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.4, -1, -0.3], color: [1, 1, 1], intensity: 2, castShadow: false },
}).unwrap();
if (SSR_EVIDENCE) {
  skylightEntity = world.spawn({
    component: Skylight,
    data: { color: [0.55, 0.7, 1], intensity: 1 },
  }).unwrap();
}
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], scale: [1.7, 1.7, 1.7] } },
  { component: MeshFilter, data: { assetHandle: sphereHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
).unwrap();
if (REFLECTION_EVIDENCE) {
  world.spawn(
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
cameraEntity = world.spawn(
  { component: Transform, data: { pos: [6, 0, 6], quat: [0, 0.38268343, 0, 0.9238795] } },
  {
    component: Camera,
    data: { ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }) },
  },
).unwrap();
if (SSR_EVIDENCE) {
  world.addComponent(cameraEntity, {
    component: ScreenSpaceReflection,
    data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
  }).unwrap();
}
}
if (!PERFORMANCE_ONLY && !SSR_EVIDENCE) {
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
}

const cameraOrigin = Array.from(world.get(cameraEntity, Transform).unwrap().pos);
const setCameraOffset = (offset) => world.set(cameraEntity, Transform, {
  pos: [cameraOrigin[0] + offset, cameraOrigin[1], cameraOrigin[2] - offset],
}).unwrap();
if (CAMERA_OFFSET !== 0) setCameraOffset(CAMERA_OFFSET);
const attached = renderer.attach(world);
if (!attached.ok) {
  console.error(`[smoke] FAIL - attach failed: ${attached.error.code}`);
  process.exit(1);
}
const events = [];
const summarizeError = (value, depth = 0) => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 8) return '[truncated]';
  const summary = {};
  for (const key of ['code', 'expected', 'hint', 'message', 'name', 'operation', 'detail', 'cause', 'error']) {
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
const cpuFrameMs = [];
const completionWaitMs = [];
const endToEndMs = [];
const reflectionPassNames = new Set();
let cpuProfileSession;
let cpuProfileStarted = false;
let cpuProfileDrawStartCount;
let cpuProfileDrawFinishCount;
const maybeStartCpuPhaseProfile = () => {
  if (cpuProfiler === undefined || cpuProfileStarted || drawCpuFrameMs.length < CPU_PHASE_PROFILE_WARMUP_FRAMES) return;
  const result = cpuProfiler.startCapture({
    frameLimit: CPU_PHASE_PROFILE_FRAMES,
    eventLimit: Math.max(
      4096,
      CPU_PHASE_PROFILE_FRAMES * (CPU_PHASE_PROFILE_DETAIL === 'nested' ? 4096 : 256),
    ),
    detail: CPU_PHASE_PROFILE_DETAIL,
  });
  if (!result.ok) throw new Error(`CPU phase profile start failed: ${result.error.code}`);
  cpuProfileSession = result.value;
  cpuProfileStarted = true;
  cpuProfileDrawStartCount = drawCpuFrameMs.length;
};
const animatedReceiverOrigin = process.env.SMOKE_ANIMATE_RECEIVER === '1'
  ? Array.from(world.get(movingObjectEntity, Transform).unwrap().pos) : undefined;
for (let attempts = 0; frames < MIN_FRAMES && attempts < MIN_FRAMES + 1000; attempts += 1) {
  if (animatedReceiverOrigin !== undefined) world.set(movingObjectEntity, Transform, {
    pos: [animatedReceiverOrigin[0] + Math.sin(frames * ANIMATION_SPEED) * ANIMATION_AMPLITUDE, animatedReceiverOrigin[1], animatedReceiverOrigin[2]],
  }).unwrap();
  const item = rafQueue.shift();
  if (item === undefined) break;
  maybeStartCpuPhaseProfile();
  now += 16.67;
  const cpuStart = hostNowMs();
  const previousReceipt = latestDrawReceipt;
  item.callback(now);
  const submissionEnd = hostNowMs();
  await delay(0);
  if (latestDrawReceipt === undefined || latestDrawReceipt === previousReceipt) continue;
  if (WAIT_DRAW_COMPLETION && latestDrawReceipt !== undefined) {
    const completed = await latestDrawReceipt.completed;
    if (!completed.ok) {
      console.error(`[smoke] FAIL - waited draw completion failed: ${completed.error.code}`);
      process.exit(1);
    }
  }
  if (latestDrawReceipt.presentation !== 'ready') continue;
  frames += 1;
  cpuFrameMs.push(submissionEnd - cpuStart);
  completionWaitMs.push(WAIT_DRAW_COMPLETION ? hostNowMs() - submissionEnd : null);
  endToEndMs.push(WAIT_DRAW_COMPLETION ? hostNowMs() - cpuStart : null);
  if (SSR_EVIDENCE) {
    for (const passName of renderer.inspect().perFramePassNames) reflectionPassNames.add(passName);
  }
  await delay(0);
  await collectTimingObservations();
  if (cpuProfileStarted && cpuProfileDrawFinishCount === undefined && cpuProfiler?.activeSession() === undefined) {
    cpuProfileDrawFinishCount = drawCpuFrameMs.length;
  }
}
// Count real full-frame MAP_READ work before optional diagnostic journeys.
const fallbackReadbackStability = {
  buffers: fallbackReadbackWork.buffers,
  maps: fallbackReadbackWork.maps,
  bytes: fallbackReadbackWork.bytes,
  submittedFrames: submittedDraws,
  captureEnabled: SSR_REFLECTION_EVIDENCE,
  receiverMovedFrames: animatedReceiverOrigin === undefined ? 0 : frames,
  receiverMotion: animatedReceiverOrigin === undefined ? undefined
    : { amplitude: ANIMATION_AMPLITUDE, speedRadiansPerFrame: ANIMATION_SPEED },
};
if (animatedReceiverOrigin !== undefined) world.set(movingObjectEntity, Transform, { pos: animatedReceiverOrigin }).unwrap();
if (cpuProfileSession !== undefined && cpuProfiler?.activeSession() !== undefined) {
  const finished = cpuProfileSession.finish();
  if (!finished.ok) throw new Error(`CPU phase profile finish failed: ${finished.error.code}`);
  cpuProfileDrawFinishCount = drawCpuFrameMs.length;
}
const cpuProfileCapture = cpuProfiler?.latestCapture();
const captureFile = process.env.SMOKE_CAPTURE_FILE;
// A display-only cycle keeps long-running visual comparisons bounded on disk.
// It is not a replacement for a canonical RHI tape or per-work inspection.
const displayDir = process.env.SMOKE_DISPLAY_DIR;
if (displayDir !== undefined) {
  if (ANTIALIAS === 'none' || captureFile !== undefined) throw new Error('Display cycle requires TAA and no simultaneous tape capture');
  app.pause().unwrap();
  mkdirSync(displayDir, { recursive: true });
  // Host callback throughput varies with compilation and GPU scheduling.
  // Match the submitted temporal age and Halton phase for paired runs.
  if (renderer.inspect().temporal.frameIndex > 1024) throw new Error('Display cycle warmup exceeded its fixed frame 1024 anchor');
  while (renderer.inspect().temporal.frameIndex < 1024) {
    if (latestDrawReceipt === undefined) throw new Error('Display warmup has no submitted receipt');
    (await latestDrawReceipt.completed).unwrap();
    const before = renderer.inspect().temporal.frameIndex;
    app.stepFrame(0).unwrap();
    (await latestDrawReceipt.completed).unwrap();
    if (renderer.inspect().temporal.frameIndex !== before + 1) throw new Error('Display warmup failed to advance one temporal frame');
  }
  const advanceDisplayFrame = async (name) => {
    if (latestDrawReceipt === undefined) throw new Error('Display cycle has no submitted receipt');
    (await latestDrawReceipt.completed).unwrap();
    const before = renderer.inspect().temporal;
    if (!before.historyValid || before.frameIndex < 128) throw new Error('Display cycle requires settled TAA');
    const executionBefore = app.execution.report().frame;
    let tape;
    if ((DISPLAY_TAPE_FRAME !== undefined && name === `frame-${DISPLAY_TAPE_FRAME}`)
      || (DISPLAY_TAPE_RECOVERY && name === 'recovery-8')) {
      if (app.rhiCapture === undefined) throw new Error('Display tape requires the RHI capture owner');
      const captured = (await app.rhiCapture.captureFrame()).unwrap();
      const path = resolve(displayDir, `${name}.rhitape`);
      writeFileSync(path, captured.bytes);
      tape = { path, digest: captured.digest, byteLength: captured.bytes.byteLength };
    } else {
      app.stepFrame(0).unwrap();
    }
    (await latestDrawReceipt.completed).unwrap();
    const after = renderer.inspect().temporal;
    const executionAfter = app.execution.report().frame;
    if (!after.historyValid || after.frameIndex !== before.frameIndex + 1
      || after.epoch !== before.epoch + 1 || after.resetReason !== undefined
      || after.viewIdentity !== before.viewIdentity || after.deviceGeneration !== before.deviceGeneration
      || executionBefore.inFlight !== 0 || executionAfter.inFlight !== 0
      || executionAfter.submitted !== executionBefore.submitted + 1
      || executionAfter.completed !== executionBefore.completed + 1) {
      throw new Error(`Display cycle lost receipt continuity: ${JSON.stringify({ before, after, executionBefore, executionAfter })}`);
    }
    let path;
    if (name !== undefined) {
      const pixels = await readCanvasPixels();
      path = resolve(displayDir, `${name}.png`);
      writeFileSync(path, encodePng(WIDTH, HEIGHT, pixels.bytes));
    }
    return { path, before, after, execution: { before: executionBefore, after: executionAfter },
      ...(tape === undefined ? {} : { tape }) };
  };
  const journey = [];
  if (DISPLAY_CAMERA_STEP !== 0 || DISPLAY_OBJECT_MOTION) {
    (await latestDrawReceipt.completed).unwrap();
    const pixels = await readCanvasPixels();
    const path = resolve(displayDir, 'baseline.png');
    writeFileSync(path, encodePng(WIDTH, HEIGHT, pixels.bytes));
    journey.push({ stage: 'baseline', path, after: renderer.inspect().temporal });
    const objectOrigin = DISPLAY_OBJECT_MOTION
      ? Array.from(world.get(movingObjectEntity, Transform).unwrap().pos) : undefined;
    for (let index = 1; index <= 7; index++) {
      const cameraOffset = index * DISPLAY_CAMERA_STEP;
      const objectOffset = objectOrigin === undefined ? undefined : Math.min(index, 5) * 0.1;
      if (objectOrigin === undefined) setCameraOffset(cameraOffset);
      else world.set(movingObjectEntity, Transform, {
        pos: [objectOrigin[0] + objectOffset, objectOrigin[1], objectOrigin[2]],
      }).unwrap();
      journey.push({ stage: 'motion', cameraOffset, objectOffset,
        ...await advanceDisplayFrame(index === 7 ? 'motion-end' : undefined) });
    }
    for (let heldFrames = 1; heldFrames <= DISPLAY_HOLD_FRAMES; heldFrames++) {
      journey.push({ stage: 'recovery', heldFrames,
        ...await advanceDisplayFrame([8, 32, 64, 128].includes(heldFrames) ? `recovery-${heldFrames}` : undefined) });
    }
  }
  const displayFrames = [];
  // Include the closing image of each complete jitter cycle.
  for (let index = 0; index < DISPLAY_FRAMES; index++) {
    displayFrames.push(await advanceDisplayFrame(`frame-${index}`));
  }
  writeFileSync(resolve(displayDir, 'frames.json'), JSON.stringify({
    mode: 'display-only-actual-rendered-frames', fixture: SSR_FIXTURE_REVISION,
    shaderManifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    cameraStep: DISPLAY_CAMERA_STEP, objectMotion: DISPLAY_OBJECT_MOTION, holdFrames: DISPLAY_HOLD_FRAMES, journey, frames: displayFrames,
  }, null, 2));
}
const capturedFrames = [];
if (captureFile !== undefined) {
  if (app.rhiCapture === undefined) throw new Error('SMOKE_CAPTURE_FILE requires FORGEAX_ENGINE_RHI_DEBUG=1');
  // The synthetic rAF queue stops after the measured frames. Use App's paused
  // capture transaction so it owns the final frame instead of awaiting a
  // running-host rAF that this deterministic driver no longer pumps.
  app.pause().unwrap();
  const objectOrigin = CAPTURE_OBJECT_MOTION ? Array.from(world.get(movingObjectEntity, Transform).unwrap().pos) : undefined;
  for (let index = 0; index < CAPTURE_FRAMES; index++) {
    const before = renderer.inspect().temporal;
    if (CAPTURE_FRAMES > 1 && (!before.historyValid || before.frameIndex < 128)) throw new Error('Temporal cycle requires the complete 128-frame TAA settling interval');
    const objectOffset = objectOrigin === undefined ? undefined : Math.min(index, 5) * 0.1;
    if (objectOrigin !== undefined) world.set(movingObjectEntity, Transform, {
      pos: [objectOrigin[0] + objectOffset, objectOrigin[1], objectOrigin[2]],
    }).unwrap();
    const cameraOffset = CAMERA_STEP === 0 ? CAMERA_OFFSET : Math.min(index, 5) * CAMERA_STEP;
    if (CAMERA_STEP !== 0) setCameraOffset(cameraOffset);
    const captured = await app.rhiCapture.captureFrame({ signal: AbortSignal.timeout(60_000) });
    if (!captured.ok) throw captured.error;
    const after = renderer.inspect().temporal;
    // Inspection epoch is the render frame number, not a reset generation.
    const continuous = after.historyValid && after.epoch === before.epoch + 1
      && after.frameIndex === before.frameIndex + 1 && after.resetReason === undefined
      && after.viewIdentity === before.viewIdentity && after.deviceGeneration === before.deviceGeneration;
    const path = CAPTURE_FRAMES === 1 ? captureFile : resolve(`${dirname(captureFile)}-${index}`, 'frame.rhitape');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, captured.value.bytes);
    const pixels = await readCanvasPixels();
    writeFileSync(resolve(dirname(path), 'frame.png'), encodePng(WIDTH, HEIGHT, pixels.bytes));
    const frame = { path, digest: captured.value.digest, byteLength: captured.value.bytes.byteLength, before, after,
      cameraOffset, ...(objectOffset === undefined ? {} : { objectOffset }) };
    capturedFrames.push(frame);
    console.log(`[smoke] captured-frame=${JSON.stringify(frame)}`);
    if (CAPTURE_FRAMES > 1 && !continuous) throw new Error(`Temporal capture did not advance exactly one valid frame: ${JSON.stringify({ index, before, after })}`);
  }
  if (CAPTURE_RECOVERY) {
    // Continue the real App/SSR/TAA history after motion stops. A TAA-only
    // splice cannot prove that SSR source rejection or rough-mip history
    // recovers. Keep every display frame and bounded canonical tape anchors.
    app.pause().unwrap();
    const recoveryDir = resolve(`${dirname(captureFile)}-recovery`);
    mkdirSync(recoveryDir, { recursive: true });
    const recovery = [];
    for (let frame = 1; frame <= 144; frame++) {
      if (latestDrawReceipt === undefined) throw new Error('Recovery has no submitted receipt');
      (await latestDrawReceipt.completed).unwrap();
      const before = renderer.inspect().temporal;
      let tape;
      if ([8, 32, 64, 128].includes(frame) || frame > 136) {
        tape = (await app.rhiCapture.captureFrame()).unwrap();
        writeFileSync(resolve(recoveryDir, `frame-${frame}.rhitape`), tape.bytes);
      } else {
        app.stepFrame(0).unwrap();
      }
      (await latestDrawReceipt.completed).unwrap();
      const pixels = await readCanvasPixels();
      const after = renderer.inspect().temporal;
      if (!after.historyValid || after.frameIndex !== before.frameIndex + 1
        || after.epoch !== before.epoch + 1 || after.resetReason !== undefined
        || after.viewIdentity !== before.viewIdentity || after.deviceGeneration !== before.deviceGeneration) {
        throw new Error(`Recovery did not preserve submitted history: ${JSON.stringify({ frame, before, after })}`);
      }
      writeFileSync(resolve(recoveryDir, `frame-${frame}.png`), encodePng(WIDTH, HEIGHT, pixels.bytes));
      recovery.push({ frame, before, after, ...(tape === undefined ? {} : { digest: tape.digest }) });
    }
    writeFileSync(resolve(recoveryDir, 'frames.json'), JSON.stringify(recovery, null, 2));
    console.log(`[smoke] recovery-frames=${recovery.length} first=${recovery[0].after.frameIndex} last=${recovery.at(-1).after.frameIndex}`);
  }
}
// Resource evidence follows the recorder's existing closure/lifecycle owner.
// Keep these captures outside the measured CPU/GPU sampling windows.
if (process.env.SMOKE_RESOURCE_LIFECYCLE === '1') {
  if (captureFile === undefined || app.rhiCapture === undefined || !SSR_EVIDENCE || SSR_DISABLED) {
    throw new Error('Resource lifecycle requires an enabled SSR capture and RHI Debug');
  }
  const { buildFrameModel, decodeTape, summarizeFrame } = await import('@forgeax/engine-rhi-debug');
  const directory = resolve(dirname(captureFile), 'lifecycle');
  mkdirSync(directory, { recursive: true });
  const resourceFrames = [];
  const captureResourceState = async (stage) => {
    // The paused App capture owns Update and Render. A separate World update
    // here would consume the transition before the recorder is armed.
    const captured = (await app.rhiCapture.captureFrame({ signal: AbortSignal.timeout(120_000) })).unwrap();
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    writeFileSync(resolve(directory, `${stage}.rhitape`), captured.bytes);
    const pixels = await readCanvasPixels();
    const tightPixels = new Uint8Array(pixels.width * pixels.height * 4);
    for (let y = 0; y < pixels.height; y++) tightPixels.set(
      pixels.bytes.subarray(y * pixels.bytesPerRow, y * pixels.bytesPerRow + pixels.width * 4), y * pixels.width * 4);
    writeFileSync(resolve(directory, `${stage}.png`), encodePng(pixels.width, pixels.height, tightPixels));
    const row = {
      stage, extent: { width: pixels.width, height: pixels.height }, digest: captured.digest, byteLength: captured.bytes.byteLength,
      inspection: { frame: renderer.inspect().frame, ssr: renderer.inspect().ssr, temporal: renderer.inspect().temporal,
        dynamicResolution: renderer.inspect().dynamicResolution },
      submissionInspection: latestResourceSubmission,
      timings: GPU_PASS_TIMING_ENABLED
        ? (await renderer.observe(latestDrawReceipt, { include: ['timings'] })).unwrap().timings
        : { status: 'not-requested' },
      lifecycle: model.resourceLifecycle,
      resources: model.resources.filter((resource) => resource.kind === 'texture' || resource.kind === 'buffer'),
      works: summarizeFrame(model).works,
      unseededResources: model.unseededResources,
    };
    resourceFrames.push(row);
    writeFileSync(resolve(directory, 'resources.json'), JSON.stringify({
      resolution: { width: WIDTH, height: HEIGHT }, identity: ssrIdentity,
      scope: 'captured-tape-resource-closure', driverAllocation: 'unavailable',
      frames: resourceFrames,
    }, null, 2));
    console.log(`[smoke] resource-stage=${stage} live=${row.lifecycle.bytes.knownLive} peak=${row.lifecycle.bytes.knownPeak}`);
  };
  const ssrParameters = { ...world.get(cameraEntity, ScreenSpaceReflection).unwrap() };
  await captureResourceState('stable-on');
  const cameraVersion = world.get(cameraEntity, Camera).unwrap().historyVersion;
  const priorResetCount = renderer.inspect().ssr.history.resetCount;
  world.set(cameraEntity, Camera, { historyVersion: cameraVersion + 1 }).unwrap();
  await captureResourceState('camera-cut');
  if (renderer.inspect().ssr.history.resetCount <= priorResetCount) {
    throw new Error('Explicit camera cut must reset the SSR-owned history');
  }
  world.set(cameraEntity, Camera, { historyVersion: cameraVersion }).unwrap();
  await captureResourceState('camera-cut-restored');
  world.removeComponent(cameraEntity, ScreenSpaceReflection).unwrap();
  await captureResourceState('ssr-off');
  world.addComponent(cameraEntity, { component: ScreenSpaceReflection, data: ssrParameters }).unwrap();
  await captureResourceState('ssr-readmission');
  if (ANTIALIAS === 'taa') {
    world.set(cameraEntity, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    await captureResourceState('taa-off');
    world.set(cameraEntity, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    await captureResourceState('taa-readmission');
  }
  // Use the existing canvas-owned surface route, so graph/history replacement
  // and fence retirement are real Renderer work inside the captured frame.
  const originalSurface = targetTexture;
  const smallerWidth = Math.floor(WIDTH * 0.75);
  const smallerHeight = Math.floor(HEIGHT * 0.75);
  targetTexture = device.createTexture({
    size: { width: smallerWidth, height: smallerHeight, depthOrArrayLayers: 1 },
    format: originalSurface.format, usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'],
  });
  canvas.width = smallerWidth;
  canvas.height = smallerHeight;
  await captureResourceState('resize-smaller');
  const smallerSurface = targetTexture;
  targetTexture = originalSurface;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  await captureResourceState('resize-restored');
  (await latestDrawReceipt.completed).unwrap();
  smallerSurface.destroy();
}
const tickets = [];
let drawn = timingReceipts.at(-1);
let observed;
if (!PERFORMANCE_ONLY) {
  for (let face = 0; face < CUBE_CAMERA_FACE_ORDER.length; face += 1) {
    // SSR owns its display output; only the cube fixture has a cube target writer.
    if (!SSR_EVIDENCE && face === CUBE_CAMERA_FACE_ORDER.length - 1) {
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
    const cpuStart = hostNowMs();
    const next = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!next.ok) {
      console.error(`[smoke] FAIL - receipt draw failed: ${next.error.code}`);
      process.exit(1);
    }
    cpuFrameMs.push(hostNowMs() - cpuStart);
    drawn = next.value;
    const completed = await next.value.completed;
    if (!completed.ok) {
      console.error(`[smoke] FAIL - receipt completion failed: ${completed.error.code}`);
      process.exit(1);
    }
    await collectTimingObservations();
  }
  observed = await renderer.observe(drawn, {
    include: [SSR_EVIDENCE ? 'draws' : 'target-readbacks', ...(PERFORMANCE ? ['timings'] : [])],
    ...(SSR_EVIDENCE ? {} : { targetReadbacks: tickets }),
  });
  if (PERFORMANCE && observed.ok && observed.value.timings !== undefined) {
    recordTimingObservation(observed.value.timings, drawCpuByReceipt.get(drawn));
  }
} else {
  if (drawn === undefined) {
    console.error('[smoke] FAIL - performance lane did not produce a frame receipt');
    process.exit(1);
  }
  observed = { ok: true, value: { targetReadbacks: [] } };
}
let finalReceipt = drawn;
if (!SSR_EVIDENCE) {
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
const canvasPixels = SSR_EVIDENCE ? undefined : await readCanvasPixels();
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
if (SSR_REFLECTION_EVIDENCE) {
  for (let settle = 0; settle < REFLECTION_PROBE_SETTLE_FRAMES; settle += 1) {
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
    const updated = world.update(1 / 60);
    if (!updated.ok) throw updated.error;
    const next = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!next.ok) throw next.error;
    const completed = await next.value.completed;
    if (!completed.ok) throw completed.error;
    for (const passName of renderer.inspect().perFramePassNames) reflectionPassNames.add(passName);
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
const drawEvidenceFrame = async () => {
  world.update(1 / 60).unwrap();
  const next = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  }).unwrap();
  (await next.completed).unwrap();
  for (const passName of renderer.inspect().perFramePassNames) reflectionPassNames.add(passName);
  return next;
};
if (SSR_REFLECTION_EVIDENCE) {
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
  let afterRecovery = renderer.inspect();
  let replacement = deriveReflectionProbeRecoveryEvidence(afterRecovery, beforeDeviceGeneration);
  for (let frame = 0; frame < REFLECTION_PROBE_SETTLE_FRAMES; frame += 1) {
    recoveryReceipt = await drawEvidenceFrame();
    await delay(0);
    afterRecovery = renderer.inspect();
    replacement = deriveReflectionProbeRecoveryEvidence(afterRecovery, beforeDeviceGeneration);
    if (replacement.matchingReplacement && replacement.replacementSsrReady) break;
  }
  const replacementOwner = afterRecovery.reflectionProbes;
  deviceRecovery = {
    triggered: true,
    lostState,
    recoverCode,
    beforeDeviceGeneration,
    beforeSsr: beforeLoss.ssr,
    ...replacement,
  };
  if (!replacement.matchingReplacement || !replacement.replacementSsrReady || recoveryReceipt === undefined) {
    throw new Error(`device replacement receipt mismatch: ${JSON.stringify({ ...deviceRecovery, owner: replacementOwner })}`);
  }
}
if (SSR_REFLECTION_EVIDENCE && skylightEntity !== undefined) {
  // Neutral means no reflection source. A single floor receiver can remain
  // entirely probe-selected after removing Skylight, unlike the tiles case
  // whose outer pavers happened to exercise the unselected path.
  if (reflectionProbeEntity !== undefined) {
    world.despawn(reflectionProbeEntity).unwrap();
  }
  world.despawn(skylightEntity).unwrap();
  await drawEvidenceFrame();
  // The first frame publishes the generation change and resets temporal history;
  // a second successful frame is required before the neutral owner can commit
  // its detached fallback receipt and the dependent temporal receipt.
  await drawEvidenceFrame();
  // Inspecting the committed source generation intentionally invalidates any
  // temporal history tied to the old projection. Submit one more frame after
  // that reset so the neutral receipt and its dependent temporal receipt are
  // both observable from the same live generation.
  void renderer.inspect().ssrDependencies;
  await drawEvidenceFrame();
  // Removing both source owners can publish a neutral receipt after this
  // frame's admission was decided. Exercise the next submitted frame too.
  await drawEvidenceFrame();
  neutralInspection = renderer.inspect();
}
// Capture the evidence frame while the renderer and canvas context are still
// live. Renderer.dispose() intentionally unconfigures the surface and releases
// device-bound state; attempting a Dawn mapAsync against the old swap-chain
// texture after that teardown can leave the native async runner open forever.
// The manifest only needs the last live frame, so retain this synchronous
// readback before the healthy-recover guard and final disposal.
const evidenceCanvasPixels = SSR_REFLECTION_EVIDENCE ? await readCanvasPixels() : undefined;
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

const percentile = (values, fraction) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * (sorted.length - 1))));
  return sorted[index];
};
const timingObservedFrames = [];
const timingReasons = [];
for (const timing of timingObservations) {
  if (timing.status === 'complete' || timing.status === 'partial') {
    timingObservedFrames.push(timing.frame);
    if (timing.status === 'partial') timingReasons.push(timing.reason);
  } else if (timing.status === 'unavailable') {
    timingReasons.push(timing.reason);
  } else {
    timingReasons.push(timing.error);
  }
}
const passSamplesMs = new Map();
for (const frame of timingObservedFrames) {
  for (const pass of frame.passes) {
    if (pass.status !== 'measured') continue;
    const samples = passSamplesMs.get(pass.passName) ?? [];
    samples.push(pass.durationNanoseconds / 1_000_000);
    passSamplesMs.set(pass.passName, samples);
  }
}
const gpuPassStats = Object.fromEntries(
  [...passSamplesMs.entries()].map(([passName, samples]) => [passName, {
    samples: [...samples],
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  }]),
);
const cpuPhaseRecords = cpuProfileCapture?.records.filter(
  (record) => record.kind === 'phase',
) ?? [];
const cpuPhaseIdentity = (record) => ({
  source: record.source,
  phase: record.phase,
  ...(record.parentSource === undefined ? {} : { parentSource: record.parentSource }),
  ...(record.parentPhase === undefined ? {} : { parentPhase: record.parentPhase }),
});
const cpuPhaseSamples = new Map();
for (const record of cpuPhaseRecords) {
  const identity = cpuPhaseIdentity(record);
  const key = JSON.stringify(identity);
  const byFrame = cpuPhaseSamples.get(key) ?? {
    identity,
    frameDurations: new Map(),
    invocationCount: 0,
  };
  byFrame.invocationCount += 1;
  byFrame.frameDurations.set(
    record.frameId,
    (byFrame.frameDurations.get(record.frameId) ?? 0) + record.durationMicros / 1_000,
  );
  cpuPhaseSamples.set(key, byFrame);
}
const cpuPhaseStats = Object.fromEntries(
  [...cpuPhaseSamples.entries()].map(([key, value]) => {
    const samples = [...value.frameDurations.values()];
    return [key, {
      ...value.identity,
      samples,
      invocationCount: value.invocationCount,
      frameCount: samples.length,
      totalMs: samples.reduce((total, sample) => total + sample, 0),
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      maxMs: Math.max(...samples),
    }];
  }),
);
const cpuPhaseProfileSummary = cpuProfileCapture === undefined
  ? undefined
  : {
      detail: CPU_PHASE_PROFILE_DETAIL,
      warmupFrames: CPU_PHASE_PROFILE_WARMUP_FRAMES,
      captureFrames: CPU_PHASE_PROFILE_FRAMES,
      drawAttemptCount: drawCpuAttemptMs.length,
      drawSuccessfulCount: drawCpuFrameMs.length,
      captureDrawStartCount: cpuProfileDrawStartCount ?? null,
      captureDrawFinishCount: cpuProfileDrawFinishCount ?? drawCpuFrameMs.length,
      captureDrawCount:
        (cpuProfileDrawFinishCount ?? drawCpuFrameMs.length) - (cpuProfileDrawStartCount ?? 0),
      completeness: cpuProfileCapture.completeness,
      phaseStats: cpuPhaseStats,
    };
const timingStatus = timingObservedFrames.length === 0
  ? timingObservations.at(-1)?.status ?? 'unavailable'
    : timingReasons.length === 0
    ? 'complete'
    : 'partial';
const performanceTiming = PERFORMANCE
  ? {
      resolution: { width: WIDTH, height: HEIGHT },
      adapter: adapterIdentity,
      host: { platform: process.platform, arch: process.arch, node: process.version },
      timingFrames: timingFrames.map((frame) => ({ ...frame, passes: [...frame.passes] })),
      gpuPassTimingEnabled: GPU_PASS_TIMING_ENABLED,
      waitDrawCompletion: WAIT_DRAW_COMPLETION,
      traceShaderSha256,
      composeShaderSha256,
      shaderManifestSha256,
      cpu: {
        semantics: 'host callback submission CPU; excludes receipt completion wait',
        completionWaitSamples: [...completionWaitMs],
        endToEndSamples: [...endToEndMs],
        completionWaitP50Ms: percentile(completionWaitMs, 0.5),
        completionWaitP95Ms: percentile(completionWaitMs, 0.95),
        endToEndP50Ms: percentile(endToEndMs, 0.5),
        endToEndP95Ms: percentile(endToEndMs, 0.95),
        endToEndSemantics: 'callback start to receipt completion; excludes polling delay and timing readback',
        samples: [...cpuFrameMs],
        p50Ms: percentile(cpuFrameMs, 0.5),
        p95Ms: percentile(cpuFrameMs, 0.95),
        drawSamples: [...drawCpuFrameMs],
        drawP50Ms: percentile(drawCpuFrameMs, 0.5),
        drawP95Ms: percentile(drawCpuFrameMs, 0.95),
        drawAttemptSamples: [...drawCpuAttemptMs],
        drawAttemptP50Ms: percentile(drawCpuAttemptMs, 0.5),
        drawAttemptP95Ms: percentile(drawCpuAttemptMs, 0.95),
        drawAttemptCount: drawCpuAttemptMs.length,
        drawSuccessfulCount: drawCpuFrameMs.length,
      },
      gpu: {
        status: timingStatus,
        observedFrames: timingFrames.length,
        measuredPasses: Object.keys(gpuPassStats).length,
        passStats: gpuPassStats,
        reasons: timingReasons,
      },
    }
  : undefined;

const report = {
  run: {
    id: RUN_ID,
    mode: RUN_MODE,
    orderIndex: RUN_ORDER_INDEX,
    pid: process.pid,
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    totalFrames: MIN_FRAMES,
    requestedFrames: MIN_FRAMES,
    warmupFrames: 0,
    measurementFrames: MIN_FRAMES,
  },
  stableTargetIds: [TARGET_ID],
  launchUrl: 'dawn://hello/ssr?forgeax-evidence=ssr',
  frames,
  backend: inspection.capabilities.backendKind,
  device: `rhi-device:${inspection.frame.deviceGeneration}`,
  sourceSha: SOURCE_SHA,
  adapter: adapterIdentity,
  host: { platform: process.platform, arch: process.arch, node: process.version },
  shaderIdentity: {
    traceShaderSha256,
    composeShaderSha256,
    shaderManifestSha256,
  },
  antialias: ANTIALIAS,
  ...(SSR_EVIDENCE ? { sceneFixture: { revision: SSR_FIXTURE_REVISION, name: resolveSsrFixture(process.env.SSR_FIXTURE), width: WIDTH, height: HEIGHT } } : {}),
  ...(capturedFrames.length === 0 ? {} : { capturedFrames }),
  targetShape: 'cube',
  faceOrder: CUBE_CAMERA_FACE_ORDER,
  faceBudget: 6,
  faces,
  epsilon,
  faceContentFalsifier: { distinctObservedFaces, rejectsUniformClear },
  resolveIdentity: 'msaa-resolve',
  uncapturedGpuErrors: events,
  receiptObservation: observed.ok,
  fallbackReadbackWork,
  fallbackReadbackStability,
  readbackBytes: observedFaces.reduce((total, entry) => total + entry.byteLength, 0),
  ...(lowerYellowProbe === undefined ? {} : { lowerYellowProbe }),
  yellowFaceRegions,
  ...(plusZMarkerOracle === undefined ? {} : { plusZMarkerOracle }),
  ...(SSR_EVIDENCE
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
  ...(performanceTiming === undefined ? {} : { performanceTiming }),
  ...(cpuPhaseProfileSummary === undefined ? {} : { cpuPhaseProfile: cpuPhaseProfileSummary }),
  ...(SSR_EVIDENCE
    ? { ssrDependencies: inspection.ssrDependencies, ssr: inspection.ssr }
    : {}),
  ...(SSR_REFLECTION_EVIDENCE
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
if (CPU_PHASE_PROFILE) {
  if (cpuProfileCapture === undefined) {
    console.error(
      `[smoke] CPU phase profile diagnostics: started=${cpuProfileStarted} ` +
        `warmup=${CPU_PHASE_PROFILE_WARMUP_FRAMES} draws=${drawCpuFrameMs.length} ` +
        `attempts=${drawCpuAttemptMs.length} frames=${frames} ` +
        `active=${cpuProfiler?.activeSession() !== undefined}`,
    );
    throw new Error('CPU phase profile did not produce a capture');
  }
  if (cpuProfileCapture.completeness.status !== 'complete') {
    throw new Error(`CPU phase profile is incomplete: ${cpuProfileCapture.completeness.status}`);
  }
  const captureDrawCount =
    (cpuProfileDrawFinishCount ?? drawCpuFrameMs.length) - (cpuProfileDrawStartCount ?? 0);
  if (captureDrawCount < CPU_PHASE_PROFILE_FRAMES) {
    throw new Error(`CPU phase profile covered ${captureDrawCount} successful draws; expected ${CPU_PHASE_PROFILE_FRAMES}`);
  }
  if (CPU_PHASE_PROFILE_FILE !== undefined) {
    const profileArtifact = {
      schemaVersion: 'ssr-cpu-phase-profile-v1',
      sourceHead: SOURCE_SHA,
      sourceTree: ssrIdentity.sourceTree,
      lockSha256: ssrIdentity.lockSha256,
      buildSha256: ssrIdentity.buildSha256,
      run: report.run,
      sceneFixture: report.sceneFixture,
      ssrEnabled: !SSR_DISABLED,
      resolution: { width: WIDTH, height: HEIGHT },
      antialias: ANTIALIAS,
      detail: CPU_PHASE_PROFILE_DETAIL,
      warmupFrames: CPU_PHASE_PROFILE_WARMUP_FRAMES,
      captureFrames: CPU_PHASE_PROFILE_FRAMES,
      drawAttemptCount: drawCpuAttemptMs.length,
      drawSuccessfulCount: drawCpuFrameMs.length,
      captureDrawStartCount: cpuProfileDrawStartCount ?? null,
      captureDrawFinishCount: cpuProfileDrawFinishCount ?? drawCpuFrameMs.length,
      captureDrawCount,
      phaseStats: cpuPhaseStats,
      capture: cpuProfileCapture,
    };
    mkdirSync(dirname(CPU_PHASE_PROFILE_FILE), { recursive: true });
    writeFileSync(CPU_PHASE_PROFILE_FILE, `${JSON.stringify(profileArtifact, null, 2)}\n`);
  }
}
const reportFile = process.env.SMOKE_REPORT_FILE;
if (reportFile !== undefined) {
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
if (process.env.SMOKE_QUIET === '1' && reportFile !== undefined) {
  console.log(`[hello-ssr] report-file=${reportFile}`);
} else {
  console.log(`[hello-ssr] report=${JSON.stringify(report)}`);
}
const failures = [];
if (frames < MIN_FRAMES) failures.push(`frames=${frames} < ${MIN_FRAMES}`);
if (report.backend !== 'webgpu') failures.push(`backend=${report.backend}`);
if (!report.receiptObservation) failures.push('receipt-bound observe failed');
if (!PERFORMANCE_ONLY && !SSR_EVIDENCE && report.faces.length !== 6) failures.push(`face count=${report.faces.length} != 6`);
if (!SSR_EVIDENCE && report.epsilon > 0.05) failures.push(`epsilon=${report.epsilon} > 0.05`);
if (!SSR_EVIDENCE && report.faces.some((face) => face.nearestColorIndex !== face.faceIndex)) {
  failures.push('face center nearest semantic color index mismatch');
}
if (!SSR_EVIDENCE && !report.plusZMarkerOracle?.detected) failures.push('plus-Z L marker did not land in upper-left quadrant');
if (
  !SSR_EVIDENCE &&
  !report.faceContentFalsifier.rejectsUniformClear
) {
  failures.push('cube face-content falsifier rejected uniform clear output');
}
if (!SSR_EVIDENCE && swappedEpsilon <= 0.05) failures.push('swapped-face falsifier unexpectedly passed');
if (report.resolveIdentity !== 'msaa-resolve') failures.push('MSAA resolve identity missing');
if (report.sourceSha.length !== 40) failures.push('source SHA missing');
if (!PERFORMANCE_ONLY && !SSR_EVIDENCE && report.readbackBytes < 6) failures.push('readback returned no bytes');
// Both the regular CI smoke and the performance carrier keep all 60
// completed frames while checking zero normal-path full-frame readback work.
if (SSR_EVIDENCE) {
  if (fallbackReadbackStability.submittedFrames < MIN_FRAMES) {
    failures.push(`SSR smoke completed too few submitted frames: ${JSON.stringify(fallbackReadbackStability)}`);
  }
  if (!fallbackReadbackStability.captureEnabled &&
      (fallbackReadbackStability.buffers !== 0 || fallbackReadbackStability.maps !== 0)) {
    failures.push(`normal rendering performed full-frame reflection readback: ${JSON.stringify(fallbackReadbackStability)}`);
  }
}
if (!SSR_EVIDENCE && !report.materialSampling.sampled) {
  failures.push(`cube material sampling epsilon=${report.materialSampling.canvasFaceMatchEpsilon} > 0.2`);
}
if (!SSR_EVIDENCE && report.lowerYellowProbe?.candidates[0]?.yellowLike) {
  failures.push('lower display reflection still maps to yellow +Z edge content');
}
if (!report.resizeOk) failures.push('resize failed');
if (!report.destroyOk) failures.push('destroy failed');
if (report.recoveryGuard.state !== 'alive' || report.recoverCode !== report.recoveryGuard.code) {
  failures.push(`healthy-recover guard mismatch state=${report.recoveryGuard.state} code=${report.recoverCode}`);
}
if (events.length > 0) failures.push(`renderer errors=${JSON.stringify(events)}`);
if (SSR_EVIDENCE && !SSR_DISABLED && report.ssr?.status !== 'admitted') {
  failures.push(`SSR status=${report.ssr?.status ?? 'missing'}`);
}
if (SSR_EVIDENCE && SSR_DISABLED) {
  if (report.ssr?.status !== 'not-requested') {
    failures.push(`SSR-off status=${report.ssr?.status ?? 'missing'} != not-requested`);
  }
  if (report.ssrDependencies?.status !== 'fallback-only') {
    failures.push(`SSR-off dependency status=${report.ssrDependencies?.status ?? 'missing'} != fallback-only`);
  }
  if (report.ssrDependencies?.requested !== false) {
    failures.push(`SSR-off dependency requested=${String(report.ssrDependencies?.requested)} != false`);
  }
  if (!Array.isArray(report.ssr?.passRoster) || report.ssr.passRoster.length !== 0) {
    failures.push(`SSR-off pass roster is not empty=${JSON.stringify(report.ssr?.passRoster ?? null)}`);
  }
  for (const [owner, work] of [['ssr', report.ssr?.work], ['ssrDependencies', report.ssrDependencies?.work]]) {
    if (work === undefined) {
      failures.push(`SSR-off ${owner} work receipt missing`);
      continue;
    }
    for (const [field, value] of Object.entries(work)) {
      if (typeof value === 'number' && value !== 0) {
        failures.push(`SSR-off ${owner}.${field}=${value} != 0`);
      }
    }
  }
}
if (PERFORMANCE) {
  if (report.performanceTiming === undefined) failures.push('performance timing report missing');
  else {
    if (report.performanceTiming.resolution.width !== WIDTH || report.performanceTiming.resolution.height !== HEIGHT) {
      failures.push(`performance resolution mismatch=${JSON.stringify(report.performanceTiming.resolution)}`);
    }
    if (report.performanceTiming.cpu.samples.length < MIN_FRAMES) {
      failures.push(`CPU timing samples=${report.performanceTiming.cpu.samples.length} < ${MIN_FRAMES}`);
    }
    if (GPU_PASS_TIMING_ENABLED) {
      if (!['complete', 'partial'].includes(report.performanceTiming.gpu.status)) {
        failures.push(`GPU timing status=${report.performanceTiming.gpu.status}`);
      }
      if (report.performanceTiming.gpu.measuredPasses < 1) failures.push('GPU timing has no measured passes');
    }
  }
}
if (SSR_REFLECTION_EVIDENCE) {
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
if (SSR_REFLECTION_EVIDENCE) {
  const evidence = deriveReflectionFallbackEvidence(report);
  if (evidence.status !== 'pass') {
    console.error(`[smoke] FAIL - SSR fallback evidence is blocked: ${JSON.stringify(evidence.failures)}`);
    process.exitCode = 1;
  }
  const completedFrames = report.reflectionProbe?.frames ?? frames;
  if (completedFrames !== MIN_FRAMES || completedFrames < 60) {
    throw new Error(`ReflectionProbe Dawn report completed ${completedFrames} frames; expected requested ${MIN_FRAMES} and at least 60`);
  }
  const manifestDir = resolve(rootDir, process.env.SMOKE_EVIDENCE_DIR ?? 'artifacts/ssr-fallback/dawn');
  const manifestLocator = relative(rootDir, manifestDir).replaceAll('\\', '/');
  mkdirSync(manifestDir, { recursive: true });
  const manifestIdentity = {
    sourceHead: SOURCE_SHA,
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
    lockSha256: hashFile(resolve(rootDir, 'pnpm-lock.yaml')),
    buildSha256: hashFile(resolve(rootDir, 'packages/render/dist/index.mjs')),
  };
  writeFileSync(
    resolve(manifestDir, 'ssr-dependencies-input.json'),
    `${JSON.stringify({
      identity: manifestIdentity,
      ssrDependencies: report.reflectionProbe.ssrDependencies,
      ssr: report.reflectionProbe.ssr,
      passRoster: report.reflectionProbe.ssr?.passRoster ?? [],
      readbackHash: report.reflectionProbe.reflectionFallbackReadback?.readbackHash ?? null,
    }, null, 2)}\n`,
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
      featureId: 'feat-20260831-ssr-probe-environment-fallback',
      lane: 'dawn',
      status: evidence.status,
      identity: manifestIdentity,
      fixture: { revision: SSR_FIXTURE_REVISION, frames: completedFrames },
      execution: {
        locator: `${manifestLocator}/manifest.json`,
        backend: 'dawn',
        frames: completedFrames,
      },
      readback: {
        locator: `${manifestLocator}/frame.png`,
        byteLength: manifestPixels.bytes.byteLength,
        validationLog: `${manifestLocator}/validation.log`,
      },
      png: { locator: `${manifestLocator}/frame.png`, width: WIDTH, height: HEIGHT },
      thresholds: { linearHdrAbsErrorMax: 0.05, hdrLumaRelativeErrorMax: 0.02 },
      expectations: evidence.expectations,
      ...(evidence.failures.length === 0 ? {} : { failures: evidence.failures }),
    }, null, 2)}\n`,
  );
}
if (!process.exitCode) console.log(`[smoke] PASS - targetId=${TARGET_ID}, frames=${frames}, readbackBytes=${report.readbackBytes}`);
if (device !== undefined) device.destroy?.();
// The native Dawn binding keeps its async event runner referenced after the
// final device is destroyed. This is a fixture-process boundary, not an
// engine lifecycle path: all engine resources and the device have already
// been released above, so terminate with the recorded verdict instead of
// letting the binding hold CI open indefinitely.
process.exit(process.exitCode ?? 0);
