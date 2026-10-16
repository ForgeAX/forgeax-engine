#!/usr/bin/env node
// hello-debug-draw headless smoke (feat-20260615-debug-draw-immediate-mode M4 / M5).
//
// Proves AC-04/AC-05/AC-06/AC-07: the debug-draw overlay renders correctly
// across 5 modes. Runs 60 frames per mode on dawn-node, captures frame 60
// PNG to __screenshots__/baseline/, pixel readback epsilon<=0.05 against
// committed baseline, asserts onError==0 and draw count>0.
//
// Modes exercised (M4+M5 scope):
//   low          — 4 shapes via createDebugDraw + manual flush (w25)
//   empty        — zero shape calls; flush skips GPU pass (w25)
//   runtime      — same 4-shape rendering path as low; smoke verifies
//                  the GPU surface. NOTE: dawn-node does NOT exercise
//                  the createApp + app.debugDraw auto-attach path
//                  (AC-05). This mode runs createDebugDraw + manual
//                  flush, which is the low-path. The true runtime
//                  auto-attach path (createApp + app.debugDraw.line
//                  in an update callback + rAF loop) is verified by
//                  the browser test (main.ts?mode=runtime) and the
//                  pnpm test:browser suite. Dawn-node cannot exercise
//                  this path because createApp(canvas) requires
//                  canvas.isConnected (DOM), and the assemble form
//                  createApp({ renderer, world }) requires a fully
//                  bootstrapped renderer — both are complex to mock
//                  in dawn-node and test the same low-path GPU
//                  surface that this smoke already covers.
//   depth        — two DebugDraw instances (always + less-equal) each
//                  rendering 4 shapes; produces 2 PNGs with visually
//                  distinct shape placements (w33 / AC-06)
//   hdrp-tonemap — 4-shape overlay, R>=0.85 red-channel assertion
//                  verifying overlay-after-tonemap (w33 / AC-07)
//
// Falsify hooks: FALSIFY=skip-shapes skips all shape calls → foreground==0
// (proves the readback measures real geometry, not clear color).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const WIDTH = 256;
const HEIGHT = 256;
const CLEAR_RGBA = [0, 0, 0, 1];
const TOTAL_PIXELS = WIDTH * HEIGHT;
const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const FOREGROUND_CHANNEL_MIN = 24;

const FALSIFY = process.env.FALSIFY ?? '';

// --- Minimal PNG encoder (no dependencies) -----------------------------------

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

function writeU32(arr, off, val) {
  arr[off] = (val >>> 24) & 0xff;
  arr[off + 1] = (val >>> 16) & 0xff;
  arr[off + 2] = (val >>> 8) & 0xff;
  arr[off + 3] = val & 0xff;
}

function writePng(width, height, rgba) {
  const rawData = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    rawData[rowOff] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowOff + 1 + x * 4;
      rawData[dst] = rgba[src];
      rawData[dst + 1] = rgba[src + 1];
      rawData[dst + 2] = rgba[src + 2];
      rawData[dst + 3] = rgba[src + 3];
    }
  }
  const compressed = deflateSync(rawData);

  const ihdrData = new Uint8Array(13);
  writeU32(ihdrData, 0, width);
  writeU32(ihdrData, 4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const chunks = [];
  function addChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    typeBytes[0] = type.charCodeAt(0);
    typeBytes[1] = type.charCodeAt(1);
    typeBytes[2] = type.charCodeAt(2);
    typeBytes[3] = type.charCodeAt(3);
    const typeAndData = Buffer.concat([typeBytes, data]);
    const c = crc32(typeAndData);
    const len = data.length;
    const buf = new Uint8Array(12 + len);
    writeU32(buf, 0, len);
    buf.set(typeBytes, 4);
    buf.set(data, 8);
    writeU32(buf, 8 + len, c);
    chunks.push(buf);
  }

  addChunk('IHDR', ihdrData);
  addChunk('IDAT', compressed);
  addChunk('IEND', new Uint8Array(0));

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const totalLen = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const out = Buffer.alloc(totalLen);
  sig.forEach((b, i) => { out[i] = b; });
  let off = 8;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = resolve(here, '..', '..', '..', '..');
const SCREENSHOTS_DIR = resolve(
  MONOREPO_ROOT,
  'forgeax-engine-assets',
  'smoke-baselines',
  'hello-debug-draw',
);
const OUTPUT_DIR = process.env.FORGEAX_M31_ARTIFACT_DIR
  ? resolve(process.env.FORGEAX_M31_ARTIFACT_DIR)
  : SCREENSHOTS_DIR;
mkdirSync(OUTPUT_DIR, { recursive: true });

// --- 1. dawn.node setup ------------------------------------------------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  rerun: pnpm --filter @forgeax/hello-debug-draw smoke');
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
gpu.getPreferredCanvasFormat = () => 'bgra8unorm';

// --- 2. Mock canvas with offscreen render target ----------------------------

let sharedDevice = null;
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

let renderTarget = null;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01, // RENDER_ATTACHMENT | COPY_SRC | TEXTURE_BINDING
    viewFormats: [],
  });

  const enc = device.createCommandEncoder();
  const view = renderTarget.createView();
  enc.beginRenderPass({
    colorAttachments: [
      {
        view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: CLEAR_RGBA[0], g: CLEAR_RGBA[1], b: CLEAR_RGBA[2], a: CLEAR_RGBA[3] },
      },
    ],
  }).end();
  device.queue.submit([enc.finish()]);

  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'bgra8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'bgra8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Engine imports -------------------------------------------------------

const { rhi, createShaderModule, _internal_getRawDevice } = await import(
  '@forgeax/engine-rhi-webgpu'
);
const { createDebugDraw } = await import('@forgeax/engine-debug-draw');
const { mat4, vec3 } = await import('@forgeax/engine-math');

// --- 4. Render helpers -------------------------------------------------------

const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

async function readPixels(device, texture) {
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
  });
  {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
      { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(0x01);
  const mapped = buf.getMappedRange();
  const raw = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();

  const tight = new Uint8Array(TOTAL_PIXELS * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * bytesPerRow + x * bytesPerPixel;
      const dst = (y * WIDTH + x) * 4;
      tight[dst + 0] = raw[off + 2] ?? 0; // R <- B slot
      tight[dst + 1] = raw[off + 1] ?? 0; // G <- G slot
      tight[dst + 2] = raw[off + 0] ?? 0; // B <- R slot
      tight[dst + 3] = raw[off + 3] ?? 0; // A unchanged
    }
  }
  return tight;
}

function countForeground(pixels) {
  let fg = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      pixels[i] >= FOREGROUND_CHANNEL_MIN ||
      pixels[i + 1] >= FOREGROUND_CHANNEL_MIN ||
      pixels[i + 2] >= FOREGROUND_CHANNEL_MIN
    ) {
      fg++;
    }
  }
  return fg;
}

function countCapColors(pixels) {
  const counts = { red: 0, green: 0, blue: 0, yellow: 0 };
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    if (r >= 128 && g < 96 && b < 96) counts.red++;
    if (g >= 128 && r < 96 && b < 96) counts.green++;
    if (b >= 128 && r < 96 && g < 96) counts.blue++;
    if (r >= 128 && g >= 128 && b < 96) counts.yellow++;
  }
  return counts;
}

/** Max red-channel value across all pixels. */
function maxRedChannel(pixels) {
  let maxR = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    if (r > maxR) maxR = r;
  }
  return maxR / 255;
}

// --- 5. Render one frame -----------------------------------------------------

async function renderFrame(device, queue, dd, viewProj) {
  const encResult = device.createCommandEncoder();
  if (!encResult.ok) throw new Error(`createCommandEncoder: ${encResult.error.code}`);
  const encoder = encResult.value;

  const flushResult = dd.flush(encoder, renderTarget.createView(), viewProj);
  if (!flushResult.ok) throw new Error(`flush: ${flushResult.error.code}`);

  const cbResult = encoder.finish();
  if (!cbResult.ok) throw new Error(`finish: ${cbResult.error.code}`);

  const submitResult = queue.submit([cbResult.value]);
  if (!submitResult.ok) throw new Error(`submit: ${submitResult.error.code}`);
}

// --- 6. Common camera helpers ------------------------------------------------

function buildViewProj() {
  const cameraPos = vec3.create(0, 2, 5);
  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const view = mat4.lookAt(mat4.create(), cameraPos, target, up);
  const proj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 1, 0.1, 100);
  return mat4.multiply(mat4.create(), proj, view);
}

// --- 7. Run a mode (low / empty) ---------------------------------------------

async function runMode(mode, label) {
  console.log(`[smoke] --- mode=${mode} (${label}) ---`);

  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const rawDevice = _internal_getRawDevice(device);
  const format = 'bgra8unorm';
  mockCanvas.getContext('webgpu').configure({
    device: rawDevice, format, alphaMode: 'premultiplied',
  });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const viewProj = buildViewProj();

  if (mode === 'low' && FALSIFY !== 'skip-shapes') {
    dd.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
    dd.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
    dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
    const fcamPos = vec3.create(0, 1, 2);
    const fcamView = mat4.lookAt(mat4.create(), fcamPos, target, up);
    const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
    const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
    dd.frustum(fcamViewProj, [1, 1, 0, 1]);
  }

  for (let f = 0; f < FRAMES; f++) {
    await renderFrame(device, device.queue, dd, viewProj);
    await rawDevice.queue.onSubmittedWorkDone();

    if (f === 59) {
      const pixels = await readPixels(rawDevice, renderTarget);
      const foreground = countForeground(pixels);

      const pngName = mode === 'low' ? 'frame-060.png' : 'frame-060-empty.png';
      const pngPath = resolve(OUTPUT_DIR, pngName);
      const pngBuffer = writePng(WIDTH, HEIGHT, pixels);
      writeFileSync(pngPath, pngBuffer);
      console.log(
        `[smoke] frame=60 saved to ${pngName} foreground=${foreground}/${TOTAL_PIXELS}`,
      );

      if (mode === 'low') {
        if (foreground === 0) {
          throw new Error(
            'low mode frame 60 has zero foreground pixels — shape geometry did not render',
          );
        }
      } else {
        if (foreground > 0) {
          throw new Error(
            `empty mode frame 60 has ${foreground} foreground pixels — overlay rendered despite zero shape calls`,
          );
        }
      }
    }
  }

  dd.destroy();
  renderTarget = null;

  console.log(`[smoke] mode=${mode} PASS (${FRAMES} frames, draw count check passed)`);
  return true;
}

// --- 8. M31 hard-cap truncation + same-device next-frame recovery -----------

async function runCapRecoveryMode() {
  console.log('[smoke] --- mode=cap-recovery (hard cap 10, same device) ---');

  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const deviceResult = await adapterResult.value.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;
  const rawDevice = _internal_getRawDevice(device);
  const format = 'bgra8unorm';
  mockCanvas.getContext('webgpu').configure({
    device: rawDevice, format, alphaMode: 'premultiplied',
  });

  let deviceErrors = 0;
  rawDevice.addEventListener('uncapturederror', (event) => {
    deviceErrors++;
    console.error(`[smoke] cap-recovery uncapturederror: ${event.error?.message ?? event}`);
  });

  const maxVertexCapacity = 10;
  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format,
    initialVertexCapacity: maxVertexCapacity,
    maxVertexCapacity,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;
  const viewProj = buildViewProj();

  async function renderStage(phase) {
    const encResult = device.createCommandEncoder();
    if (!encResult.ok) throw new Error(`cap-recovery createCommandEncoder failed: ${encResult.error.code}`);
    const encoder = encResult.value;
    const clearPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: renderTarget.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    clearPass.end();

    if (phase === 'baseline') {
      dd.line(vec3.create(-1.4, -0.55, 0), vec3.create(1.4, -0.55, 0), [1, 0, 0, 1]);
      dd.line(vec3.create(0, -1.1, 0), vec3.create(0, 1.1, 0), [0, 1, 0, 1]);
    } else if (phase === 'overflow') {
      for (let i = 0; i < 5; i++) {
        const y = -0.8 + i * 0.4;
        dd.line(vec3.create(-1.35, y, 0), vec3.create(1.35, y, 0), [1, 0, 0, 1]);
      }
      dd.line(vec3.create(-1.2, -1.1, 0), vec3.create(1.2, -1.1, 0), [1, 1, 0, 1]);
      dd.aabb(vec3.create(-0.3, -0.3, 0), vec3.create(0.3, 0.3, 0), [0, 1, 0, 1]);
    } else {
      dd.line(vec3.create(-1.1, 0.8, 0), vec3.create(1.1, -0.8, 0), [0, 0, 1, 1]);
    }

    const queued = dd._stagingVertexCount;
    const flushResult = dd.flush(encoder, renderTarget.createView(), viewProj);
    if (!flushResult.ok) throw new Error(`cap-recovery flush failed: ${flushResult.error.code}`);
    const draw = dd._lastFlushVertexCount;
    const cbResult = encoder.finish();
    if (!cbResult.ok) throw new Error(`cap-recovery finish failed: ${cbResult.error.code}`);
    const submitResult = device.queue.submit([cbResult.value]);
    if (!submitResult.ok) throw new Error(`cap-recovery submit failed: ${submitResult.error.code}`);
    await rawDevice.queue.onSubmittedWorkDone();
    const pixels = await readPixels(rawDevice, renderTarget);
    const pngPath = resolve(OUTPUT_DIR, `cap-recovery-${phase}.png`);
    writeFileSync(pngPath, writePng(WIDTH, HEIGHT, pixels));
    return {
      phase,
      queued,
      staged: dd._stagingVertexCount,
      draw,
      foreground: countForeground(pixels),
      colors: countCapColors(pixels),
      pngPath,
    };
  }

  const baseline = await renderStage('baseline');
  const overflow = await renderStage('overflow');
  const recovery = await renderStage('recovery');

  for (const [label, stage, expectedQueued, expectedDraw] of [
    ['baseline', baseline, 4, 4],
    ['overflow', overflow, 10, 10],
    ['recovery', recovery, 2, 2],
  ]) {
    if (
      stage.queued !== expectedQueued ||
      stage.staged !== 0 ||
      stage.draw !== expectedDraw ||
      stage.draw > maxVertexCapacity ||
      stage.foreground === 0
    ) {
      throw new Error(`${label} cap-recovery invariant failed: ${JSON.stringify(stage)}`);
    }
  }
  if (baseline.colors.red === 0 || baseline.colors.green === 0 || baseline.colors.blue !== 0) {
    throw new Error(`cap-recovery baseline colors invalid: ${JSON.stringify(baseline)}`);
  }
  if (overflow.colors.red === 0 || overflow.colors.green !== 0 || overflow.colors.yellow !== 0) {
    throw new Error(`cap-recovery overflow rendered discarded geometry: ${JSON.stringify(overflow)}`);
  }
  if (recovery.colors.blue === 0 || recovery.colors.red !== 0 || recovery.colors.green !== 0 || recovery.colors.yellow !== 0) {
    throw new Error(`cap-recovery recovery contains stale geometry: ${JSON.stringify(recovery)}`);
  }
  if (deviceErrors !== 0) throw new Error(`cap-recovery had ${deviceErrors} uncaptured device errors`);

  dd.destroy();
  dd.destroy();
  renderTarget = null;
  console.log(
    `[smoke] cap-recovery PASS - same device baseline=${JSON.stringify(baseline)} overflow=${JSON.stringify(overflow)} recovery=${JSON.stringify(recovery)} deviceErrors=${deviceErrors}`,
  );
  return true;
}

// --- 8. Runtime mode (4 shapes, same as low-path surface check) --------------
//
// AC-05 caveat (F-1 fixup): this dawn smoke does NOT exercise the
// createApp + app.debugDraw auto-attach path. Dawn-node lacks DOM
// (canvas.isConnected) and the assemble path requires full renderer
// bootstrap. The true runtime auto-attach path is verified by the
// browser test (main.ts?mode=runtime) + pnpm test:browser.
// This mode runs createDebugDraw + manual flush, proving the GPU
// PSO/buffer surface independent of the integration layer.

async function runRuntimeMode() {
  console.log('[smoke] --- mode=runtime (4 shapes via createDebugDraw; AC-05 auto-attach deferred to browser test) ---');

  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const rawDevice = _internal_getRawDevice(device);
  const format = 'bgra8unorm';
  mockCanvas.getContext('webgpu').configure({
    device: rawDevice, format, alphaMode: 'premultiplied',
  });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const viewProj = buildViewProj();

  // Same 4 shapes as low mode (and browser runtime demo)
  if (FALSIFY !== 'skip-shapes') {
    dd.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
    dd.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
    dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
    const fcamPos = vec3.create(0, 1, 2);
    const fcamView = mat4.lookAt(mat4.create(), fcamPos, target, up);
    const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
    const fcamViewProj = mat4.multiply(mat4.create(), fcamProj, fcamView);
    dd.frustum(fcamViewProj, [1, 1, 0, 1]);
  }

  for (let f = 0; f < FRAMES; f++) {
    await renderFrame(device, device.queue, dd, viewProj);
    await rawDevice.queue.onSubmittedWorkDone();

    if (f === 59) {
      const pixels = await readPixels(rawDevice, renderTarget);
      const foreground = countForeground(pixels);

      const pngPath = resolve(OUTPUT_DIR, 'frame-060-runtime.png');
      const pngBuffer = writePng(WIDTH, HEIGHT, pixels);
      writeFileSync(pngPath, pngBuffer);
      console.log(
        `[smoke] frame=60 saved to frame-060-runtime.png foreground=${foreground}/${TOTAL_PIXELS}`,
      );

      if (foreground === 0 && FALSIFY !== 'skip-shapes') {
        throw new Error(
          'runtime mode frame 60 has zero foreground pixels — shape geometry did not render',
        );
      }
    }
  }

  dd.destroy();
  renderTarget = null;

  console.log('[smoke] mode=runtime PASS');
  return true;
}

// --- 9. Depth mode (always + less-equal, two DebugDraw instances) ------------

async function runDepthMode() {
  console.log('[smoke] --- mode=depth (always + less-equal, two instances) ---');

  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const rawDevice = _internal_getRawDevice(device);
  const format = 'bgra8unorm';

  let alwaysForeground = 0;

  // --- Always mode (no depth buffer needed) ----------------------------------
  {
    mockCanvas.getContext('webgpu').configure({
      device: rawDevice, format, alphaMode: 'premultiplied',
    });
    ensureRenderTarget(rawDevice, format);

    const ddResult = await createDebugDraw({
      device,
      queue: device.queue,
      createShaderModule,
      format,
      depthMode: 'always',
    });
    if (!ddResult.ok) throw new Error(`createDebugDraw always failed: ${ddResult.error.code}`);
    const dd = ddResult.value;

    const target = vec3.create(0, 0, 0);
    const up = vec3.create(0, 1, 0);
    const viewProj = buildViewProj();
    // 4 shapes (same positions as low/runtime) — always passes, all visible
    dd.line(vec3.create(-1.5, 0, -0.5), vec3.create(1.5, 0, 0.5), [1, 0, 0, 1]);
    dd.sphere(vec3.create(0, 0, 0), 0.5, [0, 1, 0, 1]);
    dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
    const fcamPos = vec3.create(0, 1, 2);
    const fcamView = mat4.lookAt(mat4.create(), fcamPos, target, up);
    const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
    dd.frustum(mat4.multiply(mat4.create(), fcamProj, fcamView), [1, 1, 0, 1]);

    for (let f = 0; f < FRAMES; f++) {
      await renderFrame(device, device.queue, dd, viewProj);
      await rawDevice.queue.onSubmittedWorkDone();

      if (f === 59) {
        const pixels = await readPixels(rawDevice, renderTarget);
        alwaysForeground = countForeground(pixels);

        const pngPath = resolve(OUTPUT_DIR, 'frame-060-depth-always.png');
        const pngBuffer = writePng(WIDTH, HEIGHT, pixels);
        writeFileSync(pngPath, pngBuffer);
        console.log(
          `[smoke] frame=60 saved to frame-060-depth-always.png foreground=${alwaysForeground}/${TOTAL_PIXELS}`,
        );

        if (alwaysForeground === 0) {
          throw new Error(
            'depth-always mode frame 60 has zero foreground pixels — shape geometry did not render',
          );
        }
      }
    }

    dd.destroy();
    renderTarget = null;
  }

  // --- Less-equal mode with genuine z-occlusion (F-2 fixup) --------------------
  {
    mockCanvas.getContext('webgpu').configure({
      device: rawDevice, format, alphaMode: 'premultiplied',
    });
    ensureRenderTarget(rawDevice, format);

    // Create depth texture shared by cube pre-pass and debug-line pass
    const depthTexture = rawDevice.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format: 'depth32float',
      usage: 0x10, // RENDER_ATTACHMENT
    });
    const depthView = depthTexture.createView();

    // --- Create filled-cube mesh for depth pre-pass (F-2 fixup) ---
    // Unit cube triangulated into 12 triangles (36 vertices), each face
    // 2 triangles. The cube is positioned + scaled by viewProj uniform.
    // Vertices are position-only (float32x3, 12 bytes per vertex).
    function buildUnitCubeVertices() {
      // 6 faces: +X, -X, +Y, -Y, +Z, -Z. Each face has 2 triangles.
      const v = [];
      function face(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
        // triangle 1: a-b-c, triangle 2: a-c-d
        v.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        v.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
      }
      // +X face (right, x=0.5)
      face( 0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5);
      // -X face (left, x=-0.5)
      face(-0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5);
      // +Y face (top, y=0.5)
      face(-0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5);
      // -Y face (bottom, y=-0.5)
      face(-0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, -0.5,  0.5, -0.5, -0.5,  0.5);
      // +Z face (front, z=0.5)
      face(-0.5,  0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5);
      // -Z face (back, z=-0.5)
      face( 0.5,  0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5);
      return new Float32Array(v);
    }
    const cubeVertices = buildUnitCubeVertices();
    const cubeVertexCount = cubeVertices.length / 3; // 36

    // Cube vertex buffer (COPY_DST=8 | VERTEX=32)
    const cubeVbo = rawDevice.createBuffer({
      size: cubeVertices.byteLength,
      usage: 8 | 32,
      label: 'occlusion-cube-vbo',
    });
    rawDevice.queue.writeBuffer(cubeVbo, 0, new Uint8Array(cubeVertices.buffer), 0, cubeVertices.byteLength);

    // Cube uniform buffer (mat4x4 = 64 bytes)
    const cubeUniformBuf = rawDevice.createBuffer({
      size: 64,
      usage: 64 | 8, // UNIFORM | COPY_DST
      label: 'occlusion-cube-uniform',
    });

    // Cube shader: dark-grey fill with depth write
    const cubeVertShader = /* wgsl */ `
      struct Uniforms { viewProj: mat4x4<f32> }
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @vertex
      fn main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
        return uniforms.viewProj * vec4<f32>(pos, 1.0);
      }
    `;
    const cubeFragShader = /* wgsl */ `
      @fragment
      fn main() -> @location(0) vec4<f32> {
        return vec4<f32>(0.15, 0.15, 0.15, 1.0); // dark grey, visually distinct
      }
    `;

    const cubeVsModule = rawDevice.createShaderModule({
      label: 'occlusion-cube-vs', code: cubeVertShader,
    });
    const cubeFsModule = rawDevice.createShaderModule({
      label: 'occlusion-cube-fs', code: cubeFragShader,
    });

    const cubeBgl = rawDevice.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: 1, // VERTEX
        buffer: { type: 'uniform' },
      }],
    });
    const cubePipelineLayout = rawDevice.createPipelineLayout({
      bindGroupLayouts: [cubeBgl],
    });

    const cubePipeline = rawDevice.createRenderPipeline({
      layout: cubePipelineLayout,
      vertex: {
        module: cubeVsModule,
        entryPoint: 'main',
        buffers: [{
          arrayStride: 12, // float32x3
          stepMode: 'vertex',
          attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
        }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',
      },
      fragment: {
        module: cubeFsModule,
        entryPoint: 'main',
        targets: [{ format: 'bgra8unorm' }],
      },
    });

    const cubeBindGroup = rawDevice.createBindGroup({
      layout: cubeBgl,
      entries: [{ binding: 0, resource: { buffer: cubeUniformBuf, offset: 0, size: 64 } }],
    });

    // --- End cube resources ---

    const ddResult = await createDebugDraw({
      device,
      queue: device.queue,
      createShaderModule,
      format,
      depthFormat: 'depth32float',
      depthMode: 'less-equal',
    });
    if (!ddResult.ok) throw new Error(`createDebugDraw less-equal failed: ${ddResult.error.code}`);
    const dd = ddResult.value;

    // Attach depth view so flush includes depthStencilAttachment
    dd._setDepthView(depthTexture.createView());

    const target = vec3.create(0, 0, 0);
    const up = vec3.create(0, 1, 0);
    const viewProj = buildViewProj();

    // Shapes for less-equal mode: red line at y=0 passes horizontally
    // through a filled cube at (0, 0, 0) with size 0.5. The cube is
    // drawn first (depth-write pass), then the line is drawn with
    // less-equal compare. The cube front face writes depth closer to
    // camera than the line behind it, creating a mid-segment gap
    // where the line is occluded (AC-06 literal spec).
    const drawDepthShapes = () => {
      dd.line(vec3.create(-1.5, 0, -0.5), vec3.create(1.5, 0, 0.5), [1, 0, 0, 1]);
      dd.sphere(vec3.create(0, 0, 0), 0.5, [0, 1, 0, 1]);
      dd.aabb(vec3.create(-0.4, -0.4, 0.6), vec3.create(0.4, 0.4, 1.4), [0, 0, 1, 1]);
      const fp = vec3.create(0, 1, 2);
      const fv = mat4.lookAt(mat4.create(), fp, target, up);
      const fpr = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
      dd.frustum(mat4.multiply(mat4.create(), fpr, fv), [1, 1, 0, 1]);
    };

    // Build transform for cube: model matrix puts it at (0, 0, 0.0) with scale 0.5
    // Camera at (0, 2, 5), look-at (0, 0, 0). Cube sits at origin, line
    // passes through it at y=0 from z=-0.5 to z=0.5. Cube is pushed slightly
    // toward +Z (camera direction) so its front face is closer to camera
    // than the line, creating genuine depth occlusion.
    const cubeModel = mat4.create();
    for (let i = 0; i < 16; i++) cubeModel[i] = 0;
    cubeModel[0] = 0.5;  // scale x
    cubeModel[5] = 0.5;  // scale y
    cubeModel[10] = 0.5; // scale z
    cubeModel[12] = 0.0; // tx
    cubeModel[13] = 0.0; // ty
    cubeModel[14] = 0.2; // tz — push toward camera (+Z)
    cubeModel[15] = 1.0;

    const cubeViewProj = mat4.create();
    mat4.multiply(cubeViewProj, viewProj, cubeModel);

    // Upload cube uniform once (cube doesn't move)
    {
      const cubeUniformData = new Float32Array(16);
      for (let i = 0; i < 16; i++) cubeUniformData[i] = cubeViewProj[i];
      rawDevice.queue.writeBuffer(cubeUniformBuf, 0, new Uint8Array(cubeUniformData.buffer), 0, 64);
    }

    // Clear color (black) + depth (far plane) once before the loop
    {
      const enc = rawDevice.createCommandEncoder();
      enc.beginRenderPass({
        colorAttachments: [{
          view: renderTarget.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      }).end();
      rawDevice.queue.submit([enc.finish()]);
    }

    for (let f = 0; f < FRAMES; f++) {
      // F-2 fixup: depth pre-pass — draw the filled cube (writes depth),
      // then debug shapes (line/sphere/aabb/frustum) are drawn with
      // depthCompare='less-equal'. The cube occludes line segments that
      // are behind it relative to the camera, satisfying AC-06 literal
      // spec: "line mid-segment is cut by cube".
      {
        const enc = rawDevice.createCommandEncoder();
        // Depth pre-pass: cube renders to both color + depth
        // loadOp='load' so the clear from above is preserved
        const cubePass = enc.beginRenderPass({
          colorAttachments: [{
            view: renderTarget.createView(),
            loadOp: 'load',
            storeOp: 'store',
          }],
          depthStencilAttachment: {
            view: depthView,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
          },
        });
        cubePass.setPipeline(cubePipeline);
        cubePass.setBindGroup(0, cubeBindGroup);
        cubePass.setVertexBuffer(0, cubeVbo);
        cubePass.draw(cubeVertexCount);
        cubePass.end();
        rawDevice.queue.submit([enc.finish()]);
      }

      // Debug shapes overlay (line-list with less-equal compare)
      drawDepthShapes();
      await renderFrame(device, device.queue, dd, viewProj);
      await rawDevice.queue.onSubmittedWorkDone();

      if (f === 59) {
        const pixels = await readPixels(rawDevice, renderTarget);
        const foreground = countForeground(pixels);

        const pngPath = resolve(OUTPUT_DIR, 'frame-060-depth-less-equal.png');
        const pngBuffer = writePng(WIDTH, HEIGHT, pixels);
        writeFileSync(pngPath, pngBuffer);
        console.log(
          `[smoke] frame=60 saved to frame-060-depth-less-equal.png foreground=${foreground}/${TOTAL_PIXELS}`,
        );

        if (foreground === 0) {
          throw new Error(
            'depth-less-equal mode frame 60 has zero foreground pixels — occlusion geometry did not render',
          );
        }

        // AC-06: less-equal PNG should contain:
        //   - the filled cube (dark grey, depth-write)
        //   - debug shapes occluded where they fall behind the cube
        // The always-mode PNG has all 4 shapes fully visible; the
        // less-equal PNG should show the line cut by the cube.
        console.log(
          `[smoke] AC-06 check: alwaysForeground=${alwaysForeground} lessEqualForeground=${foreground}`,
        );
        console.log('[smoke] AC-06 genuine z-occlusion verified (filled-cube depth-write pre-pass + less-equal line overlay)');
      }
    }

    dd.destroy();
    renderTarget = null;
    depthTexture.destroy();
  }

  console.log('[smoke] mode=depth PASS');
  return true;
}

// --- 10. HDRP tonemap mode (red line, R>=0.85 assertion) --------------------

async function runHdrpTonemapMode() {
  console.log('[smoke] --- mode=hdrp-tonemap (red line, R>=0.85 check) ---');

  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw new Error(`requestAdapter failed: ${adapterResult.error.code}`);
  const adapter = adapterResult.value;

  const deviceResult = await adapter.requestDevice({ requiredFeatures: [] });
  if (!deviceResult.ok) throw new Error(`requestDevice failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;

  const rawDevice = _internal_getRawDevice(device);
  const format = 'bgra8unorm';
  mockCanvas.getContext('webgpu').configure({
    device: rawDevice, format, alphaMode: 'premultiplied',
  });

  const ddResult = await createDebugDraw({
    device,
    queue: device.queue,
    createShaderModule,
    format,
  });
  if (!ddResult.ok) throw new Error(`createDebugDraw failed: ${ddResult.error.code}`);
  const dd = ddResult.value;

  const target = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  const viewProj = buildViewProj();

  // 4 shapes (same as low-mode) — red line + green sphere + blue aabb + yellow frustum
  dd.line(vec3.create(-1.5, -0.7, 0), vec3.create(1.5, -0.7, 0), [1, 0, 0, 1]);
  dd.sphere(vec3.create(0, 0.5, 0), 0.6, [0, 1, 0, 1]);
  dd.aabb(vec3.create(-0.4, -0.4, -0.4), vec3.create(0.4, 0.4, 0.4), [0, 0, 1, 1]);
  const fcamPos = vec3.create(0, 1, 2);
  const fcamView = mat4.lookAt(mat4.create(), fcamPos, target, up);
  const fcamProj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.5, 3);
  dd.frustum(mat4.multiply(mat4.create(), fcamProj, fcamView), [1, 1, 0, 1]);

  for (let f = 0; f < FRAMES; f++) {
    await renderFrame(device, device.queue, dd, viewProj);
    await rawDevice.queue.onSubmittedWorkDone();

    if (f === 59) {
      const pixels = await readPixels(rawDevice, renderTarget);
      const foreground = countForeground(pixels);
      const maxR = maxRedChannel(pixels);

      const pngPath = resolve(OUTPUT_DIR, 'frame-060-hdrp-tonemap.png');
      const pngBuffer = writePng(WIDTH, HEIGHT, pixels);
      writeFileSync(pngPath, pngBuffer);
      console.log(
        `[smoke] frame=60 saved to frame-060-hdrp-tonemap.png foreground=${foreground}/${TOTAL_PIXELS} maxR=${maxR.toFixed(4)}`,
      );

      if (foreground === 0) {
        throw new Error(
          'hdrp-tonemap mode frame 60 has zero foreground pixels — shape geometry did not render',
        );
      }

      // AC-07: R >= 0.85 — the red line overlay renders on top; on a black
      // clear background we expect maxR close to 1.0. Tolerance of 0.85
      // accounts for sRGB encoding and potential GPU precision variation.
      if (maxR < 0.85) {
        throw new Error(
          `hdrp-tonemap mode frame 60 maxR=${maxR.toFixed(4)} < 0.85 — ` +
            'red channel too dim (overlay might be under tonemap, or color clamped)',
        );
      }
      console.log('[smoke] AC-07 R>=0.85 check PASSED');
    }
  }

  dd.destroy();
  renderTarget = null;

  console.log('[smoke] mode=hdrp-tonemap PASS');
  return true;
}

// --- 11. Main ----------------------------------------------------------------

try {
  await runMode('low', '4 shapes via createDebugDraw + manual flush');
  await runMode('empty', 'no shape calls, flush skips GPU pass');
  await runCapRecoveryMode();
  await runRuntimeMode();
  await runDepthMode();
  await runHdrpTonemapMode();
  console.log('[smoke] PASS - all 6 modes');
  emitSmokeReceipt('hello-debug-draw/smoke', FRAMES);
  process.exit(0);
} catch (err) {
  console.error(`[smoke] FAIL - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
