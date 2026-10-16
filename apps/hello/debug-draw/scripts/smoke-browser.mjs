#!/usr/bin/env node
// hello-debug-draw browser smoke: real createApp(canvas) auto-attach path.
// The normal case proves the runtime overlay reaches a live WebGPU canvas and
// survives a backing/CSS resize; the falsifier runs the same page with shape
// calls disabled and must read zero foreground pixels at both sizes. The
// cap-recovery case keeps one page/device alive while it renders a valid
// prefix, truncates an overflowing frame, and renders a semantically distinct
// next frame.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = process.env.FORGEAX_M31_ARTIFACT_DIR
  ? resolve(process.env.FORGEAX_M31_ARTIFACT_DIR)
  : resolve(HERE, '..', '.forgeax-debug', 'runtime-auto-attach');
const CANVAS_CLIP = { x: 0, y: 64, width: 256, height: 192 };
const RESIZED_CANVAS_CLIP = { x: 0, y: 64, width: 384, height: 192 };
const FOREGROUND_CHANNEL_MIN = 24;
const APP_ROOT = resolve(HERE, '..');
const softwareGraphics = process.platform === 'linux';
// Exact software raster counts verified against main before the worker change.
// Keep the original platform oracle for the native browser path.
const expectedForeground = softwareGraphics
  ? { normal: 1908, resized: 1394 }
  : { normal: 1809, resized: 1320 };

mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn(process.execPath, [resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js')], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let portUrl;
const viteReadiness = observeViteHttpReadiness(viteProc, {
  timeoutEnvName: 'FORGEAX_DEBUG_DRAW_SERVER_READINESS_TIMEOUT_MS',
});

let viteStopStarted = false;
async function stopVite() {
  if (viteStopStarted) return;
  viteStopStarted = true;
  if (viteProc.exitCode === null && viteProc.pid !== undefined) {
    try {
      process.kill(-viteProc.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    await sleep(300);
    if (viteProc.exitCode === null) {
      try {
        process.kill(-viteProc.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
  await sleep(300);
}

async function closeBrowser(browser) {
  let closed = false;
  const closePromise = browser.close().then(() => {
    closed = true;
  });
  await Promise.race([closePromise, sleep(5_000)]);
  if (!closed) {
    browser._connection?.close();
    await sleep(300);
  }
}

function foregroundStats(path) {
  const image = PNG.sync.read(readFileSync(path));
  let foreground = 0;
  let maxChannel = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const channel = Math.max(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
    if (channel >= FOREGROUND_CHANNEL_MIN) foreground++;
    maxChannel = Math.max(maxChannel, channel);
  }
  return { foreground, maxChannel, width: image.width, height: image.height };
}

function colorStats(path) {
  const image = PNG.sync.read(readFileSync(path));
  const counts = { red: 0, green: 0, blue: 0, yellow: 0 };
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i] ?? 0;
    const g = image.data[i + 1] ?? 0;
    const b = image.data[i + 2] ?? 0;
    if (r >= 128 && g < 96 && b < 96) counts.red++;
    if (g >= 128 && r < 96 && b < 96) counts.green++;
    if (b >= 128 && r < 96 && g < 96) counts.blue++;
    if (r >= 128 && g >= 128 && b < 96) counts.yellow++;
  }
  return counts;
}

function parseCapHud(text) {
  const match = text.match(
    /phase=(\w+) cap=(\d+) queued=(\d+) staged=(\d+) draw=(\d+) deviceErrors=(\d+) sameDevice=(\d+) cleanup=(\w+)/,
  );
  if (!match) throw new Error(`cap-recovery HUD did not match contract: ${text}`);
  return {
    phase: match[1],
    cap: Number(match[2]),
    queued: Number(match[3]),
    staged: Number(match[4]),
    draw: Number(match[5]),
    deviceErrors: Number(match[6]),
    sameDevice: Number(match[7]),
    cleanup: match[8],
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const RUNTIME_CONTROLLER_METHODS = [
  'setCameraPan',
  'setCameraViewport',
  'setCameraZoom',
  'setCameraClip',
  'setCameraRoll',
];

async function waitForRuntimeController(page, pageErrors, label) {
  try {
    await page.waitForFunction(
      (methods) => {
        const hud = document.querySelector('#debug-draw-hud')?.textContent ?? '';
        const controller = globalThis.__forgeax_debug_draw__;
        return (
          hud.includes('mode=runtime') &&
          hud.includes('state=ready') &&
          controller !== null &&
          typeof controller === 'object' &&
          methods.every((method) => typeof controller[method] === 'function')
        );
      },
      RUNTIME_CONTROLLER_METHODS,
      { timeout: 10_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const controller = globalThis.__forgeax_debug_draw__;
      return {
        hud: document.querySelector('#debug-draw-hud')?.textContent ?? null,
        controllerKeys:
          controller !== null && typeof controller === 'object'
            ? Object.keys(controller).sort()
            : [],
      };
    });
    const url = page.url();
    throw new Error(
      `debug-draw runtime controller did not become ready: ${JSON.stringify({
        label,
        url,
        mode: new URL(url).searchParams.get('mode'),
        hud: state.hud,
        controllerKeys: state.controllerKeys,
        pageErrors,
        cause: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
}

async function runCase(browser, query, label) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${portUrl}/?mode=runtime${query}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await waitForRuntimeController(page, pageErrors, label);
  await page.waitForTimeout(500);

  const path = resolve(ARTIFACT_DIR, `${label}.png`);
  await page.screenshot({ path, clip: CANVAS_CLIP });

  async function setCameraZoom(mode) {
    await page.evaluate((nextMode) => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.setCameraZoom !== 'function') {
        throw new Error('debug-draw camera zoom controller not found');
      }
      controller.setCameraZoom(nextMode);
    }, mode);
    await page.waitForFunction(
      (expected) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`zoom=${expected}`),
      mode,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(250);
  }

  async function setCameraClip(mode) {
    await page.evaluate((nextMode) => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.setCameraClip !== 'function') {
        throw new Error('debug-draw camera clip controller not found');
      }
      controller.setCameraClip(nextMode);
    }, mode);
    await page.waitForFunction(
      (expected) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`clip=${expected}`),
      mode,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(250);
  }

  async function setCameraRoll(mode) {
    await page.evaluate((nextMode) => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.setCameraRoll !== 'function') {
        throw new Error('debug-draw camera roll controller not found');
      }
      controller.setCameraRoll(nextMode);
    }, mode);
    await page.waitForFunction(
      (expected) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`roll=${expected}`),
      mode,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(250);
  }

  async function setCameraViewport(mode) {
    await page.evaluate((nextMode) => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.setCameraViewport !== 'function') {
        throw new Error('debug-draw camera viewport controller not found');
      }
      controller.setCameraViewport(nextMode);
    }, mode);
    await page.waitForFunction(
      (expected) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`viewport=${expected}`),
      mode,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(250);
  }

  async function setCameraPan(pan) {
    await page.evaluate((nextPan) => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.setCameraPan !== 'function') {
        throw new Error('debug-draw camera controller not found');
      }
      controller.setCameraPan(nextPan);
    }, pan);
    await page.waitForFunction(
      (expected) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`camera=${expected}`),
      pan ? 'pan' : 'base',
      { timeout: 10_000 },
    );
    await page.waitForTimeout(250);
  }

  await setCameraRoll('roll');
  const rollPath = resolve(ARTIFACT_DIR, `${label}-roll.png`);
  await page.screenshot({ path: rollPath, clip: CANVAS_CLIP });
  await setCameraRoll('base');
  await setCameraClip('near');
  const clipNearPath = resolve(ARTIFACT_DIR, `${label}-clip-near.png`);
  await page.screenshot({ path: clipNearPath, clip: CANVAS_CLIP });
  await setCameraClip('far');
  const clipFarPath = resolve(ARTIFACT_DIR, `${label}-clip-far.png`);
  await page.screenshot({ path: clipFarPath, clip: CANVAS_CLIP });
  await setCameraClip('base');
  await setCameraZoom('zoom');
  const zoomPath = resolve(ARTIFACT_DIR, `${label}-zoom.png`);
  await page.screenshot({ path: zoomPath, clip: CANVAS_CLIP });
  await setCameraZoom('base');
  await setCameraViewport('wide');
  const viewportPath = resolve(ARTIFACT_DIR, `${label}-viewport-wide.png`);
  await page.screenshot({ path: viewportPath, clip: CANVAS_CLIP });
  await setCameraViewport('base');
  await setCameraPan(true);
  const panPath = resolve(ARTIFACT_DIR, `${label}-pan.png`);
  await page.screenshot({ path: panPath, clip: CANVAS_CLIP });

  const resized = await page.evaluate(() => {
    const canvas = document.querySelector('#app');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas #app not found');
    canvas.width = 384;
    canvas.height = 192;
    canvas.style.width = '384px';
    canvas.style.height = '192px';
    return { width: canvas.width, height: canvas.height };
  });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('#app');
      return canvas instanceof HTMLCanvasElement && canvas.width === 384 && canvas.height === 192;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  const panResizedPath = resolve(ARTIFACT_DIR, `${label}-pan-resized.png`);
  await page.screenshot({ path: panResizedPath, clip: RESIZED_CANVAS_CLIP });
  await setCameraPan(false);
  const resizedPath = resolve(ARTIFACT_DIR, `${label}-resized.png`);
  await page.screenshot({ path: resizedPath, clip: RESIZED_CANVAS_CLIP });
  await page.close();

  if (pageErrors.length > 0) throw new Error(`${label} page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`${label} console errors: ${consoleErrors.join(' | ')}`);
  return {
    path,
    stats: foregroundStats(path),
    sha256: sha256File(path),
    rollPath,
    rollStats: foregroundStats(rollPath),
    rollSha256: sha256File(rollPath),
    zoomPath,
    zoomStats: foregroundStats(zoomPath),
    zoomSha256: sha256File(zoomPath),
    clipNearPath,
    clipNearStats: foregroundStats(clipNearPath),
    clipNearSha256: sha256File(clipNearPath),
    clipFarPath,
    clipFarStats: foregroundStats(clipFarPath),
    clipFarSha256: sha256File(clipFarPath),
    viewportPath,
    viewportStats: foregroundStats(viewportPath),
    viewportSha256: sha256File(viewportPath),
    panPath,
    panStats: foregroundStats(panPath),
    panSha256: sha256File(panPath),
    panResizedPath,
    panResizedStats: foregroundStats(panResizedPath),
    panResizedSha256: sha256File(panResizedPath),
    resizedPath,
    resizedStats: foregroundStats(resizedPath),
    resizedSha256: sha256File(resizedPath),
    resized,
  };
}

async function runCapRecoveryCase(browser) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  const capWarnings = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      consoleErrors.push(message.text());
    }
    if (message.type() === 'warning' && message.text().includes('MAX_VERTEX_CAPACITY')) {
      capWarnings.push(message.text());
    }
  });

  try {
    await page.goto(`${portUrl}/?mode=cap-recovery`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    async function waitForPhase(expected) {
      await page.waitForFunction(
        (phase) => document.querySelector('#debug-draw-hud')?.textContent?.includes(`phase=${phase}`),
        expected,
        { timeout: 10_000 },
      );
      await page.waitForTimeout(100);
      const hud = await page.locator('#debug-draw-hud').textContent();
      if (!hud) throw new Error(`cap-recovery ${expected} HUD is empty`);
      return parseCapHud(hud);
    }

    async function capture(label, hud) {
      const path = resolve(ARTIFACT_DIR, `cap-recovery-${label}.png`);
      await page.screenshot({ path, clip: CANVAS_CLIP });
      return {
        path,
        hud,
        foreground: foregroundStats(path),
        colors: colorStats(path),
        sha256: sha256File(path),
      };
    }

    const baselineHud = await waitForPhase('baseline');
    const baseline = await capture('baseline', baselineHud);
    await page.evaluate(() => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.advance !== 'function') {
        throw new Error('cap-recovery controller not found');
      }
      return controller.advance();
    });
    const overflowHud = await waitForPhase('overflow');
    const overflow = await capture('overflow', overflowHud);
    await page.evaluate(() => {
      const controller = globalThis.__forgeax_debug_draw__;
      if (!controller || typeof controller.advance !== 'function') {
        throw new Error('cap-recovery controller not found');
      }
      return controller.advance();
    });
    const recoveryHud = await waitForPhase('recovery');
    const recovery = await capture('recovery', recoveryHud);

    for (const [label, stage, expectedQueued, expectedDraw] of [
      ['baseline', baseline, 4, 4],
      ['overflow', overflow, 10, 10],
      ['recovery', recovery, 2, 2],
    ]) {
      if (
        stage.hud.cap !== 10 ||
        stage.hud.queued !== expectedQueued ||
        stage.hud.staged !== 0 ||
        stage.hud.draw !== expectedDraw ||
        stage.hud.draw > stage.hud.cap ||
        stage.hud.deviceErrors !== 0 ||
        stage.hud.sameDevice !== 1
      ) {
        throw new Error(`${label} cap-recovery HUD invariant failed: ${JSON.stringify(stage.hud)}`);
      }
      if (stage.foreground.foreground === 0) {
        throw new Error(`${label} cap-recovery stage rendered no foreground pixels`);
      }
    }
    if (baseline.colors.red === 0 || baseline.colors.green === 0 || baseline.colors.blue !== 0) {
      throw new Error(`baseline did not render the intended red/green prefix: ${JSON.stringify(baseline)}`);
    }
    if (overflow.colors.red === 0 || overflow.colors.green !== 0 || overflow.colors.yellow !== 0) {
      throw new Error(`overflow rendered discarded geometry: ${JSON.stringify(overflow)}`);
    }
    if (recovery.colors.blue === 0 || recovery.colors.red !== 0 || recovery.colors.green !== 0 || recovery.colors.yellow !== 0) {
      throw new Error(`recovery contains stale or discarded geometry: ${JSON.stringify(recovery)}`);
    }
    if (capWarnings.length !== 1) {
      throw new Error(`expected one bounded cap warning, got ${capWarnings.length}: ${capWarnings.join(' | ')}`);
    }
    if (pageErrors.length > 0) throw new Error(`cap-recovery page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`cap-recovery console errors: ${consoleErrors.join(' | ')}`);

    console.log(
      `[smoke-browser] cap-recovery PASS - same page/device baseline=${JSON.stringify(baseline.hud)} overflow=${JSON.stringify(overflow.hud)} recovery=${JSON.stringify(recovery.hud)} warnings=${capWarnings.length} baselineForeground=${baseline.foreground.foreground} overflowForeground=${overflow.foreground.foreground} recoveryForeground=${recovery.foreground.foreground} baselineSha256=${baseline.sha256} overflowSha256=${overflow.sha256} recoverySha256=${recovery.sha256}`,
    );
    return { baseline, overflow, recovery, capWarnings: [...capWarnings] };
  } finally {
    await page.close();
  }
}

function repeatabilitySnapshot(result) {
  return {
    stats: result.stats,
    sha256: result.sha256,
    rollStats: result.rollStats,
    rollSha256: result.rollSha256,
    zoomStats: result.zoomStats,
    zoomSha256: result.zoomSha256,
    clipNearStats: result.clipNearStats,
    clipNearSha256: result.clipNearSha256,
    clipFarStats: result.clipFarStats,
    clipFarSha256: result.clipFarSha256,
    viewportStats: result.viewportStats,
    viewportSha256: result.viewportSha256,
    panStats: result.panStats,
    panSha256: result.panSha256,
    panResizedStats: result.panResizedStats,
    panResizedSha256: result.panResizedSha256,
    resizedStats: result.resizedStats,
    resizedSha256: result.resizedSha256,
    resized: result.resized,
  };
}

function assertEqualSnapshots(label, first, second) {
  const firstJson = JSON.stringify(repeatabilitySnapshot(first));
  const secondJson = JSON.stringify(repeatabilitySnapshot(second));
  if (firstJson !== secondJson) {
    throw new Error(`${label} repeatability mismatch: ${firstJson} !== ${secondJson}`);
  }
}

try {
  const readiness = await viteReadiness.wait();
  portUrl = readiness.origin;

  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? (softwareGraphics ? browserLaunch.channel : 'chrome'),
    args: softwareGraphics ? [...browserLaunch.args, '--use-angle=swiftshader'] : [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });
  try {
    const capRecovery = await runCapRecoveryCase(browser);
    const normal = await runCase(browser, '', 'runtime-1');
    const normalRepeat = await runCase(browser, '', 'runtime-2');
    for (const [label, result] of [
      ['runtime-1', normal],
      ['runtime-2', normalRepeat],
    ]) {
      if (result.stats.foreground !== expectedForeground.normal || result.resizedStats.foreground !== expectedForeground.resized) {
        throw new Error(`${label} foreground oracle mismatch: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.stats.maxChannel < 128 || result.resizedStats.maxChannel < 128) {
        throw new Error(`${label} overlay max channel too low: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.zoomStats.foreground === 0 || result.zoomStats.maxChannel < 128) {
        throw new Error(`${label} zoom removed the overlay: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.zoomSha256 === result.sha256) {
        throw new Error(`${label} camera zoom did not change the rendered image: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.clipNearStats.foreground === 0 || result.clipNearStats.maxChannel < 128) {
        throw new Error(`${label} near clip removed the overlay: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.clipNearSha256 === result.sha256 || result.clipFarSha256 === result.sha256) {
        throw new Error(`${label} camera clip did not change the rendered image: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.rollStats.foreground === 0 || result.rollStats.maxChannel < 128) {
        throw new Error(`${label} camera roll removed the overlay: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.rollSha256 === result.sha256) {
        throw new Error(`${label} camera roll did not change the rendered image: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.viewportStats.foreground === 0 || result.viewportStats.maxChannel < 128) {
        throw new Error(`${label} wide viewport removed the overlay: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.viewportSha256 === result.sha256) {
        throw new Error(`${label} wide viewport did not change the rendered image: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.panStats.foreground === 0 || result.panResizedStats.foreground === 0) {
        throw new Error(`${label} camera pan removed the overlay: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.panSha256 === result.sha256 || result.panResizedSha256 === result.resizedSha256) {
        throw new Error(`${label} camera pan did not change the rendered image: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
      if (result.resized.width !== 384 || result.resized.height !== 192) {
        throw new Error(`resize did not apply to canvas: ${JSON.stringify(result.resized)}`);
      }
    }

    const falsified = await runCase(browser, '&falsify=1', 'runtime-falsified-1');
    const falsifiedRepeat = await runCase(browser, '&falsify=1', 'runtime-falsified-2');
    for (const [label, result] of [
      ['runtime-falsified-1', falsified],
      ['runtime-falsified-2', falsifiedRepeat],
    ]) {
      if (
        result.stats.foreground !== 0 ||
        result.rollStats.foreground !== 0 ||
        result.zoomStats.foreground !== 0 ||
        result.clipNearStats.foreground !== 0 ||
        result.clipFarStats.foreground !== 0 ||
        result.viewportStats.foreground !== 0 ||
        result.panStats.foreground !== 0 ||
        result.panResizedStats.foreground !== 0 ||
        result.resizedStats.foreground !== 0
      ) {
        throw new Error(`${label} produced foreground pixels: ${JSON.stringify(repeatabilitySnapshot(result))}`);
      }
    }
    assertEqualSnapshots('normal', normal, normalRepeat);
    assertEqualSnapshots('falsifier', falsified, falsifiedRepeat);

    console.log(
      `[smoke-browser] artifacts: capBaseline=${capRecovery.baseline.path} capOverflow=${capRecovery.overflow.path} capRecovery=${capRecovery.recovery.path} normal=${normal.path} normalRoll=${normal.rollPath} normalClipNear=${normal.clipNearPath} normalClipFar=${normal.clipFarPath} normalZoom=${normal.zoomPath} normalViewport=${normal.viewportPath} normalPan=${normal.panPath} normalPanResized=${normal.panResizedPath} normalResized=${normal.resizedPath} falsified=${falsified.path} falsifiedRoll=${falsified.rollPath} falsifiedClipNear=${falsified.clipNearPath} falsifiedClipFar=${falsified.clipFarPath} falsifiedZoom=${falsified.zoomPath} falsifiedViewport=${falsified.viewportPath} falsifiedPan=${falsified.panPath} falsifiedPanResized=${falsified.panResizedPath} falsifiedResized=${falsified.resizedPath}`,
    );
    console.log(
      `[smoke-browser] PASS - cap-recovery kept one page/device alive through bounded truncation and cleanup; createApp(canvas) auto-attached app.debugDraw and survived repeatable camera roll, near/far clipping, zoom, viewport/aspect change, pan + live resize; serverReadyElapsedMs=${readiness.elapsedMs}, capWarnings=${capRecovery.capWarnings.length}, capBaselineForeground=${capRecovery.baseline.foreground.foreground}, capOverflowForeground=${capRecovery.overflow.foreground.foreground}, capRecoveryForeground=${capRecovery.recovery.foreground.foreground}, normalForeground=${normal.stats.foreground}, normalRollForeground=${normal.rollStats.foreground}, normalClipNearForeground=${normal.clipNearStats.foreground}, normalClipFarForeground=${normal.clipFarStats.foreground}, normalZoomForeground=${normal.zoomStats.foreground}, normalViewportForeground=${normal.viewportStats.foreground}, normalPanForeground=${normal.panStats.foreground}, normalPanResizedForeground=${normal.panResizedStats.foreground}, normalResizedForeground=${normal.resizedStats.foreground}, falsifiedForeground=${falsified.stats.foreground}, falsifiedRollForeground=${falsified.rollStats.foreground}, falsifiedClipNearForeground=${falsified.clipNearStats.foreground}, falsifiedClipFarForeground=${falsified.clipFarStats.foreground}, falsifiedZoomForeground=${falsified.zoomStats.foreground}, falsifiedViewportForeground=${falsified.viewportStats.foreground}, falsifiedPanForeground=${falsified.panStats.foreground}, falsifiedPanResizedForeground=${falsified.panResizedStats.foreground}, falsifiedResizedForeground=${falsified.resizedStats.foreground}, normalSha256=${normal.sha256}, normalRollSha256=${normal.rollSha256}, normalClipNearSha256=${normal.clipNearSha256}, normalClipFarSha256=${normal.clipFarSha256}, normalZoomSha256=${normal.zoomSha256}, normalViewportSha256=${normal.viewportSha256}, normalPanSha256=${normal.panSha256}, normalPanResizedSha256=${normal.panResizedSha256}, normalResizedSha256=${normal.resizedSha256}, falsifiedSha256=${falsified.sha256}, falsifiedRollSha256=${falsified.rollSha256}, falsifiedClipNearSha256=${falsified.clipNearSha256}, falsifiedClipFarSha256=${falsified.clipFarSha256}, falsifiedZoomSha256=${falsified.zoomSha256}, falsifiedViewportSha256=${falsified.viewportSha256}, falsifiedPanSha256=${falsified.panSha256}, falsifiedPanResizedSha256=${falsified.panResizedSha256}, falsifiedResizedSha256=${falsified.resizedSha256}.`,
    );
  } finally {
    await stopVite();
    await closeBrowser(browser);
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await stopVite();
}
