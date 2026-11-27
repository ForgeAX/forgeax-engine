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
import { readShaderManifestText } from '../../../scripts/lib/shader-manifest.mjs';
import { drawReadyFrame } from '../../../scripts/test/ready-render-frame.mjs';
import { nativeTriangleDraws, nativeTrianglePixels } from './native-window-pixels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.env.NATIVE_WINDOW_EVIDENCE ?? 'artifacts/native-window');
await mkdir(output, { recursive: true });
const manifestPath = resolve(root, 'apps/hello/triangle/dist/shaders/manifest.json');
const shaderManifestUrl = `data:application/json,${encodeURIComponent(readShaderManifestText(manifestPath))}`;
const window = createNativeWindow({ title: 'ForgeAX native TypeScript World', width: 640, height: 360 }).unwrap();
installNavigatorGpu(window.gpu).unwrap();
const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { World } = await import('@forgeax/engine-ecs');
const { Camera, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { propagateTransforms, Transform } = await import('@forgeax/engine-scene');
const { createPrimitiveMesh } = await import('../../geometry/dist/index.mjs');
const { halfFloat } = await import('../../math/dist/index.mjs');
const adapter = await window.gpu.requestAdapter();
assert(adapter, 'native Surface requires an actual compatible adapter');
const recording = process.env.NATIVE_WINDOW_RHI_CAPTURE === '1'
  ? (await import('../../rhi-debug/dist/index.mjs')).attachRecorder({
    ...await import('@forgeax/engine-rhi-webgpu'), rhi: window.rhi,
  }).unwrap() : undefined;
const clearColor = [0.025, 0.055, 0.1, 1];
let world;
let renderer;
const report = { runtime: process.version, platform: process.platform, arch: process.arch,
  wgpu: nativeWgpuVersion(), adapter: adapter.info, frames: [], events: [], checks: [] };
const checkpoint = async (name, frameId) => {
  await writeFile(resolve(output, 'progress.json'), JSON.stringify({ stage: name, frameId, display: window.facts().unwrap() }, null, 2));
  console.log(`[native-window] ${name}`);
  const hold = Number(process.env.NATIVE_WINDOW_HOLD_MS ?? '0');
  if (hold > 0) await delay(hold);
};
try {
  const constructed = await constructRuntimeRendererHost(window.canvas, {
    rhi: recording?.backend.rhi ?? window.rhi,
    ...(recording ? { rhiInstrumentation: {
      resolveSurfaceDevice: (device) => recording.backend.unwrapDeviceForSurface(device),
    } } : {}),
  }, { shaderManifestUrl });
  if (!constructed.ok) throw constructed.error;
  const host = constructed.value;
  renderer = host.renderer;
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  world = new World({ assets: host.assets });
  const triangle = host.assets.create(createPrimitiveMesh('triangle').unwrap()).unwrap();
  world.spawn({ component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: triangle } },
    { component: MeshRenderer, data: {} }).unwrap();
  host.assets.release(triangle).unwrap();
  world.spawn({ component: Transform, data: { pos: [0, 0, 3] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
      clearColor } }).unwrap();
  const lease = renderer.attach(world).unwrap();
  const context = window.canvas.getContext('webgpu');
  const errors = [];
  renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
  let lastReceipt;
  async function draw(observation) {
    window.requestRedraw().unwrap();
    report.events.push(...window.pollEvents().unwrap());
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = await drawReadyFrame(renderer, { source: lease }, observation);
    lastReceipt = receipt;
    report.frames.push({ frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      display: window.facts().unwrap() });
  }
  async function witness(name) {
    const capture = recording && name === 'initial' ? recording.captureFrame() : undefined;
    if (capture) (await recording.frameBoundary()).unwrap();
    await draw(['linear-hdr']);
    let tape, frameModel;
    if (capture) {
      (await recording.frameBoundary()).unwrap();
      tape = (await capture).unwrap();
      assert(tape.byteLength <= 128 * 1024 * 1024, 'Native triangle diagnostic tape is bounded');
      await writeFile(resolve(output, `${name}-frame.rhitape`), tape.bytes);
      const debug = await import('../../rhi-debug/dist/index.mjs');
      frameModel = debug.buildFrameModel(debug.decodeTape(tape.bytes).unwrap());
      await writeFile(resolve(output, `${name}-frame-model.json`), JSON.stringify(frameModel, null, 2));
    }
    const observed = (await renderer.observe(lastReceipt, { include: ['linear-hdr', 'draws'] })).unwrap();
    const hdr = observed.observations?.find(item => item.domain === 'linear-hdr');
    await writeFile(resolve(output, `${name}-observation.json`), JSON.stringify({
      frameId: lastReceipt.frameId, worldAssetsBound: world.assets !== undefined,
      inspection: renderer.inspect(), draws: observed.draws,
      observations: observed.observations?.map(item => ({ domain: item.domain, metadata: item.metadata })),
    }, null, 2));
    if (tape) await writeFile(resolve(output, `${name}-scene-diagnostic.json`), JSON.stringify({
      scope: 'Actual recorded witness frame and observations; not GI or pixel acceptance',
      frameId: lastReceipt.frameId, worldAssetsBound: world.assets !== undefined,
      inspection: renderer.inspect(), draws: observed.draws,
      tapeBytes: tape.byteLength, tapeDigest: tape.digest,
    }, null, 2));
    assert(hdr && hdr.metadata.frameId === lastReceipt.frameId);
    assert.equal(hdr.metadata.format, 'rgba16float');
    assert.equal(renderer.inspect().observation.antialias, 'none');
    const { width, height, bytesPerRow } = hdr.metadata;
    const facts = window.facts().unwrap();
    assert.equal(width, facts.width);
    assert.equal(height, facts.height);
    const bytes = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
    const rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        rgb[(y * width + x) * 3 + c] = halfFloat.f16ToF32(bytes.getUint16(y * bytesPerRow + x * 8 + c * 2, true));
    await writeFile(resolve(output, `${name}-linear-hdr.f32`), new Uint8Array(rgb.buffer));
    const geometry = nativeTriangleDraws(observed.draws, frameModel);
    const pixels = nativeTrianglePixels(rgb, width, height, clearColor);
    const evidence = { frameId: lastReceipt.frameId, deviceGeneration: lastReceipt.deviceGeneration,
      metadata: hdr.metadata, ...geometry, pixels };
    await writeFile(resolve(output, `${name}-pixels.json`), JSON.stringify(evidence, null, 2));
    report.checks.push(`${name}: projected triangle and finite foreground/background HDR pixels`);
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
  await checkpoint('60-ordinary-visible', lastReceipt.frameId);
  await witness('initial');
  await checkpoint('60-completed-visible', lastReceipt.frameId);

  device.pushErrorScope('validation');
  const staleEncoder = device.createCommandEncoder();
  const stalePass = staleEncoder.beginRenderPass({ colorAttachments: [{ view: retainedView,
    clearValue: [1, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
  stalePass.end();
  device.queue.submit([staleEncoder.finish()]);
  assert(await device.popErrorScope(), 'a retained view of a presented image must fail native validation');
  report.checks.push('stale surface view rejected by native GPU validation');

  // Keep native command/view references alive across presentation and resize.
  // GC must not decide when DXGI swapchain images can be resized.
  const resizeView = context.getCurrentTexture().createView();
  const pendingPass = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: resizeView,
      clearValue: [0.025, 0.055, 0.1, 1], loadOp: 'clear', storeOp: 'store' }] });
    pass.end();
    return encoder;
  };
  const pendingCommands = pendingPass().finish();
  const unfinishedCommands = pendingPass();
  device.queue.submit([pendingPass().finish()]);
  await device.queue.onSubmittedWorkDone();

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
  device.pushErrorScope('validation');
  device.queue.submit([pendingCommands]);
  assert(await device.popErrorScope(), 'pending commands using a retired image must fail validation');
  device.pushErrorScope('validation');
  device.queue.submit([unfinishedCommands.finish()]);
  assert(await device.popErrorScope(), 'unfinished commands using a retired view must fail validation');
  report.checks.push('retained views and pending commands do not block resize; late use is rejected');
  await draw();
  report.checks.push('actual window resize reconfigures the Surface and Renderer continues');
  await witness('resized');
  await checkpoint('resized-visible', lastReceipt.frameId);
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
  await witness('recovered');
  await checkpoint('recovered-visible', lastReceipt.frameId);
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
  const replacement = createNativeWindow({ width: 320, height: 180, title: 'ForgeAX replacement' }).unwrap();
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
