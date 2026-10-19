#!/usr/bin/env node
import { encodePng } from '@forgeax/engine-image/png';
// Real Chrome/WebGPU M3 live pipeline evidence for Learn Render 4.5.
// The page already owns the public installPipelineByKey, resize listener, and
// RHI-debug capture hook; this smoke drives those browser-visible surfaces.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


import { buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../../shared/scripts/rhi-debug-verify.mjs';
import { createOwnedProcessGroupStopper } from '../../../../shared/scripts/rhi-debug-process.mjs';
import { extractViteLocalUrl } from './vite-local-url.mjs';
import { pnpmCommand } from '../../../../../scripts/lib/pnpm-command.mjs';
import browserLaunchConfig from '../../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { resolveBrowserWebGpuLaunch } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const { PNG } = createRequire(resolve(APP_ROOT, 'package.json'))('pngjs');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-browser-live'),
);
const RAW_TAPE_ROUTE = '/__forgeax-debug/tape';
const RHITAPE_MIME = 'application/x-forgeax-rhitape';
const VITE_READY_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_RHI_DEBUG_VITE_READINESS_TIMEOUT_MS ?? '120000', 10) || 120_000, 1),
  180_000,
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const [manager, ...managerArgs] = pnpmCommand();
const viteProc = spawn(manager, [...managerArgs, '-F', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'dev'], {
  cwd: REPO_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopVite = createOwnedProcessGroupStopper(viteProc);
let portUrl;
let viteOutput = '';
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput = `${viteOutput}${text}`.slice(-8192);
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= extractViteLocalUrl(viteOutput)?.replace(/\/$/, '');
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function decodePixels(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function pixelStats(pixels) {
  let nonBlack = 0;
  let maxChannel = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const max = Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (max > 16) nonBlack++;
    maxChannel = Math.max(maxChannel, max);
  }
  return { nonBlack, maxChannel };
}

function changedPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) return null;
  let changed = 0;
  for (let i = 0; i < before.pixels.length; i += 4) {
    const delta = Math.abs((before.pixels[i] ?? 0) - (after.pixels[i] ?? 0))
      + Math.abs((before.pixels[i + 1] ?? 0) - (after.pixels[i + 1] ?? 0))
      + Math.abs((before.pixels[i + 2] ?? 0) - (after.pixels[i + 2] ?? 0));
    if (delta > 12) changed++;
  }
  return changed;
}

function writeCapturePng(label, capture) {
  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  writeFileSync(path, encodePng(capture.width, capture.height, capture.pixels));
  return path;
}

async function captureCanvasScreenshot(page, label) {
  const bytes = await page.locator('#app').screenshot();
  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  writeFileSync(path, bytes);
  return { png: PNG.sync.read(bytes), path };
}

function changedPngPixels(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    return before.width * before.height + after.width * after.height;
  }
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    if (
      before.data[i] !== after.data[i] ||
      before.data[i + 1] !== after.data[i + 1] ||
      before.data[i + 2] !== after.data[i + 2] ||
      before.data[i + 3] !== after.data[i + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

function resolveArtifact(path) {
  if (typeof path !== 'string') throw new Error('capture path is not a string');
  if (path.startsWith('/')) return path;
  const inApp = resolve(APP_ROOT, path);
  if (existsSync(inApp)) return inApp;
  return resolve(REPO_ROOT, path);
}

async function capture(page, label) {
  const result = await page.evaluate(async ({ route, mime }) => {
    const captureFrame = globalThis.__forgeax?.captureFrame;
    const readPixels = globalThis.__captureFramebuffers;
    if (typeof captureFrame !== 'function') throw new Error('window.__forgeax.captureFrame is unavailable');
    if (typeof readPixels !== 'function') throw new Error('window.__captureFramebuffers is unavailable');
    const capture = await captureFrame();
    if (!capture?.ok) throw new Error(`captureFrame failed: ${JSON.stringify(capture?.error)}`);
    const runId = `m3-live-${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`;
    const response = await fetch(`${location.origin}${route}?runId=${runId}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: new Blob([capture.value.bytes], { type: 'application/x-forgeax-rhitape' }),
    });
    const artifact = await response.json();
    if (!response.ok) throw new Error(`raw tape upload failed: ${JSON.stringify(artifact)}`);
    const raw = await readPixels();
    const pixels = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < pixels.length; i += chunk) {
      binary += String.fromCharCode(...pixels.subarray(i, i + chunk));
    }
    const canvas = document.querySelector('#app');
    return {
      tape: { ...artifact, runId },
      pixelsB64: btoa(binary),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      hud: document.querySelector('#hud')?.textContent ?? '',
    };
  }, { route: RAW_TAPE_ROUTE, mime: RHITAPE_MIME });
  const pixels = decodePixels(result.pixelsB64);
  if (result.width <= 0 || result.height <= 0 || pixels.length !== result.width * result.height * 4) {
    throw new Error(`invalid ${label} capture dimensions: ${JSON.stringify(result)}`);
  }
  const value = {
    width: result.width,
    height: result.height,
    hud: result.hud,
    pixels,
    tape: result.tape,
  };
  const pngPath = writeCapturePng(label, value);
  return { ...value, pngPath, stats: pixelStats(pixels) };
}

async function publicSwitchCapture(page, method, label, { driveFrame = false } = {}) {
  const result = await page.evaluate(async ({ methodName, driveFrame: shouldDriveFrame }) => {
    const api = globalThis.__learnRenderFramebuffers;
    const captureFrame = globalThis.__captureFramebuffers;
    const readPixels = globalThis.__captureFramebuffers;
    if (api === undefined || typeof captureFrame !== 'function' || typeof readPixels !== 'function') {
      throw new Error('public framebuffers recovery seam is unavailable');
    }
    const install = api[methodName]();
    const raw = shouldDriveFrame ? await captureFrame() : await readPixels();
    const pixels = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < pixels.length; i += chunk) {
      binary += String.fromCharCode(...pixels.subarray(i, i + chunk));
    }
    const canvas = document.querySelector('#app');
    return {
      install,
      pixelsB64: btoa(binary),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      hud: document.querySelector('#hud')?.textContent ?? '',
      state: api.getState(),
    };
  }, { methodName: method, driveFrame });
  const pixels = decodePixels(result.pixelsB64);
  if (result.width <= 0 || result.height <= 0 || pixels.length !== result.width * result.height * 4) {
    throw new Error(`invalid ${label} capture dimensions: ${result.width}x${result.height}`);
  }
  const value = {
    width: result.width,
    height: result.height,
    hud: result.hud,
    pixels,
    tape: null,
    state: result.state,
    install: result.install,
  };
  const pngPath = writeCapturePng(label, value);
  return { ...value, pngPath, stats: pixelStats(pixels) };
}

try {
  const deadline = Date.now() + VITE_READY_TIMEOUT_MS;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error(`vite did not become ready in ${VITE_READY_TIMEOUT_MS}ms`);

  const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunchConfig.channel;
  const browserHeadless = !['0', 'false'].includes(
    (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
  );
  const browser = await chromium.launch({
    headless: browserHeadless,
    ...(chromeChannel === undefined ? {} : { channel: chromeChannel }),
    args: resolveBrowserWebGpuLaunch().args,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
    });

    await page.goto(`${portUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(
      () => document.querySelector('#hud')?.textContent === 'passthrough'
        && (document.querySelector('#app')?.getAttribute('width') ?? '') !== '0',
      undefined,
      { timeout: 60_000 },
    );
    // The HUD and canvas dimensions come from index.html before the async
    // createApp/bootstrap path finishes. Wait for the demo's public capture
    // seam so the first sample cannot race renderer setup.
    await page.waitForFunction(
      () => typeof globalThis.__captureFramebuffers === 'function',
      undefined,
      { timeout: 90_000 },
    );
    await page.waitForTimeout(500);

    const baseline = await capture(page, 'pipeline-passthrough');
    const paused = await page.evaluate(() => globalThis.__learnRenderFramebuffers?.pause());
    if (paused?.ok !== true) throw new Error(`recovery pause failed: ${JSON.stringify(paused)}`);
    // Use the compositor-visible canvas for the no-submit assertion. Chrome's
    // createImageBitmap readback returns black after a WebGPU current texture
    // expires without a replacement submission, while the visible canvas still
    // retains the last healthy frame.
    const healthyCanvas = await captureCanvasScreenshot(page, 'pipeline-healthy-canvas');
    const invalidFormat = await publicSwitchCapture(
      page,
      'installInvalidFormatPipeline',
      'pipeline-invalid-format',
      { driveFrame: true },
    );
    const invalidFormatCanvas = await captureCanvasScreenshot(page, 'pipeline-invalid-format-canvas');
    const cycle = await publicSwitchCapture(page, 'installCyclePipeline', 'pipeline-cycle-fault');
    const cycleCanvas = await captureCanvasScreenshot(page, 'pipeline-cycle-fault-canvas');
    const repaired = await publicSwitchCapture(page, 'installRepairedPipeline', 'pipeline-cycle-repaired');
    const repairedCanvas = await captureCanvasScreenshot(page, 'pipeline-cycle-repaired-canvas');
    const resumed = await page.evaluate(() => globalThis.__learnRenderFramebuffers?.resume());
    if (resumed?.ok !== true) throw new Error(`recovery resume failed: ${JSON.stringify(resumed)}`);
    await page.keyboard.press('2');
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent === 'inversion', undefined, { timeout: 10_000 });
    await page.waitForTimeout(500);
    const inversion = await capture(page, 'pipeline-inversion');
    const inversionCanvas = await captureCanvasScreenshot(page, 'pipeline-inversion-canvas');

    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#app');
        return canvas instanceof HTMLCanvasElement && canvas.width === 640 && canvas.height === 360;
      },
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500);
    const resized = await capture(page, 'pipeline-inversion-resized');

    await page.keyboard.press('6');
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent === 'edge-detection', undefined, { timeout: 10_000 });
    await page.waitForTimeout(500);
    const edge = await capture(page, 'pipeline-edge-resized');
    const cleanup = await page.evaluate(() => {
      const api = globalThis.__learnRenderFramebuffers;
      if (api === undefined) throw new Error('public framebuffers recovery seam is unavailable');
      return { first: api.dispose(), second: api.dispose(), state: api.getState() };
    });

    const switchDelta = changedPixels(baseline, inversion);
    const edgeDelta = changedPixels(resized, edge);
    const tapePath = resolveArtifact(edge.tape?.path);
    const rhiDir = resolve(ARTIFACT_DIR, 'rhi');
    mkdirSync(rhiDir, { recursive: true });
    const retainedTape = resolve(rhiDir, 'edge-frame.tape.bin');
    copyFileSync(tapePath, retainedTape);
    const tapeBytes = new Uint8Array(readFileSync(retainedTape));
    const digest = `sha256:${createHash('sha256').update(tapeBytes).digest('hex')}`;
    if (edge.tape?.digest !== digest) throw new Error(`raw tape digest mismatch: ${edge.tape?.digest} != ${digest}`);
    const decoded = decodeTape(tapeBytes);
    if (!decoded.ok) throw new Error(`strict v7 decode failed: ${decoded.error.code}`);
    const tape = decoded.value;
    const model = buildFrameModel(tape);
    if (model.works.length === 0) throw new Error('decoded tape has no work entries');
    const inspectedWork = model.works.length - 1;
    const { freshDevice, rhiWebgpu, dispose } = await bootstrapDawn('m3-programmable', tape);
    let inspection;
    let replay;
    try {
      const replayResult = await openReplay(tape, {
        device: freshDevice,
        createShaderModule: rhiWebgpu.createShaderModule,
      });
      if (!replayResult.ok) throw new Error(`openReplay failed: ${replayResult.error.code}`);
      replay = replayResult.value;
      const inspected = await replay.inspectWork(inspectedWork, ['bindings', 'pixels']);
      if (!inspected.ok) throw new Error(`inspectWork(${inspectedWork}) failed: ${inspected.error.code}`);
      inspection = inspected.value;
    } finally {
      try {
        if (replay !== undefined) (await replay.dispose()).unwrap();
      } finally {
        await dispose();
      }
    }
    const drawCount = model.works.filter((work) => work.kind === 'draw' || work.kind === 'drawIndexed').length;
    const summary = {
      workCount: model.works.length,
      passCount: model.passes.length,
      bindingCount: tape.events.filter((event) => event.kind === 'setBindGroup').length,
    };
    const inspect = {
      workIndex: inspection.workIndex,
      eventIndex: inspection.eventIndex,
      passIndex: inspection.passIndex,
      attachment: inspection.attachment === undefined
        ? undefined
        : {
            resourceId: inspection.attachment.resourceId,
            kind: inspection.attachment.kind,
            format: inspection.attachment.format,
            width: inspection.attachment.width,
            height: inspection.attachment.height,
            byteLength: inspection.attachment.bytes.byteLength,
          },
    };
    writeFileSync(resolve(rhiDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(resolve(rhiDir, 'inspect.json'), `${JSON.stringify(inspect, null, 2)}\n`);
    writeFileSync(resolve(ARTIFACT_DIR, 'browser-live.json'), `${JSON.stringify({
      baseline: { width: baseline.width, height: baseline.height, hud: baseline.hud, stats: baseline.stats },
      cycle: {
        install: cycle.install,
        code: cycle.state.cycleDiagnostic?.code,
        detail: cycle.state.cycleDiagnostic?.detail,
        frameStatus: cycle.state.lastFrameStatus,
        activePipelineId: cycle.state.activePipelineId,
        healthyCanvasPixelsChanged: changedPngPixels(healthyCanvas.png, cycleCanvas.png),
      },
      invalidFormat: {
        install: invalidFormat.install,
        diagnostic: invalidFormat.state.invalidFormatDiagnostic,
        activePipelineId: invalidFormat.state.activePipelineId,
        healthyCanvasPixelsChanged: changedPngPixels(healthyCanvas.png, invalidFormatCanvas.png),
      },
      repaired: {
        install: repaired.install,
        activePipelineId: repaired.state.activePipelineId,
        frameStatus: repaired.state.lastFrameStatus,
        recoveredBytes: changedPixels(baseline, repaired),
        recoveredCanvasPixelsChanged: changedPngPixels(healthyCanvas.png, repairedCanvas.png),
      },
      inversion: { width: inversion.width, height: inversion.height, hud: inversion.hud, stats: inversion.stats },
      resized: { width: resized.width, height: resized.height, hud: resized.hud, stats: resized.stats },
      edge: { width: edge.width, height: edge.height, hud: edge.hud, stats: edge.stats },
      switchDelta,
      switchCanvasPixels: changedPngPixels(repairedCanvas.png, inversionCanvas.png),
      edgeDelta,
      tape: retainedTape,
      draws: drawCount,
      inspectedWork,
      cleanup,
    }, null, 2)}\n`);

    await page.close();
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (baseline.hud !== 'passthrough' || inversion.hud !== 'inversion' || edge.hud !== 'edge-detection') {
      throw new Error(`HUD did not track public pipeline switches: ${baseline.hud}, ${inversion.hud}, ${edge.hud}`);
    }
    const cycleDetail = cycle.state.cycleDiagnostic?.detail;
    const expectedFeatureFailure = (diagnostic, mode) =>
      diagnostic?.code === 'render-feature-stage-failed'
      && diagnostic.mode === mode
      && diagnostic.detail?.featureIdentity === 'learn-render-4-5::feature-recovery'
      && diagnostic.detail?.stage === 'plan'
      && diagnostic.detail?.recovery === 'next-frame';
    if (!expectedFeatureFailure(cycle.state.cycleDiagnostic, 'cycle')) {
      throw new Error(`feature-plan diagnostic incomplete: ${JSON.stringify(cycle.state.cycleDiagnostic)}`);
    }
    if (
      invalidFormat.install.ok !== true ||
      !expectedFeatureFailure(invalidFormat.state.invalidFormatDiagnostic, 'invalid-format') ||
      invalidFormat.state.activePipelineId !== 'learn-render-5::passthrough' ||
      changedPngPixels(healthyCanvas.png, invalidFormatCanvas.png) !== 0
    ) {
      throw new Error(`invalid-format recovery evidence incomplete: ${JSON.stringify(invalidFormat)}`);
    }
    if (cycle.state.lastFrameStatus !== 'feature-failed' || changedPngPixels(healthyCanvas.png, cycleCanvas.png) !== 0) {
      throw new Error(`cycle contaminated/submitted: frameStatus=${cycle.state.lastFrameStatus} canvasChanged=${changedPngPixels(healthyCanvas.png, cycleCanvas.png)}`);
    }
    if (repaired.state.lastFrameStatus !== 'healthy') {
      throw new Error(`repaired pipeline evidence incomplete: ${JSON.stringify(repaired.state)}`);
    }
    if (changedPixels(baseline, repaired) !== 0) throw new Error(`repaired pixels did not recover: ${changedPixels(baseline, repaired)}`);
    if (changedPngPixels(healthyCanvas.png, repairedCanvas.png) !== 0) throw new Error(`repaired canvas did not recover: ${changedPngPixels(healthyCanvas.png, repairedCanvas.png)}`);
    if (!cleanup.first.ok || !cleanup.second.ok) throw new Error(`cleanup failed: ${JSON.stringify(cleanup)}`);
    if (switchDelta === null || switchDelta < 1000 || edgeDelta === null || edgeDelta < 1000) {
      throw new Error(`pipeline pixel deltas too small: switch=${switchDelta}, edge=${edgeDelta}`);
    }
    if (changedPngPixels(repairedCanvas.png, inversionCanvas.png) === 0) throw new Error('healthy switch did not change the canvas');
    if (resized.width !== 640 || resized.height !== 360) throw new Error(`resize dimensions wrong: ${resized.width}x${resized.height}`);
    if (drawCount === 0 || inspect.attachment === undefined || summary.bindingCount === 0) {
      throw new Error(`RHI inspect missing draw evidence: draws=${drawCount} bindings=${summary.bindingCount}`);
    }
    console.log(`[m3-programmable] browser live artifacts: baseline=${baseline.pngPath} inversion=${inversion.pngPath} resized=${resized.pngPath} edge=${edge.pngPath}`);
    console.log(`[m3-programmable] browser live RHI: tape=${retainedTape} draws=${drawCount} inspectedWork=${inspectedWork} bindings=${summary.bindingCount}`);
    console.log(`[m24] browser live feature-plan/recovery: PASS feature=render-feature-stage-failed detail=${cycleDetail.featureIdentity}:${cycleDetail.stage} frameStatus=${cycle.state.lastFrameStatus}->${repaired.state.lastFrameStatus} recoveredBytes=0 healthyChangedPixels=${changedPixels(repaired, inversion)} cleanup=idempotent`);
    console.log(`[m3-programmable] browser live pipeline: PASS switchChangedPixels=${switchDelta} edgeChangedPixels=${edgeDelta} resized=${resized.width}x${resized.height}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[m3-programmable] browser live pipeline: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await stopVite();
  await sleep(300);
}
