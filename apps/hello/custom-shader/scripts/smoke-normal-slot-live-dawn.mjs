#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const WIDTH = 200;
const HEIGHT = 150;
const RESIZED_WIDTH = 256;
const RESIZED_HEIGHT = 192;
const BYTES_PER_PIXEL = 4;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = resolve(APP_ROOT, 'assets', 'pulse-material.pack.json');
const MANIFEST_PATH = resolve(APP_ROOT, 'dist', 'shaders', 'manifest.json');
const RECOOK_SCRIPT = resolve(APP_ROOT, 'scripts', 'recook-material-pack.mjs');
const ARTIFACT_DIR = process.env.FORGEAX_MATERIAL_ARTIFACT_DIR;
if (ARTIFACT_DIR !== undefined) mkdirSync(ARTIFACT_DIR, { recursive: true });
const require = createRequire(resolve(APP_ROOT, 'package.json'));
const { PNG } = require('pngjs');
const execFileAsync = promisify(execFile);
const m36Mode = process.env.FORGEAX_MATERIAL_M36 === '1';
const resizeVariant = process.env.FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT;
const twoSlotResizeVariant = process.env.FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT;
const twoSlotResizeRebuild = twoSlotResizeVariant === 'normal' || twoSlotResizeVariant === 'swap';
const twoSlotSwap = twoSlotResizeVariant === 'swap';
const inheritanceLive = process.env.FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND === '1';
const inheritanceFalsify = process.env.FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND === '1';
const resizeRebuild = twoSlotResizeRebuild || resizeVariant === 'normal' || resizeVariant === 'swap';
const liveSwap =
  !m36Mode &&
  (twoSlotSwap || resizeVariant === 'swap' || (!resizeRebuild && twoSlotResizeVariant === undefined));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function materialFromRecord(record, baseColorHandle, normalHandle) {
  return {
    kind: 'material',
    passes: [...record.resolved.passes],
    parameters: record.resolved.parameters,
    values: {
      ...record.resolved.values,
      baseColorTexture: {
        texture: baseColorHandle,
        coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1] } },
      },
      normalTexture: {
        texture: normalHandle,
        coordinates: { set: 1, transform: { offset: [0.125, 0.25], scale: [2, 2] } },
      },
    },
  };
}

function bytesPerRow(width) {
  return Math.ceil((width * BYTES_PER_PIXEL) / 256) * 256;
}

function compactReadback(bytes, width, height) {
  const packed = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  const rowBytes = bytesPerRow(width);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * rowBytes;
    const targetStart = y * width * BYTES_PER_PIXEL;
    Buffer.from(bytes).copy(packed, targetStart, sourceStart, sourceStart + width * BYTES_PER_PIXEL);
  }
  return packed;
}

function writePng(path, rgba, width, height) {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

function compareRgba(before, after, width, height) {
  assert(before.length === after.length, 'Dawn readbacks must have matching dimensions');
  let changedPixels = 0;
  let absoluteRgbDelta = 0;
  for (let index = 0; index < before.length; index += 4) {
    const redDelta = Math.abs(before[index] - after[index]);
    const greenDelta = Math.abs(before[index + 1] - after[index + 1]);
    const blueDelta = Math.abs(before[index + 2] - after[index + 2]);
    if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels += 1;
    absoluteRgbDelta += redDelta + greenDelta + blueDelta;
  }
  return {
    changedPixels,
    changedFraction: changedPixels / (width * height),
    meanRgbDelta: absoluteRgbDelta / (width * height * 3 * 255),
  };
}

function compareRgbaRegion(before, after, width, height, left, right) {
  let changedPixels = 0;
  let absoluteRgbDelta = 0;
  const regionWidth = right - left;
  for (let y = 0; y < height; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      const redDelta = Math.abs(before[index] - after[index]);
      const greenDelta = Math.abs(before[index + 1] - after[index + 1]);
      const blueDelta = Math.abs(before[index + 2] - after[index + 2]);
      if (redDelta !== 0 || greenDelta !== 0 || blueDelta !== 0) changedPixels += 1;
      absoluteRgbDelta += redDelta + greenDelta + blueDelta;
    }
  }
  const pixels = regionWidth * height;
  return {
    changedPixels,
    changedFraction: changedPixels / pixels,
    meanRgbDelta: absoluteRgbDelta / (pixels * 3 * 255),
  };
}

const originalFixture = readFileSync(FIXTURE_PATH);
process.once('exit', () => writeFileSync(FIXTURE_PATH, originalFixture));
const fixture = JSON.parse(originalFixture);
let cookedByGuid = new Map(
  fixture.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
);
const { createMaterialLoader, MaterialGenerationCache } =
  await import('@forgeax/engine-assets-runtime');
const loader = createMaterialLoader({
  loadPublication: async (guid) => {
    const record = cookedByGuid.get(guid.toLowerCase());
    if (record === undefined) return undefined;
    return {
      guid,
      record,
      artifacts: Object.fromEntries(
        record.programs.map(({ artifact }) => [
          artifact.path,
          { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
        ]),
      ),
    };
  },
  loadReference: async () => true,
});
const materialCache = new MaterialGenerationCache();
const materialDependencies = ['my-game::pulse-material', 'pack:pulse-material'];
let destabilizeMaterialLoad = false;
let lastMaterialGeneration;
const loadCachedMaterial = (guid) =>
  materialCache.resolve(guid, 'my-game::pulse-material', () =>
    materialCache.loadWithGeneration(guid, materialDependencies, async (generation) => {
      lastMaterialGeneration = generation;
      const record = cookedByGuid.get(guid.toLowerCase());
      assert(record !== undefined, `cooked material ${guid} is absent`);
      const loaded = await loader.load({ guid, specializationKey: record.specializationKey });
      assert(loaded.status === 'Ready', `material ${guid} is not runtime-ready`);
      if (destabilizeMaterialLoad) materialCache.bump(materialDependencies[0]);
      return { generation, value: loaded };
    }),
  );
const rootResult = await loadCachedMaterial('01935b00-7d8c-7c4e-9f12-345678abcd02');
const derivedResult = await loadCachedMaterial('01935b00-7d8c-7c4e-9f12-345678abcd03');
assert(rootResult.ok && derivedResult.ok, 'inheritance material generations are not runtime-ready');
const root = rootResult.value;
const derived = derivedResult.value;
assert(root.record.artifactDigest === derived.record.artifactDigest, 'root and derived cooked program sets differ');
assert(root.record.receipt.identity.cookIdentity === derived.record.receipt.identity.cookIdentity, 'inheritance specialization inputs differ');
assert(root.record.receipt.identity.layoutIdentity === derived.record.receipt.identity.layoutIdentity, 'inheritance material layouts differ');
assert(root.record.receipt.identity.programIdentity === derived.record.receipt.identity.programIdentity, 'inheritance material programs differ');
assert(root.record.receipt.identity.pipelineIdentity === derived.record.receipt.identity.pipelineIdentity, 'inheritance material pipelines differ');
assert(root.record.receipt.identity.materialPublicationIdentity !== derived.record.receipt.identity.materialPublicationIdentity, 'inheritance publication identities did not capture the child override');
assert(JSON.stringify(derived.record.resolved.values.baseColor) === JSON.stringify([0.2, 0.55, 0.95, 1]), 'inheritance derived value override is missing');
assert(JSON.stringify(root.record.resolved.values.baseColor) !== JSON.stringify(derived.record.resolved.values.baseColor), 'inheritance derived value override did not diverge from root');

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (adapter === null) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
let renderTargetWidth = 0;
let renderTargetHeight = 0;
function ensureRenderTarget(device, format) {
  if (renderTarget !== undefined && (renderTargetWidth !== mockCanvas.width || renderTargetHeight !== mockCanvas.height)) {
    renderTarget.destroy();
    renderTarget = undefined;
  }
  renderTarget ??= device.createTexture({
    size: { width: mockCanvas.width, height: mockCanvas.height, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x04 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  renderTargetWidth = mockCanvas.width;
  renderTargetHeight = mockCanvas.height;
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
        assert(sharedDevice !== undefined, 'engine requested canvas texture before Dawn device capture');
        return ensureRenderTarget(sharedDevice, 'rgba8unorm');
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } =
  await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');

const manifest = `data:application/json,${encodeURIComponent(readFileSync(MANIFEST_PATH, 'utf8'))}`;
const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifest });
assert(constructed.ok, constructed.ok ? undefined : `${constructed.error.code}: ${constructed.error.hint}`);
const renderer = constructed.value.renderer;
renderer.subscribe((event) => { if (event.kind === 'error') console.error(`[normal-slot-live] renderer error: ${JSON.stringify(event.error)}`); });
assert(renderer.inspect().capabilities.backendKind === 'webgpu', `unexpected backend: ${renderer.inspect().capabilities.backendKind}`);

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const baseColorTexturePayload = {
  kind: 'texture', shape: { viewDimension: '2d', extent: { width: 2, height: 2 } }, format: 'rgba8unorm-srgb',
  data: new Uint8Array([255, 96, 32, 255, 32, 96, 255, 255, 32, 96, 255, 255, 255, 96, 32, 255]),
  colorSpace: 'srgb', mips: { kind: 'none' },
};
const normalTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([32, 224, 32, 255, 224, 32, 32, 255, 224, 32, 32, 255, 32, 224, 32, 255]),
};
const liveSwapBaseColorTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([32, 224, 224, 255, 224, 224, 32, 255, 224, 224, 32, 255, 32, 224, 224, 255]),
};
const liveSwapNormalTexturePayload = {
  ...baseColorTexturePayload,
  data: new Uint8Array([224, 32, 224, 255, 32, 32, 224, 255, 32, 32, 224, 255, 224, 32, 224, 255]),
};
const baseColorHandle = world.allocSharedRef('TextureAsset', baseColorTexturePayload);
const normalHandle = world.allocSharedRef('TextureAsset', normalTexturePayload);
const liveSwapBaseColorHandle = world.allocSharedRef('TextureAsset', liveSwapBaseColorTexturePayload);
const liveSwapNormalHandle = world.allocSharedRef('TextureAsset', liveSwapNormalTexturePayload);
const normalMaterial = materialFromRecord(derived.record, baseColorHandle, normalHandle);
const swapMaterial = materialFromRecord(
  derived.record,
  inheritanceLive
    ? inheritanceFalsify
      ? baseColorHandle
      : liveSwapBaseColorHandle
    : twoSlotSwap
      ? liveSwapBaseColorHandle
      : baseColorHandle,
  inheritanceLive
    ? inheritanceFalsify
      ? normalHandle
      : liveSwapNormalHandle
    : liveSwap
      ? liveSwapNormalHandle
      : normalHandle,
);
const normalMaterialHandle = world.allocSharedRef('MaterialAsset', normalMaterial);
const swapMaterialHandle = world.allocSharedRef('MaterialAsset', swapMaterial);
const box = createBoxGeometry(1, 1, 1);
assert(box.ok, 'box geometry creation failed');
const boxHandle = world.allocSharedRef('MeshAsset', box.value);
world.spawn(
  { component: Transform, data: { pos: [-0.9, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: boxHandle } },
  { component: MeshRenderer, data: { materials: [normalMaterialHandle] } },
).unwrap();
const entity = world.spawn(
  { component: Transform, data: { pos: [0.9, 0, 0] } },
  { component: MeshFilter, data: { assetHandle: boxHandle } },
  { component: MeshRenderer, data: { materials: [normalMaterialHandle] } },
).unwrap();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) },
).unwrap();
world.spawn({
  component: DirectionalLight,
  data: { direction: [-0.5, -1, -0.3], color: [1, 0.95, 0.9], intensity: 1 },
}).unwrap();

const materialValues = normalMaterial.values;
if (materialValues !== undefined) materialValues.time = 0;
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    errors.push(event.error.code);
    console.error(JSON.stringify(event.error));
  }
});

async function readback(label) {
  const width = mockCanvas.width;
  const height = mockCanvas.height;
  const rowBytes = bytesPerRow(width);
  const buffer = sharedDevice.createBuffer({ size: rowBytes * height, usage: 0x01 | 0x08 });
  const encoder = sharedDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow: rowBytes, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([encoder.finish()]);
  await sharedDevice.queue.onSubmittedWorkDone();
  await buffer.mapAsync(0x01);
  const rgba = compactReadback(buffer.getMappedRange(), width, height);
  buffer.unmap();
  buffer.destroy();
  const result = {
    label,
    sha256: createHash('sha256').update(rgba).digest('hex'),
    width,
    height,
    centerPixel: [...rgba.subarray(((height >> 1) * width + (width >> 1)) * 4, ((height >> 1) * width + (width >> 1)) * 4 + 4)],
  };
  if (ARTIFACT_DIR !== undefined) {
    writePng(resolve(ARTIFACT_DIR, `live-normal-slot-${label}.png`), rgba, width, height);
    writeFileSync(resolve(ARTIFACT_DIR, `live-normal-slot-${label}.rgba`), rgba);
    writeFileSync(
      resolve(ARTIFACT_DIR, `live-normal-slot-${label}.json`),
      `${JSON.stringify({ width, height, byteLength: rgba.length, sha256: result.sha256 })}\n`,
    );
  }
  return { ...result, rgba };
}

async function drawFrame(label) {
  world.update().unwrap();
  const result = renderer.draw({
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  });
  assert(result.ok, `${label} draw failed: ${result.ok ? '' : JSON.stringify(result.error)}`);
  await sharedDevice.queue.onSubmittedWorkDone();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Custom material PSOs are built through the renderer's lazy runtime cache.
// Warm the public draw path before taking the baseline so the evidence tests
// the live resource rebind rather than the first-frame pipeline compile.
for (let frame = 0; frame < 4; frame += 1) await drawFrame(`warmup-${frame}`);
const before = await readback('before');
let m36Evidence;
let m36Stale;
let m36StalePixels;
if (m36Mode) {
  materialCache.bump(materialDependencies[1]);
  destabilizeMaterialLoad = true;
  m36Stale = await loadCachedMaterial('01935b00-7d8c-7c4e-9f12-345678abcd03');
  destabilizeMaterialLoad = false;
  assert(!m36Stale.ok, 'Dawn stale cooked material was accepted');
  assert(
    m36Stale.error.code === 'material-specialization-stale-generation' &&
      m36Stale.error.detail.code === m36Stale.error.code,
    'Dawn stale generation code/detail changed',
  );
  assert(
    JSON.stringify(m36Stale.error.detail.observed) !==
      JSON.stringify(m36Stale.error.detail.current),
    'Dawn stale generation vectors were equal',
  );
  for (let frame = 0; frame < 4; frame += 1) await drawFrame(`stale-${frame}`);
  m36StalePixels = await readback('stale');

  const recook = await execFileAsync(process.execPath, [RECOOK_SCRIPT, '--write'], {
    cwd: resolve(APP_ROOT, '../../..'),
    env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (ARTIFACT_DIR !== undefined) {
    writeFileSync(resolve(ARTIFACT_DIR, 'm36-dawn-producer.log'), `${recook.stdout}${recook.stderr}`);
    writeFileSync(resolve(ARTIFACT_DIR, 'm36-dawn-recooked.pack.json'), readFileSync(FIXTURE_PATH));
  }
  const recooked = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  cookedByGuid = new Map(
    recooked.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
  );
  materialCache.bump(materialDependencies[1]);
  const fresh = await loadCachedMaterial('01935b00-7d8c-7c4e-9f12-345678abcd03');
  assert(fresh.ok, `Dawn fresh recook failed: ${fresh.ok ? '' : fresh.error.code}`);
  assert(fresh.value.record.artifactDigest !== derived.record.artifactDigest, 'Dawn recook kept the stale digest');
  assert(materialCache.generationError('01935b00-7d8c-7c4e-9f12-345678abcd03') === undefined, 'Dawn stale diagnostic survived recook');
  const freshMaterialHandle = world.allocSharedRef(
    'MaterialAsset',
    materialFromRecord(fresh.value.record, baseColorHandle, normalHandle),
  );
  const freshMutation = world.set(entity, MeshRenderer, { materials: [freshMaterialHandle] });
  assert(freshMutation.ok, `Dawn fresh material publication failed: ${freshMutation.ok ? '' : freshMutation.error.code}`);
  const allocationRelease = world.sharedRefs.release(freshMaterialHandle);
  assert(allocationRelease.ok, 'Dawn fresh material allocation was not released');
  for (let frame = 0; frame < 4; frame += 1) await drawFrame(`fresh-${frame}`);
  m36Evidence = {
    stale: {
      code: m36Stale.error.code,
      detail: m36Stale.error.detail,
      published: false,
      artifactDigest: derived.record.artifactDigest,
    },
    fresh: {
      artifactDigest: fresh.value.record.artifactDigest,
      inputDigest: fresh.value.record.receipt.identity.cookIdentity,
      generation: lastMaterialGeneration,
      allocationRelease: { ok: allocationRelease.ok },
      materialRefcount: world.sharedRefs.refcount(freshMaterialHandle),
    },
    stalePixels: {
      sha256: m36StalePixels.sha256,
      centerPixel: m36StalePixels.centerPixel,
    },
  };
} else {
  const mutation = liveSwap ? world.set(entity, MeshRenderer, { materials: [swapMaterialHandle] }) : { ok: true };
  assert(mutation.ok, `live material rebind failed: ${mutation.ok ? '' : mutation.error.code}`);
}
for (let frame = 0; frame < 4; frame += 1) await drawFrame(`pre-resize-${frame}`);
const beforeResize = m36Mode ? before : await readback('before-resize');
if (resizeRebuild) {
  mockCanvas.width = RESIZED_WIDTH;
  mockCanvas.height = RESIZED_HEIGHT;
  for (let frame = 0; frame < 4; frame += 1) await drawFrame(`post-resize-${frame}`);
}
const after = await readback(resizeRebuild ? 'after-resize' : 'after');
const delta = resizeRebuild ? undefined : compareRgba(before.rgba, after.rgba, WIDTH, HEIGHT);
assert(!resizeRebuild || (after.width === RESIZED_WIDTH && after.height === RESIZED_HEIGHT), 'Dawn resize did not reach the requested drawing buffer');
if (delta !== undefined) {
  if (m36Mode) {
    // The M36 path compares the unchanged LKG and the fresh recook below.
  } else if (inheritanceFalsify) {
    assert(delta.changedPixels === 0 && delta.meanRgbDelta === 0, `inheritance falsifier unexpectedly changed rendered pixels: ${JSON.stringify(delta)}`);
  } else {
    assert(
      delta.changedPixels > 0 && delta.meanRgbDelta > 0.001,
      `normal-slot live rebind was not visually discriminative: ${JSON.stringify(delta)}`,
    );
  }
}
assert(errors.length === 0, `renderer errors: ${errors.join(',')}`);

if (m36Mode) {
  assert(m36StalePixels !== undefined, 'Dawn M36 stale readback is missing');
  const staleDelta = compareRgba(before.rgba, m36StalePixels.rgba, WIDTH, HEIGHT);
  const siblingDelta = compareRgbaRegion(
    before.rgba,
    after.rgba,
    WIDTH,
    HEIGHT,
    0,
    Math.floor(WIDTH / 2),
  );
  const freshDelta = compareRgba(before.rgba, after.rgba, WIDTH, HEIGHT);
  assert(staleDelta.changedPixels === 0, `Dawn LKG changed during stale refusal: ${JSON.stringify(staleDelta)}`);
  assert(siblingDelta.changedPixels === 0, `Dawn healthy sibling changed: ${JSON.stringify(siblingDelta)}`);
  assert(freshDelta.meanRgbDelta <= 0.01, `Dawn fresh recook left semantic pixel range: ${JSON.stringify(freshDelta)}`);
  console.log(JSON.stringify({
    status: 'pass',
    frontDoor: 'custom-shader Dawn same-World renderer recook',
    backend: renderer.inspect().capabilities.backendKind,
    stale: m36Evidence.stale,
    fresh: m36Evidence.fresh,
    before: { sha256: before.sha256, centerPixel: before.centerPixel },
    stalePixels: m36Evidence.stalePixels,
    after: { sha256: after.sha256, centerPixel: after.centerPixel },
    pixels: { staleDelta, siblingDelta, freshDelta },
    rendererErrors: errors,
  }));
  sharedDevice.destroy();
} else {
const afterBaseColorHandle = inheritanceLive
  ? inheritanceFalsify
    ? baseColorHandle
    : liveSwapBaseColorHandle
  : twoSlotSwap
    ? liveSwapBaseColorHandle
    : baseColorHandle;
const afterNormalHandle = inheritanceLive
  ? inheritanceFalsify
    ? normalHandle
    : liveSwapNormalHandle
  : liveSwap
    ? liveSwapNormalHandle
    : normalHandle;
if (inheritanceFalsify) {
  assert(afterBaseColorHandle === baseColorHandle && afterNormalHandle === normalHandle, 'inheritance falsifier unexpectedly changed replacement texture handles');
  throw new Error('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind');
}

const output = {
  status: 'pass',
  frontDoor: 'engine-renderer-world-draw',
  backend: renderer.inspect().capabilities.backendKind,
  frames: { before: 1, after: 1 },
  material: {
    beforeHandle: normalMaterialHandle,
    afterHandle: liveSwap ? swapMaterialHandle : normalMaterialHandle,
    beforeTextureHandles: [baseColorHandle, normalHandle],
    afterTextureHandles: [afterBaseColorHandle, afterNormalHandle],
    baseColorPreserved: inheritanceLive ? inheritanceFalsify : !twoSlotSwap,
    baseColorChanged: inheritanceLive ? !inheritanceFalsify : twoSlotSwap,
    normalSlotChanged: inheritanceLive ? !inheritanceFalsify : liveSwap,
    twoSlotSwap,
    inheritanceBacked: inheritanceLive,
    sourceDerivedGuid: derived.record.guid,
    sourceArtifactDigest: derived.record.artifactDigest,
    sourceCookInputDigest: derived.record.receipt.identity.cookIdentity,
  },
  before: { sha256: before.sha256, centerPixel: before.centerPixel },
  beforeResize: { sha256: beforeResize.sha256, centerPixel: beforeResize.centerPixel },
  after: { sha256: after.sha256, centerPixel: after.centerPixel, width: after.width, height: after.height },
  resize: { enabled: resizeRebuild, before: [WIDTH, HEIGHT], after: [after.width, after.height] },
  delta,
  rootArtifactDigest: root.record.artifactDigest,
  derivedArtifactDigest: derived.record.artifactDigest,
  rootCookInputDigest: root.record.receipt.identity.cookIdentity,
  derivedCookInputDigest: derived.record.receipt.identity.cookIdentity,
};
console.log(JSON.stringify(output));
sharedDevice.destroy();
}
