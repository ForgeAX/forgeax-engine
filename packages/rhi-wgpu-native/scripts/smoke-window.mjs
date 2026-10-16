#!/usr/bin/env node
// Native qualification: ordinary TS World/Renderer, real swapchain, real completion.
// This contributor fixture borrows hello-triangle's built shader manifest. It is not
// part of the default SDK build, and performs no readback-to-canvas presentation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNativeWindow, installNavigatorGpu, nativeWgpuVersion } from '../dist/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.env.NATIVE_WINDOW_EVIDENCE ?? 'artifacts/native-window');
await mkdir(output, { recursive: true });
const manifestPath = resolve(root, 'apps/hello/triangle/dist/shaders/manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(await readFile(manifestPath, 'utf8'))}`;
const window = createNativeWindow({ title: 'ForgeaX native TypeScript World', width: 640, height: 360 }).unwrap();
installNavigatorGpu(window.gpu).unwrap();
const { createRenderer } = await import('@forgeax/engine-runtime');
const { World } = await import('@forgeax/engine-ecs');
const { Camera, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_TRIANGLE } = await import('@forgeax/engine-assets-runtime');
const adapter = await window.gpu.requestAdapter();
assert(adapter, 'native Surface requires an actual compatible adapter');
const world = new World();
world.spawn({ component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
  { component: MeshRenderer, data: {} }).unwrap();
world.spawn({ component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
    clearColor: [0.025, 0.055, 0.1, 1] } }).unwrap();
let renderer;
const report = { runtime: process.version, platform: process.platform, arch: process.arch,
  wgpu: nativeWgpuVersion(), adapter: adapter.info, frames: [], events: [], checks: [] };
const checkpoint = async (name) => {
  await writeFile(resolve(output, 'progress.json'), JSON.stringify({ stage: name, display: window.facts().unwrap() }, null, 2));
  console.log(`[native-window] ${name}`);
  const hold = Number(process.env.NATIVE_WINDOW_HOLD_MS ?? '0');
  if (hold > 0) await delay(hold);
};
try {
  renderer = (await createRenderer(window.canvas, { rhi: window.rhi }, { shaderManifestUrl })).unwrap();
  const lease = renderer.attach(world).unwrap();
  const context = window.canvas.getContext('webgpu');
  const errors = [];
  renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
  let lastReceipt;
  async function draw() {
    window.requestRedraw().unwrap();
    report.events.push(...window.pollEvents().unwrap());
    world.update(1 / 60).unwrap();
    const receipt = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }).unwrap();
    const completed = await receipt.completed;
    completed.unwrap();
    lastReceipt = receipt;
    report.frames.push({ frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration,
      display: window.facts().unwrap() });
  }
  await draw();
  const device = context.getConfiguration().device;
  report.surface = { supportedAlphaModes: context.supportedAlphaModes,
    alphaMode: context.getConfiguration().alphaMode, format: context.getConfiguration().format };
  assert.equal(window.resize(0, 360).ok, false);
  assert.equal(window.resize(-1, 360).ok, false);
  const retained = context.getCurrentTexture();
  const retainedView = retained.createView();
  device.queue.submit([]);
  assert.equal(context.getCurrentTexture(), retained, 'unrelated submit must retain the acquired image');
  report.checks.push('unrelated submission does not present');
  for (let frame = 1; frame < 60; frame++) await draw();
  assert.throws(() => retained.createView(), /expired/);
  report.checks.push('60 Renderer receipts completed and presented texture expired');
  await checkpoint('60-completed-visible');

  device.pushErrorScope('validation');
  const staleEncoder = device.createCommandEncoder();
  const stalePass = staleEncoder.beginRenderPass({ colorAttachments: [{ view: retainedView,
    clearValue: [1, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
  stalePass.end();
  device.queue.submit([staleEncoder.finish()]);
  assert(await device.popErrorScope(), 'a retained view of a presented image must fail native validation');
  report.checks.push('stale surface view rejected by native GPU validation');

  window.resize(800, 450).unwrap();
  for (let attempt = 0; attempt < 100 && window.facts().unwrap().width !== 800; attempt++) {
    report.events.push(...window.pollEvents().unwrap());
    await delay(5);
  }
  assert.equal(window.facts().unwrap().width, 800);
  assert.equal(window.facts().unwrap().height, 450);
  await draw();
  assert.equal(context.getCurrentTexture().width, 800);
  assert.equal(context.getCurrentTexture().height, 450);
  await draw();
  report.checks.push('actual window resize reconfigures the Surface and Renderer continues');
  await checkpoint('resized-visible');
  assert.deepEqual(errors, []);
  const beforeLoss = lastReceipt;
  device.destroy();
  await delay(0);
  (await renderer.recover()).unwrap();
  await draw();
  assert(lastReceipt.deviceGeneration > beforeLoss.deviceGeneration);
  const staleReceipt = await renderer.observe(beforeLoss, { include: ['draws'] });
  assert.equal(staleReceipt.ok, false);
  report.checks.push('device destruction retires its Surface; ordinary Renderer recovery presents a new generation');
  await checkpoint('recovered-visible');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.cause.code, 'device-lost');
  report.expectedLossEvent = errors[0];
  renderer.dispose();
  renderer = undefined;
  window.close().unwrap();
  window.close().unwrap();
  assert.equal(window.requestRedraw().ok, false);
  assert.equal(window.pollEvents().ok, false);
  assert.throws(() => context.getCurrentTexture(), /unconfigured/);
  report.checks.push('close is idempotent and rejects late window and surface use');
  const replacement = createNativeWindow({ width: 320, height: 180, title: 'ForgeaX replacement' }).unwrap();
  replacement.pollEvents().unwrap();
  replacement.close().unwrap();
  report.checks.push('window can be recreated after close on the native event loop');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail';
  report.error = { message: String(error), stack: error?.stack, detail: error?.detail };
  throw error;
} finally {
  renderer?.dispose();
  window.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`[native-window] PASS: ${report.frames.length} completed frames; ${output}`);
