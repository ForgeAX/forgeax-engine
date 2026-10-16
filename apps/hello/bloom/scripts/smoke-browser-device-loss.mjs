#!/usr/bin/env node

// Real browser recovery evidence for the Bloom carrier. Browser.crashGpuProcess
// is the driver action; surface release/restore is intentionally covered by
// smoke-browser.mjs as a separate surface-owner operation.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';
import browserLaunchConfig from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const evidenceDir = resolve(appRoot, 'evidence');
const serverStartTimeoutMs = Number.parseInt(
  process.env.FORGEAX_BLOOM_SERVER_START_TIMEOUT_MS ?? '120000',
  10,
);
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const evidence = {
  schemaVersion: 'hello-bloom-browser-device-loss-evidence/1',
  sourceRevision,
  backend: 'browser-webgpu',
  driverCommand: 'Browser.crashGpuProcess',
  recoveryAttempts: [],
  pageErrors: [],
  consoleErrors: [],
  verdict: 'fail',
};

mkdirSync(evidenceDir, { recursive: true });

function imageStats(path) {
  const image = PNG.sync.read(readFileSync(path));
  let nonBlackPixels = 0;
  let maxLuma = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (luma > 0.02) nonBlackPixels += 1;
    maxLuma = Math.max(maxLuma, luma);
  }
  return { width: image.width, height: image.height, nonBlackPixels, maxLuma };
}

let server;
let browser;
let serverUrl;
let serverOutput = '';
let latestInspection;

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForServer() {
  const serverDeadline = Date.now() + serverStartTimeoutMs;
  while (Date.now() < serverDeadline) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(serverUrl);
      if (response.ok) return;
    } catch {
      // Vite may still be compiling before it accepts HTTP connections.
    }
    await delay(100);
  }
  throw new Error(`Bloom Vite server did not become reachable at ${serverUrl}: ${serverOutput}`);
}

async function cleanup() {
  await browser?.close().catch(() => undefined);
  if (server?.pid !== undefined) await createOwnedProcessGroupStopper(server)();
}

try {
  const configuredPort = process.env.FORGEAX_BLOOM_PORT;
  const port = configuredPort !== undefined && configuredPort !== '0' ? configuredPort : String(await reservePort());
  serverUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      resolve(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: appRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );
  const observeServer = (chunk) => {
    serverOutput += String(chunk);
  };
  server.stdout.on('data', observeServer);
  server.stderr.on('data', observeServer);
  await waitForServer();

  const browserChannel = process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunchConfig.channel;
  const browserHeadless = process.env.FORGEAX_BROWSER_HEADLESS !== '0';
  const browserArgs = [
    ...(process.platform === 'win32' ? resolveBrowserWebGpuLaunch().args : []),
    '--disable-features=MacAppCodeSignClone',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
    '--disable-gpu-process-crash-limit',
    '--disable-domain-blocking-for-3d-apis',
  ];
  // Chrome Beta on the Linux CI carrier must select the same software Vulkan
  // adapter as the other real Browser WebGPU gates. This keeps the CDP crash
  // aimed at Chrome's GPU process while avoiding an unbound host adapter.
  if (browserChannel === 'chrome-beta' && process.env.CI && process.platform === 'linux') {
    browserArgs.push(
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    );
  }
  evidence.browser = { channel: browserChannel, headless: browserHeadless, args: browserArgs };
  browser = await chromium.launch({
    channel: browserChannel,
    headless: browserHeadless,
    args: browserArgs,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 225 } });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  // The root HTTP probe can complete before Vite transforms this page's
  // shader-heavy module graph. Give navigation the same startup budget while
  // retaining the 30-second renderer admission and recovery assertions below.
  await page.goto(`${serverUrl}/`, { waitUntil: 'domcontentloaded', timeout: serverStartTimeoutMs });
  await page.waitForFunction(
    () => typeof globalThis.__bloomCarrierProbe?.inspect === 'function',
    undefined,
    { timeout: 30_000 },
  );

  const inspect = async () => {
    latestInspection = await page.evaluate(() => globalThis.__bloomCarrierProbe.inspect());
    return latestInspection;
  };
  const waitForState = async (state) => {
    const deadline = Date.now() + 30_000;
    let last;
    while (Date.now() < deadline) {
      last = await inspect();
      if (last.state === state) return last;
      await delay(200);
    }
    throw new Error(`renderer state did not reach ${state}: ${JSON.stringify(last)}`);
  };
  const waitForSubmitted = async (additional) => {
    const before = await inspect();
    const target = before.submittedFrames + additional;
    await page.waitForFunction(
      (expected) => (globalThis.__bloomCarrierProbe?.inspect()?.submittedFrames ?? 0) >= expected,
      target,
      { timeout: 30_000 },
    );
  };

  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('device-loss-before'));
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setBloom(true));
  await waitForSubmitted(60);
  const before = await inspect();
  const beforePng = resolve(evidenceDir, 'browser-device-loss-before.png');
  await page.screenshot({ path: beforePng });
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.crashGpuProcess');
  const lost = await waitForState('device-lost');
  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('device-loss-recover'));
  const recoveryStartedAt = Date.now();
  const recovery = await page.evaluate(() => globalThis.__bloomCarrierProbe.recoverDeviceLoss());
  evidence.recoveryAttempts.push({
    attempt: 1,
    elapsedMs: Date.now() - recoveryStartedAt,
    result: recovery,
  });
  if (recovery?.ok !== true) {
    await delay(1_000);
    const retryStartedAt = Date.now();
    const retry = await page.evaluate(() => globalThis.__bloomCarrierProbe.recoverDeviceLoss());
    evidence.recoveryAttempts.push({
      attempt: 2,
      elapsedMs: Date.now() - retryStartedAt,
      result: retry,
    });
    if (retry?.ok !== true) throw new Error(`renderer.recover failed: ${JSON.stringify(evidence.recoveryAttempts)}`);
  }
  const recovered = await waitForState('alive');
  await waitForSubmitted(3);
  const after = await inspect();
  const afterPng = resolve(evidenceDir, 'browser-device-loss-after.png');
  await page.screenshot({ path: afterPng });
  const beforeVisual = imageStats(beforePng);
  const afterVisual = imageStats(afterPng);
  evidence.before = { ...before, screenshot: 'apps/hello/bloom/evidence/browser-device-loss-before.png' };
  evidence.lost = lost;
  evidence.recovered = recovered;
  evidence.after = { ...after, screenshot: 'apps/hello/bloom/evidence/browser-device-loss-after.png' };
  evidence.visual = {
    before: beforeVisual,
    after: afterVisual,
    minimumRestoredFraction: 0.5,
    rule: 'post-loss PNG must retain at least half of the pre-loss non-black pixels and peak luma',
  };
  const transitions = after.rendererTransitions.map((entry) => entry.current);
  if (!transitions.includes('device-lost') || !transitions.includes('recovering') || !transitions.includes('alive')) {
    throw new Error(`missing device-loss health transitions: ${JSON.stringify(after.rendererTransitions)}`);
  }
  if ((after.frame.deviceGeneration ?? 0) <= (before.frame.deviceGeneration ?? 0)) {
    throw new Error(`device generation did not advance: ${JSON.stringify({ before: before.frame, after: after.frame })}`);
  }
  if (after.bloom.graphStatus !== 'valid' || after.bloom.passCount !== 10 || after.bloom.enabled !== true) {
    throw new Error(`Bloom was not rebuilt after device loss: ${JSON.stringify(after.bloom)}`);
  }
  if (
    afterVisual.nonBlackPixels < Math.floor(beforeVisual.nonBlackPixels * 0.5) ||
    afterVisual.maxLuma < beforeVisual.maxLuma * 0.5
  ) {
    throw new Error(`Bloom visual output was not restored after device loss: ${JSON.stringify(evidence.visual)}`);
  }
  if (evidence.pageErrors.length > 0 || evidence.consoleErrors.length > 0) {
    throw new Error(`browser errors during device loss: ${JSON.stringify({ page: evidence.pageErrors, console: evidence.consoleErrors })}`);
  }
  evidence.verdict = 'pass';
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  evidence.lastInspection = latestInspection;
  evidence.serverOutput = serverOutput;
} finally {
  await cleanup();
}

const evidencePath = resolve(evidenceDir, 'browser-device-loss-result.json');
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
if (evidence.verdict !== 'pass') {
  console.error(
    `[bloom-browser-device-loss] FAIL - ${JSON.stringify({
      failure: evidence.failure,
      lastInspection: evidence.lastInspection,
      pageErrors: evidence.pageErrors,
      consoleErrors: evidence.consoleErrors,
    })}`,
  );
}
console.log(`[bloom-browser-device-loss] evidence=${evidencePath} status=${evidence.verdict}`);
if (evidence.verdict !== 'pass') process.exit(1);
