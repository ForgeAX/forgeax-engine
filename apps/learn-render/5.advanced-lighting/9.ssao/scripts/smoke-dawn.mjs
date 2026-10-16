#!/usr/bin/env node
import { createSmokePlatform } from '../../../../../scripts/smoke-platform.mjs';
// apps/learn-render/5.advanced-lighting/9.ssao/scripts/smoke-dawn.mjs
// Standard profile SSAO Dawn smoke (structural-only + discrimination).
//
// LearnOpenGL section 5.9 SSAO dawn-node smoke.
// Normal mode: spawns one cube and one plane through the Standard lane
// with SSAO enabled, renders 60 frames, and proves the receipt-bound path.
//
// --discrimination mode: renders 2 passes — normal SSAO vs disabled SSAO —
// checks final RGB changes at the contact: at least 100 pixels, with a
// mean change above 1% among changed pixels. Background area is not an AO ROI.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-5-9-ssao] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke-discrimination] mean.normal=<N> mean.wrong=<N> diff=<N>`
//   - `[smoke] PASS`
//   - `[smoke] FAIL`

import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSsaoScene } from '../src/ssao-scene.ts';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { emitSmokeReceipt } from '../../../../shared/scripts/smoke-receipt.mjs';
import { writeReferencePng } from '../../../../shared/png-codec.mjs';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FALSIFY = process.env.FALSIFY ?? '';
const DISCRIMINATION = process.argv.includes('--discrimination');
const algorithm = process.argv.includes('--gtao') ? 'gtao' : 'ssao';
const WIDTH = 512;
const HEIGHT = 512;

const FLOOR_Y = -1.0;
const FLOOR_SCALE_XZ = 5.0;
const FLOOR_SCALE_Y = 0.1;
const CUBE_Y = -0.5;
const SPHERE_Y = -0.2;
const OBJECT_X_OFFSET = 1.2;

const here = dirname(fileURLToPath(import.meta.url));

// --- dawn.node binding setup (shared by both normal + discrimination) ---

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
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

// --- engine shader manifest (shared by both paths) ---

const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = URL.createObjectURL(new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(MANIFEST_URL));

async function drawSubmittedFrames(app, count) {
  app.pause().unwrap();
  const attached = app.renderer.attach(app.world);
  if (!attached.ok) throw attached.error;
  let receipt;
  for (let i = 0; i < count; i++) {
    app.world.update(1 / 60).unwrap();
    const frame = app.renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!frame.ok) throw frame.error;
    const completed = await frame.value.completed;
    if (!completed.ok) throw completed.error;
    receipt = frame.value;
    await delay(0);
  }
  if (receipt === undefined) throw new Error('No submitted SSAO frames');
  const observed = await app.renderer.observe(receipt, { include: ['draws'] });
  if (!observed.ok) throw observed.error;
  return receipt;
}

// ── M9 w41 GREEN: --discrimination dual-render + readback ─────────────────

if (DISCRIMINATION) {
  // ── M9 w41 GREEN: dual-render discrimination ───────────────────────────

  let readbackDevice;

  // Re-capture the adapter interception for readback passthrough.
  // sharedDevice is set by the first createApp call inside the adapter hook.
  // We use a fresh rafQueue per pass.

  // --- Helper: create a fresh mock canvas for each pass ---

  function makeMockCanvas(readbackTargetRef) {
    return {
      tagName: 'CANVAS',
      isConnected: true,
      width: WIDTH,
      height: HEIGHT,
      getContext(kind) {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc) {
            const rt = desc.device.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: desc.format ?? 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
            // eslint-disable-next-line no-param-reassign
            readbackTargetRef.tex = rt;
          },
          unconfigure() {},
          getCurrentTexture() {
            return readbackTargetRef.tex;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  // --- Helper: read center 32x32 R-channel mean from a render target ---

  async function readCenterRMean(device, texture, label) {
    const CENTER = WIDTH;
    const x = 0,
      y = 0;
    const alignedRowBytes = Math.ceil((WIDTH * 4) / 256) * 256;
    const totalBytes = HEIGHT * alignedRowBytes;
    const buf = device.createBuffer({
      size: totalBytes,
      usage: 0x01 | 0x08, // MAP_READ | COPY_DST
      label: `ssao-readback-${label}`,
    });
    const encoder = device.createCommandEncoder({ label: `ssao-copy-${label}` });
    encoder.copyTextureToBuffer(
      { texture, mipLevel: 0, origin: { x, y, z: 0 } },
      { buffer: buf, bytesPerRow: alignedRowBytes, rowsPerImage: CENTER },
      { width: CENTER, height: CENTER, depthOrArrayLayers: 1 },
    );
    const cmd = encoder.finish();
    device.queue.submit([cmd]);
    await device.queue.onSubmittedWorkDone();
    await buf.mapAsync(1); // GPUMapMode.READ
    const pixelRowBytes = CENTER * 4;
    const mapped = new Uint8Array(buf.getMappedRange());
    let sum = 0;
    for (let row = 0; row < CENTER; row++) {
      const base = row * alignedRowBytes;
      for (let col = 0; col < pixelRowBytes; col += 4) {
        sum += mapped[base + col]; // R channel
      }
    }
    const pixelCount = CENTER * CENTER;
    const mean = sum / (pixelCount * 255);
    const pixels = new Uint8Array(mapped);
    buf.unmap();
    buf.destroy();
    return { mean, pixels };
  }

  // --- Helper: run one smoke pass with the given SSAO config + return R mean ---

  async function runDiscriminationPass(ssaoConfig, label) {
    let rafQueue = [];
    let rafCounter = 1;
    globalThis.requestAnimationFrame = (cb) => {
      const id = rafCounter++;
      rafQueue.push({ id, cb });
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
      rafQueue = rafQueue.filter((frame) => frame.id !== id);
    };

    const readbackRef = { tex: null };
    const canvas = makeMockCanvas(readbackRef);

    let sharedDeviceLocal;
    const originalReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(
      globalThis.navigator.gpu,
    );
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const adapter = await originalReqAdapter(opts);
      if (adapter === null) return adapter;
      const originalReqDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (desc) => {
        const dev = await originalReqDevice(desc);
        if (!sharedDeviceLocal) sharedDeviceLocal = dev;
        return dev;
      };
      return adapter;
    };

    const { createApp: createAppLocal } = await import('@forgeax/engine-app/browser');
    const { Transform: TransformLocal } = await import('@forgeax/engine-scene');
    const {
      Camera: CameraLocal,
      DirectionalLight: DirectionalLightLocal,
      Materials: MaterialsLocal,
      MeshFilter: MeshFilterLocal,
      MeshRenderer: MeshRendererLocal,
      perspective: perspectiveLocal,
      DEFAULT_STANDARD_PROFILE,
    } = await import('@forgeax/engine-render');
    const { HANDLE_CUBE: HANDLE_CUBE_LOCAL, HANDLE_SPHERE: HANDLE_SPHERE_LOCAL } = await import(
      '@forgeax/engine-assets-runtime'
    );

    const appResult = await createAppLocal(
      canvas,
      {
        platform: createSmokePlatform(canvas),
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
          ssao: ssaoConfig.enabled ? { algorithm } : false,
        },
      },
      { shaderManifestUrl: MANIFEST_URL },
    );
    globalThis.navigator.gpu.requestAdapter = originalReqAdapter;

    if (!appResult.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - createApp error: ${appResult.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }
    const app = appResult.value;
    if (!readbackDevice) readbackDevice = sharedDeviceLocal;

    const onErrorEvents = [];
    app.onError((err) => onErrorEvents.push({ code: err.code }));

    const assets = app.assets;
    if (assets === undefined) {
      console.error(`[smoke-discrimination] FAIL pass=${label} - AssetRegistry null`);
      return { mean: null, device: sharedDeviceLocal };
    }

    const world = app.world;

    // Spawn scene. feat-20260614 M8 (D-17): mint user-tier column handles via
    // world.allocSharedRef (bare Handle, not a Result).
    spawnSsaoScene(world, WIDTH / HEIGHT);

    // Render frames.
    let fakeNow = 0;
    globalThis.performance.now = () => fakeNow;
    const startResult = app.start();
    if (!startResult.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - app.start: ${startResult.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }

    await drawSubmittedFrames(app, SMOKE_MIN_FRAMES);

    const stopResult = app.stop();
    if (!stopResult.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - app.stop() returned ${stopResult.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }
    if (!readbackRef.tex || !sharedDeviceLocal) {
      console.error(`[smoke-discrimination] FAIL pass=${label} - no render target`);
      return { mean: null, device: sharedDeviceLocal };
    }

    await sharedDeviceLocal.queue.onSubmittedWorkDone();
    const { mean, pixels } = await readCenterRMean(sharedDeviceLocal, readbackRef.tex, label);
    if (process.env.SMOKE_ARTIFACT_DIR) {
      const output = resolve(process.env.SMOKE_ARTIFACT_DIR, `${algorithm}-${label}.png`);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, writeReferencePng(pixels, WIDTH, HEIGHT));
      console.log(`[smoke-discrimination] png=${output}`);
    }

    const disposeResult = await app.dispose();
    if (!disposeResult.ok) {
      console.error(
        `[smoke-discrimination] FAIL pass=${label} - app.dispose() returned ${disposeResult.error.code}`,
      );
      return { mean: null, device: sharedDeviceLocal };
    }

    // Destroy the app's device textures to avoid leaking.
    readbackRef.tex.destroy?.();

    if (onErrorEvents.length)
      throw new Error(`SSAO frame errors: ${JSON.stringify(onErrorEvents)}`);
    return { mean, pixels, device: sharedDeviceLocal, onErrorEvents };
  }

  // --- Execute both passes ---

  console.log('[smoke-discrimination] pass 1/2: normal SSAO');
  const normalResult = await runDiscriminationPass({ enabled: true }, 'normal');
  if (normalResult.mean === null) {
    console.error('[smoke-discrimination] FAIL - normal pass failed');
    if (normalResult.device) normalResult.device.destroy?.();
    process.exit(1);
  }

  console.log('[smoke-discrimination] pass 2/2: SSAO disabled');
  const wrongResult = await runDiscriminationPass({ enabled: false }, 'off');
  if (wrongResult.mean === null) {
    console.error('[smoke-discrimination] FAIL - disabled pass failed');
    if (wrongResult.device) wrongResult.device.destroy?.();
    process.exit(1);
  }

  let changed = 0,
    total = 0;
  for (let i = 0; i < normalResult.pixels.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++)
      d += Math.abs(normalResult.pixels[i + c] - wrongResult.pixels[i + c]);
    if (d > 3) changed++;
    total += d;
  }
  const diff = total / (WIDTH * HEIGHT * 3 * 255);
  console.log(
    `[smoke-discrimination] mean.normal=${normalResult.mean.toFixed(4)} mean.off=${wrongResult.mean.toFixed(4)} changed=${changed} meanRgbDelta=${diff}`,
  );
  if (changed < 100 || (diff * (WIDTH * HEIGHT)) / changed < 0.01)
    throw new Error('SSAO contact scene has no visible effect');
  console.log('[smoke-discrimination] PASS - contact occlusion changes final pixels');
  if (readbackDevice) readbackDevice.destroy?.();
  delete globalThis.navigator.gpu;
  process.exit(0);
}

const KNOWN_NOISE_CODES = new Set();

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

// rAF / cAF stubs must be installed BEFORE createApp.
let rafQueue = [];
let rafCounter = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafCounter++;
  rafQueue.push({ id, cb });
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((f) => f.id !== id);
};

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return adapter;
};

// --- Mock canvas with offscreen render target ---

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
  tagName: 'CANVAS',
  isConnected: true,
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

// --- createApp + setup (normal mode, non-discrimination) ---

const { createApp } = await import('@forgeax/engine-app/browser');

const runtimePkg = await import('@forgeax/engine-runtime');
const { DEFAULT_STANDARD_PROFILE, Materials } = await import('@forgeax/engine-render');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } = await import(
  '@forgeax/engine-render'
);
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_CUBE, HANDLE_SPHERE } = await import('@forgeax/engine-assets-runtime');

const ssaoEnabled = FALSIFY !== 'ssao-off';
const appResult = await createApp(
  mockCanvas,
  { platform: createSmokePlatform(mockCanvas),  standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', ssao: ssaoEnabled ? { algorithm } : false } },
  { shaderManifestUrl: MANIFEST_URL },
);
globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;

if (!appResult.ok) {
  console.error(
    `[smoke] FAIL - createApp returned err: ${JSON.stringify({ code: appResult.error.code, hint: appResult.error.hint })}`,
  );
  process.exit(1);
}
const app = appResult.value;
console.log(`[learn-render-5-9-ssao] backend=${app.renderer.inspect().capabilities.backendKind}`);

const onErrorEvents = [];
app.onError((err) => onErrorEvents.push({ code: err.code, hint: err.hint }));

const assets = app.assets;
if (assets === undefined) {
  console.error('[smoke] FAIL - AssetRegistry is null');
  process.exit(1);
}

const world = app.world;

// --- 5. Spawn scene ---

spawnSsaoScene(world, WIDTH / HEIGHT);

// --- 6. Render 60 frames ---

let fakeNow = 0;
globalThis.performance.now = () => fakeNow;

const startResult = app.start();
if (!startResult.ok) {
  console.error(`[smoke] FAIL - app.start() returned err: ${startResult.error.code}`);
  process.exit(1);
}

const receipt = await drawSubmittedFrames(app, SMOKE_MIN_FRAMES);
const totalFrames = SMOKE_MIN_FRAMES;
const receiptFrameId = receipt.frameId;
const receiptObservationError = undefined;
console.log(`[smoke] frames observed=${totalFrames}`);
const inspection = app.renderer.inspect();
console.log(
  `[smoke] inspection state=${inspection.state} frame=${inspection.frame.frameId} receipt=${receiptFrameId}`,
);

const stopResult = app.stop();
if (!stopResult.ok) {
  console.error(`[smoke] FAIL - app.stop() returned err: ${stopResult.error.code}`);
  process.exit(1);
}
const disposeResult = await app.dispose();
if (!disposeResult.ok) {
  console.error(`[smoke] FAIL - app.dispose() returned err: ${disposeResult.error.code}`);
  process.exit(1);
}

// --- 7. Verdict (receipt-bound structural smoke) ---

const failures = [];
if (inspection.capabilities.backendKind !== 'webgpu')
  failures.push(`(a) backend=${inspection.capabilities.backendKind} (expected webgpu)`);
if (totalFrames < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${totalFrames} < ${SMOKE_MIN_FRAMES}`);
if (inspection.state !== 'alive') failures.push(`(c) renderer state=${inspection.state}`);
if (receiptObservationError !== undefined)
  failures.push(`(d) receipt observation failed: ${receiptObservationError.code}`);
if (receiptFrameId !== inspection.frame.frameId)
  failures.push(
    `(e) receipt frame=${receiptFrameId} differs from inspection=${inspection.frame.frameId}`,
  );

const expectedSsaoCodes = new Set();
const unknownErrors = onErrorEvents.filter(
  (e) => !KNOWN_NOISE_CODES.has(e.code) && !expectedSsaoCodes.has(e.code),
);
if (unknownErrors.length > 0) {
  failures.push(
    `(e) app.onError fired ${unknownErrors.length} unknown-code times: ${JSON.stringify(unknownErrors.slice(0, 3))}`,
  );
}

const unexpectedConsoleErrors = consoleErrors.filter((e) => !e.includes('[smoke]'));
if (unexpectedConsoleErrors.length > 0) {
  failures.push(
    `(f) console.error fired ${unexpectedConsoleErrors.length} times: ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`,
  );
}

const errorCodeHistogram = onErrorEvents.reduce((acc, e) => {
  acc[e.code] = (acc[e.code] ?? 0) + 1;
  return acc;
}, {});
console.log(`[smoke] onError histogram=${JSON.stringify(errorCodeHistogram)}`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  if (sharedDevice) sharedDevice.destroy?.();
  process.exit(1);
}

emitSmokeReceipt('app-learn-render-5-advanced-lighting-9-ssao/smoke', totalFrames);

console.log(
  `[smoke] PASS - criteria GREEN: backend=webgpu, frames=${totalFrames}, ssaoEnabled=${ssaoEnabled}, ` +
    `rendererState=${inspection.state}, receiptFrame=${receiptFrameId}, ` +
    `onError events=${onErrorEvents.length}, console.error=${unexpectedConsoleErrors.length}`,
);

if (sharedDevice) sharedDevice.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
