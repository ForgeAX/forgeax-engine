#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createSmokePlatform } from '../../../../scripts/smoke-platform.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (callback) => { const id = rafId++; rafQueue.push({ id, callback }); return id; };
globalThis.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter((frame) => frame.id !== id); };
let device;
let target;
const canvas = {
  tagName: 'CANVAS', isConnected: true, width: testQuality.viewport.width, height: testQuality.viewport.height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure({ device: nextDevice }) {
        device = nextDevice;
        target ??= device.createTexture({
          size: { width: testQuality.viewport.width, height: testQuality.viewport.height },
          format: 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() { return target; },
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const { createApp } = await import('@forgeax/engine-app/browser');
const { buildCapstoneScene } = await import(resolve(root, 'apps/hello/m8-integrated-capstone/src/scene.ts'));
const { physics3d } = await import('@forgeax/engine-physics');
const manifestPath = resolve(root, 'apps/hello/m8-integrated-capstone/dist/shaders/manifest.json');
const manifestUrl = URL.createObjectURL(new Blob([readFileSync(manifestPath)], { type: 'application/json' }));
process.once('exit', () => URL.revokeObjectURL(manifestUrl));
const result = await createApp(canvas, { platform: createSmokePlatform(canvas),  plugins: [physics3d] }, { shaderManifestUrl: manifestUrl });
if (!result.ok) throw new Error(`M8 Dawn createApp failed: ${result.error.code}`);
const app = result.value;
const scene = buildCapstoneScene(app.world);
const fixedTicks = { value: 0 };
const { FixedUpdate } = await import('@forgeax/engine-ecs');
app.world.addSystem(FixedUpdate, { name: 'm8-dawn-fixed-oracle', queries: [], fn: () => { fixedTicks.value += 1; } }).unwrap();
const errors = [];
app.onError((error) => errors.push({ code: error.code, hint: error.hint, detail: error.detail }));
const started = app.start();
if (!started.ok) throw new Error(`M8 Dawn app.start failed: ${started.error.code}`);
const paused = app.pause();
if (!paused.ok) throw new Error(`M8 Dawn app.pause failed: ${paused.error.code}`);
const frameCount = Math.max(60, Number(process.env.SMOKE_MIN_FRAMES ?? 60));
const receiptWaitDeadlineMs = 30_000;
const waitForReceiptCredit = async () => {
  const deadline = Date.now() + receiptWaitDeadlineMs;
  while (app.execution.report().frame.inFlight !== 0) {
    if (Date.now() >= deadline) {
      throw new Error(`M8 frame receipt did not settle within ${receiptWaitDeadlineMs}ms`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
};
let submissions = 0;
for (; submissions < frameCount; ) {
  const stepped = app.stepFrame(1 / 60);
  if (!stepped.ok) {
    if (
      stepped.error.code === 'app-frame-step-invalid' &&
      stepped.error.detail.reason === 'credit'
    ) {
      await waitForReceiptCredit();
      continue;
    }
    throw new Error(`M8 deterministic frame ${submissions} failed: ${stepped.error.code}`);
  }
  submissions += 1;
  await waitForReceiptCredit();
}
const actor = app.world.get(scene.actor, (await import('@forgeax/engine-scene')).Transform);
const entities = app.world.inspect().entityCount;
if (!actor.ok || fixedTicks.value < 30 || entities < 6 || errors.length > 0) {
  throw new Error(`M8 Dawn shared-scene oracle failed: ${JSON.stringify({ submissions, fixedTicks: fixedTicks.value, entities, actorY: actor.ok ? actor.value.pos[1] : null, errors })}`);
}
const stopped = app.stop();
if (!stopped.ok) throw new Error(`M8 Dawn app.stop failed: ${stopped.error.code}`);
console.log(`[m8-capstone] Dawn shared-scene journey: PASS submissions=${submissions} entities=${entities} fixed=${fixedTicks.value} actorY=${actor.value.pos[1]}`);
delete globalThis.navigator.gpu;
process.exit(0);
