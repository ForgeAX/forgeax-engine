#!/usr/bin/env node
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
// bevy-delayed-commands headless dawn smoke (structural-only).
// Verify: backend=webgpu, 60 frames no crash, 0 RhiError

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const WIDTH = 200, HEIGHT = 150;
const TARGET_FRAMES = 60;

let create, globals;
({ create, globals } = await import('@forgeax/engine-dawn-node'));
Object.assign(globalThis, globals);
if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const origReqAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const raw = await origReqAdapter(opts);
  if (raw === null) return raw;
  const origReqDevice = raw.requestDevice.bind(raw);
  raw.requestDevice = async (desc) => { const dev = await origReqDevice(desc); if (!sharedDevice) sharedDevice = dev; return dev; };
  return raw;
};

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({ size: { width: WIDTH, height: HEIGHT }, format, usage: 0x10 | 0x01, viewFormats: ['rgba8unorm-srgb'] });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH, height: HEIGHT,
  getContext(k) { if (k !== 'webgpu') return null; return { configure(d) { ensureRenderTarget(d.device, d.format ?? 'rgba8unorm'); }, unconfigure() {}, getCurrentTexture() { if (!renderTarget) { if (!sharedDevice) throw new Error('no device'); ensureRenderTarget(sharedDevice, 'rgba8unorm'); } return renderTarget; } }; },
  addEventListener() {}, removeEventListener() {},
};

const { World } = await import('@forgeax/engine-ecs');
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { PointLight } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');

const world = new World();
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = `data:application/json,${encodeURIComponent(readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8'))}`;

let renderer;
try { renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, { shaderManifestUrl: MANIFEST }); }
finally { globalThis.navigator.gpu.requestAdapter = origReqAdapter; }
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;

console.log(`[delayed-commands] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (err) => errors.push(err));


const boxGeom = createBoxGeometry(0.5, 0.5, 0.5, 1, 1, 1);
if (!boxGeom.ok) { console.error('FAIL: box'); process.exit(1); }
const boxHandle = world.allocSharedRef('MeshAsset', boxGeom.value);
const mat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.8, 0.3, 0.3, 1] }));

for (let i = 0; i < 5; i++) {
  world.spawn(
    { component: Transform, data: { pos: [i - 2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: boxHandle } },
    { component: MeshRenderer, data: { materials: [mat] } },
  );
}
world.spawn({ component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } });
world.spawn({ component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) });

let frames = 0;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update().unwrap();
  const result = drawSmokeFrame(renderer, world);
  if (!result.ok) console.error(`draw ${i}: ${result.error.code}`);
  frames++;
}

const device = sharedDevice;
if (device) await device.queue.onSubmittedWorkDone();

const failures = [];
if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (frames < TARGET_FRAMES) failures.push(`frames=${frames}`);
if (errors.length > 0) failures.push(`errors=${errors.length}: [${errors.map(e => e.code).join(',')}]`);

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  await delay(0); device?.destroy?.(); process.exit(1);
}
console.log(`[smoke] PASS - backend=webgpu, frames=${frames}, RhiError count=0`);
device?.destroy?.(); delete globalThis.navigator.gpu; process.exit(0);
