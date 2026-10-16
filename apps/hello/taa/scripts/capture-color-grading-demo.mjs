#!/usr/bin/env node

// Low-resolution, software-friendly visual demo capture.  This is a human
// inspection aid, not feature admission: the JSON keeps the live inspection
// receipt and explicitly records that the run is not physical-GPU evidence.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const outputDir = resolve(process.env.TAA_DEMO_OUTPUT ?? '/tmp/forgeax-taa-color-grading-demo');
const channel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
const useSoftware = process.env.FORGEAX_TAA_DEMO_SOFTWARE !== '0';
const settleFrames = Math.max(60, Number.parseInt(process.env.TAA_DEMO_FRAMES ?? '60', 10) || 60);
const viewport = { width: 960, height: 720 };
const cases = [
  {
    id: 'exposure-adaptation-card',
    query: 'taa-case=exposure-adaptation-card&taa-workload=auto&taa-profile=ci',
  },
  {
    id: 'exposure-auto-dark',
    query: 'taa-case=exposure-adaptation-card&taa-workload=auto&taa-scene-scale=0.25&taa-profile=ci',
  },
  {
    id: 'exposure-auto-bright',
    query: 'taa-case=exposure-adaptation-card&taa-workload=auto&taa-scene-scale=4&taa-profile=ci',
  },
  {
    id: 'exposure-manual-reference',
    query: 'taa-case=exposure-manual-reference&taa-workload=manual&taa-exposure=0.5&taa-profile=ci',
  },
  {
    id: 'exposure-manual-dark',
    query: 'taa-case=exposure-manual-reference&taa-workload=manual&taa-exposure=1&taa-scene-scale=0.25&taa-profile=ci',
  },
  {
    id: 'exposure-manual-bright',
    query: 'taa-case=exposure-manual-reference&taa-workload=manual&taa-exposure=1&taa-scene-scale=4&taa-profile=ci',
  },
  {
    id: 'white-balance-card',
    query: 'taa-case=white-balance-card&taa-workload=manual&taa-temperature=3200&taa-tint=0&taa-profile=ci',
  },
  {
    id: 'lut-output-card',
    query: 'taa-case=lut-output-card&taa-workload=positive-lut&taa-profile=ci',
  },
];

mkdirSync(outputDir, { recursive: true });

const vite = spawn(
  'pnpm',
  ['--filter', '@forgeax/hello-taa', 'exec', 'vite', '--host', '127.0.0.1', '--port', '0'],
  {
    cwd: repoRoot,
    env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '0' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverOutput = '';
let baseUrl;
const observeServer = (chunk) => {
  serverOutput += String(chunk);
  const plain = serverOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  baseUrl ??= plain.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
};
vite.stdout.on('data', observeServer);
vite.stderr.on('data', observeServer);

const stopVite = async () => {
  if (vite.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-vite.pid, 'SIGTERM');
    else vite.kill('SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await sleep(500);
};

const waitForServer = async () => {
  const started = Date.now();
  while (baseUrl === undefined && Date.now() - started < 90_000) await sleep(100);
  if (baseUrl === undefined) throw new Error(`Vite did not publish a URL: ${serverOutput}`);
  const catalogDeadline = Date.now() + 90_000;
  while (Date.now() < catalogDeadline) {
    try {
      const response = await fetch(`${baseUrl}/__pack/scopes/hello-taa/1/catalog.json`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // Keep polling until the scoped Pack catalog is authoritative.
    }
    await sleep(100);
  }
  throw new Error(`hello-taa Pack catalog did not become ready: ${serverOutput}`);
};

const readInspection = async (page) => {
  const text = await page.locator('#inspection').textContent();
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
};

const waitForFrame = async (page, minimum) => {
  await page.waitForFunction(
    (target) => {
      try {
        const state = JSON.parse(document.querySelector('#inspection')?.textContent ?? '');
        return Number(state?.frame?.frameId ?? state?.frame) >= target;
      } catch {
        return false;
      }
    },
    minimum,
    { timeout: 120_000 },
  );
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let browser;
try {
  await waitForServer();
  const args = [
    '--disable-features=MacAppCodeSignClone',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
    '--disable-gpu-driver-bug-workarounds',
    '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    ...(useSoftware
      ? ['--enable-unsafe-swiftshader', '--use-vulkan=swiftshader', '--disable-vulkan-surface']
      : []),
  ];
  browser = await chromium.launch({ headless: true, channel, args, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], chromiumSandbox: true});
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const records = [];
  for (const demoCase of cases) {
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('favicon.ico')) consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/?${demoCase.query}`, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForSelector('#app', { timeout: 10_000 });
    await waitForFrame(page, settleFrames);
    const state = await readInspection(page);
    const canvasBytes = await page.locator('#app').screenshot({ type: 'png' });
    const panelBytes = await page.locator('main').screenshot({ type: 'png' });
    const canvasPath = resolve(outputDir, `${demoCase.id}.png`);
    const panelPath = resolve(outputDir, `${demoCase.id}-panel.png`);
    writeFileSync(canvasPath, canvasBytes);
    writeFileSync(panelPath, panelBytes);
    const record = {
      schemaVersion: 'forgeax-taa-color-grading-demo/1',
      id: demoCase.id,
      execution: 'software-demo-only',
      physicalGpu: false,
      query: demoCase.query,
      settleFrames,
      canvas: { path: canvasPath, sha256: sha256(canvasBytes) },
      panel: { path: panelPath, sha256: sha256(panelBytes) },
      inspection: state,
      errors: { console: consoleErrors, page: pageErrors },
    };
    writeFileSync(resolve(outputDir, `${demoCase.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    records.push(record);
    await page.close();
    console.log(`${demoCase.id}: ${canvasPath}`);
  }
  writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'forgeax-taa-color-grading-demo-manifest/1',
    execution: 'software-demo-only',
    physicalGpu: false,
    cases: records.map(({ id, canvas, panel }) => ({ id, canvas, panel })),
  }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopVite();
}
