#!/usr/bin/env node
// Focused browser proof for the static depth-aware calibration scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createOwnedProcessGroupStopper } from '../../shared/scripts/rhi-debug-process.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_DOF_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/depth-of-field'));
const PORT = Number.parseInt(process.env.FORGEAX_DOF_PORT ?? '5199', 10);
const DEFAULT_SERVER_TIMEOUT_MS = 180_000;
const MAX_SERVER_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_DOF_SERVER_TIMEOUT_MS ?? String(DEFAULT_SERVER_TIMEOUT_MS), 10) || DEFAULT_SERVER_TIMEOUT_MS, 1),
  MAX_SERVER_TIMEOUT_MS,
);
const EVIDENCE_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_DOF_EVIDENCE_TIMEOUT_MS ?? String(30_000), 10) || 30_000, 1),
  60_000,
);
const MAX_SERVER_OUTPUT_CHARS = 16_000;
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stopServer = createOwnedProcessGroupStopper(server);
let serverOutput = '';
const appendServerOutput = (chunk) => {
  serverOutput = (serverOutput + chunk.toString()).slice(-MAX_SERVER_OUTPUT_CHARS);
};
server.stdout.on('data', appendServerOutput);
server.stderr.on('data', appendServerOutput);
let serverError;
server.once('error', (error) => { serverError = error; });
let browser;
let browserLaunch;
let page;
const pageErrors = [];
const consoleErrors = [];
const httpFailures = [];
const notFound = [];
const actualUrls = { primary: null };
const screenshotDiagnostics = [];
const cleanupDiagnostics = [];
const startedAt = Date.now();
let stage = 'starting-preview-server';
let cancelled;
let cancellation;

const attachPageDiagnostics = (target, label) => {
  target.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
  target.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      consoleErrors.push(`${label}: ${message.text()}${location ? ` @ ${location}` : ''}`);
    }
  });
  target.on('response', (response) => {
    if (response.status() >= 400) {
      const entry = `${label}: ${response.status()} ${response.url()}`;
      httpFailures.push(entry);
      if (response.status() === 404) notFound.push(response.url());
    }
  });
  target.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText;
    httpFailures.push(`${label}: request failed ${request.url()}${failure ? ` (${failure})` : ''}`);
  });
};

const readPageUrl = (target) => {
  try {
    return target?.url() ?? null;
  } catch {
    return null;
  }
};

const serialiseError = (error) => {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      errors: error.errors.map((cause) => serialiseError(cause)),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: serialiseError(error.cause) }),
    };
  }
  return { name: typeof error, message: String(error) };
};

const readServerExit = () => ({ code: server.exitCode, signal: server.signalCode });

const serverHasStarted = () => /\bready in\b|\bLocal:\s+http/i.test(serverOutput);

const serverHasFailed = () => /error when starting dev server|port .* in use|ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/i.test(serverOutput);

const assertServerAlive = (context) => {
  if (serverError !== undefined) {
    throw new Error(`preview server failed during ${context}: ${serverError.message}; output: ${serverOutput}`);
  }
  if (server.exitCode !== null || server.signalCode !== null) {
    const exit = readServerExit();
    throw new Error(`preview server exited during ${context} (exit ${exit.code}, signal ${exit.signal}); output: ${serverOutput}`);
  }
};

const captureDiagnosticScreenshot = async (target, label) => {
  if (target === undefined || target.isClosed()) return;
  const path = resolve(ARTIFACT_DIR, `failure-${label}.png`);
  try {
    await target.screenshot({ path });
    screenshotDiagnostics.push(path);
  } catch (error) {
    screenshotDiagnostics.push(`${label}: ${String(error)}`);
  }
};

const writeFailureReport = (error, reportStage = stage, cleanupErrors = []) => {
  const report = {
    status: 'failed',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    errorDetails: serialiseError(error),
    stage: reportStage,
    elapsedMs: Date.now() - startedAt,
    serverExit: readServerExit(),
    serverOutput,
    actualUrls: { primary: actualUrls.primary ?? readPageUrl(page) },
    pageErrors,
    consoleErrors,
    httpFailures,
    notFound,
    cleanupErrors,
    cleanupDiagnostics,
    screenshotDiagnostics,
  };
  try {
    writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch (reportError) {
    console.error(`failed to write failure report: ${String(reportError)}`);
  }
};

const cleanupTimeout = async (operation, timeoutMs, label) => {
  const timeout = Symbol(label);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), timeoutMs); }),
    ]);
    if (result === timeout) throw new Error(`${label} cleanup timed out after ${timeoutMs}ms`);
    return result;
  } finally {
    clearTimeout(timer);
  }
};

const closeBrowser = async () => {
  const errors = [];
  const currentPage = page;
  let currentBrowser = browser;
  page = undefined;
  browser = undefined;
  if (currentBrowser === undefined && browserLaunch !== undefined) {
    try {
      currentBrowser = await cleanupTimeout(() => browserLaunch, 10_000, 'browser launch');
    } catch (error) {
      errors.push(new Error('browser launch cleanup failed', { cause: error }));
    }
  }
  for (const [label, close] of [
    ['primary page', () => currentPage && !currentPage.isClosed() && currentPage.close()],
  ]) {
    const started = Date.now();
    try {
      await cleanupTimeout(close, 10_000, label);
      cleanupDiagnostics.push({ label, status: 'closed', elapsedMs: Date.now() - started });
    } catch (error) {
      cleanupDiagnostics.push({ label, status: 'failed', elapsedMs: Date.now() - started, error: serialiseError(error) });
      errors.push(new Error(`${label} cleanup failed`, { cause: error }));
    }
  }
  for (const [index, context] of (currentBrowser?.contexts?.() ?? []).entries()) {
    const label = `browser context ${index}`;
    const started = Date.now();
    try {
      await cleanupTimeout(() => context.close(), 10_000, label);
      cleanupDiagnostics.push({ label, status: 'closed', elapsedMs: Date.now() - started });
    } catch (error) {
      cleanupDiagnostics.push({ label, status: 'failed', elapsedMs: Date.now() - started, error: serialiseError(error) });
      errors.push(new Error(`${label} cleanup failed`, { cause: error }));
    }
  }
  const browserStarted = Date.now();
  try {
    await cleanupTimeout(() => currentBrowser && currentBrowser.isConnected() && currentBrowser.close(), 10_000, 'browser');
    cleanupDiagnostics.push({ label: 'browser', status: 'closed', elapsedMs: Date.now() - browserStarted });
  } catch (error) {
    cleanupDiagnostics.push({ label: 'browser', status: 'failed', elapsedMs: Date.now() - browserStarted, error: serialiseError(error) });
    errors.push(new Error('browser cleanup failed', { cause: error }));
  }
  if (errors.length > 0) {
    currentBrowser?._connection?.close();
    throw new AggregateError(errors, 'browser cleanup failed');
  }
};

let cleanupPromise;
const cleanupSmoke = () => {
  if (cleanupPromise !== undefined) return cleanupPromise;
  cleanupPromise = Promise.allSettled([closeBrowser(), stopServer()]);
  return cleanupPromise;
};

const cleanupErrorDetails = (cleanup) => cleanup
  .filter((result) => result.status === 'rejected')
  .map((result) => String(result.reason));

const cancelSmoke = (signal) => {
  if (cancellation !== undefined) return cancellation;
  cancelled = signal;
  const cancellationStage = stage;
  cancellation = (async () => {
    const failure = new Error(`depth-of-field smoke cancelled by ${signal}`);
    writeFailureReport(failure, cancellationStage);
    const cleanup = await cleanupSmoke();
    const cleanupErrors = cleanupErrorDetails(cleanup);
    const finalFailure = cleanupErrors.length === 0
      ? failure
      : new AggregateError([failure, ...cleanupErrors.map((detail) => new Error(detail))], 'smoke cancellation cleanup failed');
    writeFailureReport(finalFailure, cancellationStage, cleanupErrors);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  })();
  return cancellation;
};
const onInterrupt = () => { void cancelSmoke('SIGINT'); };
const onTerminate = () => { void cancelSmoke('SIGTERM'); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

const waitForPreviewServer = async () => {
  const targetUrl = `http://127.0.0.1:${PORT}/?game=depth-of-field`;
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  let lastError;
  stage = 'waiting-for-preview-server';
  while (Date.now() < deadline) {
    assertServerAlive('startup');
    if (serverHasFailed()) {
      throw new Error(`preview server failed during startup; output: ${serverOutput}`);
    }
    if (!serverHasStarted()) {
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      const response = await fetch(targetUrl, { signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))) });
      if (response.ok) {
        // A strict-port conflict can briefly expose an already-running server
        // before Vite reports that this child exited. Give the child one turn
        // to publish that failure so this probe never attaches to stale state.
        await sleep(100);
        assertServerAlive('HTTP readiness');
        return;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      httpFailures.push(`server: ${response.status} ${targetUrl}`);
    } catch (error) {
      lastError = error;
      httpFailures.push(`server: request failed ${targetUrl} (${String(error)})`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`preview server did not become ready within ${SERVER_TIMEOUT_MS}ms: ${String(lastError)}; output: ${serverOutput}`);
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`preview server did not become ready within ${SERVER_TIMEOUT_MS}ms: ${String(lastError)}; output: ${serverOutput}`);
};

const openDepthOfFieldPage = async (target, label) => {
  const targetUrl = `http://127.0.0.1:${PORT}/?game=depth-of-field`;
  stage = `navigating:${label}`;
  try {
    await target.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } finally {
    actualUrls[label] = readPageUrl(target);
  }
  stage = `waiting-for-depth-of-field-demo:${label}`;
  await target.waitForFunction(
    () => typeof globalThis.__forgeaxDepthOfFieldDemo?.snapshot === 'function'
      && globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'depth-of-field.snapshot')
      && globalThis.__forgeaxPreviewInspection?.list().actions.some(({ id }) => id === 'depth-of-field.set-preset'),
    undefined,
    { timeout: EVIDENCE_TIMEOUT_MS },
  );
};

const waitForEffectivePreset = async (target, preset, focusDistance) => {
  stage = `waiting-for-effective-preset:${preset}`;
  try {
    await target.waitForFunction(
      ({ preset: expectedPreset, focusDistance: expectedFocusDistance }) => {
        const demo = globalThis.__forgeaxDepthOfFieldDemo;
        const snapshot = demo?.snapshot?.();
        const renderer = snapshot?.renderer;
        return snapshot?.scene?.animated === false
          && snapshot?.depthOfField?.enabled === (expectedPreset !== 'off')
          && snapshot?.depthOfField?.preset === expectedPreset
          && renderer?.status === (expectedPreset === 'off' ? 'off' : 'active')
          && renderer?.lastKnownGood === (expectedPreset !== 'off')
          && (expectedPreset === 'off' || renderer?.effective?.blurSide === expectedPreset)
          && (expectedFocusDistance === undefined || Math.abs((renderer?.effective?.focusDistance ?? Number.NaN) - expectedFocusDistance) < 0.01);
      },
      { preset, focusDistance },
      { timeout: EVIDENCE_TIMEOUT_MS, polling: 100 },
    );
  } catch (error) {
    let observed;
    try {
      observed = await target.evaluate(() => globalThis.__forgeaxDepthOfFieldDemo?.snapshot?.());
    } catch (cause) {
      observed = { readError: String(cause) };
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(observed)}`, { cause: error });
  }
};

let smokeFailure;
let failureStage;
let successReport;
try {
  stage = 'launching-browser';
  browserLaunch = chromium.launch({
    headless: true,
    channel: 'chrome',
    handleSIGINT: false,
    handleSIGTERM: false,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  browser = await browserLaunch;
  if (cancelled !== undefined) throw new Error(`depth-of-field smoke cancelled by ${cancelled}`);
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  attachPageDiagnostics(page, 'primary');
  await waitForPreviewServer();
  await openDepthOfFieldPage(page, 'primary');
  const snapshot = async (name) => {
    const path = resolve(ARTIFACT_DIR, `${name}.png`);
    await page.locator('canvas').first().screenshot({ path });
    return { path, png: PNG.sync.read(readFileSync(path)) };
  };
  const changedPixelsInRegion = (before, after, region) => {
    const x0 = Math.max(0, Math.floor(before.width * region.x));
    const y0 = Math.max(0, Math.floor(before.height * region.y));
    const x1 = Math.min(before.width, Math.ceil(before.width * (region.x + region.width)));
    const y1 = Math.min(before.height, Math.ceil(before.height * (region.y + region.height)));
    let changed = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * before.width + x) * 4;
        const difference = Math.max(
          Math.abs(before.data[offset] - after.data[offset]),
          Math.abs(before.data[offset + 1] - after.data[offset + 1]),
          Math.abs(before.data[offset + 2] - after.data[offset + 2]),
        );
        if (difference > 10) changed += 1;
      }
    }
    return changed;
  };
  const measureForegroundWireProfile = (image, threshold = 220) => {
    // The static calibration scene's foreground wire occupies this stable
    // lower-center strip at the smoke viewport (800x600). Measure the bright
    // run containing the wire center so a depth-edge halo cannot silently
    // widen halfway through the rod.
    const centerX = Math.round(image.width * 0.58);
    const y0 = Math.round(image.height * 0.86);
    const y1 = Math.round(image.height * 0.96);
    const luminance = (x, y) => {
      const offset = (y * image.width + x) * 4;
      return (image.data[offset] + image.data[offset + 1] + image.data[offset + 2]) / 3;
    };
    const rows = [];
    for (let y = y0; y <= y1; y += 1) {
      if (luminance(centerX, y) <= threshold) continue;
      let left = centerX;
      let right = centerX;
      while (left > 0 && luminance(left - 1, y) > threshold) left -= 1;
      while (right < image.width - 1 && luminance(right + 1, y) > threshold) right += 1;
      rows.push({ y, width: right - left + 1 });
    }
    if (rows.length === 0) throw new Error(`foreground wire was not visible in profile strip: ${JSON.stringify({ centerX, y0, y1, threshold })}`);
    const widths = rows.map(({ width }) => width);
    const minWidth = Math.min(...widths);
    const maxWidth = Math.max(...widths);
    return {
      centerX,
      y0,
      y1,
      threshold,
      sampleCount: rows.length,
      minWidth,
      maxWidth,
      spread: maxWidth - minWidth,
      rows,
    };
  };
  const sceneRegions = {
    // Interior stripes avoid the fixed HTML panel, floor silhouette, and
    // foreground rod so each count belongs to one depth layer.
    near: { x: 0.12, y: 0.5, width: 0.35, height: 0.4 },
    far: { x: 0.64, y: 0.34, width: 0.12, height: 0.24 },
    // Keep the focal-plane cards' interiors only: the old range included the
    // left near-board edge and the right foreground rod.
    focus: { x: 0.48, y: 0.39, width: 0.08, height: 0.22 },
  };
  const readDemo = () => page.evaluate(() => {
    const value = globalThis.__forgeaxDepthOfFieldDemo;
    if (!value) throw new Error('depth-of-field demo handle was not installed');
    return value.snapshot();
  });
  const readProjection = () => page.evaluate(async () => {
    const result = await globalThis.__forgeaxPreviewInspection?.read('depth-of-field.snapshot');
    if (!result?.ok) throw new Error(`depth-of-field read projection failed: ${JSON.stringify(result)}`);
    return result.value;
  });
  const runPreset = (preset) => page.evaluate(async (next) => {
    const result = await globalThis.__forgeaxPreviewInspection?.run('depth-of-field.set-preset', { preset: next });
    if (!result?.ok) throw new Error(`depth-of-field preset action failed: ${JSON.stringify(result)}`);
    return result.value;
  }, preset);
  const setControls = (controls) => page.evaluate((next) => {
    const value = globalThis.__forgeaxDepthOfFieldDemo;
    if (!value) throw new Error('depth-of-field demo handle was not installed');
    value.setControls(next);
    return value.snapshot();
  }, controls);
  await waitForEffectivePreset(page, 'off');
  const baseline = await readDemo();
  const baselineProjection = await readProjection();
  const off = await snapshot('off');
  const offStable = await snapshot('off-stable');
  const offStabilityDelta = pixelmatch(off.png.data, offStable.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 });

  stage = 'capturing-static-presets';
  await setControls({ focusDistance: 9, fStop: 0.7, sensorHeight: 0.06, quality: 'high', maxRadiusPixels: 16 });
  await runPreset('near');
  await waitForEffectivePreset(page, 'near', 9);
  const near = await snapshot('near');
  const nearState = await readDemo();
  await runPreset('far');
  await waitForEffectivePreset(page, 'far', 9);
  const far = await snapshot('far');
  const farState = await readDemo();
  await runPreset('both');
  await waitForEffectivePreset(page, 'both', 9);
  const both = await snapshot('both');
  const bothState = await readDemo();

  const focusShiftRequest = await setControls({ focusDistance: 4.5 });
  if (focusShiftRequest.depthOfField?.focalDistance !== 4.5) throw new Error(`DoF focus control request was not applied: ${JSON.stringify(focusShiftRequest)}`);
  await waitForEffectivePreset(page, 'both', 4.5);
  const focusShift = await readDemo();
  await setControls({ focusDistance: 9 });
  await waitForEffectivePreset(page, 'both', 9);

  // Keep a pure small-near source in the scene as a focal-plane regression:
  // at f/2.8 the near white wire is about 1.4px out of focus while the
  // neighboring destination is focal. The full-resolution source kernel must
  // brighten that edge even though the half-resolution near gather has zero
  // confidence for a sub-2px source.
  await setControls({ focusDistance: 9, fStop: 2.8 });
  await waitForEffectivePreset(page, 'both', 9);
  await page.waitForFunction(
    () => Math.abs((globalThis.__forgeaxDepthOfFieldDemo.snapshot().renderer?.effective?.fStop ?? Number.NaN) - 2.8) < 0.01,
    undefined,
    { timeout: EVIDENCE_TIMEOUT_MS, polling: 100 },
  );
  const smallOnly = await snapshot('both-focus-9-fstop-2.8');
  const smallOnlyState = await readDemo();
  const pixelLuminance = (image, x, y) => {
    const offset = (y * image.width + x) * 4;
    return (image.data[offset] + image.data[offset + 1] + image.data[offset + 2]) / 3;
  };
  const smallNearFocalProbe = {
    x: 473,
    y: 350,
    off: pixelLuminance(off.png, 473, 350),
    smallOnly: pixelLuminance(smallOnly.png, 473, 350),
  };
  smallNearFocalProbe.delta = smallNearFocalProbe.smallOnly - smallNearFocalProbe.off;

  // Reproduce the reported focus=8m / f-stop=0.7 edge case. The near wire
  // should keep a continuous silhouette through the floor crossing; a
  // discontinuous bright-run width indicates the old background rejection
  // artifact.
  await setControls({ focusDistance: 8, fStop: 0.7 });
  await waitForEffectivePreset(page, 'both', 8);
  const focus8 = await snapshot('both-focus-8-fstop-0.7');
  const foregroundWireProfile = measureForegroundWireProfile(focus8.png);
  const foregroundWireHaloProfile = {
    threshold100: measureForegroundWireProfile(focus8.png, 100),
    threshold140: measureForegroundWireProfile(focus8.png, 140),
  };
  const focus8State = await readDemo();
  await setControls({ focusDistance: 9 });
  await waitForEffectivePreset(page, 'both', 9);

  // Exercise reset on the same page after a real active transition. This
  // avoids treating a fresh default-off page followed by reset as evidence.
  stage = 'resetting-active-static-scene';
  await page.evaluate(() => globalThis.__forgeaxDepthOfFieldDemo.reset());
  await waitForEffectivePreset(page, 'off');
  const reset = await readDemo();
  const resetProjection = await readProjection();
  const resetOff = await snapshot('reset-off');
  const deltas = {
    near: pixelmatch(off.png.data, near.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 }),
    far: pixelmatch(off.png.data, far.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 }),
    both: pixelmatch(off.png.data, both.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 }),
  };
  const roiDeltas = {
    near: changedPixelsInRegion(off.png, near.png, sceneRegions.near),
    nearPresetFarControl: changedPixelsInRegion(off.png, near.png, sceneRegions.far),
    far: changedPixelsInRegion(off.png, far.png, sceneRegions.far),
    farPresetNearControl: changedPixelsInRegion(off.png, far.png, sceneRegions.near),
    bothNear: changedPixelsInRegion(off.png, both.png, sceneRegions.near),
    bothFar: changedPixelsInRegion(off.png, both.png, sceneRegions.far),
    bothFocus: changedPixelsInRegion(off.png, both.png, sceneRegions.focus),
    // The static cards are spatially separated. Both must preserve each
    // side's single-side result in its own ROI; a shared params UBO overwrite
    // would make this comparison diverge before any semantic receipt changes.
    nearBothAgreement: changedPixelsInRegion(near.png, both.png, sceneRegions.near),
    farBothAgreement: changedPixelsInRegion(far.png, both.png, sceneRegions.far),
  };
  successReport = {
    oracle: 'Static ordinary-mesh near/focus/far calibration scene changes the Engine-owned Camera DepthOfField compositor through the public Preview projection and reset restores off',
    scene: baseline.scene,
    semantic: {
      baseline: baseline.depthOfField,
      baselineProjection,
      near: nearState.depthOfField,
      far: farState.depthOfField,
      both: bothState.depthOfField,
      focusShift: focusShift.depthOfField,
      smallOnly: smallOnlyState.depthOfField,
      focus8: focus8State.depthOfField,
      reset: reset.depthOfField,
      resetProjection,
    },
    renderer: {
      near: nearState.renderer,
      far: farState.renderer,
      both: bothState.renderer,
      focusShift: focusShift.renderer,
      reset: reset.renderer,
    },
    pixel: {
      deltas,
      roiDeltas,
      foregroundWireProfile,
      foregroundWireHaloProfile,
      smallNearFocalProbe,
      offStabilityDelta,
      resetDelta: pixelmatch(off.png.data, resetOff.png.data, undefined, off.png.width, off.png.height, { threshold: 0.1 }),
      activeToResetDelta: pixelmatch(both.png.data, resetOff.png.data, undefined, both.png.width, both.png.height, { threshold: 0.1 }),
    },
    artifacts: { off: off.path, near: near.path, far: far.path, both: both.path, smallOnly: smallOnly.path, focus8: focus8.path, resetOff: resetOff.path },
    elapsedMs: Date.now() - startedAt,
    serverExit: readServerExit(),
    serverOutput,
    actualUrls,
    pageErrors,
    consoleErrors,
    httpFailures,
    notFound,
  };
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (baseline.scene.animated !== false || baseline.scene.layers?.length !== 3) throw new Error(`static calibration scene contract failed: ${JSON.stringify(baseline.scene)}`);
  if (baseline.depthOfField.enabled || baseline.depthOfField.mode !== 'off' || baseline.depthOfField.preset !== 'off') throw new Error(`baseline DoF state was not off: ${JSON.stringify(baseline.depthOfField)}`);
  if (baseline.renderer?.status !== 'off' || baseline.renderer?.passCount !== 0 || baseline.renderer?.textureBytes !== 0) throw new Error(`baseline renderer was not off: ${JSON.stringify(baseline.renderer)}`);
  for (const [preset, state] of [['near', nearState], ['far', farState], ['both', bothState]]) {
    const effective = state.renderer?.effective;
    if (!state.depthOfField.enabled || state.depthOfField.mode !== 'bokeh' || state.depthOfField.preset !== preset || state.renderer?.status !== 'active' || state.renderer?.lastKnownGood !== true || effective?.focusDistance !== 9 || Math.abs(effective?.fStop - 0.7) > 0.01 || Math.abs(effective?.sensorHeight - 0.06) > 0.0001 || effective?.maxRadiusPixels !== 16 || effective?.quality !== 'high' || effective?.blurSide !== preset) throw new Error(`DoF ${preset} transition failed: ${JSON.stringify(state)}`);
    if (state.renderer?.passCount <= 0 || state.renderer?.textureBytes <= 0) throw new Error(`DoF ${preset} did not publish graph resources: ${JSON.stringify(state.renderer)}`);
    if (state.renderer.outputExtent?.width !== near.png.width || state.renderer.outputExtent?.height !== near.png.height) throw new Error(`DoF ${preset} output extent did not match screenshot: ${JSON.stringify(state.renderer)}`);
  }
  if (reset.depthOfField.enabled || reset.depthOfField.mode !== 'off' || reset.depthOfField.preset !== 'off') throw new Error(`DoF reset transition failed: ${JSON.stringify(reset.depthOfField)}`);
  if (reset.renderer?.status !== 'off' || reset.renderer?.passCount !== 0 || reset.renderer?.textureBytes !== 0) throw new Error(`reset renderer was not off: ${JSON.stringify(reset.renderer)}`);
  if (offStabilityDelta > 20) throw new Error(`static off frame was unstable: ${offStabilityDelta} changed pixels`);
  if (deltas.near < 20 || deltas.far < 20 || deltas.both < 20) throw new Error(`DoF preset changed too few compositor pixels: ${JSON.stringify(deltas)}`);
  if (roiDeltas.near < 200 || roiDeltas.far < 200 || roiDeltas.bothNear < 200 || roiDeltas.bothFar < 200) throw new Error(`DoF scene ROI changed too few pixels: ${JSON.stringify(roiDeltas)}`);
  if (roiDeltas.nearPresetFarControl >= roiDeltas.near * 0.2 || roiDeltas.farPresetNearControl >= roiDeltas.far * 0.2) throw new Error(`DoF non-target ROI changed too much: ${JSON.stringify(roiDeltas)}`);
  if (roiDeltas.bothFocus >= 200) throw new Error(`DoF both preset changed the focal-plane ROI too much: ${JSON.stringify(roiDeltas)}`);
  if (roiDeltas.nearBothAgreement >= 200 || roiDeltas.farBothAgreement >= 200) throw new Error(`DoF both preset did not preserve its isolated side result: ${JSON.stringify(roiDeltas)}`);
  if (Math.abs((focusShift.renderer?.effective?.focusDistance ?? Number.NaN) - 4.5) > 0.01) throw new Error(`DoF focus control did not reach 4.5m: ${JSON.stringify(focusShift.renderer)}`);
  if (Math.abs((focus8State.renderer?.effective?.focusDistance ?? Number.NaN) - 8) > 0.01 || Math.abs((focus8State.renderer?.effective?.fStop ?? Number.NaN) - 0.7) > 0.01) throw new Error(`DoF focus=8m / f-stop=0.7 control did not reach the requested state: ${JSON.stringify(focus8State.renderer)}`);
  if (smallNearFocalProbe.delta < 40) throw new Error(`DoF small-near source did not reach the focal-plane edge: ${JSON.stringify(smallNearFocalProbe)}`);
  if (foregroundWireProfile.sampleCount < 20 || foregroundWireProfile.spread > 2 || foregroundWireProfile.maxWidth > 12) throw new Error(`DoF foreground wire profile has an irregular blur width: ${JSON.stringify(foregroundWireProfile)}`);
  if (foregroundWireHaloProfile.threshold100.sampleCount < 20 || foregroundWireHaloProfile.threshold100.spread > 2 || foregroundWireHaloProfile.threshold140.sampleCount < 20 || foregroundWireHaloProfile.threshold140.spread > 2) throw new Error(`DoF foreground wire halo has an irregular transition: ${JSON.stringify(foregroundWireHaloProfile)}`);
  if (successReport.pixel.resetDelta > 20 || successReport.pixel.activeToResetDelta < 200) throw new Error(`DoF reset pixel transition failed: ${JSON.stringify(successReport.pixel)}`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('Failed to load resource'));
  if (unexpectedConsoleErrors.length > 0) throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  if (notFound.some((url) => !url.includes('/__import/') && !url.includes('/__forgeax-ddc/'))) throw new Error(`unexpected 404 responses: ${notFound.join(' | ')}`);
} catch (error) {
  smokeFailure = error;
  failureStage = stage;
  console.error(`[depth-of-field] smoke failure before cleanup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await captureDiagnosticScreenshot(page, 'primary');
}

let cleanupFailure;
stage = 'cleanup';
const cleanup = await cleanupSmoke();
const cleanupErrors = cleanupErrorDetails(cleanup);
if (cleanupErrors.length > 0) {
  cleanupFailure = cleanupErrors.length === 1
    ? cleanup.find((result) => result.status === 'rejected')?.reason
    : new AggregateError(cleanupErrors.map((detail) => new Error(detail)), 'depth-of-field smoke cleanup failed');
}
process.off('SIGINT', onInterrupt);
process.off('SIGTERM', onTerminate);
if (cancelled !== undefined) await cancellation;
if (smokeFailure !== undefined || cleanupFailure !== undefined) {
  const failures = [smokeFailure, cleanupFailure].filter((error) => error !== undefined);
  const failure = failures.length === 1
    ? failures[0]
    : new AggregateError(failures, 'depth-of-field smoke failed');
  writeFailureReport(failure, failureStage ?? stage, cleanupErrors);
  throw failure;
}
if (successReport === undefined) throw new Error('depth-of-field smoke produced no success report');
successReport.serverExit = readServerExit();
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(successReport, null, 2)}\n`);
console.log(`[depth-of-field] PASS near=${successReport.pixel.deltas.near} far=${successReport.pixel.deltas.far} both=${successReport.pixel.deltas.both} artifacts=${ARTIFACT_DIR}`);
