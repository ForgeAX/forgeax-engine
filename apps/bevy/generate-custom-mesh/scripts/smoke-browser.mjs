#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-generate-custom-mesh';

if (process.env.GENERATE_CUSTOM_MESH_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy generate_custom_mesh public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareGenerateCustomMeshCapture',
    appDir,
    assertTape: ({ tape }) => assertCustomMeshTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const uvExit = await runExistingBrowserSmoke();
  if (uvExit !== 0) process.exit(uvExit);
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runRhiDebugBrowserAdmission({
    pkg: packageName,
    label: 'bevy generate_custom_mesh',
    readyHook: '__bevyGenerateCustomMeshReady',
    capturePrepareHook: '__prepareGenerateCustomMeshCapture',
    screenshotPath: resolve(appDir, 'artifacts', 'generate-custom-mesh-rhi-debug.png'),
    triggerLabel: 'generate-custom-mesh-public-trigger',
    assertTape: ({ events, blobPool }) => assertCustomMeshTape({ events, blobPool }),
    formatCapture: ({ capture, selected, inspected }) =>
      `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} ` +
      `attributes=${selected.attributes.join(',')} bindings=${inspected.bindings.length} ` +
      `materialBuffer=${selected.materialBuffer} texture=${selected.texture} sampler=${selected.sampler}`,
  });
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, GENERATE_CUSTOM_MESH_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

async function runExistingBrowserSmoke() {
  const port = Number(process.env.PORT ?? 5176);
  const vite = spawn('pnpm', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: 'pipe',
  });
  vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  let browser;
  try {
    await waitForServer(port);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => globalThis.__bevyGenerateCustomMeshReady === true, null, { timeout: 30000 });
    } catch (error) {
      console.error(`[smoke-browser] ready timeout; diagnostics=${errors.join(' | ') || 'none'}`);
      throw error;
    }
    await page.waitForTimeout(1000);
    const before = await page.evaluate(() => globalThis.__bevyGenerateCustomMeshState.toggles);
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.waitForFunction((value) => globalThis.__bevyGenerateCustomMeshState.toggles === value + 1, before);
    const after = await page.evaluate(() => ({
      toggles: globalThis.__bevyGenerateCustomMeshState.toggles,
      uvMode: globalThis.__bevyGenerateCustomMeshState.uvMode,
    }));
    await page.screenshot({ path: resolve(appDir, 'artifacts', 'generate-custom-mesh-browser.png') });
    if (errors.length > 0) throw new Error(errors.join(' | '));
    if (after.uvMode !== 'lower') throw new Error(`UV toggle failed: ${JSON.stringify(after)}`);
    console.log(`[smoke-browser] PASS - ready=1 toggles=${after.toggles} uvMode=${after.uvMode}`);
    return 0;
  } catch (error) {
    console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await browser?.close();
    vite.kill('SIGTERM');
    await delay(100);
  }
}

async function waitForServer(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // Vite is still booting.
    }
    await delay(100);
  }
  throw new Error(`Vite did not become ready on 127.0.0.1:${port}`);
}

function assertCustomMeshTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const textures = new Map(events.filter((event) => event.kind === 'createTexture').map((event) => [event.handleId, event]));
  const textureViews = new Map(events.filter((event) => event.kind === 'createTextureView').map((event) => [event.resultHandleId, event]));
  const samplers = new Map(events.filter((event) => event.kind === 'createSampler').map((event) => [event.handleId, event]));
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const candidates = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasCustomMeshPipeline(draw.pipeline) &&
      findMaterialBinding(draw, groups, layouts, textures, textureViews, samplers, initialData, events, blobPool) !== undefined,
  );
  if (candidates.length !== 1) {
    throw new Error(`expected one semantically selected custom mesh draw, got ${candidates.length} of ${indexed.length} indexed draws`);
  }
  const selected = candidates[0];
  if (selected.event.indexCount !== 36 || selected.event.instanceCount <= 0 || !['uint16', 'uint32'].includes(selected.indexBuffer.format)) {
    throw new Error(`selected custom mesh draw is not the expected indexed cube: ${JSON.stringify(selected.event)}`);
  }
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, events, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, events, blobPool, 'index');

  const material = findMaterialBinding(selected, groups, layouts, textures, textureViews, samplers, initialData, events, blobPool);
  if (material === undefined) throw new Error('selected custom mesh draw has no material binding');
  const materialBytes = bufferBytes(material.materialBuffer, initialData, events, blobPool);
  if (materialBytes === undefined || !asBytes(materialBytes).some((value) => value !== 0)) {
    throw new Error('selected custom mesh material uniform buffer is empty');
  }
  const textureBytes = textureBytesFor(material.texture, initialData, events, blobPool);
  if (textureBytes === undefined || !asBytes(textureBytes).some((value) => value !== 0)) {
    throw new Error('selected custom mesh texture upload is empty');
  }

  const drawOrdinal = draws.indexOf(selected);
  const attributes = ['position', 'normal', 'uv', 'tangent'];
  console.log(
    `[bevy generate_custom_mesh] semantic selector attributes=${attributes.join(',')} ` +
      `materialBuffer=${material.materialBuffer} texture=${material.texture} sampler=${material.sampler} drawOrdinal=${drawOrdinal}`,
  );
  return {
    drawOrdinal,
    attributes,
    materialBuffer: material.materialBuffer,
    texture: material.texture,
    sampler: material.sampler,
  };
}

function hasCustomMeshPipeline(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const byLocation = new Map(attributes.map((attribute) => [attribute.shaderLocation, attribute.format]));
  return (
    byLocation.get(0) === 'float32x3' &&
    byLocation.get(1) === 'float32x3' &&
    byLocation.get(2) === 'float32x2' &&
    byLocation.get(3) === 'float32x4' &&
    pipeline?.desc?.primitive?.topology === 'triangle-list' &&
    pipeline?.desc?.fragment?.targets?.length === 1
  );
}

function findMaterialBinding(draw, groups, layouts, textures, textureViews, samplers, initialData, events, blobPool) {
  for (const bindGroupSet of draw.bindGroups.values()) {
    const group = groups.get(bindGroupSet.bindGroupHandleId);
    if (group === undefined || layouts.get(group.layoutHandleId)?.desc?.label !== 'pbr-material-skylight-bgl') continue;
    const materialBuffer = resourceAt(group, 0);
    const sampler = resourceAt(group, 1);
    const textureView = resourceAt(group, 2);
    if (
      materialBuffer?.resourceKind !== 'buffer' ||
      sampler?.resourceKind !== 'sampler' ||
      textureView?.resourceKind !== 'textureView'
    ) continue;
    const samplerEvent = samplers.get(sampler.resourceHandleId);
    const viewEvent = textureViews.get(textureView.resourceHandleId);
    const textureEvent = viewEvent === undefined ? undefined : textures.get(viewEvent.sourceHandleId);
    if (
      samplerEvent === undefined ||
      textureEvent === undefined ||
      textureEvent.desc?.size?.width !== 64 ||
      textureEvent.desc?.size?.height !== 64 ||
      !['rgba8unorm', 'rgba8unorm-srgb'].includes(textureEvent.desc?.format) ||
      bufferBytes(materialBuffer.resourceHandleId, initialData, events, blobPool) === undefined
    ) continue;
    return {
      materialBuffer: materialBuffer.resourceHandleId,
      sampler: sampler.resourceHandleId,
      texture: textureEvent.handleId,
    };
  }
  return undefined;
}

function resourceAt(group, binding) {
  const index = group.entries.findIndex((entry) => entry.binding === binding);
  if (index < 0) return undefined;
  const entry = group.entries[index];
  const resourceHandleId = group.resourceHandleIds[index];
  return resourceHandleId === undefined ? undefined : { ...entry, resourceHandleId };
}

function bufferBytes(handleId, initialData, events, blobPool) {
  const write = [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size >= 16);
  if (write !== undefined) return blobPool.get(write.dataHash);
  const seed = initialData.get(handleId);
  return seed === undefined ? undefined : blobPool.get(seed.dataHash);
}

function textureBytesFor(handleId, initialData, events, blobPool) {
  const write = [...events].reverse().find((event) => event.kind === 'writeTexture' && event.destination?.textureHandleId === handleId);
  if (write !== undefined) return blobPool.get(write.dataHash);
  const seed = initialData.get(handleId);
  return seed === undefined ? undefined : blobPool.get(seed.dataHash);
}

function assertNonEmptyBuffer(handleId, initialData, events, blobPool, label) {
  const blob = bufferBytes(handleId, initialData, events, blobPool);
  const bytes = blob === undefined ? undefined : asBytes(blob);
  if (bytes === undefined || bytes.byteLength === 0 || !bytes.some((value) => value !== 0)) {
    throw new Error(`selected custom mesh ${label} buffer has no non-zero captured data`);
  }
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
