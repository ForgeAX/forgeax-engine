#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const appRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const port = Number.parseInt(process.env.BOSS_LIGHTNING_M11_PORT ?? '5174', 10);
const falsifier = process.env.BOSS_LIGHTNING_FALSIFY ?? '';
const artifactDir = resolve(
  process.env.BOSS_LIGHTNING_M11_DIR ?? resolve(repoRoot, '.forgeax-debug/boss-lightning-m11'),
);
const beforePath = resolve(artifactDir, 'before-loss.png');
const afterPath = resolve(artifactDir, 'after-recover.png');
mkdirSync(artifactDir, { recursive: true });

function visualStats(path) {
  const png = PNG.sync.read(readFileSync(path));
  let nonBlack = 0;
  let brightness = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const value =
        (png.data[offset] ?? 0) + (png.data[offset + 1] ?? 0) + (png.data[offset + 2] ?? 0);
      brightness += value;
      if (value > 24) nonBlack += 1;
    }
  }
  const samplePixels = png.width * png.height;
  return {
    width: png.width,
    height: png.height,
    nonBlack,
    nonBlackRatio: samplePixels === 0 ? 0 : nonBlack / samplePixels,
    meanRgb: samplePixels === 0 ? 0 : brightness / (samplePixels * 3),
  };
}

function visualDiff(referencePath, candidatePath) {
  const reference = PNG.sync.read(readFileSync(referencePath));
  const candidate = PNG.sync.read(readFileSync(candidatePath));
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return { meanAbsRgb: Number.POSITIVE_INFINITY, highDeltaRatio: 1 };
  }
  let totalDelta = 0;
  let highDelta = 0;
  const samplePixels = reference.width * reference.height;
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    const delta =
      (Math.abs((reference.data[offset] ?? 0) - (candidate.data[offset] ?? 0)) +
        Math.abs((reference.data[offset + 1] ?? 0) - (candidate.data[offset + 1] ?? 0)) +
        Math.abs((reference.data[offset + 2] ?? 0) - (candidate.data[offset + 2] ?? 0))) /
      3;
    totalDelta += delta;
    if (delta > 20) highDelta += 1;
  }
  return {
    meanAbsRgb: samplePixels === 0 ? Number.POSITIVE_INFINITY : totalDelta / samplePixels,
    highDeltaRatio: samplePixels === 0 ? 1 : highDelta / samplePixels,
  };
}

function waitFor(read, predicate, label, timeoutMs = 15_000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
      try {
        value = await read();
      } catch {
        // Chrome can reject one evaluation while the GPU process is re-created.
      }
      if (predicate(value)) return value;
      await sleep(100);
    }
    throw new Error(`${label} timed out: ${JSON.stringify(value)}`);
  })();
}

async function evaluateWithTimeout(page, expression, timeoutMs = 1_000) {
  try {
    return await Promise.race([page.evaluate(expression), sleep(timeoutMs).then(() => undefined)]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let server;
let browser;
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];

try {
  server = spawn(
    'pnpm',
    [
      '--filter',
      '@forgeax/hello-boss-lightning',
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: repoRoot, detached: process.platform !== 'win32', stdio: 'ignore' },
  );
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        return response.ok;
      } catch {
        return false;
      }
    },
    value => value === true,
    'Vite dev server',
    30_000,
  );
  console.log('[m11-vfx] browser server: ready');

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
  console.log('[m11-vfx] browser chrome: ready');
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      badResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const readStatus = () =>
    evaluateWithTimeout(page, () => globalThis.__forgeaxBossLightning?.status?.());
  const readInspect = () =>
    evaluateWithTimeout(page, () => globalThis.__forgeaxBossLightning?.publicApi?.inspect?.());
  const readHealth = () =>
    evaluateWithTimeout(page, () => globalThis.__forgeaxBossLightning?.renderer?.health());
  const readRuntime = async () => ({
    status: await readStatus(),
    inspect: await readInspect(),
    health: await readHealth(),
    validationErrors: await evaluateWithTimeout(page, () => globalThis.__forgeaxBossLightning?.validationErrors),
  });

  await page.goto(
    `http://127.0.0.1:${port}/?boss-lightning-falsify=${encodeURIComponent(falsifier)}`,
    { waitUntil: 'domcontentloaded', timeout: 15_000 },
  );
  console.log('[m11-vfx] browser page: loaded');
  await page.waitForFunction(() => globalThis.__forgeaxBossLightning !== undefined, null, { timeout: 15_000 });
  console.log('[m11-vfx] browser app: booted');
  await waitFor(
    readRuntime,
    value => value?.status?.hasPlayer === true && value.inspect?.players?.length === 1,
    'boss-lightning baseline VFX player',
  );
  await page.evaluate(() => globalThis.__forgeaxBossLightning?.submitImpact?.());
  await sleep(250);
  const before = await readRuntime();
  console.log('[m11-vfx] browser baseline: ready');
  if (before?.health?.reason !== 'alive' || before.status?.diagnostics?.length !== 0) {
    throw new Error(`baseline renderer/VFX state failed: ${JSON.stringify(before)}`);
  }
  const held = await page.evaluate(() => globalThis.__forgeaxBossLightning?.m11?.holdStaleInstance?.());
  if (held?.ok !== true) throw new Error(`could not hold the baseline VFX instance: ${JSON.stringify(held)}`);
  await page.screenshot({ path: beforePath });
  const beforeVisual = visualStats(beforePath);
  if (beforeVisual.nonBlack < 1_000 || beforeVisual.meanRgb < 1) {
    throw new Error(`baseline frame is not visible: ${JSON.stringify(beforeVisual)}`);
  }

  const cdp = await browser.newBrowserCDPSession();
  console.log('[m11-vfx] browser fault: crashing GPU process');
  await cdp.send('Browser.crashGpuProcess');
  const deviceLost = await waitFor(
    readHealth,
    value => value?.reason === 'device-lost',
    'Chrome device-lost health transition',
  );
  console.log('[m11-vfx] browser fault: device-lost observed');
  const recovery = await page.evaluate(() => globalThis.__forgeaxBossLightning?.publicApi?.recover?.());
  if (recovery?.ok !== true) throw new Error(`public renderer recovery failed: ${JSON.stringify(recovery)}`);
  const aliveAfter = await waitFor(readHealth, value => value?.reason === 'alive', 'renderer recovery');
  console.log('[m11-vfx] browser recovery: renderer alive');
  await sleep(1_000);
  const recovered = await waitFor(
    readRuntime,
    value =>
      value?.inspect?.renderGeneration > (before.inspect?.renderGeneration ?? -1) &&
      value.inspect.players?.length === 1 &&
      value.status?.hasPlayer === true,
    'VFX render generation restart',
  );
  console.log('[m11-vfx] browser recovery: VFX generation restarted');

  const stalePatch = await page.evaluate(() => globalThis.__forgeaxBossLightning?.m11?.patchStaleInstance?.());
  await sleep(150);
  const afterStalePatch = await readRuntime();
  const staleGeneration = afterStalePatch?.inspect?.players?.[0]?.values?.generation;
  if (staleGeneration !== 0) {
    throw new Error(`stale instance patch crossed the recovery fence: ${JSON.stringify({ stalePatch, afterStalePatch })}`);
  }
  const currentPatch = await page.evaluate(() => globalThis.__forgeaxBossLightning?.m11?.patchCurrentInstance?.());
  const patched = await waitFor(
    readRuntime,
    value => value?.inspect?.players?.[0]?.values?.generation === 1 && value.inspect.players[0].values.pendingPatchCount === 0,
    'current generation patch commit',
  );
  await page.screenshot({ path: afterPath });
  const afterVisual = visualStats(afterPath);
  const afterDiff = visualDiff(beforePath, afterPath);
  if (afterVisual.nonBlack < 1_000 || afterVisual.meanRgb < 1) {
    throw new Error(`recovered frame is not visible: ${JSON.stringify({ beforeVisual, afterVisual })}`);
  }
  if (afterVisual.nonBlackRatio < beforeVisual.nonBlackRatio * 0.6 || afterDiff.highDeltaRatio > 0.5) {
    throw new Error(`recovered frame diverged from baseline: ${JSON.stringify({ beforeVisual, afterVisual, afterDiff })}`);
  }
  const validationErrors = Array.isArray(patched?.validationErrors) ? patched.validationErrors : [];
  const actionableValidationErrors = validationErrors.filter(error => error?.code !== 'device-lost');
  if (actionableValidationErrors.length > 0) {
    throw new Error(`recovery emitted unexpected renderer errors: ${JSON.stringify(actionableValidationErrors)}`);
  }

  const secondRecovery = await page.evaluate(async () => {
    const result = await globalThis.__forgeaxBossLightning?.publicApi?.recover?.();
    return result?.ok === true
      ? result
      : result === undefined
        ? result
        : { ok: false, error: { code: result.error?.code } };
  });
  if (secondRecovery?.ok !== false || secondRecovery?.error?.code !== 'recover-not-needed') {
    throw new Error(`recovery was not idempotently fenced while renderer was alive: ${JSON.stringify(secondRecovery)}`);
  }
  const cleanup = await page.evaluate(() => {
    const runtime = globalThis.__forgeaxBossLightning;
    const stopped = runtime?.app?.stop?.();
    runtime?.renderer?.dispose?.();
    runtime?.renderer?.dispose?.();
    return { stopped, rendererDisposedTwice: true };
  });

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter(
    line => !line.includes('favicon') && !line.includes('Failed to load resource') && !line.includes('device-lost'),
  );
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);

  console.log(
    `[m11-vfx] browser device-loss recovery: PASS ${JSON.stringify({
      beforeGeneration: before.inspect?.renderGeneration,
      lost: deviceLost?.reason,
      afterGeneration: recovered?.inspect?.renderGeneration,
      stalePatch,
      staleGeneration,
      currentPatch,
      currentGeneration: patched?.inspect?.players?.[0]?.values?.generation,
      aliveAfter: aliveAfter?.reason,
      beforeVisual,
      afterVisual,
      afterDiff,
    })}`,
  );
  console.log(`[m11-vfx] cleanup idempotency: PASS ${JSON.stringify(cleanup)}`);
} catch (error) {
  console.error(`[m11-vfx] browser device-loss recovery: FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server?.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await sleep(300);
}
