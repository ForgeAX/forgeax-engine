// Shared Chromium admission for the single raw .rhitape browser path.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DEV_LIVE = resolve(REPO_ROOT, 'scripts/dev-live.mjs');
const RAW_TAPE_ROUTE = '/__forgeax-debug/tape';
const RHITAPE_MIME = 'application/x-forgeax-rhitape';

/** @param {BrowserAdmissionOptions} options */
export async function runRhiDebugBrowserAdmission(options) {
  const {
    pkg,
    label,
    readyHook,
    capturePrepareHook,
    screenshotPath,
    assertTape,
    formatCapture,
  } = options;
  const bridgePort = await findFreePort();
  const dev = spawn(process.execPath, [DEV_LIVE, pkg], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FORGEAX_ENGINE_BRIDGE_PORT: String(bridgePort),
      FORGEAX_ENGINE_RHI_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let url;
  dev.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(`[dev-live] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live:err] ${String(chunk)}`));

  let browser;
  try {
    url = await waitForUrl(dev, () => url, output);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
      ],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction((hook) => globalThis[hook] === true, readyHook, { timeout: 20_000 });
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.log(`[${label}] browser screenshot=${screenshotPath}`);

    const hasGpu = await page.evaluate(() => navigator.gpu !== undefined);
    if (!hasGpu) {
      console.log(`[${label}] ENVIRONMENT_BLOCKED -- Chromium has no navigator.gpu`);
      return { status: 'environment-blocked', reason: 'webgpu-unavailable' };
    }

    const health = await waitForRemoteHealth(bridgePort);
    if (health.pageConnected !== true) {
      throw new Error(`remote-live page did not connect: ${JSON.stringify(health)}`);
    }
    const prep = await remoteEval(
      bridgePort,
      '(async () => { const updated = world.update(1 / 60); if (!updated.ok) throw updated.error; const drawn = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }); if (!drawn.ok) throw drawn.error; return { updated: true, drawn: true }; })()',
    );
    if (prep.updated !== true || prep.drawn !== true) {
      throw new Error(`remote-live capture preparation failed: ${JSON.stringify(prep)}`);
    }

    const publicCapture = await captureAndUpload(page, capturePrepareHook);
    await verifyCaptured({ label, captureLabel: 'public capture', capture: publicCapture, assertTape, formatCapture });

    const remoteCapture = await remoteEval(bridgePort, captureExpression(capturePrepareHook));
    await verifyCaptured({ label, captureLabel: 'remote capture', capture: remoteCapture, assertTape, formatCapture });

    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[${label}] Browser admission + raw upload + strict decode PASS`);
    await page.close();
    return { status: 'passed' };
  } finally {
    await browser?.close();
    dev.kill('SIGTERM');
    await sleep(500);
  }
}

export function collectRhiDebugDraws(events) {
  const groups = new Map();
  const layouts = new Map();
  const pipelines = new Map();
  const initialData = new Map();
  const draws = [];
  let pass;
  let pipeline;
  let bindGroups = new Map();
  let vertexBuffer;
  let indexBuffer;
  for (const event of events) {
    if (event.kind === 'createBindGroup') groups.set(event.handleId, event);
    else if (event.kind === 'createBindGroupLayout') layouts.set(event.handleId, event);
    else if (event.kind === 'createRenderPipeline') pipelines.set(event.handleId, event);
    else if (event.kind === 'initialData') initialData.set(event.handleId, event);
    else if (event.kind === 'beginRenderPass') {
      pass = event;
      bindGroups = new Map();
      pipeline = undefined;
      vertexBuffer = undefined;
      indexBuffer = undefined;
    } else if (event.kind === 'setPipeline') pipeline = pipelines.get(event.pipelineHandleId);
    else if (event.kind === 'setBindGroup') bindGroups.set(event.index, event);
    else if (event.kind === 'setVertexBuffer') vertexBuffer = event;
    else if (event.kind === 'setIndexBuffer') indexBuffer = event;
    else if (event.kind === 'draw' || event.kind === 'drawIndexed') {
      draws.push({ event, pass, pipeline, bindGroups: new Map(bindGroups), vertexBuffer, indexBuffer });
    }
  }
  return { draws, groups, layouts, pipelines, initialData };
}

async function captureAndUpload(page, capturePrepareHook) {
  return page.evaluate(async ({ hook, route, mime }) => {
    if (hook !== undefined) {
      const prepare = globalThis[hook];
      if (typeof prepare !== 'function') throw new Error(`capture preparation hook window.${hook} is not a function`);
      await prepare();
    }
    const capture = await globalThis.__forgeax?.captureFrame();
    if (!capture?.ok) throw new Error(`captureFrame failed: ${JSON.stringify(capture?.error)}`);
    const runId = `browser-${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`;
    const response = await fetch(`${location.origin}${route}?runId=${runId}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: new Blob([capture.value.bytes]),
    });
    const artifact = await response.json();
    if (!response.ok) throw new Error(`raw tape upload failed: ${JSON.stringify(artifact)}`);
    return { ...artifact, runId };
  }, { hook: capturePrepareHook, route: RAW_TAPE_ROUTE, mime: RHITAPE_MIME });
}

function captureExpression(capturePrepareHook) {
  const hook = JSON.stringify(capturePrepareHook);
  return `(async () => {
    const prepare = globalThis[${hook}];
    if (typeof prepare !== 'function') throw new Error('capture preparation hook is unavailable');
    await prepare();
    const capture = await globalThis.__forgeax?.captureFrame();
    if (!capture?.ok) throw new Error('remote captureFrame failed');
    const runId = 'remote-' + Date.now() + '-' + crypto.randomUUID().replaceAll('-', '');
    const response = await fetch(location.origin + '${RAW_TAPE_ROUTE}?runId=' + runId, {
      method: 'POST',
      headers: { 'content-type': '${RHITAPE_MIME}' },
      body: new Blob([capture.value.bytes]),
    });
    const artifact = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(artifact));
    return { ...artifact, runId };
  })()`;
}

async function waitForUrl(child, readUrl, initialOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = readUrl();
    if (value !== undefined) return value;
    if (child.exitCode !== null) throw new Error(`dev-live exited before Vite was ready: ${initialOutput}`);
    await sleep(100);
  }
  throw new Error(`dev-live did not publish a Vite URL: ${initialOutput}`);
}

async function waitForRemoteHealth(port) {
  const remote = resolve(REPO_ROOT, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [remote, '--health'], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: String(port) },
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const health = JSON.parse(result.stdout);
      if (health.pageConnected === true) return health;
    }
    await sleep(250);
  }
  throw new Error('remote-live bridge did not report pageConnected=true');
}

async function remoteEval(port, code) {
  const remote = resolve(REPO_ROOT, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
  const result = spawnSync(process.execPath, [remote, code], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: String(port) },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`remote-live failed: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) throw new Error(`remote-live returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function verifyCaptured({ label, captureLabel, capture, assertTape, formatCapture }) {
  if (capture?.kind !== 'rhi-tape' || typeof capture.path !== 'string' || typeof capture.digest !== 'string') {
    throw new Error(`${captureLabel} returned an incomplete raw artifact: ${JSON.stringify(capture)}`);
  }
  const bytes = new Uint8Array(readFileSync(capture.path));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== capture.digest) throw new Error(`${captureLabel} digest mismatch: ${capture.digest} != ${digest}`);
  const decoded = decodeTape(bytes);
  if (!decoded.ok) throw new Error(`${captureLabel} strict decode failed: ${decoded.error.code}`);
  const tape = decoded.value;
  const blobPool = new Map(tape.blobs.map((blob) => [blob.hash, blob.bytes]));
  const selected = assertTape?.({ events: tape.events, blobPool }) ?? {
    drawOrdinal: lastDrawOrdinal(tape.events),
  };
  const model = buildFrameModel(tape);
  const drawOrdinal = selected.drawOrdinal ?? lastDrawOrdinal(tape.events);
  const draw = tape.events.filter((event) => event.kind === 'draw' || event.kind === 'drawIndexed')[drawOrdinal];
  const bindings = tape.events.filter((event) => event.kind === 'setBindGroup');
  if (draw === undefined || bindings.length === 0 || model.works.length === 0) {
    throw new Error(`${captureLabel} model missing binding/draw state`);
  }
  const drawCall = draw.kind === 'drawIndexed'
    ? { indexCount: draw.indexCount, instanceCount: draw.instanceCount }
    : { indexCount: draw.vertexCount, instanceCount: draw.instanceCount };
  const inspected = { bindings, drawCall, rt: capture.path };
  const details = formatCapture?.({ label: captureLabel, capture, selected, inspected }) ??
    `events=${tape.events.length} draws=${model.works.filter((work) => work.kind === 'draw' || work.kind === 'drawIndexed').length} works=${model.works.length}`;
  console.log(`[${label}] ${captureLabel} raw artifact + strict decode PASS ${details}`);
}

function lastDrawOrdinal(events) {
  let ordinal = -1;
  for (const event of events) {
    if (event.kind === 'draw' || event.kind === 'drawIndexed') ordinal += 1;
  }
  return ordinal;
}

async function findFreePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  server.close();
  if (port === undefined) throw new Error('could not allocate a remote-live bridge port');
  return port;
}
