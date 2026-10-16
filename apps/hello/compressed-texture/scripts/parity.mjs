#!/usr/bin/env node
// hello-compressed-texture pixel parity smoke (M6 w42, AC-14).
// feat-20260707-texture-block-compression-web-transcode-ktx2-basis.
//
// F-4 fixup. Two legs, both over the REAL Basis chain (no synthetic BC7 POD):
//
//   Leg A -- CPU codec parity (primary AC-14 verdict, portable, deterministic):
//     makeCheckerRgba (ground truth)
//       -> basisEncode (etc1s KTX2, the build-time image-importer arm)
//       -> parseKtx2   (container -> Ktx2Parsed)
//       -> transcodeKtx2 to rgba8unorm (the codec's uncompressed decode target)
//       -> compare decoded cell centres against the ground-truth checkerboard.
//     This is the real encode->transcode chain end-to-end; it needs only the
//     codec WASM (no GPU), so it runs and asserts on every host + in CI. The
//     compressed decode must reproduce the checkerboard within epsilon; that is
//     the "compression vs baseline" parity with real discriminating power (the
//     old synthetic-POD centre-pixel probe had none).
//
//   Leg B -- GPU block-upload liveness (structural, best-effort):
//     transcodeKtx2 to the platform-native BLOCK format (selectTranscodeTarget
//     under the device caps) -> TextureAsset POD (mirrors asset-registry
//     basisTextureLoader) -> Renderer draw. Asserts the real block-aware upload
//     (deriveMipUploadLayout, M5 w36) drives >0 frames with no RhiError. This is
//     structural-only: the dawn offscreen render target reads back the camera
//     clear colour for this PBR-quad scene (verified: even a full-screen quad
//     surfaces only clear colour, same as the shipped smoke-dawn pixelSamples),
//     so a GPU pixel diff here has no discriminating power -- the pixel verdict
//     lives in Leg A. When dawn/GPU is absent, Leg B is skipped (logged), and
//     Leg A still gives a full pass/fail.
//
//   FALSIFY=bcs-row -- in-script env-guard (NOT an ESM monkey-patch, so no
//     ESM-freeze hazard). It re-packs Leg A's decoded image with a WRONG row
//     stride (reads each row from a (W-1)-wide pitch into a W-wide row), the CPU
//     analogue of the mis-strided block upload the parity guards against: the
//     per-row drift shears the checkerboard so decoded cell centres no longer
//     match ground truth. This MUST produce a FAIL, proving the cell-centre
//     comparison is sensitive to a stride defect (AC-14 falsification, §5.4).

import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const FALSIFY = process.env.FALSIFY ?? '';
const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '2000', 10);
const EPSILON = Number.parseFloat(process.env.PARITY_EPSILON ?? '0.05');
const WIDTH = 200;
const HEIGHT = 150;
const TEX_W = 256;
const TEX_H = 256;
const CHECK_SIZE = 32;

// --- Ground-truth checkerboard ------------------------------------------------

function makeCheckerRgba() {
  const p = new Uint8Array(TEX_W * TEX_H * 4);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const cx = Math.floor(x / CHECK_SIZE) % 2;
      const cy = Math.floor(y / CHECK_SIZE) % 2;
      const white = cx === cy ? 1 : 0;
      const i = (y * TEX_W + x) * 4;
      p[i] = white ? 255 : 64;
      p[i + 1] = white ? 200 : 32;
      p[i + 2] = white ? 128 : 255;
      p[i + 3] = 255;
    }
  }
  return p;
}

const checkerPixels = makeCheckerRgba();

// Sample the centre of every checkerboard cell (deterministic sample set).
function cellCentreSamples(rgba, width) {
  const samples = [];
  const cellsX = Math.floor(TEX_W / CHECK_SIZE);
  const cellsY = Math.floor(TEX_H / CHECK_SIZE);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const x = cx * CHECK_SIZE + CHECK_SIZE / 2;
      const y = cy * CHECK_SIZE + CHECK_SIZE / 2;
      const i = (y * width + x) * 4;
      samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
  }
  return samples;
}

function compareSamples(a, b) {
  if (a.length !== b.length) return { max: 1, mean: 1 };
  let maxDiff = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i][c] - b[i][c]) / 255;
      if (d > maxDiff) maxDiff = d;
      sum += d;
      count++;
    }
  }
  return { max: maxDiff, mean: count > 0 ? sum / count : 1 };
}

// FALSIFY=bcs-row env-guard: re-pack the decoded image with a WRONG row pitch
// (read each destination row from a (W-1)-wide source stride). The cumulative
// per-row drift shears the checkerboard -- the CPU analogue of a mis-strided
// block upload. Read HERE, in this script's own path (no ESM binding rewrite).
function maybeShearRows(rgba, width, height) {
  if (FALSIFY !== 'bcs-row') return rgba;
  const wrongPitch = (width - 1) * 4; // one pixel short per row
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcOff = y * wrongPitch;
    const dstOff = y * width * 4;
    const rowBytes = width * 4;
    const avail = Math.max(0, Math.min(rowBytes, rgba.byteLength - srcOff));
    if (avail > 0) out.set(rgba.subarray(srcOff, srcOff + avail), dstOff);
  }
  console.log(`[parity] FALSIFY=bcs-row: re-packed decoded image with wrong pitch (${wrongPitch}B vs ${width * 4}B) to shear the checkerboard`);
  return out;
}

// --- Codec chain (CPU) --------------------------------------------------------

const { basisEncode } = await import('@forgeax/engine-codec/encode');
const { parseKtx2, selectTranscodeTarget, transcodeKtx2, isCompressedFormat } = await import(
  '@forgeax/engine-codec'
);

console.log('[parity] Leg A: encoding checkerboard -> Basis KTX2 (etc1s)...');
const encodeRes = await basisEncode(checkerPixels, {
  mode: 'etc1s',
  width: TEX_W,
  height: TEX_H,
  srgb: true,
  perceptual: true,
  uastcSupercompression: false,
  mipGen: false,
});
if (!encodeRes.ok) {
  console.error(`[parity] FAIL - basisEncode failed: ${encodeRes.error.code}`);
  process.exit(1);
}
const ktx2Bytes = encodeRes.value;
console.log(`[parity] encoded KTX2: ${ktx2Bytes.byteLength}B`);

const parsedRes = await parseKtx2(ktx2Bytes);
if (!parsedRes.ok) {
  console.error(`[parity] FAIL - parseKtx2 failed: ${parsedRes.error.code}`);
  process.exit(1);
}

// Transcode to the uncompressed rgba8unorm target so we can compare pixels on
// the CPU (the codec's own decode path -- the same transcodeKtx2 the runtime
// uses, targeting rgba8unorm which the block-format table treats as the
// uncompressed fallback).
const decodeRes = await transcodeKtx2(parsedRes.value, 'rgba8unorm');
if (!decodeRes.ok) {
  console.error(`[parity] FAIL - transcodeKtx2 (rgba8unorm decode) failed: ${decodeRes.error.code}`);
  process.exit(1);
}
const decodedBase = decodeRes.value.mips[0].data;
const decodeWidth = decodeRes.value.width;
const decoded = maybeShearRows(decodedBase, decodeWidth, decodeRes.value.height);

const gtSamples = cellCentreSamples(checkerPixels, TEX_W);
const decodedSamples = cellCentreSamples(decoded, decodeWidth);
const cpu = compareSamples(gtSamples, decodedSamples);
console.log(
  `[parity] Leg A cell-centre diff: max=${cpu.max.toFixed(4)} mean=${cpu.mean.toFixed(4)} (epsilon=${EPSILON}, ${gtSamples.length} cells)`,
);

if (FALSIFY === 'bcs-row') {
  if (cpu.mean <= EPSILON) {
    console.error(`[parity] FAIL - FALSIFY=bcs-row: mean cell diff=${cpu.mean.toFixed(4)} <= epsilon=${EPSILON}`);
    console.error('  The parity check did NOT detect the sheared decode. AC-14 falsification failed.');
    process.exit(1);
  }
  console.log(`[parity] FALSIFY=bcs-row CONFIRMED: mean cell diff=${cpu.mean.toFixed(4)} > epsilon=${EPSILON}`);
  console.log('  The parity check correctly detects a wrong-stride decode (plan-strategy §5.4).');
  process.exit(0);
}

if (cpu.mean > EPSILON) {
  console.error(`[parity] FAIL - Leg A mean cell diff=${cpu.mean.toFixed(4)} > epsilon=${EPSILON} (max=${cpu.max.toFixed(4)})`);
  console.error('  The real encode->transcode chain diverged from the checkerboard baseline beyond tolerance.');
  process.exit(1);
}
console.log(`[parity] Leg A PASS - real codec chain reproduces the checkerboard (mean=${cpu.mean.toFixed(4)} <= ${EPSILON}).`);

// --- Leg B: GPU block-upload liveness (structural, best-effort) ---------------

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  console.log(`[parity] Leg B SKIP - dawn.node absent (GPU block-upload liveness deferred to CI): ${err.message}`);
  console.log('[parity] PASS (Leg A green; Leg B deferred to a GPU host / CI)');
  process.exit(0);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.log(`[parity] Leg B SKIP - dawn create failed (deferred to CI): ${err.message}`);
  console.log('[parity] PASS (Leg A green; Leg B deferred to a GPU host / CI)');
  process.exit(0);
}
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalReqAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const origReqDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await origReqDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

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
      configure(desc) { ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) { if (!sharedDevice) throw new Error('no device'); ensureRenderTarget(sharedDevice, 'rgba8unorm'); }
        return renderTarget;
      },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { Transform } = await import('@forgeax/engine-scene');
const { MeshFilter, MeshRenderer, DirectionalLight, Camera, perspective } = await import('@forgeax/engine-render');
const { HANDLE_QUAD } = await import('@forgeax/engine-assets-runtime');

const MANIFEST_URL = `data:application/json,${encodeURIComponent(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'shaders', 'manifest.json'), 'utf8'),
)}`;

const created = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
if (!created.ok) throw created.error;
const renderer = created.value.renderer;
const inspection = renderer.inspect();
console.log(`[parity] Leg B: backend=${inspection.capabilities.backendKind}`);
const caps = inspection.capabilities;
console.log(`[parity] caps: bc=${caps.textureCompressionBc} etc2=${caps.textureCompressionEtc2} astc=${caps.textureCompressionAstc}`);


// Real transcode to the platform-native BLOCK format (same selector the runtime
// basisTextureLoader uses); the block-aware upload path consumes this POD.
const blockFormat = selectTranscodeTarget(
  { model: 'etc1s', srgb: true, channels: 'rgba' },
  { bc: caps.textureCompressionBc, etc2: caps.textureCompressionEtc2, astc: caps.textureCompressionAstc },
);
console.log(`[parity] transcode target=${blockFormat} (block=${isCompressedFormat(blockFormat)})`);
const blockTranscoded = await transcodeKtx2(parsedRes.value, blockFormat);
if (!blockTranscoded.ok) {
  console.error(`[parity] FAIL - transcodeKtx2 (block ${blockFormat}) failed: ${blockTranscoded.error.code}`);
  process.exit(1);
}
let blockData = new Uint8Array(0);
for (const m of blockTranscoded.value.mips) {
  const merged = new Uint8Array(blockData.byteLength + m.data.byteLength);
  merged.set(blockData, 0);
  merged.set(m.data, blockData.byteLength);
  blockData = merged;
}

const rhiErrors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') rhiErrors.push(event.error);
});

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const lease = worldAttachment1.value;
const texHandle = world.allocSharedRef('TextureAsset', {
  kind: 'texture',
  width: blockTranscoded.value.width,
  height: blockTranscoded.value.height,
  format: blockFormat,
  data: blockData,
  colorSpace: 'srgb',
  mipmap: blockTranscoded.value.mips.length > 1,
  mipLevelCount: Math.max(1, blockTranscoded.value.mips.length),
});
const samplerHandle = world.allocSharedRef('SamplerAsset', {
  kind: 'sampler', magFilter: 'linear', minFilter: 'linear',
  addressModeU: 'repeat', addressModeV: 'repeat',
});
const matHandle = world.allocSharedRef('MaterialAsset', {
  kind: 'material',
  passes: [{
    name: 'Forward',
    program: { module: 'forgeax::default-standard-pbr' },
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  }],
  values: {
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.8,
    baseColorTexture: texHandle,
    sampler: samplerHandle,
  },
});
const quads = [[-1.5, 0.8, 0, 0.7, 0.7, 1], [1.5, 0.8, 0, 0.5, 0.5, 1], [-1.5, -0.8, 0, 0.5, 0.5, 1], [1.5, -0.8, 0, 0.7, 0.7, 1]];
for (const [px, py, pz, sx, sy, sz] of quads) {
  world.spawn(
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
    { component: Transform, data: { pos: [px, py, pz], scale: [sx, sy, sz]} },
  );
}
world.spawn({ component: DirectionalLight, data: { direction: [-0.1, -0.6, -1], color: [1, 1, 1], intensity: 3 } });
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3]} },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }), clearColor: [0.02, 0.02, 0.05, 1] } },
);

const start = performance.now();
let frames = 0;
while (true) {
  world.update().unwrap();
  renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
  frames++;
  if (performance.now() - start >= SMOKE_DURATION_MS) break;
  await delay(0);
}
console.log(`[parity] Leg B: frames=${frames} rhiErrors=${rhiErrors.length}`);

if (frames <= 0) {
  console.error('[parity] FAIL - Leg B produced 0 frames (block-upload path did not run)');
  process.exit(1);
}
if (rhiErrors.length > 0) {
  console.error(`[parity] FAIL - Leg B raised ${rhiErrors.length} RhiError(s) during block upload:`);
  for (const e of rhiErrors) console.error(`  ${e?.code ?? e}`);
  process.exit(1);
}
console.log(`[parity] Leg B PASS - real block upload (${blockFormat}) drove ${frames} frames with no RhiError.`);
console.log(`[parity] PASS - Leg A (codec pixel parity) + Leg B (GPU block-upload liveness) both green.`);
