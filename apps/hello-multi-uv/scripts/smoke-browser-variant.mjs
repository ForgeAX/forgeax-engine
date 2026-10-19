#!/usr/bin/env node
// Browser-live M3 gate: select the compiled multi-UV material variant through
// the public MeshRenderer/MaterialAsset path, then prove the canvas changes.
// The falsifier gives both handles the same compiled variant; the pixel switch
// must disappear, otherwise the gate is measuring the HUD rather than the PSO.

import { chromium } from 'playwright';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-browser-variant'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

function decodePngStats(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported screenshot PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const source = raw[rawPos++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = x >= channels && y > 0 ? pixels[previousStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = source; break;
        case 1: value = source + left; break;
        case 2: value = source + above; break;
        case 3: value = source + ((left + above) >> 1); break;
        case 4: {
          const predictor = left + above - upperLeft;
          const pa = Math.abs(predictor - left);
          const pb = Math.abs(predictor - above);
          const pc = Math.abs(predictor - upperLeft);
          value = source + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      pixels[rowStart + x] = value & 0xff;
    }
  }
  let count = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let i = 0; i < pixels.length; i += channels * 4) {
    red += pixels[i] ?? 0;
    green += pixels[i + 1] ?? 0;
    blue += pixels[i + 2] ?? 0;
    count++;
  }
  return { width, height, mean: [red / count, green / count, blue / count] };
}

function meanDistance(a, b) {
  return Math.sqrt(
    (a.mean[0] - b.mean[0]) ** 2 +
      (a.mean[1] - b.mean[1]) ** 2 +
      (a.mean[2] - b.mean[2]) ** 2,
  );
}

async function waitForVite(proc) {
  let portUrl;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    portUrl ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) throw new Error('vite did not become ready in 30s');
  return portUrl;
}

async function capture(page, label) {
  const canvas = page.locator('#app');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`canvas bounding box missing for ${label}`);
  const control = page.locator('#variant-control');
  await control.evaluate((element) => {
    (element).style.visibility = 'hidden';
  });
  let png;
  try {
    png = await page.screenshot({
      path: resolve(ARTIFACT_DIR, `${label}.png`),
      clip: box,
    });
  } finally {
    await control.evaluate((element) => {
      (element).style.visibility = 'visible';
    });
  }
  if (process.env.FORGEAX_M3_VARIANT_TAPES === '1') {
    const bytes = await page.evaluate(async () => {
      const capture = await globalThis.__forgeax.captureFrame();
      if (!capture.ok) throw new Error(JSON.stringify(capture.error));
      return Array.from(capture.value.bytes);
    });
    writeFileSync(resolve(ARTIFACT_DIR, `${label}.rhitape`), Buffer.from(bytes));
  }
  return decodePngStats(png);
}

async function driveSelection(page, baseUrl, falsify) {
  const targetUrl = `${baseUrl}/${falsify ? '?falsify=constant' : ''}`;
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  try {
    await page.waitForFunction(
      () => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=true',
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body.innerText,
      status: document.querySelector('#variant-status')?.textContent ?? null,
      html: document.documentElement.outerHTML.slice(0, 1000),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)} diagnostic=${JSON.stringify(diagnostic)}`);
  }
  await page.waitForTimeout(700);
  const baseline = await capture(page, falsify ? 'falsify-true' : 'variant-true');
  await page.selectOption('#variant-select', 'false');
  await page.waitForFunction(
    () => document.querySelector('#variant-status')?.textContent === 'M3_MULTI_UV_VARIANT=false',
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(700);
  const selected = await capture(page, falsify ? 'falsify-false' : 'variant-false');
  return { baseline, selected, delta: meanDistance(baseline, selected) };
}

const devPort = Number(process.env.FORGEAX_BROWSER_PORT ?? 55900) + Math.floor(Math.random() * 90);
const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  String(devPort),
], {
  cwd: APP_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const baseUrl = await waitForVite(viteProc);
  browser = await chromium.launch({
    ...browserLaunch,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.error(`[browser-pageerror] ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) {
      consoleErrors.push(message.text());
      console.error(`[browser-console] ${message.text()}`);
    }
  });

  const live = await driveSelection(page, baseUrl, false);
  const falsified = await driveSelection(page, baseUrl, true);
  const liveDelta = live.delta;
  const falsifiedDelta = falsified.delta;
  writeFileSync(
    resolve(ARTIFACT_DIR, 'browser-variant.json'),
    `${JSON.stringify({ live, falsified, liveDelta, falsifiedDelta }, null, 2)}\n`,
  );
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (liveDelta < 0.05) throw new Error(`compiled variant switch did not change canvas pixels: delta=${liveDelta.toFixed(3)}`);
  if (falsifiedDelta >= 0.05) throw new Error(`falsifier did not kill switch delta: delta=${falsifiedDelta.toFixed(3)}`);
  console.log(
    `[m3-browser-variant] PASS - liveDelta=${liveDelta.toFixed(3)} falsifiedDelta=${falsifiedDelta.toFixed(3)} screenshots=${ARTIFACT_DIR}`,
  );
} catch (error) {
  console.error(`[m3-browser-variant] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
  await browser?.close();
}
