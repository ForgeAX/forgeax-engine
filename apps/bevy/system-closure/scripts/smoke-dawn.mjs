#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
const FRAMES = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10), 60);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
let device;
let target;
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        target ??= device.createTexture({ size: { width: WIDTH, height: HEIGHT }, format: desc.format ?? 'rgba8unorm', usage: 0x11, viewFormats: ['rgba8unorm-srgb'] });
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const here = dirname(fileURLToPath(import.meta.url));
const manifest = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => { device = await requestDevice(descriptor); return device; };
  return adapter;
};
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
if (rendererBackend(renderer) !== 'webgpu') throw new Error(`[smoke] backend=${rendererBackend(renderer)}`);
const { buildSystemClosureWorld, readSystemClosureState } = await import(resolve(here, '..', 'src', 'system-closure.ts'));
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const state = buildSystemClosureWorld(world);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));
for (let frame = 0; frame < FRAMES; frame++) {
  world.update(0.016).unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`[smoke] draw=${draw.error.code}`);
}
const finalState = readSystemClosureState(world, state);
console.log(`[smoke] state=${JSON.stringify(finalState)}`);
if (
  finalState.simpleRuns !== FRAMES ||
  finalState.statefulRuns !== FRAMES ||
  finalState.capturedRuns !== FRAMES ||
  finalState.statefulValue !== FRAMES ||
  finalState.capturedValue <= 7 ||
  finalState.simpleX === -260 ||
  finalState.statefulX === 0 ||
  finalState.capturedX === 260 ||
  errors.length > 0
) {
  throw new Error(`[smoke] FAIL - state=${JSON.stringify(finalState)}, errors=${errors.join(',')}`);
}
console.log(`[smoke] PASS - ${FRAMES} frames, Dawn render plus closure capture evidence`);
device?.destroy?.();
