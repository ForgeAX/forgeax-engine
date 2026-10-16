#!/usr/bin/env node
// apps/dual-impl-spike/scripts/texture-4x4.mjs
//
// Dual-impl 4x4 RGBA8unorm texture spike (feat-20260511-asset-system-v1
// M6 / w17). Implements D-P6 + AC-19: upload a fixed 4x4 RGBA8unorm texel
// block via `queue.writeTexture` through BOTH @forgeax/engine-rhi-webgpu
// and @forgeax/engine-rhi-wgpu, round-trip through a 256-byte-row-stride
// padded readback buffer, and assert byte-exact (ε=0) equality vs the
// source Uint8Array on both sides.
//
// Raw GPU binding: dawn-node (`webgpu` npm package) — same pattern as
// apps/hello/triangle/scripts/smoke-{dawn,wgpu-wasm}.mjs. Under dawn-node
// both rhi shims route through `globalThis.navigator.gpu`, so the same
// native Dawn backend services both code paths; ε=0 is expected because
// the RHI surfaces are thin shims over the same queue.writeTexture path
// and neither side applies a colorspace transform (colorSpace='srgb' +
// premultipliedAlpha=false are writeTexture no-ops — they only take
// effect for copyExternalImageToTexture, but we lock them into the spike
// docs as the aligned invariant so Node/browser parity stays stable).
//
// Emitted report: report/texture-4x4.json (schema: { verdict, backends,
// sourceBytes, details }). The metric runner consumes this via
// package.json#forgeax.metrics.spike-report.reportPath (M6 / w18).
//
// Exit codes: 0 = both backends ε=0; 1 = any failure (dawn-node absent,
// adapter unavailable, writeTexture error, ε != 0, etc.). stderr carries
// 3-section structured failure hints matching the forgeax-harness
// convention (reason / rerun / hint).
//
// Output literals (grep anchors for future verify gates):
//   '[spike] backend=rhi-webgpu epsilon=0'
//   '[spike] backend=rhi-wgpu SKIPPED reason=wasm-GL-fallback-not-applicable-under-dawn-node'
//     (bug-20260610: rhi-wgpu is now strictly the browser WebGL2 fallback;
//      navigator.gpu fast path + BROWSER_WEBGPU backend both removed by
//      contract — dawn-node lacks a GL adapter, so this leg is not
//      applicable. True dual-impl GL parity belongs in a separate CI job.)
//   '[spike] PASS - rhi-webgpu round-trip 4x4 RGBA8unorm with epsilon=0 (rhi-wgpu skipped post-bug-20260610)'

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bytesEqual,
  padRowStride,
  unpadRowStride,
  WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT,
} from './row-stride-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPORT_PATH = resolve(APP_ROOT, 'report/texture-4x4.json');

const WIDTH = 4;
const HEIGHT = 4;
const BPP = 4; // RGBA8unorm
const FORMAT = 'rgba8unorm';
// Deterministic source texel block (ε=0 assertion target). 64 bytes tight.
// Row-major R/G/B/A per pixel. Chosen to cover low + high byte values +
// monotone increments so a single-bit readback corruption is visible.
const SOURCE_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0xff, 0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xff, 0x70, 0x80, 0x90, 0xff,
  0xa0, 0xb0, 0xc0, 0xff, 0xd0, 0xe0, 0xf0, 0xff, 0x0a, 0x1b, 0x2c, 0xff, 0x3d, 0x4e, 0x5f, 0xff,
  0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff, 0xaa, 0xbb, 0xcc, 0xff,
  0xdd, 0xee, 0xff, 0xff, 0x01, 0x03, 0x05, 0xff, 0x07, 0x09, 0x0b, 0xff, 0x0d, 0x0f, 0x11, 0xff,
]);

if (SOURCE_BYTES.byteLength !== WIDTH * HEIGHT * BPP) {
  structuredFail('source-length-mismatch', `SOURCE_BYTES.byteLength === ${WIDTH * HEIGHT * BPP}`, `got ${SOURCE_BYTES.byteLength}`);
}

function structuredFail(code, expected, hint, report) {
  process.stderr.write(`[reason] ${code}: ${expected}\n[rerun]  pnpm --filter dual-impl-spike smoke\n[hint]   ${hint}\n`);
  writeReport({ verdict: 'fail', code, expected, hint, ...(report ?? {}) });
  process.exit(1);
}

function writeReport(payload) {
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    const body = {
      schema: 'forgeax.dual-impl-spike.texture-4x4@v1',
      width: WIDTH,
      height: HEIGHT,
      format: FORMAT,
      colorSpace: 'srgb',
      premultipliedAlpha: false,
      bytesPerRow: WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT,
      sourceBytes: WIDTH * HEIGHT * BPP,
      at: new Date().toISOString(),
      ...payload,
    };
    writeFileSync(REPORT_PATH, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  } catch (e) {
    process.stderr.write(`[warn] spike-report write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Dawn-node bootstrap. Mirrors apps/hello/triangle/scripts/smoke-dawn.mjs.
let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  structuredFail(
    'dawn-node-import-failed',
    'dawn-node (webgpu) npm module available',
    `ensure node_modules/webgpu present; inner error: ${err instanceof Error ? err.message : String(err)}`,
  );
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  structuredFail(
    'dawn-node-create-failed',
    'dawn-node create([]) succeeds',
    `on linux ensure libvulkan1 + mesa-vulkan-drivers installed; inner error: ${err instanceof Error ? err.message : String(err)}`,
  );
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

// Per-backend runner. Isolates one rhi surface, allocates texture +
// readback buffer, uploads via queue.writeTexture, copies to buffer,
// reads back, unpads, asserts ε=0 vs SOURCE_BYTES. Returns structured
// detail so the caller aggregates both backends before exiting.
//
// Readback note (M6 scope boundary): the upload path (queue.writeTexture)
// is the dual-impl boundary we validate for ε=0. For readback we drop to
// the raw GPUDevice (via `_internal_getRawDevice`) because the current rhi shim's
// `copyTextureToBuffer` does not yet unwrap the destination Buffer handle
// (discovered during w17; a fix is out-of-scope for M6 and tracked under
// `feat-future-rhi-copy-texture-to-buffer-unwrap`). This does not weaken
// the ε=0 claim: the texture was written through the rhi.writeTexture
// surface; the readback is a passive verification path.
async function runBackend(backendName, rhi, _internal_getRawDevice) {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) {
    return { backend: backendName, status: 'fail', stage: 'requestAdapter', code: adapterResult.error.code, hint: adapterResult.error.hint };
  }
  const adapter = adapterResult.value;
  const deviceResult = await adapter.requestDevice({ label: `dual-impl-spike-${backendName}` });
  if (!deviceResult.ok) {
    return { backend: backendName, status: 'fail', stage: 'requestDevice', code: deviceResult.error.code, hint: deviceResult.error.hint };
  }
  const device = deviceResult.value;
  const rawDevice = _internal_getRawDevice(device);
  if (!rawDevice) {
    return { backend: backendName, status: 'fail', stage: 'rawDeviceLookup', code: 'raw-device-unavailable', hint: `_internal_getRawDevice returned undefined for backend=${backendName}` };
  }

  // Pad upload source to 256 bytesPerRow (RHI shim normative check).
  const { padded: uploadPadded, bytesPerRow } = padRowStride(SOURCE_BYTES, WIDTH, HEIGHT, BPP);

  // Create the 4x4 texture (COPY_DST for writeTexture + COPY_SRC for
  // copyTextureToBuffer readback). GPUTextureUsage literals are 0x02
  // (COPY_DST) + 0x01 (COPY_SRC) — dawn-node exposes them via globals
  // injection above (GPUTextureUsage global).
  const texUsage = 0x02 | 0x01; // COPY_DST | COPY_SRC
  const texResult = device.createTexture({
    label: `dual-impl-spike-${backendName}-tex`,
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format: FORMAT,
    usage: texUsage,
  });
  if (!texResult.ok) {
    return { backend: backendName, status: 'fail', stage: 'createTexture', code: texResult.error.code, hint: texResult.error.hint };
  }
  const texture = texResult.value;

  // Upload via the RHI surface (the dual-impl boundary under test).
  const writeResult = device.queue.writeTexture(
    { texture: texture, mipLevel: 0, origin: [0, 0, 0] },
    uploadPadded,
    { offset: 0, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  if (!writeResult.ok) {
    return { backend: backendName, status: 'fail', stage: 'writeTexture', code: writeResult.error.code, hint: writeResult.error.hint };
  }

  // Readback via the raw GPUDevice (see Readback note above). The texture
  // handle IS the raw GPUTexture in both rhi shims (createTexture returns
  // the raw object as its handle), so copyTextureToBuffer accepts it.
  const readbackSize = bytesPerRow * HEIGHT;
  const rawReadback = rawDevice.createBuffer({
    label: `dual-impl-spike-${backendName}-raw-readback`,
    size: readbackSize,
    usage: 0x01 | 0x08, // MAP_READ | COPY_DST
  });
  const rawEncoder = rawDevice.createCommandEncoder({ label: `dual-impl-spike-${backendName}-raw-enc` });
  rawEncoder.copyTextureToBuffer(
    { texture: texture, mipLevel: 0, origin: [0, 0, 0] },
    { buffer: rawReadback, offset: 0, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  rawDevice.queue.submit([rawEncoder.finish()]);
  await rawDevice.queue.onSubmittedWorkDone();

  try {
    await rawReadback.mapAsync(0x01); // GPUMapMode.READ
  } catch (err) {
    return { backend: backendName, status: 'fail', stage: 'mapAsync', code: 'webgpu-runtime-error', hint: `mapAsync rejected: ${err instanceof Error ? err.message : String(err)}` };
  }
  const paddedReadback = new Uint8Array(rawReadback.getMappedRange().slice(0));
  rawReadback.unmap();
  rawReadback.destroy?.();

  // Unpad + byte-equality.
  const tightReadback = unpadRowStride(paddedReadback, WIDTH, HEIGHT, BPP, bytesPerRow);
  const eq = bytesEqual(SOURCE_BYTES, tightReadback);
  if (!eq.equal) {
    return { backend: backendName, status: 'fail', stage: 'bytesEqual', code: 'epsilon-nonzero', detail: eq };
  }
  return { backend: backendName, status: 'ok', bytesPerRow, epsilon: 0 };
}

// Run both backends.
//
// bug-20260610: rhi-wgpu's contract changed — it is now strictly the
// browser WebGL2 fallback and explicitly removes both (1) the navigator.gpu
// fast path and (2) the `BROWSER_WEBGPU` wgpu backend. Under dawn-node
// there is no GL adapter, so rhi-wgpu cannot acquire one. The dual-impl
// invariant under dawn-node thus collapses to mono-WebGPU (rhi-webgpu
// only). Skip rhi-wgpu here with an explicit reason rather than letting
// requestAdapter fail; report it as `skipped` (not `fail`) so metric
// runners can distinguish "contract-not-applicable" from real regressions.
// True dual-impl GL parity belongs in a separate CI job (lavapipe etc.).
const { rhi: rhiWebgpu, _internal_getRawDevice: webgpuGetRaw } = await import('@forgeax/engine-rhi-webgpu');

const results = [];
const webgpuResult = await runBackend('rhi-webgpu', rhiWebgpu, webgpuGetRaw);
results.push(webgpuResult);
if (webgpuResult.status === 'ok') {
  console.log('[spike] backend=rhi-webgpu epsilon=0');
} else {
  console.error(`[spike] backend=rhi-webgpu FAIL stage=${webgpuResult.stage} code=${webgpuResult.code ?? 'unknown'}`);
}

results.push({
  backend: 'rhi-wgpu',
  status: 'skipped',
  reason: 'rhi-wgpu is the browser WebGL2 fallback (bug-20260610): no GL adapter under dawn-node, navigator.gpu fast path removed by contract',
});
console.log('[spike] backend=rhi-wgpu SKIPPED reason=wasm-GL-fallback-not-applicable-under-dawn-node');

const failures = results.filter((r) => r.status === 'fail');
if (failures.length > 0) {
  const first = failures[0];
  structuredFail(
    'dual-impl-epsilon-nonzero',
    'rhi-webgpu + rhi-wgpu both round-trip 4x4 RGBA8unorm with epsilon=0',
    `backend=${first.backend} stage=${first.stage} code=${first.code ?? 'unknown'}${first.detail ? ` detail=${JSON.stringify(first.detail)}` : ''}`,
    { backends: results },
  );
}

writeReport({ verdict: 'pass', backends: results });
console.log(
  '[spike] PASS - rhi-webgpu round-trip 4x4 RGBA8unorm with epsilon=0 (rhi-wgpu skipped post-bug-20260610)',
);
process.exit(0);
