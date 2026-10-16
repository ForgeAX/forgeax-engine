#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const here = fileURLToPath(new URL('.', import.meta.url));
let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
gpu.requestAdapter = async (options) => {
  const adapter = await originalRequestAdapter(options);
  if (!adapter) return adapter;
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await originalRequestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const mockCanvas = {
  width: 320,
  height: 180,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width: 320, height: 180, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() { return renderTarget; },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World, FixedTime } = await import('@forgeax/engine-ecs');
const { PhysicalTranslation } = await import(resolve(here, '..', 'src', 'physics-fixed-loop.ts'));
const { Transform } = await import('@forgeax/engine-scene');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { buildPhysicsFixedWorld, installPhysicsFixedSystems, readPhysicsFixedState } = await import(resolve(here, '..', 'src', 'physics-fixed-loop.ts'));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: manifestUrl });
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));

const world = new World({ time: { fixedDeltaSeconds: 1 / 30, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.25 } });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
buildPhysicsFixedWorld(world);
installPhysicsFixedSystems(world);
for (let i = 0; i < frames; i++) {
  const updated = world.update(1 / 60);
  if (!updated.ok) {
    console.error(`[smoke] FAIL - world.update: ${updated.error.code}`);
    process.exit(1);
  }
  const drawn = await drawSmokeFrame(renderer, world);
  if (!drawn.ok) console.error(`[smoke] draw ${i}: ${drawn.error.code}`);
}
const state = readPhysicsFixedState(world);
const physical = world.get(state.player, PhysicalTranslation);
const rendered = world.get(state.player, Transform);
const fixed = world.getResource(FixedTime);
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  [`frames>=${frames}`, state.interpolationFrames === frames],
  ['fixed-steps>0', state.fixedSteps > 0],
  ['physics-advanced', physical.ok && physical.value.x > 0],
  ['rendered-interpolation', rendered.ok && rendered.value.pos[0] > 0 && state.lastAlpha >= 0 && state.lastAlpha <= 1],
  ['fixed-overstep-bounded', fixed.overstep >= 0 && fixed.overstep < fixed.delta],
  ['rhi-error-count=0', errors.length === 0],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  failed ||= !ok;
}
if (failed) {
  console.error(`[smoke] FAIL - fixedSteps=${state.fixedSteps}, alpha=${state.lastAlpha}, errors=${errors.join(',')}`);
  process.exit(1);
}
console.log(`[smoke] PASS - ${frames} frames, fixedSteps=${state.fixedSteps}, physicalX=${physical.value.x.toFixed(3)}, alpha=${state.lastAlpha.toFixed(3)}`);
process.exit(0);
