#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const PORT = Number.parseInt(process.env.FORGEAX_SKYBOX_WEBGL2_PORT ?? '5421', 10);
const FRAME_COUNT = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_SKYBOX_WEBGL2_DIR ?? resolve(ROOT, '.forgeax-debug/skybox-webgl2'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const pnpmArgs = ['--filter', '@forgeax/bevy-skybox', 'preview', '--host', '127.0.0.1', '--port', String(PORT)];
const server = spawn(
  'pnpm',
  pnpmArgs,
  { cwd: ROOT, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

const serverDeadline = Date.now() + 30_000;
let serverReady = false;
while (Date.now() < serverDeadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    if (response.ok) {
      serverReady = true;
      break;
    }
  } catch {
    // Vite preview is still starting.
  }
  await delay(250);
}
if (!serverReady) throw new Error(`Skybox preview did not start: ${serverOutput}`);

const launchOptions = {
  headless: true,
  ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE === undefined
    ? { channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel }
    : { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }),
  args: [
    '--disable-gpu',
    '--disable-features=WebGPU,MacAppCodeSignClone',
    '--disable-gpu-driver-bug-workarounds',
  ],
};
const browser = await chromium.launch({ ...(launchOptions), chromiumSandbox: true });
const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (
    consoleErrors.length < 20 &&
    message.type() === 'error' &&
    !message.text().includes('favicon.ico') &&
    !message.text().includes('Failed to load resource')
  ) {
    consoleErrors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});
try {
  await page.goto(`http://127.0.0.1:${PORT}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(
    (minimumFrames) => Number(document.documentElement.dataset.forgeaxFrameCompleted ?? 0) >= minimumFrames,
    FRAME_COUNT,
    { timeout: 45_000, polling: 100 },
  );
  await page.waitForTimeout(250);

  const screenshotPath = resolve(ARTIFACT_DIR, 'skybox-webgl2.png');
  const screenshot = await page.locator('#app').screenshot({ path: screenshotPath, type: 'png' });
  const pixels = await page.evaluate(async (encoded) => {
    const response = await fetch(`data:image/png;base64,${encoded}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Skybox screenshot 2D readback unavailable');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxLuma = 0;
    let sumLuma = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luma = ((data[index] ?? 0) * 0.299 + (data[index + 1] ?? 0) * 0.587 + (data[index + 2] ?? 0) * 0.114) / 255;
      maxLuma = Math.max(maxLuma, luma);
      sumLuma += luma;
    }
    bitmap.close();
    return { maxLuma, meanLuma: sumLuma / Math.max(1, data.length / 4) };
  }, screenshot.toString('base64'));

  const probe = await page.evaluate(async () => {
    const canvas = document.querySelector('#app');
    let adapterAvailable = false;
    try {
      adapterAvailable = (await navigator.gpu?.requestAdapter()) != null;
    } catch {
      adapterAvailable = false;
    }
    return {
      navigatorGpu: navigator.gpu !== undefined,
      adapterAvailable,
      webgl2: canvas instanceof HTMLCanvasElement && canvas.getContext('webgl2') !== null,
      frames: Number(document.documentElement.dataset.forgeaxFrameCompleted ?? 0),
      canvas: canvas instanceof HTMLCanvasElement
        ? { width: canvas.width, height: canvas.height }
        : null,
    };
  });
  const report = { probe, pixels, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const failures = [];
  if (probe.adapterAvailable) failures.push('WebGPU adapter unexpectedly available');
  if (!probe.webgl2) failures.push('WebGL2 context unavailable');
  if (probe.frames < FRAME_COUNT) failures.push(`frames=${probe.frames} < ${FRAME_COUNT}`);
  if (pixels.maxLuma <= 0.05 || pixels.meanLuma <= 0.02) {
    failures.push(`HDR skybox is black: maxLuma=${pixels.maxLuma.toFixed(4)} meanLuma=${pixels.meanLuma.toFixed(4)}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    failures.push(`browser errors=${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));

  console.log(
    `[skybox-webgl2] PASS frames=${probe.frames} webgl2=${probe.webgl2} ` +
      `maxLuma=${pixels.maxLuma.toFixed(4)} meanLuma=${pixels.meanLuma.toFixed(4)} errors=0`,
  );
  console.log(`[skybox-webgl2] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await delay(300);
}
