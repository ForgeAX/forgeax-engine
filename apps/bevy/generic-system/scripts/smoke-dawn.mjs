import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const FRAMES = Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10), 60);
// Keep the original 2.88-second lifecycle horizon while reducing GPU submissions.
const DELTA_SECONDS = 2.88 / FRAMES;

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
const { createRenderer } = await import('@forgeax/engine-runtime');
const { World } = await import('@forgeax/engine-ecs');
const { registerStatesPlugin } = await import('@forgeax/engine-state');
const renderer = await createSmokeRenderer(createRenderer, canvas, {}, { shaderManifestUrl: manifestUrl });
if (rendererBackend(renderer) !== 'webgpu') throw new Error(`[smoke] backend=${rendererBackend(renderer)}`);
const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const genericSystem = await import(resolve(here, '..', 'src', 'generic-system.ts'));
registerStatesPlugin(world);
const { buildGenericSystemWorld, readGenericSystemState } = genericSystem;
const state = buildGenericSystemWorld(world);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));
for (let frame = 0; frame < FRAMES; frame += 1) {
  world.update(DELTA_SECONDS).unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`[smoke] draw=${draw.error.code}`);
}
const snapshot = readGenericSystemState(world, state);
console.log(`[smoke] state=${JSON.stringify(snapshot)}`);
if (snapshot.cleanupLog.join(',') !== 'menu-close,level-unload') throw new Error('generic cleanup order mismatch');
if (snapshot.remaining !== 1 || errors.length > 0) throw new Error(`[smoke] FAIL - errors=${errors.join(',')}`);
console.log('[smoke] PASS - generic system specializations clean state-scoped entities');
device?.destroy?.();
