#!/usr/bin/env node
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
let smokeAssets;
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-plugin-group headless Dawn smoke — proves group expansion through createApp.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const WIDTH = 160;
const HEIGHT = 120;

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (error) {
  console.error(`[smoke] FAIL - dawn.node import: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (error) {
  console.error(`[smoke] FAIL - dawn-node create: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
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
    if (!sharedDevice) sharedDevice = device;
    return device;
  };
  return adapter;
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
      configure(descriptor) { ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm'); },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) ensureRenderTarget(sharedDevice, 'rgba8unorm');
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { World, Update, defineComponent, defineSystem } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Camera, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { quat } = await import('@forgeax/engine-math');
const here = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const manifestUrl = `data:application/json,${encodeURIComponent(readFileSync(manifestPath, 'utf8'))}`;
const { createApp } = await import('@forgeax/engine-app');
const { helloWorldPlugins } = await import(resolve(here, '..', 'src', 'plugin-group.ts'));

const consoleLogCalls = [];
const originalLog = console.log;
console.log = (...args) => consoleLogCalls.push(args.join(' '));

let renderer;
try {
  const hostResult = await constructRuntimeRendererHost(mockCanvas, {}, { shaderManifestUrl: manifestUrl });
if (!hostResult.ok) throw hostResult.error;
({ renderer, assets: smokeAssets } = hostResult.value);
} catch (error) {
  console.log = originalLog;
  console.error(`[smoke] FAIL - createRenderer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push({ code: error.code, hint: error.hint }));

const eye = [-2, 2.5, 5];
const world = new World({ assets: smokeAssets });
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
world.spawn(
  { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
);
const M33FirstMarker = defineComponent('M33DawnFirstMarker', { value: 'u32' });
const M33SecondMarker = defineComponent('M33DawnSecondMarker', { value: 'u32' });
const m33Counters = { first: 0, second: 0 };
const m33Order = [];
const m33First = {
  name: 'm33-dawn-first',
  inject: ['world'],
  apply(ctx) {
    m33Counters.first += 1;
    m33Order.push('first');
    const entity = ctx.world.spawn({ component: M33FirstMarker, data: { value: 1 } }).unwrap();
    ctx.world.insertResource('m33DawnFirstBuilt', true);
    ctx.world.addSystem(Update, defineSystem({
      name: 'm33-dawn-first-system',
      queries: [],
      fn: () => {},
    })).unwrap();
    return () => {
      ctx.world.removeSystem(Update, 'm33-dawn-first-system');
      ctx.world.removeResource('m33DawnFirstBuilt');
      ctx.world.despawn(entity);
    };
  },
};
const m33Second = {
  name: 'm33-dawn-second',
  inject: ['world'],
  apply(ctx) {
    m33Counters.second += 1;
    m33Order.push('second');
    const entity = ctx.world.spawn({ component: M33SecondMarker, data: { value: 3 } }).unwrap();
    ctx.world.insertResource('m33DawnSecondBuilt', true);
    ctx.world.addSystem(Update, defineSystem({
      name: 'm33-dawn-second-system',
      queries: [],
      fn: () => {},
    })).unwrap();
    return () => {
      ctx.world.removeSystem(Update, 'm33-dawn-second-system');
      ctx.world.removeResource('m33DawnSecondBuilt');
      ctx.world.despawn(entity);
    };
  },
};

const appResult = await createApp({ platform: createSmokePlatform(mockCanvas),  renderer, world, plugins: [helloWorldPlugins, m33First, m33Second] });
if (!appResult.ok) {
  console.log = originalLog;
  console.error(`[smoke] FAIL - createApp: ${appResult.error.code}`);
  process.exit(1);
}
const m33Registry = [...appResult.value.pluginContext.registry.values()].map((runtime) => runtime.name);
if (
  !['hello-world', 'print-hello', 'print-world', 'm33-dawn-first', 'm33-dawn-second'].every((name) => m33Registry.includes(name)) ||
  JSON.stringify(m33Counters) !== JSON.stringify({ first: 1, second: 1 }) ||
  JSON.stringify(m33Order) !== JSON.stringify(['first', 'second']) ||
  !world.hasResource('m33DawnFirstBuilt') ||
  !world.hasResource('m33DawnSecondBuilt') ||
  world.inspect().entityCount !== 3 ||
  !world.inspect().systems.some((system) => system.name === 'm33-dawn-first-system') ||
  !world.inspect().systems.some((system) => system.name === 'm33-dawn-second-system')
) {
  console.log = originalLog;
  console.error('[smoke] FAIL - same-World repair registry/order/effects mismatch');
  process.exit(1);
}

for (let index = 0; index < SMOKE_MIN_FRAMES; index += 1) {
  world.update(0.016);
  await drawSmokeFrame(renderer, world);
}
await delay(50);
console.log = originalLog;

const registryOrder = [...appResult.value.pluginContext.registry.values()].map((runtime) => runtime.name);
const firstHello = consoleLogCalls.findIndex((entry) => entry === 'hello');
const firstWorld = consoleLogCalls.findIndex((entry) => entry === 'world');
const checks = [
  ['backend=webgpu', rendererBackend(renderer) === 'webgpu'],
  ['rhi-error-count=0', errors.length === 0],
  ['native-parent-fiber', registryOrder.includes('hello-world')],
  ['group-children=hello,world', registryOrder.indexOf('print-hello') < registryOrder.indexOf('print-world')],
  ['system-order=hello-before-world', firstHello >= 0 && firstWorld > firstHello],
];

let allPass = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) allPass = false;
}
if (!allPass) {
  console.error(`[smoke] FAIL - ${checks.filter(([, pass]) => !pass).map(([name]) => name).join(', ')}`);
  process.exit(1);
}
await appResult.value.dispose();
if (
  world.hasResource('m33DawnFirstBuilt') ||
  world.hasResource('m33DawnSecondBuilt') ||
  world.inspect().systems.some((system) => system.name.startsWith('m33-dawn-'))
) {
  console.error('[smoke] FAIL - plugin fiber cleanup left World contributions');
  process.exit(1);
}
renderer.dispose();
renderer.dispose();
console.log(`[smoke] PASS - ${SMOKE_MIN_FRAMES} frames, backend=${rendererBackend(renderer)}`);
process.exit(0);
