#!/usr/bin/env node
// RectAreaLight sourceTexture Dawn witness. One renderer and one World cycle
// through four phases: uniform -> textured -> mirrored -> uniform. Each phase
// reads the real presentation target back and checks colour ROIs:
//   - textured: the floor under the red half is redder than the floor under
//     the green half (u follows the light's local +X);
//   - mirrored: the asymmetry flips sign with the same magnitude
//     (orientation falsifier);
//   - uniform after textured: matches the first uniform phase within epsilon
//     (no stale light-texture slice survives removal of the source).
// Then every gallery image (one per accepted storage format, 128x64 to
// 1024x512) renders once: each must be accepted, lit, continuous on the floor
// and distinct from uniform and from every other image.
// When the adapter has texture-compression-bc, two gallery images are also
// encoded as UASTC KTX2 with offline mips and transcoded to BC7 (the runtime
// KTX2 path), then rendered through the GPU resample: each must match the
// uncompressed render of the same image within BC7_EPSILON, and a source
// switch must resample exactly once while steady frames reuse the slice.
// SMOKE_ARTIFACT_DIR=<dir> writes one PNG per phase for visual review.
// SMOKE_PERF_ROUNDS=<n> additionally alternates warmed uniform/textured blocks
// and reports median GPU-complete frame time (diagnostic; never gated).
// SMOKE_SIZE=<w>x<h> overrides the 256x160 target.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { createGalleryTextures } from '../src/images.ts';
import {
  FLOOR_PROBES,
  GALLERY_IMAGES,
  populateRectLightTextureWorld,
  projectToPixel,
} from '../src/scene.ts';

const here = dirname(fileURLToPath(import.meta.url));
const [WIDTH, HEIGHT] = (process.env.SMOKE_SIZE ?? '256x160').split('x').map(Number);
const PHASES = ['uniform', 'textured', 'mirrored', 'uniform'];
const FRAMES_PER_PHASE = Math.max(16, Math.ceil(smokeFrameBudget() / PHASES.length));
const FRAMES_PER_GALLERY_IMAGE = 8;
const MIN_GALLERY_DIFF = 0.004;
const MIN_GALLERY_FLOOR_SHIFT = 0.02;
const MIN_ASYMMETRY = Number.parseFloat(process.env.SMOKE_MIN_ASYMMETRY ?? '0.15');
const REVERT_EPSILON = Number.parseFloat(process.env.SMOKE_PIXEL_EPSILON ?? '0.05');
const MAX_FLOOR_STEP = Number.parseFloat(process.env.SMOKE_MAX_FLOOR_STEP ?? '0.05');
const ARTIFACT_DIR = process.env.SMOKE_ARTIFACT_DIR;
const PERF_ROUNDS = Number.parseInt(process.env.SMOKE_PERF_ROUNDS ?? '0', 10);
const PERF_FRAMES_PER_BLOCK = 20;
const BC7_IMAGES = ['neon', 'stained-glass'];
const BC7_EPSILON = Number.parseFloat(process.env.SMOKE_BC7_EPSILON ?? '0.01');

const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  originalConsoleError(...args);
};

function fail(message) {
  originalConsoleError(`[rect-light-texture] FAIL - ${message}`);
  process.exit(1);
}

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (err) {
  fail(`dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (opts) => {
  const adapter = await originalRequestAdapter(opts);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    sharedDevice ??= dev;
    return dev;
  };
  return adapter;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  renderTarget ??= device.createTexture({
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
        if (!sharedDevice) throw new Error('no shared device captured');
        return ensureRenderTarget(sharedDevice, 'rgba8unorm');
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { DEFAULT_STANDARD_PROFILE } = await import('@forgeax/engine-render');

const manifest = readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8');
const constructed = await constructRuntimeRendererHost(
  mockCanvas,
  { standardProfile: DEFAULT_STANDARD_PROFILE },
  { shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}` },
).catch((err) => fail(`renderer host threw: ${err instanceof Error ? err.message : String(err)}`));
gpu.requestAdapter = originalRequestAdapter;
if (!constructed.ok) fail(`renderer host: ${constructed.error.code} - ${constructed.error.hint}`);
const renderer = constructed.value.renderer;

// Each GPU resample decodes its source through one transient texture with
// this label; counting them proves when the light-texture slice is rebuilt.
let resampleDispatches = 0;
const originalCreateTexture = sharedDevice.createTexture.bind(sharedDevice);
sharedDevice.createTexture = (descriptor) => {
  if (descriptor.label === 'light-texture-resample-source') resampleDispatches++;
  return originalCreateTexture(descriptor);
};

/** The production KTX2 path: UASTC encode with offline mips, then BC7 transcode. */
async function encodeBc7(image) {
  const { parseKtx2, transcodeKtx2 } = await import('@forgeax/engine-codec');
  const { basisEncode } = await import('@forgeax/engine-codec/encode');
  const { display } = createGalleryTextures(image);
  const { width, height } = display.shape.extent;
  const encoded = await basisEncode(display.data, {
    mode: 'uastc-ldr',
    width,
    height,
    srgb: true,
    perceptual: true,
    uastcSupercompression: false,
    mipGen: true,
  });
  if (!encoded.ok) fail(`basis encode ${image}: ${encoded.error.code}`);
  const parsed = await parseKtx2(encoded.value);
  if (!parsed.ok) fail(`ktx2 parse ${image}: ${parsed.error.code}`);
  const transcoded = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm-srgb');
  if (!transcoded.ok) fail(`ktx2 transcode ${image}: ${transcoded.error.code}`);
  const data = new Uint8Array(transcoded.value.mips.reduce((size, mip) => size + mip.data.length, 0));
  let offset = 0;
  for (const mip of transcoded.value.mips) {
    data.set(mip.data, offset);
    offset += mip.data.length;
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'bc7-rgba-unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'packed', levelCount: transcoded.value.mips.length },
    data,
  };
}

const bcSupported = sharedDevice.features.has('texture-compression-bc');
const compressed = new Map();
if (bcSupported) {
  for (const image of BC7_IMAGES) compressed.set(`${image}.bc7`, await encodeBc7(image));
}

const world = new World();
const attached = renderer.attach(world);
if (!attached.ok) fail(`renderer.attach: ${attached.error.code} - ${attached.error.hint}`);
const lease = attached.value;
const scene = populateRectLightTextureWorld(world, WIDTH / HEIGHT, 'uniform', compressed);

const renderErrors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') renderErrors.push({ code: event.error.code, hint: event.error.hint });
});

async function readback() {
  const device = sharedDevice;
  await device.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return pixels;
}

function roiMean(pixels, point) {
  const [cx, cy] = projectToPixel(point, WIDTH, HEIGHT);
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = cy - 3; y <= cy + 3; y++) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      const offset = (y * WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += pixels[offset + c] / 255;
      count++;
    }
  }
  return sum.map((value) => value / Math.max(count, 1));
}

// Largest per-channel step between neighbouring pixels along two floor lines
// running away from the camera between the spheres. Diffuse light-texture
// filtering must stay continuous; a mip-dependent UV clamp once drew a ring.
function floorStep(pixels) {
  let largest = 0;
  for (const x of [-0.6, 0.6]) {
    let previous;
    for (let i = 0; i <= 4 * HEIGHT; i++) {
      const z = -1.2 + (3.7 * i) / (4 * HEIGHT);
      const [px, py] = projectToPixel([x, 0, z], WIDTH, HEIGHT);
      if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) continue;
      const offset = (py * WIDTH + px) * 4;
      if (previous !== undefined && previous !== offset) {
        for (let c = 0; c < 3; c++) {
          largest = Math.max(largest, Math.abs(pixels[offset + c] - pixels[previous + c]) / 255);
        }
      }
      previous = offset;
    }
  }
  return largest;
}

function meanAbsDiff(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) total += Math.abs(a[i + c] - b[i + c]);
  }
  return total / ((a.length / 4) * 3 * 255);
}

const round = (values) => values.map((value) => Number(value.toFixed(4)));
const results = [];
let totalFrames = 0;
let latestReceipt;
async function renderPhase(index, source, frames) {
  scene.setSource(source);
  const dispatchesBefore = resampleDispatches;
  let started = performance.now();
  let firstFrameMs = 0;
  let firstFrameDispatches = 0;
  for (let frame = 0; frame < frames; frame++) {
    world.update().unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) fail(`phase ${source} frame ${frame}: ${drawn.error.code} - ${drawn.error.hint}`);
    latestReceipt = drawn.value;
    totalFrames++;
    if (frame === 0) {
      // The switch frame carries any slice rebuild; steady frames follow.
      await sharedDevice.queue.onSubmittedWorkDone();
      firstFrameMs = performance.now() - started;
      firstFrameDispatches = resampleDispatches - dispatchesBefore;
      started = performance.now();
    }
    if (frame % 16 === 15) await delay(1);
  }
  await sharedDevice.queue.onSubmittedWorkDone();
  const msPerFrame = (performance.now() - started) / Math.max(frames - 1, 1);
  const dispatches = { first: firstFrameDispatches, steady: resampleDispatches - dispatchesBefore - firstFrameDispatches };
  const pixels = await readback();
  const left = roiMean(pixels, FLOOR_PROBES.left);
  const right = roiMean(pixels, FLOOR_PROBES.right);
  const lighting = renderer.inspect().extendedLighting;
  console.log(
    `[rect-light-texture] phase=${index}:${source} firstFrameMs=${firstFrameMs.toFixed(2)} ms/frame=${msPerFrame.toFixed(2)} ` +
      `gpuResample=${JSON.stringify(dispatches)} ` +
      `left=${JSON.stringify(round(left))} right=${JSON.stringify(round(right))} ` +
      `lightTextureUploadBytes=${lighting.uploadBytes} accepted=${lighting.accepted}`,
  );
  if (ARTIFACT_DIR !== undefined) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(resolve(ARTIFACT_DIR, `phase-${index}-${source}.png`), writeReferencePng(pixels, WIDTH, HEIGHT));
  }
  return { index, source, msPerFrame, firstFrameMs, dispatches, pixels, left, right, lighting };
}

for (const [index, source] of PHASES.entries()) {
  results.push(await renderPhase(index, source, FRAMES_PER_PHASE));
}
const gallery = [];
for (const [offset, image] of GALLERY_IMAGES.entries()) {
  gallery.push(await renderPhase(PHASES.length + offset, image, FRAMES_PER_GALLERY_IMAGE));
}
const blockCompressed = [];
for (const [offset, source] of [...compressed.keys()].entries()) {
  blockCompressed.push(
    await renderPhase(PHASES.length + GALLERY_IMAGES.length + offset, source, FRAMES_PER_GALLERY_IMAGE),
  );
}

async function drawBlock(frames) {
  for (let frame = 0; frame < frames; frame++) {
    world.update().unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) fail(`perf frame ${frame}: ${drawn.error.code} - ${drawn.error.hint}`);
    latestReceipt = drawn.value;
    totalFrames++;
  }
  await sharedDevice.queue.onSubmittedWorkDone();
}

if (PERF_ROUNDS > 0) {
  scene.setSource('uniform');
  const samples = { uniform: [], textured: [] };
  const passSamples = { uniform: new Map(), textured: new Map() };
  let timingStatus = 'unobserved';
  for (let round = 0; round < PERF_ROUNDS; round++) {
    const order = round % 2 === 0 ? ['uniform', 'textured'] : ['textured', 'uniform'];
    for (const source of order) {
      scene.setSource(source, false);
      await drawBlock(4);
      const started = performance.now();
      await drawBlock(PERF_FRAMES_PER_BLOCK);
      samples[source].push((performance.now() - started) / PERF_FRAMES_PER_BLOCK);
      const timed = await renderer.observe(latestReceipt, { include: ['timings'] });
      const timings = timed.ok ? timed.value.timings : undefined;
      timingStatus = timings?.status ?? 'absent';
      if (timings?.status === 'complete' || timings?.status === 'partial') {
        for (const pass of timings.frame.passes) {
          if (pass.status !== 'measured') continue;
          const list = passSamples[source].get(pass.passName) ?? [];
          list.push(pass.durationNanoseconds / 1e6);
          passSamples[source].set(pass.passName, list);
        }
      }
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const uniformMs = median(samples.uniform);
  const texturedMs = median(samples.textured);
  console.log(
    `[rect-light-texture] perf ${WIDTH}x${HEIGHT} rounds=${PERF_ROUNDS} median ms/frame ` +
      `uniform=${uniformMs.toFixed(3)} textured=${texturedMs.toFixed(3)} ` +
      `delta=${((texturedMs / uniformMs - 1) * 100).toFixed(2)}% gpuTimings=${timingStatus}`,
  );
  for (const [pass, values] of passSamples.uniform) {
    const textured = passSamples.textured.get(pass);
    if (textured === undefined) continue;
    const u = median(values);
    const t = median(textured);
    if (u < 0.05 && t < 0.05) continue;
    console.log(`[rect-light-texture] perf pass ${pass}: uniform=${u.toFixed(3)}ms textured=${t.toFixed(3)}ms`);
  }
}

const observed = await renderer.observe(latestReceipt, { include: ['timings', 'draws'] });
if (!observed.ok) fail(`receipt observation: ${observed.error.code} - ${observed.error.hint}`);

const failures = [];
const [uniform, textured, mirrored, reverted] = results;
// log(r/g) under the left half minus log(r/g) under the right half: positive
// when the left floor is redder. Tonemapping is monotonic, so the sign and the
// mirror symmetry survive the output transform.
const asymmetry = (phase) =>
  Math.log(phase.left[0] / Math.max(phase.left[1], 1e-4)) -
  Math.log(phase.right[0] / Math.max(phase.right[1], 1e-4));
const lit = (rgb) => rgb[0] + rgb[1] + rgb[2] > 0.15;
for (const phase of results) {
  if (!lit(phase.left) || !lit(phase.right)) failures.push(`phase ${phase.index}:${phase.source} floor probes are unlit`);
  if (phase.lighting.failure !== undefined) failures.push(`extendedLighting failure ${phase.lighting.failure}`);
}
const [uniformAsym, texturedAsym, mirroredAsym] = [uniform, textured, mirrored].map(asymmetry);
if (Math.abs(uniformAsym) > 0.05) failures.push(`uniform asymmetry ${uniformAsym.toFixed(3)} is not balanced`);
if (texturedAsym < MIN_ASYMMETRY) failures.push(`textured asymmetry ${texturedAsym.toFixed(3)} < ${MIN_ASYMMETRY}`);
if (mirroredAsym > -MIN_ASYMMETRY) failures.push(`mirrored asymmetry ${mirroredAsym.toFixed(3)} > -${MIN_ASYMMETRY}`);
if (Math.abs(texturedAsym + mirroredAsym) > 0.05) {
  failures.push(`mirror is not symmetric: textured ${texturedAsym.toFixed(3)} vs mirrored ${mirroredAsym.toFixed(3)}`);
}
if (meanAbsDiff(textured.pixels, uniform.pixels) < 0.01) failures.push('textured phase is indistinguishable from uniform');
const steps = [uniform, textured, mirrored].map((phase) => floorStep(phase.pixels));
for (const [i, step] of steps.entries()) {
  if (step > MAX_FLOOR_STEP) failures.push(`phase ${i} floor step ${step.toFixed(3)} > ${MAX_FLOOR_STEP} (lighting discontinuity)`);
}
for (const [i, phase] of gallery.entries()) {
  const label = `gallery ${phase.source}`;
  if (!lit(phase.left) || !lit(phase.right)) failures.push(`${label} floor probes are unlit`);
  if (phase.lighting.failure !== undefined) failures.push(`${label} extendedLighting failure ${phase.lighting.failure}`);
  const step = floorStep(phase.pixels);
  if (step > MAX_FLOOR_STEP) failures.push(`${label} floor step ${step.toFixed(3)} > ${MAX_FLOOR_STEP}`);
  // The floor probes only change if the light itself took the image; the
  // emitter quad alone (a rejected source) leaves them at the uniform value.
  const floorShift = Math.max(
    ...[0, 1, 2].map((c) => Math.abs(phase.left[c] - uniform.left[c]) + Math.abs(phase.right[c] - uniform.right[c])),
  );
  if (floorShift < MIN_GALLERY_FLOOR_SHIFT) {
    failures.push(`${label} floor shift ${floorShift.toFixed(4)} < ${MIN_GALLERY_FLOOR_SHIFT}: the light ignored its image`);
  }
  for (const other of gallery.slice(i + 1)) {
    if (meanAbsDiff(phase.pixels, other.pixels) < MIN_GALLERY_DIFF) {
      failures.push(`${label} is indistinguishable from ${other.source} (stale or shared slice)`);
    }
  }
}
for (const phase of [...results, ...gallery]) {
  if (phase.dispatches.first + phase.dispatches.steady !== 0) {
    failures.push(`${phase.source} is uncompressed but ran ${JSON.stringify(phase.dispatches)} GPU resamples`);
  }
}
const bc7Report = [];
for (const phase of blockCompressed) {
  const label = `bc7 ${phase.source}`;
  const image = phase.source.slice(0, -'.bc7'.length);
  const reference = gallery.find((entry) => entry.source === image);
  if (reference === undefined) {
    failures.push(`${label} has no uncompressed gallery reference`);
    continue;
  }
  if (!lit(phase.left) || !lit(phase.right)) failures.push(`${label} floor probes are unlit`);
  if (phase.lighting.failure !== undefined) failures.push(`${label} extendedLighting failure ${phase.lighting.failure}`);
  // One resample on the switch frame, none while the source stays bound.
  if (phase.dispatches.first !== 1 || phase.dispatches.steady !== 0) {
    failures.push(`${label} GPU resamples ${JSON.stringify(phase.dispatches)}, expected {"first":1,"steady":0}`);
  }
  const vsReference = meanAbsDiff(phase.pixels, reference.pixels);
  const vsUniform = meanAbsDiff(phase.pixels, uniform.pixels);
  if (vsReference > BC7_EPSILON) {
    failures.push(`${label} differs from the uncompressed ${image} by ${vsReference.toFixed(4)} > ${BC7_EPSILON}`);
  }
  if (vsUniform < MIN_GALLERY_DIFF) failures.push(`${label} is indistinguishable from uniform (light ignored its image)`);
  const step = floorStep(phase.pixels);
  if (step > MAX_FLOOR_STEP) failures.push(`${label} floor step ${step.toFixed(3)} > ${MAX_FLOOR_STEP}`);
  bc7Report.push({
    source: phase.source,
    vsUncompressed: Number(vsReference.toFixed(5)),
    vsUniform: Number(vsUniform.toFixed(4)),
    switchFrameMs: Number(phase.firstFrameMs.toFixed(2)),
    uncompressedSwitchFrameMs: Number(reference.firstFrameMs.toFixed(2)),
    steadyMs: Number(phase.msPerFrame.toFixed(2)),
    uncompressedSteadyMs: Number(reference.msPerFrame.toFixed(2)),
  });
}
if (!bcSupported) console.log('[rect-light-texture] bc7 phases skipped: adapter lacks texture-compression-bc');
else if (blockCompressed.length !== BC7_IMAGES.length) failures.push('bc7 phases did not all render');
const revertDiff = meanAbsDiff(reverted.pixels, uniform.pixels);
if (revertDiff > REVERT_EPSILON) failures.push(`reverted uniform differs from first uniform by ${revertDiff.toFixed(4)} > ${REVERT_EPSILON}`);
if (renderErrors.length > 0) failures.push(`renderer errors: ${JSON.stringify(renderErrors.slice(0, 4))}`);
if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);

console.log(
  `[rect-light-texture] asymmetry uniform=${uniformAsym.toFixed(3)} textured=${texturedAsym.toFixed(3)} ` +
    `mirrored=${mirroredAsym.toFixed(3)} revertDiff=${revertDiff.toFixed(5)} ` +
    `floorStep=${JSON.stringify(steps.map((step) => Number(step.toFixed(3))))} ` +
    `textured/uniform ms ratio=${(textured.msPerFrame / uniform.msPerFrame).toFixed(3)} ` +
    `gallery=${JSON.stringify(gallery.map((phase) => [phase.source, Number(meanAbsDiff(phase.pixels, uniform.pixels).toFixed(4)), Number(floorStep(phase.pixels).toFixed(3))]))} ` +
    `bc7=${JSON.stringify(bc7Report)} frames=${totalFrames}`,
);

lease.dispose();
await renderer.dispose();
if (failures.length > 0) {
  for (const failure of failures) originalConsoleError(`[rect-light-texture] FAIL - ${failure}`);
  sharedDevice?.destroy?.();
  process.exit(1);
}
emitSmokeReceipt('hello-rect-light-texture/smoke', totalFrames);
console.log('[rect-light-texture] PASS');
sharedDevice?.destroy?.();
process.exit(0);
