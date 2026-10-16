#!/usr/bin/env node
// Native qualification: ordinary TS World/Renderer, real swapchain, real completion.
// This contributor fixture borrows hello-triangle's built shader manifest. It is not
// part of the default SDK build, and performs no readback-to-canvas presentation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bindNativeWindow, installNavigatorGpu } from '../../../../rhi-wgpu-native/dist/index.mjs';

const addonPath = resolve(process.env.NATIVE_TAURI_ADDON ?? new URL(`./native/tauri-native-host.${process.platform}-${process.arch}.node`, import.meta.url).pathname);
const addon = createRequire(import.meta.url)(addonPath);
function createWindow(options) {
  const host = new addon.TauriWindow(JSON.stringify(options));
  return { host, window: bindNativeWindow(host.takeNativeWindow()) };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const output = resolve(process.env.NATIVE_WINDOW_EVIDENCE ?? 'artifacts/native-window');
await mkdir(output, { recursive: true });
const manifestPath = resolve(root, 'apps/hello/triangle/dist/shaders/manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(await readFile(manifestPath, 'utf8'))}`;
const { host, window } = createWindow({ title: 'ForgeaX native TypeScript World', width: 640, height: 360 });
assert.throws(() => host.takeNativeWindow(), /already borrowed/);
installNavigatorGpu(window.gpu).unwrap();
const { createRenderer } = await import('@forgeax/engine-runtime');
const { World } = await import('@forgeax/engine-ecs');
const { Camera, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { HANDLE_TRIANGLE } = await import('@forgeax/engine-assets-runtime');
const adapter = await window.gpu.requestAdapter();
assert(adapter, 'native Surface requires an actual compatible adapter');
const world = new World();
const triangle = world.spawn({ component: Transform, data: {} },
  { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
  { component: MeshRenderer, data: {} }).unwrap();
world.spawn({ component: Transform, data: { pos: [0, 0, 3] } },
  { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
    clearColor: [0.025, 0.055, 0.1, 1] } }).unwrap();
let renderer;
const report = { runtime: process.version, platform: process.platform, arch: process.arch,
  wgpu: addon.wgpuVersion(), adapter: adapter.info, frames: [], events: [], checks: [] };
const uiMessages = [];
report.uiMessages = uiMessages;
let actions = 0;
host.mountWebview(`<html><head><meta charset="utf-8"><style>
body{margin:0;padding:12px;background:#152238;color:white;font:16px sans-serif}
h1{margin:0;font-size:18px}button{display:block;width:200px;height:44px;margin:18px 0;background:#5ee0b1;border:0;font-size:16px}output{display:block}
</style></head><body><h1>WebView controls</h1><button id="move">Move native triangle</button><output id="state">State: ready</output><script>
let clickCount=0;
const send=(message)=>window.ipc.postMessage(JSON.stringify(message));
document.getElementById('move').addEventListener('click',()=>send({kind:'move',sequence:++clickCount}));
send({kind:'ready',width:innerWidth,height:innerHeight,userAgent:navigator.userAgent});
</script></body></html>`);
const pump = () => {
  report.events.push(...window.pollEvents().unwrap());
  for (const raw of JSON.parse(host.webviewMessages())) {
    const message = JSON.parse(raw);
    uiMessages.push(message);
    if (message.kind === 'move') {
      assert.equal(message.sequence, actions + 1);
      actions++;
      world.set(triangle, Transform, {pos: [0.8, 0, 0]}).unwrap();
      host.webviewEval(`document.getElementById('state').textContent='State: native moved';window.ipc.postMessage(JSON.stringify({kind:'state-applied',sequence:${actions}}))`);
    }
  }
};
const until = async (predicate) => {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    assert(performance.now() < deadline, 'WebView message deadline exceeded');
    pump();
    await delay(5);
  }
};
const checkpoint = async (name) => {
  for (let i=0;i<40;i++) {pump();await delay(5);}
  await writeFile(resolve(output, 'progress.json'), JSON.stringify({ stage: name, display: window.facts().unwrap() }, null, 2));
  console.log(`[native-window] ${name}`);
  const hold = Number(process.env.NATIVE_WINDOW_HOLD_MS ?? '0');
  if (hold > 0) { const end = performance.now() + hold; while (performance.now() < end) { pump(); await delay(5); } }
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
    pump();
    world.update(1 / 60).unwrap();
    const receipt = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }).unwrap();
    const completed = await receipt.completed;
    completed.unwrap();
    lastReceipt = receipt;
    report.frames.push({ frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration,
      display: window.facts().unwrap() });
  }
  await draw();
  await until(() => uiMessages.some(message => message.kind === 'ready'));
  await checkpoint('ui-ready');
  await until(() => actions === 1 && uiMessages.some(message => message.kind === 'state-applied'));
  await draw();
  await checkpoint('ui-action-native-moved');
  report.uiMessages = uiMessages;
  report.pid = process.pid;
  report.checks.push('real WebView click crosses ordered POD action, native World changes, state returns to DOM');
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
  assert.throws(() => host.webviewEval('1'), /closed/);
  window.close().unwrap();
  assert.equal(window.requestRedraw().ok, false);
  assert.equal(window.pollEvents().ok, false);
  assert.throws(() => context.getCurrentTexture(), /unconfigured/);
  report.checks.push('close is idempotent and rejects late window and surface use');
  const { window: replacement, host: replacementHost } = createWindow({ width: 320, height: 180, title: 'ForgeaX replacement' });
  replacement.pollEvents().unwrap();
  replacementHost.mountWebview('<html><body>Replacement WebView</body></html>');
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
  addon.shutdownHost();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`[native-window] PASS: ${report.frames.length} completed frames; ${output}`);
