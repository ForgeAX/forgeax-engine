#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

const APP_ROOT = new URL('..', import.meta.url).pathname;
const externalServerUrl = process.env.FORGEAX_MIPMAP_URL;
const port = process.env.FORGEAX_MIPMAP_PORT ?? '5184';
const engine = process.env.FORGEAX_BROWSER_ENGINE ?? 'chromium-webgl2';
const marker = '__forgeaxMipmapProbe:';
const startedAt = Date.now();
let vite;
let browser;
let page;
let url;

if (!['chromium', 'chromium-webgl2', 'webkit'].includes(engine)) {
  console.error(`[mipmap-browser] FAIL - unsupported browser engine=${engine}`);
  process.exit(2);
}

function errorDetail(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack ?? '' }
    : String(error);
}

function signalVite(signal) {
  if (vite?.pid === undefined) return;
  try {
    process.kill(-vite.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
      lastError = new Error(`server returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error('server did not become ready');
}

try {
  if (externalServerUrl === undefined) {
    vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const serverOutput = [];
    vite.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
    vite.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
    vite.once('exit', (code) => {
      if (url === undefined) {
        console.error(`[mipmap-browser] vite exited before readiness: ${code}\n${serverOutput.join('')}`);
      }
    });
    url = `http://127.0.0.1:${port}`;
  } else {
    url = externalServerUrl;
  }
  const routeUrl = new URL(url);
  routeUrl.searchParams.set('fixture', 'mipmap-pipeline');
  await waitForServer(url);

  const launchOptions = {
    headless: !['0', 'false'].includes((process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase()),
    timeout: 30_000,
  };
  if (engine === 'chromium-webgl2') {
    launchOptions.args = [
      '--disable-features=WebGPU',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
    ];
  } else if (engine === 'chromium') {
    launchOptions.args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  } else if (process.env.FORGEAX_WEBKIT_EXECUTABLE_PATH !== undefined) {
    launchOptions.executablePath = process.env.FORGEAX_WEBKIT_EXECUTABLE_PATH;
  }
  if (engine !== 'webkit' && process.env.FORGEAX_BROWSER_CHANNEL !== undefined) {
    launchOptions.channel = process.env.FORGEAX_BROWSER_CHANNEL;
  }
  const browserType = engine === 'webkit' ? webkit : chromium;
  browser = await browserType.launch({ ...(launchOptions), chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
  const consoleDiagnostics = [];
  const pageErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(marker)) {
      try {
        consoleDiagnostics.push(JSON.parse(text.slice(marker.length)));
      } catch {
        consoleDiagnostics.push({ malformed: text });
      }
    }
  });
  page.on('pageerror', (error) => pageErrors.push(errorDetail(error)));
  await page.goto(routeUrl.toString(), { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.__forgeaxMipmapProbeResult !== undefined,
    undefined,
    { timeout: Number(process.env.FORGEAX_BROWSER_HARD_DEADLINE_MS ?? 120_000) },
  );
  const result = await page.evaluate(() => globalThis.__forgeaxMipmapProbeResult);
  const evidence = {
    schema: 'forgeax.mipmap-browser-smoke/1',
    status: result?.status === 'pass' && result?.backendKind === 'wgpu-webgl2' ? 'pass' : 'fail',
    engine,
    elapsedMs: Date.now() - startedAt,
    result,
    consoleDiagnostics,
    pageErrors,
  };
  console.log(`[mipmap-browser] report=${JSON.stringify(evidence)}`);
  if (evidence.status !== 'pass') process.exitCode = 2;
} catch (error) {
  console.error(`[mipmap-browser] FAIL - ${JSON.stringify({ engine, elapsedMs: Date.now() - startedAt, error: errorDetail(error) })}`);
  process.exitCode = 2;
} finally {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (vite?.pid !== undefined) {
    signalVite('SIGTERM');
    await delay(500);
    signalVite('SIGKILL');
  }
}
