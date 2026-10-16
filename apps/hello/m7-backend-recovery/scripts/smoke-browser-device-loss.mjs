#!/usr/bin/env node
// M7 browser recovery evidence: inject a real GPU-process loss through CDP,
// then observe the public Renderer health channel on one page and one World.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { isRetryableAdapterRecoveryFailure } from './recovery-contract.mjs';
import { viteLocalUrl } from './vite-local-url.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const appRoot = resolve(repoRoot, 'apps', 'hello', 'cube');
const artifactDir = resolve(
  process.env.FORGEAX_M7_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m7-backend-recovery', 'browser-device-loss'),
);
const runId = `run-${Date.now()}-${process.pid}`;
const runArtifactDir = resolve(artifactDir, runId);
const adapterAvailabilityWaitMs = 2_000;
const browserChannel =
  process.env.FORGEAX_CHROME_CHANNEL ?? (process.env.CI ? browserLaunch.channel : 'chrome');
const browserArgs = [
  ...(process.env.CI && process.platform === 'linux'
    ? [...browserLaunch.args, '--use-angle=swiftshader']
    : [
      '--disable-features=MacAppCodeSignClone',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer',
      '--ignore-gpu-blocklist',
    ]),
  // The carrier deliberately crashes the GPU three times. Keep adapters
  // available so Chrome quarantine does not replace the Engine recovery test.
  '--disable-gpu-process-crash-limit',
  '--disable-domain-blocking-for-3d-apis',
];
mkdirSync(runArtifactDir, { recursive: true });

const vite = spawn(
  process.execPath,
  [resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '0'],
  {
    cwd: appRoot,
    env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let baseUrl;
let viteOutput = '';
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  viteOutput = (viteOutput + text).slice(-8192);
  baseUrl ??= viteLocalUrl(viteOutput);
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

let browser;
const pageLifecycle = [];
const workerLifecycle = [];
const browserLifecycle = [];
const pageErrors = [];
const consoleErrors = [];
const recoveryCycles = [];
const recoveryAttemptEvidence = [];

function readPng(path) {
  const png = PNG.sync.read(readFileSync(path));
  let nonBlackPixels = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (png.data[index] > 8 || png.data[index + 1] > 8 || png.data[index + 2] > 8) nonBlackPixels += 1;
  }
  return { width: png.width, height: png.height, nonBlackPixels };
}

function visualDiff(referencePath, candidatePath) {
  const reference = PNG.sync.read(readFileSync(referencePath));
  const candidate = PNG.sync.read(readFileSync(candidatePath));
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return { meanAbsRgb: Number.POSITIVE_INFINITY, highDeltaRatio: 1 };
  }
  let totalDelta = 0;
  let highDelta = 0;
  const pixelCount = reference.width * reference.height;
  for (let index = 0; index < reference.data.length; index += 4) {
    const delta =
      (Math.abs(reference.data[index] - candidate.data[index]) +
        Math.abs(reference.data[index + 1] - candidate.data[index + 1]) +
        Math.abs(reference.data[index + 2] - candidate.data[index + 2])) /
      3;
    totalDelta += delta;
    if (delta > 20) highDelta += 1;
  }
  return {
    meanAbsRgb: pixelCount === 0 ? Number.POSITIVE_INFINITY : totalDelta / pixelCount,
    meanAbsRgbNormalized:
      pixelCount === 0 ? Number.POSITIVE_INFINITY : totalDelta / (pixelCount * 255),
    highDeltaRatio: pixelCount === 0 ? 1 : highDelta / pixelCount,
  };
}

try {
  const deadline = Date.now() + 30_000;
  while (baseUrl === undefined && Date.now() < deadline) await sleep(200);
  if (baseUrl === undefined) throw new Error('Vite did not become ready in 30s');

  browser = await chromium.launch({
    headless: true,
    channel: browserChannel,
    args: browserArgs,
    chromiumSandbox: true,
  });
  browser.on('disconnected', () => browserLifecycle.push('disconnected'));
  // Keep all three real GPU-loss journeys and their 60-frame receipts at lower CI fill cost.
  const viewport = process.env.CI ? { width: 320, height: 240 } : { width: 800, height: 600 };
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('crash', () => pageLifecycle.push('crash'));
  page.on('close', () => pageLifecycle.push('close'));
  page.on('worker', (worker) => workerLifecycle.push(`created:${worker.url()}`));

  await page.goto(`${baseUrl}/?m7-device-loss=1`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => typeof globalThis.__forgeaxM7DeviceRecovery?.health === 'function',
    undefined,
    { timeout: 30_000 },
  );

  const readState = () =>
    page.evaluate(() => {
      const probe = globalThis.__forgeaxM7DeviceRecovery;
      if (probe === undefined) throw new Error('M7 device-loss probe hook is missing');
      return { ...probe.state(), transitions: probe.healthTransitions() };
    });
  const waitForHealth = async (expected) => {
    const healthDeadline = Date.now() + 30_000;
    let last;
    let lastError;
    while (Date.now() < healthDeadline) {
      try {
        last = await readState();
        if (last.health === expected) return last;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(250);
    }
    throw new Error(
      `renderer health did not reach ${expected}: ${JSON.stringify({ last, lastError, pageClosed: page.isClosed(), pageLifecycle, browserLifecycle })}`,
    );
  };
  const captureFrame = async (label) => {
    const capture = await page.evaluate(async ({ captureLabel }) => {
      const captureFn = globalThis.__forgeax?.captureFrame;
      if (typeof captureFn !== 'function') return null;
      const captured = await captureFn({ snapshotTimeoutMs: 5_000 });
      if (!captured.ok) return captured;
      const runId = `m7-${captureLabel}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
      const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-forgeax-rhitape' },
        // Blob keeps large binary tapes out of CDP's inline request-body string.
        body: new Blob([captured.value.bytes], { type: 'application/x-forgeax-rhitape' }),
      });
      const payload = await response.json();
      if (!response.ok) return { ok: false, error: payload };
      return { ok: true, value: { ...payload, digest: captured.value.digest, runId } };
    }, { captureLabel: label });
    if (capture === null) throw new Error(`RHI capture hook missing for ${label}`);
    if (!capture.ok) throw new Error(`${label} capture failed: ${JSON.stringify(capture.error)}`);
    const source = [capture.value.path, resolve(appRoot, capture.value.path), resolve(repoRoot, capture.value.path)].find((path) => existsSync(path));
    if (source === undefined) throw new Error(`${label} tape artifact missing: ${capture.value.path}`);
    const artifactPath = resolve(runArtifactDir, `${label}.rhitape`);
    copyFileSync(source, artifactPath);
    const tape = decodeTape(new Uint8Array(readFileSync(artifactPath)));
    if (!tape.ok) throw new Error(`${label} tape decode failed: ${tape.error.code}`);
    const model = buildFrameModel(tape.value);
    return { ...capture.value, path: artifactPath, eventCount: tape.value.events.length, workCount: model.works.length };
  };

  const runFrames = async (count) => {
    const result = await page.evaluate(async (frameCount) => {
      for (let frame = 0; frame < frameCount; frame += 1) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      }
      return frameCount;
    }, count);
    if (result !== count) throw new Error(`M7 frame oracle completed ${result}/${count} frames`);
    return result;
  };

  const probeAdapterAvailability = async () =>
    page.evaluate(async (timeoutMs) => {
      const startedAt = performance.now();
      const deadline = startedAt + timeoutMs;
      const attempts = [];
      const gpu = navigator.gpu;
      if (gpu === undefined) {
        return { status: 'missing', timeoutMs, elapsedMs: performance.now() - startedAt, attempts };
      }
      while (performance.now() < deadline) {
        const probeStartedAt = performance.now();
        const remainingMs = Math.max(1, deadline - probeStartedAt);
        const request = gpu.requestAdapter().then(
          (adapter) => ({ status: adapter === null ? 'unavailable' : 'available' }),
          (error) => ({
            status: 'rejected',
            error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
          }),
        );
        const outcome = await Promise.race([
          request,
          new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), remainingMs)),
        ]);
        const attempt = {
          attempt: attempts.length + 1,
          status: outcome.status,
          elapsedMs: performance.now() - probeStartedAt,
        };
        attempts.push(attempt);
        if (outcome.status === 'available') {
          return { status: 'available', timeoutMs, elapsedMs: performance.now() - startedAt, attempts };
        }
        if (outcome.status === 'rejected' || outcome.status === 'timeout') {
          return {
            status: outcome.status,
            timeoutMs,
            elapsedMs: performance.now() - startedAt,
            attempts,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          };
        }
        const sleepMs = Math.min(50, deadline - performance.now());
        if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
      return { status: 'timeout', timeoutMs, elapsedMs: performance.now() - startedAt, attempts };
    }, adapterAvailabilityWaitMs);

  const canvas = page.locator('#app');
  const cdp = await browser.newBrowserCDPSession();
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const before = await waitForHealth('alive');
    const cdpCommand = 'Browser.crashGpuProcess';
    const cycleEvidence = { cycle, cdpCommand, faultRequested: false, before, recoveryAttempts: [] };
    recoveryAttemptEvidence.push(cycleEvidence);
    const beforeCapture = await captureFrame(`cycle-${cycle}-before`);
    const beforePng = resolve(runArtifactDir, `cycle-${cycle}-before.png`);
    await canvas.screenshot({ path: beforePng });
    const transitionStart = before.transitions.length;
    cycleEvidence.faultRequested = true;
    await cdp.send(cdpCommand);
    const lost = await waitForHealth('device-lost');
    cycleEvidence.lost = lost;
    if (lost.worldIdentity !== before.worldIdentity || lost.rendererIdentity !== before.rendererIdentity) {
      throw new Error(`cycle ${cycle} changed logical owner at loss: ${JSON.stringify({ before, lost })}`);
    }
    if (lost.deviceLossError?.code !== 'device-lost') {
      throw new Error(`cycle ${cycle} missing device-lost error: ${JSON.stringify(lost)}`);
    }
    const firstRecoveryStartedAt = Date.now();
    const firstRecovery = await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.recover());
    const firstRecoveryAttempt = {
      attempt: 1,
      operation: 'renderer.recover',
      status: firstRecovery.ok ? 'succeeded' : 'failed',
      elapsedMs: Date.now() - firstRecoveryStartedAt,
      result: firstRecovery,
      finalHealth: await readState().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    };
    cycleEvidence.recoveryAttempts.push(firstRecoveryAttempt);
    let recovery = firstRecovery;
    if (!recovery.ok) {
      const detail = recovery.error?.detail;
      const adapterRetryable = isRetryableAdapterRecoveryFailure(detail);
      if (!adapterRetryable) {
        cycleEvidence.finalHealth = firstRecoveryAttempt.finalHealth;
        throw new Error(
          `cycle ${cycle} recovery failed without an eligible adapter retry: ${JSON.stringify({ recoveryAttempts: cycleEvidence.recoveryAttempts, finalHealth: cycleEvidence.finalHealth })}`,
        );
      }
      const adapterProbe = await probeAdapterAvailability();
      cycleEvidence.adapterProbe = adapterProbe;
      if (adapterProbe.status !== 'available') {
        cycleEvidence.finalHealth = await readState().catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        throw new Error(
          `cycle ${cycle} adapter availability did not recover: ${JSON.stringify({ recoveryAttempts: cycleEvidence.recoveryAttempts, adapterProbe, finalHealth: cycleEvidence.finalHealth })}`,
        );
      }
      const retryRecoveryStartedAt = Date.now();
      const retryRecovery = await page.evaluate(() => globalThis.__forgeaxM7DeviceRecovery.recover());
      const retryRecoveryAttempt = {
        attempt: 2,
        operation: 'renderer.recover',
        status: retryRecovery.ok ? 'succeeded' : 'failed',
        elapsedMs: Date.now() - retryRecoveryStartedAt,
        result: retryRecovery,
        finalHealth: await readState().catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      };
      cycleEvidence.recoveryAttempts.push(retryRecoveryAttempt);
      recovery = retryRecovery;
      if (!recovery.ok) {
        cycleEvidence.finalHealth = retryRecoveryAttempt.finalHealth;
        throw new Error(
          `cycle ${cycle} recovery retry failed: ${JSON.stringify({ recoveryAttempts: cycleEvidence.recoveryAttempts, adapterProbe, finalHealth: cycleEvidence.finalHealth })}`,
        );
      }
    }
    const after = await waitForHealth('alive');
    cycleEvidence.recovery = recovery;
    cycleEvidence.after = after;
    cycleEvidence.finalHealth = after;
    if (after.worldIdentity !== before.worldIdentity || after.rendererIdentity !== before.rendererIdentity) {
      throw new Error(`cycle ${cycle} changed logical owner after recovery: ${JSON.stringify({ before, after })}`);
    }
    if (after.deviceIdentity === before.deviceIdentity) {
      throw new Error(`cycle ${cycle} reused the stale device identity`);
    }
    const frames = await runFrames(60);
    const afterCapture = await captureFrame(`cycle-${cycle}-after`);
    const afterPng = resolve(runArtifactDir, `cycle-${cycle}-after.png`);
    await canvas.screenshot({ path: afterPng });
    const transitions = after.transitions.slice(transitionStart).map((entry) => entry.state);
    if (!transitions.includes('device-lost') || !transitions.includes('recovering') || !transitions.includes('alive')) {
      throw new Error(`cycle ${cycle} missing health transition: ${JSON.stringify({ transitions, after })}`);
    }
    recoveryCycles.push({
      ...cycleEvidence,
      frames,
      transitions,
      capture: { before: beforeCapture, after: afterCapture },
      png: { before: beforePng, after: afterPng },
      connection: { pageClosed: page.isClosed(), pageLifecycle: [...pageLifecycle], browserLifecycle: [...browserLifecycle] },
    });
  }

  const visual = recoveryCycles.map(({ cycle, png }) => ({
    cycle,
    before: readPng(png.before),
    after: readPng(png.after),
    diff: visualDiff(png.before, png.after),
  }));
  for (const result of visual) {
    if (result.before.nonBlackPixels < 1000 || result.after.nonBlackPixels < 1000) {
      throw new Error(`cycle ${result.cycle} scene is visually empty: ${JSON.stringify(result)}`);
    }
    if (result.diff.meanAbsRgbNormalized > 0.05 || result.diff.highDeltaRatio > 0.25) {
      throw new Error(`cycle ${result.cycle} semantic pixels diverged: ${JSON.stringify(result)}`);
    }
  }
  if (page.isClosed() || browserLifecycle.includes('disconnected')) {
    throw new Error(`connection termination is not loss evidence: ${JSON.stringify({ pageLifecycle, browserLifecycle })}`);
  }
  const result = {
    status: 'pass',
    browserVersion: browser.version(),
    browserArgs,
    runId,
    artifactDir: runArtifactDir,
    driverCommand: 'Browser.crashGpuProcess',
    recoveryCycles,
    visual,
    pageErrors,
    consoleErrors,
    pageLifecycle,
    workerLifecycle,
    browserLifecycle,
  };
  writeFileSync(resolve(runArtifactDir, 'device-loss-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[m7-browser-device-loss] PASS - ${JSON.stringify({ cycles: recoveryCycles.length, visual })}`);
} catch (error) {
  const evidence = {
    status: 'insufficient-evidence',
    runId,
    artifactDir: runArtifactDir,
    driverCommand: 'Browser.crashGpuProcess',
    browserVersion: browser?.version(),
    browserArgs,
    error: error instanceof Error ? error.message : String(error),
    completedRecoveryCycles: recoveryCycles,
    recoveryAttemptEvidence,
    pageLifecycle,
    workerLifecycle,
    browserLifecycle,
    pageErrors,
    consoleErrors,
  };
  const failureArtifact = resolve(runArtifactDir, 'device-loss-failure.json');
  writeFileSync(failureArtifact, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(`[m7-browser-device-loss] FAIL - ${JSON.stringify({ error: evidence.error, failureArtifact })}`);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close();
  vite.kill('SIGTERM');
}
