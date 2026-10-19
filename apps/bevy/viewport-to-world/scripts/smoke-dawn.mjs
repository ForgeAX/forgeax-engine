#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from "../../scripts/renderer-smoke.mjs";
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {} });
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let device;
let target;
const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        if (!target) {
          device = desc.device;
          target = device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!target) throw new Error('render target was not configured');
        return target;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const here = dirname(fileURLToPath(import.meta.url));
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms, Transform } = await import('@forgeax/engine-scene');
const { buildViewportToWorldWorld, stepViewportToWorld } = await import(
  resolve(here, '..', 'src', 'viewport-to-world.ts'),
);
const manifest = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const renderer = await createSmokeRenderer(createRenderer, mockCanvas, {}, {
  shaderManifestUrl: `data:application/json,${encodeURIComponent(readFileSync(manifest, 'utf8'))}`,
});
console.log(`[bevy-viewport-to-world] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push({ code: error.code, hint: error.hint }));

const world = new World();
const worldAttachment1 = renderer.attach(world);
if (!worldAttachment1.ok) throw worldAttachment1.error;
const scene = buildViewportToWorldWorld(world);
let early;
let late;
let earlyX;
let frames = 0;
for (let i = 0; i < MIN_FRAMES; i++) {
  const screenX = i < Math.floor(MIN_FRAMES / 2) ? WIDTH * 0.25 : WIDTH * 0.75;
  propagateTransforms(world);
  if (!stepViewportToWorld(world, scene, screenX, HEIGHT * 0.5, WIDTH, HEIGHT)) {
    throw new Error(`[smoke] viewport ray missed ground at frame ${i}`);
  }
  propagateTransforms(world);
  world.update().unwrap();
  const draw = await drawSmokeFrame(renderer, world);
  if (!draw.ok) throw new Error(`draw failed: ${draw.error.code}`);
  frames++;
  if (i === Math.min(10, MIN_FRAMES - 1)) {
    early = await capture(device, target);
    const position = world.get(scene.marker, Transform);
    if (position.ok) earlyX = position.value.pos[0] ?? 0;
  }
  if (i === MIN_FRAMES - 1) late = await capture(device, target);
}

if (!early || !late || earlyX === undefined) throw new Error('smoke capture or marker state missing');
const latePosition = world.get(scene.marker, Transform);
const moved = earlyX !== undefined && latePosition.ok && Math.abs((latePosition.value.pos[0] ?? 0) - earlyX) > 0.5;
const maxBright = late.reduce((max, value, index) => index % 4 === 3 ? max : Math.max(max, value / 255), 0);
console.log(`[smoke] frames observed=${frames}`);
console.log(`[smoke] marker moved=${moved} maxBright=${maxBright.toFixed(4)} errors=${errors.length}`);

const outDir = resolve(here, '..', 'dist', 'smoke');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'viewport-early.png'), encodePng(WIDTH, HEIGHT, early));
writeFileSync(resolve(outDir, 'viewport-late.png'), encodePng(WIDTH, HEIGHT, late));

const passed = frames >= MIN_FRAMES && moved && maxBright >= 0.1 && errors.length === 0;
if (!passed) {
  process.exitCode = 1;
  console.error('[smoke] FAIL - viewport-to-world witness did not hold');
} else {
  console.log('[smoke] PASS - viewport ray moved marker across ground');
}
device.destroy?.();
process.exit(passed ? 0 : 1);

async function capture(activeDevice, texture) {
  await activeDevice.queue.onSubmittedWorkDone();
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const buffer = activeDevice.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x01 | 0x08 });
  const encoder = activeDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  activeDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x01);
  const raw = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const tight = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    tight.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4), y * WIDTH * 4);
  }
  return tight;
}
