#!/usr/bin/env node
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
let device;
let target;
const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const canvas = {
  width: WIDTH, height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) { target ??= device.createTexture({ size: { width: WIDTH, height: HEIGHT }, format: desc.format ?? 'rgba8unorm', usage: 0x11, viewFormats: ['rgba8unorm-srgb'] }); },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {}, removeEventListener() {},
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
const hostResult = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
if (!hostResult.ok) throw hostResult.error;
const { renderer, assets: smokeAssets } = hostResult.value;
if (rendererBackend(renderer) !== 'webgpu') throw new Error(`[smoke] backend=${rendererBackend(renderer)}`);
const { buildContiguousQueryWorld, readContiguousQueryState } = await import(resolve(here, '..', 'src', 'contiguous-query.ts'));
const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const state = buildContiguousQueryWorld(world);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));
for (let frame = 0; frame < 60; frame++) {
  world.update(0.016).unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`[smoke] draw=${draw.error.code}`);
}
const finalState = readContiguousQueryState(state);
console.log(`[smoke] state=${JSON.stringify(finalState)}`);
if (!finalState.contiguousSupported || finalState.contiguousCalls === 0 || finalState.rows !== 32 || finalState.decayPasses === 0 || !finalState.lengthsEqual || finalState.currentHealth >= finalState.initialHealth || errors.length > 0) {
  throw new Error(`[smoke] FAIL - state=${JSON.stringify(finalState)}, errors=${errors.join(',')}`);
}
console.log('[smoke] PASS - Dawn render plus dense contiguous query evidence');
device?.destroy?.();
