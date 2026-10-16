#!/usr/bin/env node
// Browser proof for the same Vite entry used by the consumer. This exercises
// the dev-server pack path and native Chromium WebGPU, then checks the
// workload oracle and two real canvas screenshots.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const outputPath = process.env.PERF_BROWSER_OUTPUT ?? resolve(appRoot, 'artifacts', 'browser.json');
const firstScreenshotPath = process.env.PERF_BROWSER_FIRST_SCREENSHOT ?? `${outputPath}.first.png`;
const finalScreenshotPath = process.env.PERF_BROWSER_SCREENSHOT ?? `${outputPath}.png`;
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(firstScreenshotPath), { recursive: true });
mkdirSync(dirname(finalScreenshotPath), { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/perf-10k-cubes-lights', 'dev'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverUrl;
server.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  const match = text.match(/Local:\s+(http:\/\/[^\s]+)/u);
  if (match !== null) serverUrl = match[1];
});
server.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk.toString()}`));

function stopServer() {
  server.kill('SIGTERM');
}
function fail(message) {
  stopServer();
  console.error(`[perf-10k-cubes-lights/browser] FAIL ${message}`);
  process.exit(1);
}

const serverDeadline = Date.now() + 30_000;
while (serverUrl === undefined && Date.now() < serverDeadline) await delay(100);
if (serverUrl === undefined) fail('Vite dev server did not become ready within 30s');

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
} catch (error) {
  fail(`Chromium WebGPU launch failed: ${error instanceof Error ? error.message : String(error)}`);
}

const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`);
});

try {
  await page.goto(`${serverUrl}?cubes=10000&pointLights=16&spotLights=16`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPerf?.frameProgress >= 60, undefined, { timeout: 60_000 });
  const firstScreenshot = await page.locator('#app').screenshot({ path: firstScreenshotPath });
  await page.waitForFunction(() => globalThis.__forgeaxPerf?.frameProgress >= 210, undefined, { timeout: 60_000 });
  const finalScreenshot = await page.locator('#app').screenshot({ path: finalScreenshotPath });
  const evidence = await page.evaluate(() => globalThis.__forgeaxPerf);

  const imageAnalysis = await page.evaluate(async ({ first, final }) => {
    async function decode(base64) {
      const response = await fetch(`data:image/png;base64,${base64}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('2D canvas readback unavailable');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    function stats(image) {
      let nonClearPixels = 0;
      let sum = 0;
      let sumSquares = 0;
      for (let index = 0; index < image.pixels.length; index += 4) {
        const r = image.pixels[index] ?? 0;
        const g = image.pixels[index + 1] ?? 0;
        const b = image.pixels[index + 2] ?? 0;
        const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        sum += luma;
        sumSquares += luma * luma;
        if (r > 8 || g > 8 || b > 14) nonClearPixels += 1;
      }
      const count = image.pixels.length / 4;
      const meanLuma = sum / count;
      return { nonClearPixels, meanLuma, lumaVariance: sumSquares / count - meanLuma * meanLuma };
    }
    const before = await decode(first);
    const after = await decode(final);
    let changedPixels = 0;
    let maxDelta = 0;
    for (let index = 0; index < before.pixels.length; index += 4) {
      const delta = Math.max(
        Math.abs((before.pixels[index] ?? 0) - (after.pixels[index] ?? 0)),
        Math.abs((before.pixels[index + 1] ?? 0) - (after.pixels[index + 1] ?? 0)),
        Math.abs((before.pixels[index + 2] ?? 0) - (after.pixels[index + 2] ?? 0)),
      ) / 255;
      maxDelta = Math.max(maxDelta, delta);
      if (delta > 0.02) changedPixels += 1;
    }
    return { width: after.width, height: after.height, first: stats(before), final: stats(after), motion: { changedPixels, maxDelta } };
  }, { first: firstScreenshot.toString('base64'), final: finalScreenshot.toString('base64') });

  const profileComplete = evidence.profileCapture?.completeness?.status === 'complete' && evidence.profileCapture.completeness.droppedEventCount === 0;
  const screenshotHashes = {
    first: createHash('sha256').update(firstScreenshot).digest('hex'),
    final: createHash('sha256').update(finalScreenshot).digest('hex'),
  };
  const assertions = {
    exactCubeCount: evidence.postSpawn.cubeCount === 10_000 && evidence.processedCubeCount === 10_000,
    sharedMeshAndMaterial: evidence.postSpawn.meshHandleMatches === 10_000 && evidence.postSpawn.materialHandleMatches === 10_000,
    punctualLightsPresent: evidence.postSpawn.pointLightCount === 16 && evidence.postSpawn.spotLightCount === 16,
    cameraAndCubeMotion: evidence.cameraRotationRadians > 0 && imageAnalysis.motion.changedPixels > imageAnalysis.width * imageAnalysis.height * 0.01,
    notClearOnly: imageAnalysis.final.nonClearPixels > imageAnalysis.width * imageAnalysis.height * 0.01 && imageAnalysis.final.lumaVariance > 0.00001,
    completeProfileNoDrops: profileComplete,
    noAppRendererOrBrowserErrors: evidence.appRendererErrors.length === 0 && browserErrors.length === 0,
  };
  const result = { entry: serverUrl, evidence, profileComplete, browserErrors, screenshotHashes, imageAnalysis, assertions };
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  const failed = Object.entries(assertions).filter(([, value]) => value !== true);
  if (failed.length > 0) fail(`assertions failed: ${JSON.stringify(Object.fromEntries(failed))}`);
  console.log(`[perf-10k-cubes-lights/browser] PASS ${JSON.stringify({ imageAnalysis, profileComplete, screenshotHashes })}`);
} finally {
  await browser.close();
  stopServer();
}
