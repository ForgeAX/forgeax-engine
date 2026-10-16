#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { collectRhiDebugDraws, runRhiDebugBrowserAdmission } from '../../../shared/scripts/rhi-debug-browser-admission.mjs';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..', '..', '..', '..');
const appDir = dirname(scriptsDir);
const packageName = '@forgeax/bevy-component-hooks';

if (process.env.COMPONENT_HOOKS_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy component_hooks public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareComponentHooksCapture',
    appDir,
    assertTape: ({ tape }) => assertComponentHooksTape({ events: tape.events, blobPool: tape.blobPool }),
  });
  process.exit(0);
}

let vite;
let browser;
let appUrl;
let stopping = false;
const errors = [];
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  vite = spawn('pnpm', ['-F', '@forgeax/bevy-component-hooks', 'dev'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  vite.stdout.on('data', (chunk) => {
    if (stopping) return;
    const text = String(chunk);
    process.stdout.write(`[vite] ${text}`);
    appUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  vite.stderr.on('data', (chunk) => { if (!stopping) process.stderr.write(`[vite-err] ${chunk}`); });
  await waitFor(() => appUrl !== undefined, 'Vite dev server');
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon.ico')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => Boolean(globalThis.__bevyComponentHooksReady)), 'component hooks app');
  await sleep(2_500);
  const state = await page.evaluate(() => globalThis.__bevyComponentHooksState?.());
  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`);
  if (!state || state.add !== 2 || state.insert !== 3 || state.discard !== 2 || state.remove !== 1 || state.indexSize !== 1 || state.rekey !== 3 || state.remaining !== 0) {
    throw new Error(`invalid component hook state: ${JSON.stringify(state)}`);
  }
  console.log(`[smoke] PASS - browser ready, state=${JSON.stringify(state)}`);
} finally {
  await browser?.close();
  stopping = true;
  vite?.kill();
}

const publicExit = await runPublicCaptureFrame();
if (publicExit !== 0) process.exit(publicExit);

await runRhiDebugBrowserAdmission({
  pkg: packageName,
  label: 'bevy component_hooks',
  readyHook: '__bevyComponentHooksReady',
  capturePrepareHook: '__prepareComponentHooksCapture',
  screenshotPath: resolve(appDir, 'artifacts', 'component-hooks-rhi-debug.png'),
  triggerLabel: 'component-hooks-public-trigger',
  assertTape: ({ events, blobPool }) => assertComponentHooksTape({ events, blobPool }),
  formatCapture: ({ capture, selected, inspected }) =>
    `${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} ` +
    `markerDraws=${selected.markerDraws} sceneIds=${selected.sceneIds.join(',')} materialIds=${selected.materialIds.join(',')}`,
});

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: repoRoot,
      env: { ...process.env, COMPONENT_HOOKS_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function assertComponentHooksTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectRhiDebugDraws(events);
  const markerDraws = draws.filter(({ event, pass, pipeline, vertexBuffer, indexBuffer, bindGroups }) => {
    const viewSet = bindGroups.get(0);
    const materialSet = bindGroups.get(1);
    return (
      event.kind === 'drawIndexed' &&
      event.indexCount === 36 &&
      event.instanceCount > 0 &&
      vertexBuffer !== undefined &&
      indexBuffer !== undefined &&
      ['uint16', 'uint32'].includes(indexBuffer.format) &&
      pass?.colorAttachmentViewHandleIds?.length === 1 &&
      pipeline?.desc?.primitive?.topology === 'triangle-list' &&
      viewSet !== undefined &&
      materialSet !== undefined &&
      groups.has(viewSet.bindGroupHandleId) &&
      groups.has(materialSet.bindGroupHandleId)
    );
  });
  if (markerDraws.length !== 2) {
    throw new Error(`expected two component-hook marker draws, got ${markerDraws.length} of ${draws.length} draws`);
  }

  for (const draw of markerDraws) {
    assertNonEmptyBuffer(draw.vertexBuffer.bufferHandleId, initialData, events, blobPool, 'vertex');
    assertNonEmptyBuffer(draw.indexBuffer.bufferHandleId, initialData, events, blobPool, 'index');
  }

  const materialGroup = groups.get(markerDraws[0].bindGroups.get(1).bindGroupHandleId);
  const materialLayout = materialGroup === undefined ? undefined : layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') {
    throw new Error('component-hook marker draws are missing the canonical material bind group');
  }
  const materialBuffer = materialGroup.resourceHandleIds[0];
  if (materialBuffer === undefined) throw new Error('component-hook material bind group has no uniform buffer');
  const materialOffsets = markerDraws.map((draw) => draw.bindGroups.get(1).dynamicOffsets?.[0]);
  if (
    materialOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) ||
    new Set(materialOffsets).size !== 2
  ) {
    throw new Error(`component-hook marker materials do not have two aligned dynamic slices: ${JSON.stringify(materialOffsets)}`);
  }
  const materialBytes = latestBufferBytes(materialBuffer, events, blobPool);
  if (materialBytes === undefined) throw new Error('component-hook material uniform upload is missing');
  const materialIds = materialOffsets.map((offset) => {
    const rgba = readFloats(materialBytes, offset, 4);
    if (rgba === undefined || rgba.some((value) => !Number.isFinite(value)) || rgba[3] <= 0) {
      throw new Error(`component-hook material slice ${offset} is empty or invalid`);
    }
    return `material:${offset}:${rgba.map((value) => Number(value.toFixed(4))).join(',')}`;
  });
  if (new Set(materialIds).size !== 2) {
    throw new Error(`component-hook marker material slices are not distinct: ${JSON.stringify(materialIds)}`);
  }

  // The color pass reuses a mutable JS offset array while the RHI recorder
  // serializes it. The shadow pass uses fresh arrays and therefore provides
  // the per-marker scene-slot identity without trusting cached bind-group IDs.
  const sceneDraws = draws.filter(({ event, pass, pipeline, vertexBuffer, indexBuffer, bindGroups }) => {
    const meshSet = bindGroups.get(2);
    return (
      event.kind === 'drawIndexed' &&
      event.indexCount === 36 &&
      event.instanceCount > 0 &&
      vertexBuffer !== undefined &&
      indexBuffer !== undefined &&
      ['uint16', 'uint32'].includes(indexBuffer.format) &&
      pass?.colorAttachmentViewHandleIds?.length === 0 &&
      pipeline?.desc?.primitive?.topology === 'triangle-list' &&
      meshSet !== undefined &&
      groups.has(meshSet.bindGroupHandleId)
    );
  });
  if (sceneDraws.length !== 2) {
    throw new Error(`expected two component-hook scene draws, got ${sceneDraws.length} shadow draws`);
  }
  const sceneOffsets = sceneDraws.map((draw) => draw.bindGroups.get(2).dynamicOffsets?.[0]);
  if (
    sceneOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) ||
    new Set(sceneOffsets).size !== 2
  ) {
    throw new Error(`component-hook marker scenes do not have two aligned mesh slots: ${JSON.stringify(sceneOffsets)}`);
  }
  const meshGroup = groups.get(sceneDraws[0].bindGroups.get(2).bindGroupHandleId);
  const meshBuffer = meshGroup?.resourceHandleIds[0];
  if (meshBuffer === undefined) throw new Error('component-hook scene bind group has no mesh buffer');
  const meshBytes = latestBufferBytes(meshBuffer, events, blobPool);
  if (meshBytes === undefined) throw new Error('component-hook mesh scene upload is missing');
  const sceneIds = sceneOffsets.map((offset) => {
    const matrix = readFloats(meshBytes, offset, 16);
    if (matrix === undefined || matrix.some((value) => !Number.isFinite(value))) {
      throw new Error(`component-hook scene slot ${offset} is empty or invalid`);
    }
    const translation = matrix.slice(12, 15).map((value) => Number(value.toFixed(3)));
    if (translation.every((value) => value === 0)) {
      throw new Error(`component-hook scene slot ${offset} has an identity translation`);
    }
    return `scene:${offset}:${translation.join(',')}`;
  });
  if (new Set(sceneIds).size !== 2) {
    throw new Error(`component-hook marker scene slots are not distinct: ${JSON.stringify(sceneIds)}`);
  }
  const drawOrdinal = draws.indexOf(markerDraws[0]);
  console.log(`[bevy component_hooks] semantic selector markerDraws=2 drawOrdinal=${drawOrdinal} sceneIds=${sceneIds.join(',')} materialIds=${materialIds.join(',')}`);
  return { drawOrdinal, markerDraws: markerDraws.length, sceneIds, materialIds };
}

function assertNonEmptyBuffer(handleId, initialData, events, blobPool, label) {
  const bytes = latestBufferBytes(handleId, events, blobPool) ?? initialBufferBytes(handleId, initialData, blobPool);
  if (bytes === undefined || bytes.every((value) => value === 0)) {
    throw new Error(`component-hook ${label} buffer ${handleId} is empty`);
  }
}

function latestBufferBytes(handleId, events, blobPool) {
  const write = [...events].reverse().find(
    (event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size > 0,
  );
  return write === undefined ? undefined : asBytes(blobPool.get(write.dataHash));
}

function initialBufferBytes(handleId, initialData, blobPool) {
  const seed = initialData.get(handleId);
  return seed === undefined ? undefined : asBytes(blobPool.get(seed.dataHash));
}

function readFloats(bytes, byteOffset, count) {
  const raw = asBytes(bytes);
  if (raw === undefined || !Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + count * 4 > raw.byteLength) return undefined;
  const aligned = raw.byteOffset % 4 === 0 ? raw : Uint8Array.from(raw);
  return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset + byteOffset, count));
}

function asBytes(value) {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}
