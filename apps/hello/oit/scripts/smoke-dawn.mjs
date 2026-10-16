#!/usr/bin/env node
// hello-oit dawn-node smoke: weighted blended OIT on a cyclic interpenetrating
// triple, with pixel readback against the WBOIT reference and a sorted falsifier.
//
//   1. constructRuntimeRendererHost over dawn-node with a mock canvas.
//   2. Spawn the scene from scripts/oit-scene.mjs (same World as src/main.ts).
//   3. Run the frame budget (default 60) in four phases:
//        OIT order A, OIT reversed order, sorted order A, sorted reversed order.
//      The last frame of each phase reads the linear-hdr observation.
//   4. Verdict:
//        (a) OIT probes match the WBOIT reference within eps (0.05);
//        (b) OIT probes agree across submission orders within 0.01;
//        (c) inspect() reports weighted-blended with 3 accumulated draws and the
//            oit-accumulate / oit-composite passes, and no OIT pass under sorted;
//        (d) FALSIFY: the sorted path differs by > 0.1 between orders at a
//            cyclic probe, so the probes observe order-dependent compositing;
//        (e) no renderer error events.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';

const SIZE = 128;
const EPSILON = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const ORDER_EPSILON = 0.01;
const FALSIFY_MIN_DELTA = 0.1;
const FRAMES = smokeFrameBudget();

const here = dirname(fileURLToPath(import.meta.url));

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
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let surface;
const mockCanvas = {
  width: SIZE,
  height: SIZE,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        surface?.destroy();
        surface = desc.device.createTexture({
          size: [SIZE, SIZE],
          format: desc.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [desc.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        return surface;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { constructRuntimeRendererHost } = await import(
  '@forgeax/engine-runtime/internal/renderer-host'
);
const { OIT_PROBES, probePixel, probeReference, spawnOitScene } = await import('./oit-scene.mjs');

const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const constructed = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl });
if (!constructed.ok) {
  console.error(`[smoke] FAIL - renderer construction: ${JSON.stringify(constructed.error)}`);
  process.exit(1);
}
const renderer = constructed.value.renderer;
const backend = renderer.inspect().capabilities.backendKind;
console.log(`[hello-oit] backend=${backend}`);

const world = new World();
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
const lease = attached.value;
const scene = spawnOitScene(world);
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') errors.push({ code: event.error.code, hint: event.error.hint });
});

function halfToFloat(bits) {
  const exponent = (bits >>> 10) & 31;
  const mantissa = bits & 1023;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return (
    sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
}

function readRgb(observation, px, py) {
  const { bytes, metadata } = observation;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const row = py * metadata.bytesPerRow;
  if (metadata.format === 'rgba16float')
    return [0, 1, 2].map((c) => halfToFloat(view.getUint16(row + px * 8 + c * 2, true)));
  return [0, 1, 2].map((c) => view.getUint8(row + px * 4 + c) / 255);
}

let framesObserved = 0;
async function drawFrame(sample) {
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  if (sample) {
    const requested = renderer.requestObservation?.(['linear-hdr']);
    if (requested !== undefined && !requested.ok) throw new Error(JSON.stringify(requested.error));
  }
  const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  if (!drawn.ok) throw new Error(`draw failed: ${JSON.stringify(drawn.error)}`);
  const completed = await drawn.value.completed;
  if (!completed.ok) throw new Error(`frame failed: ${JSON.stringify(completed.error)}`);
  framesObserved++;
  if (!sample) return undefined;
  const observed = await renderer.observe(drawn.value, { include: ['linear-hdr'] });
  if (!observed.ok) throw new Error(`observe failed: ${JSON.stringify(observed.error)}`);
  const observation = observed.value.observations?.find((entry) => entry.domain === 'linear-hdr');
  if (observation === undefined) throw new Error('missing linear-hdr observation');
  const inspection = renderer.inspect();
  return {
    probes: Object.fromEntries(
      OIT_PROBES.map((probe) => {
        const { px, py } = probePixel(probe, SIZE);
        return [probe.name, readRgb(observation, px, py)];
      }),
    ),
    transparency: inspection.transparency,
    passes: inspection.perFramePassNames,
  };
}

async function phase(frames) {
  let sample;
  for (let i = 0; i < frames; i++) sample = await drawFrame(i === frames - 1);
  return sample;
}

const oitFrames = Math.ceil(FRAMES / 3);
const sortedFrames = Math.ceil((FRAMES - 2 * oitFrames) / 2);
let oitA;
let oitB;
let sortedA;
let sortedB;
try {
  oitA = await phase(oitFrames);
  scene.spawnLayers([2, 1, 0]);
  oitB = await phase(oitFrames);
  scene.setTransparency('sorted');
  scene.spawnLayers([0, 1, 2]);
  sortedA = await phase(sortedFrames);
  scene.spawnLayers([2, 1, 0]);
  sortedB = await phase(sortedFrames);
} catch (err) {
  console.error(`[smoke] FAIL - ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  errors=${JSON.stringify(errors)}`);
  process.exit(1);
}
console.log(`[smoke] frames observed=${framesObserved}`);

const delta = (a, b, names) =>
  Math.max(
    ...names.flatMap((name) => a.probes[name].map((v, c) => Math.abs(v - b.probes[name][c]))),
  );
const reference = Object.fromEntries(
  OIT_PROBES.map((probe) => [probe.name, probeReference(probe, SIZE)]),
);
const referenceDelta = Math.max(
  ...OIT_PROBES.flatMap((probe) =>
    oitA.probes[probe.name].map((v, c) => Math.abs(v - reference[probe.name].weighted[c])),
  ),
);
const allNames = OIT_PROBES.map((probe) => probe.name);
const oitOrderDelta = delta(oitA, oitB, allNames);
const sortedOrderDelta = delta(sortedA, sortedB, ['left', 'right']);
console.log(
  `[smoke] pixelSamples=${JSON.stringify({ oitA: oitA.probes, oitB: oitB.probes, sortedA: sortedA.probes, sortedB: sortedB.probes })}`,
);
console.log(
  `[smoke] reference=${JSON.stringify(reference)} referenceDelta=${referenceDelta.toFixed(4)} oitOrderDelta=${oitOrderDelta.toFixed(4)} sortedOrderDelta=${sortedOrderDelta.toFixed(4)}`,
);
console.log(
  `[smoke] transparency=${JSON.stringify({ oit: oitA.transparency, sorted: sortedA.transparency })}`,
);

const failures = [];
if (backend !== 'webgpu') failures.push(`backend=${backend} (expected webgpu)`);
if (framesObserved < FRAMES) failures.push(`frames=${framesObserved} < ${FRAMES}`);
if (!(referenceDelta <= EPSILON))
  failures.push(`(a) OIT reference delta ${referenceDelta} > ${EPSILON}`);
if (!(oitOrderDelta <= ORDER_EPSILON))
  failures.push(`(b) OIT order delta ${oitOrderDelta} > ${ORDER_EPSILON}`);
for (const sample of [oitA, oitB]) {
  if (
    sample.transparency?.resolved !== 'weighted-blended' ||
    sample.transparency?.accumulatedDrawCount !== 3 ||
    sample.transparency?.sortedDrawCount !== 0 ||
    !sample.passes.includes('oit-accumulate') ||
    !sample.passes.includes('oit-composite') ||
    sample.passes.includes('transparent')
  )
    failures.push(
      `(c) OIT inspection ${JSON.stringify({ t: sample.transparency, passes: sample.passes })}`,
    );
}
for (const sample of [sortedA, sortedB]) {
  if (
    sample.transparency?.resolved !== 'sorted' ||
    sample.passes.includes('oit-accumulate') ||
    sample.passes.includes('oit-composite')
  )
    failures.push(
      `(c) sorted inspection ${JSON.stringify({ t: sample.transparency, passes: sample.passes })}`,
    );
}
if (!(sortedOrderDelta > FALSIFY_MIN_DELTA))
  failures.push(`(d) FALSIFY sorted order delta ${sortedOrderDelta} <= ${FALSIFY_MIN_DELTA}`);
if (errors.length > 0) failures.push(`(e) renderer errors ${JSON.stringify(errors)}`);

renderer.dispose();
surface?.destroy();
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `[smoke] PASS - OIT matches reference (max ${referenceDelta.toFixed(4)} <= ${EPSILON}), order independent (${oitOrderDelta.toFixed(4)}), sorted falsifier differs (${sortedOrderDelta.toFixed(4)} > ${FALSIFY_MIN_DELTA})`,
);
emitSmokeReceipt('hello-oit/smoke', framesObserved);
process.exit(0);
