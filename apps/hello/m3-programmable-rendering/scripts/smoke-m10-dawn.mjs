#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';

import { World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createRenderer } from '@forgeax/engine-runtime';
import { ok } from '@forgeax/engine-types';

const FRAME_COUNT = smokeFrameBudget();
const WIDTH = 64;
const HEIGHT = 64;
const COPY_SRC = 0x01;
const COPY_DST = 0x08;
const MAP_READ = 0x0001;
const RENDER_ATTACHMENT = 0x10;
const artifactDir = process.env.FORGEAX_M10_ARTIFACT_DIR ?? resolve(process.cwd(), '.forgeax-gauntlet', 'm10-render-feature');
mkdirSync(artifactDir, { recursive: true });

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });

const deviceRef = { value: undefined };
const targetRef = { value: undefined };
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        deviceRef.value = descriptor.device;
        targetRef.value = descriptor.device.createTexture({
          size: { width: WIDTH, height: HEIGHT },
          format: descriptor.format ?? 'rgba8unorm',
          usage: RENDER_ATTACHMENT | COPY_SRC,
          ...(descriptor.format === 'rgba8unorm' ? { viewFormats: ['rgba8unorm-srgb'] } : {}),
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (targetRef.value === undefined) throw new Error('M10 Dawn target is not configured');
        return targetRef.value;
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

function makeWorld() {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        clearColor: [0.18, 0.08, 0.03, 1],
      },
    },
  );
  return world;
}

function makeFeature(identity, state) {
  return {
    identity,
    extract: () => ok(undefined),
    plan: () => {
      if (!state.repaired) throw new Error(`${identity} declarative plan is intentionally unavailable`);
      return ok({ work: [] });
    },
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function hasFeaturePlanFailure(entry, identity) {
  const detail = isRecord(entry.detail) ? entry.detail : undefined;
  const cause = isRecord(detail?.cause) ? detail.cause : undefined;
  const causeDetail = isRecord(cause?.detail) ? cause.detail : undefined;
  return cause?.code === 'render-feature-stage-failed' && causeDetail?.featureIdentity === identity;
}

async function readCenterPixel() {
  const device = deviceRef.value;
  const target = targetRef.value;
  if (device === undefined || target === undefined) throw new Error('M10 Dawn readback target missing');
  const bytesPerRow = 256;
  const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: MAP_READ | COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(MAP_READ);
  const bytes = new Uint8Array(readback.getMappedRange()).slice(0);
  readback.unmap();
  readback.destroy();
  const offset = Math.floor(HEIGHT / 2) * bytesPerRow + Math.floor(WIDTH / 2) * 4;
  return [...bytes.slice(offset, offset + 4)];
}

const states = new Map([
  ['m10.dawn.plan-a', { repaired: false }],
  ['m10.dawn.plan-b', { repaired: false }],
  ['m10.dawn.plan-c', { repaired: false }],
]);
const features = [...states.entries()].map(([identity, state]) => makeFeature(identity, state));
const created = await createRenderer(
  canvas,
  { features },
  { shaderManifestUrl: manifestUrl },
);
if (!created.ok) throw new Error(`M10 Dawn renderer creation failed: ${String(created.error)}`);
const renderer = created.value;
const errors = [];
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    errors.push({
      code: event.error.code,
      hint: event.error.hint,
      detail: 'detail' in event.error ? event.error.detail : undefined,
    });
  }
});

const world = makeWorld();
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
world.update().unwrap();
const frame = {
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
};
const firstDraw = renderer.draw(frame);
const firstPixel = await readCenterPixel();
const firstErrors = errors.slice();
for (const state of states.values()) state.repaired = true;
const secondDraw = renderer.draw(frame);
const secondPixel = await readCenterPixel();
const stableDraw = renderer.draw(frame);
const stablePixel = await readCenterPixel();
let framesObserved = 0;
async function completeFrame(receipt) {
  const completed = await receipt.completed;
  if (!completed.ok) throw new Error(`M10 Dawn frame ${receipt.frameId} completion failed: ${JSON.stringify(completed.error)}`);
  framesObserved += 1;
}
if (firstDraw.ok) await completeFrame(firstDraw.value);
if (secondDraw.ok) await completeFrame(secondDraw.value);
if (stableDraw.ok) await completeFrame(stableDraw.value);

for (const identity of states.keys()) {
  const failure = firstErrors.find((entry) => hasFeaturePlanFailure(entry, identity));
  if (failure === undefined || failure.hint.length === 0) {
    throw new Error(`M10 Dawn ${identity} plan failure was not observable: ${JSON.stringify({ firstErrors })}`);
  }
}
if (!firstDraw.ok || !secondDraw.ok || !stableDraw.ok) {
  throw new Error(`M10 Dawn draw recovery failed: ${JSON.stringify({ firstDraw, secondDraw, stableDraw })}`);
}
if (
  secondPixel.slice(0, 3).every((channel) => channel === 0) ||
  JSON.stringify(secondPixel) !== JSON.stringify(stablePixel)
) {
  throw new Error(`M10 Dawn pixel acceptance failed: ${JSON.stringify({ firstPixel, secondPixel, stablePixel })}`);
}

while (framesObserved < FRAME_COUNT) {
  const drawn = renderer.draw(frame);
  if (!drawn.ok) throw new Error(`M10 Dawn stable frame ${framesObserved} failed: ${JSON.stringify(drawn.error)}`);
  await completeFrame(drawn.value);
}
const finalPixel = await readCenterPixel();
if (JSON.stringify(finalPixel) !== JSON.stringify(stablePixel) || errors.length !== firstErrors.length) {
  throw new Error(`M10 Dawn stable frames failed: ${JSON.stringify({ framesObserved, stablePixel, finalPixel, errors })}`);
}

const firstDispose = await renderer.dispose();
const secondDispose = await renderer.dispose();
if (!firstDispose.ok || !secondDispose.ok) {
  throw new Error(`M10 Dawn cleanup failed: ${JSON.stringify({ firstDispose, secondDispose })}`);
}
const evidence = {
  status: 'pass',
  backend: 'dawn',
  framesObserved,
  finalPixel,
  firstPixel,
  secondPixel,
  stablePixel,
  firstErrors,
  featureIdentities: renderer.inspect().features,
  firstDraw: { frameId: firstDraw.value.frameId },
  secondDraw: { frameId: secondDraw.value.frameId },
  recovery: 'next-frame declarative plan retry',
  cleanup: { disposeCalls: 2, first: firstDispose.ok, second: secondDispose.ok },
};
writeFileSync(resolve(artifactDir, 'm10-dawn.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[m10-render-feature] Dawn PASS cases=${states.size} firstPixel=${JSON.stringify(firstPixel)} secondPixel=${JSON.stringify(secondPixel)} artifact=${resolve(artifactDir, 'm10-dawn.json')}`);
emitSmokeReceipt('hello-m3-programmable-rendering/m10-dawn', framesObserved, 'smoke:m10:dawn');
process.exit(0);
