#!/usr/bin/env node
// Browser-live M3 gate: switch one scene between the built-in URP pipeline and
// a user-registered RenderGraph pipeline. The falsifier maps both selections to
// URP so the framebuffer delta must disappear.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(APP_ROOT, '.forgeax-debug', 'm3-browser-pipeline'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

function decodePng(buffer) {
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

function distance(a, b) {
  return Math.sqrt(
    (a.mean[0] - b.mean[0]) ** 2 +
      (a.mean[1] - b.mean[1]) ** 2 +
      (a.mean[2] - b.mean[2]) ** 2,
  );
}

async function waitForVite(proc) {
  let url;
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[vite] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
  });
  proc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('vite did not become ready in 30s');
  return url;
}

async function capture(page, label) {
  const canvas = page.locator('#app');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error(`canvas bounding box missing for ${label}`);
  const controls = page.locator('#variant-control, #pipeline-control');
  await controls.evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden';
  });
  try {
    const png = await page.screenshot({ path: resolve(ARTIFACT_DIR, `${label}.png`), clip: box });
    return decodePng(png);
  } finally {
    await controls.evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'visible';
    });
  }
}

const port = Number(process.env.FORGEAX_BROWSER_PORT ?? 55940) + Math.floor(Math.random() * 40);
const viteProc = spawn(process.execPath, [
  resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js'),
  'preview',
  '--host', '127.0.0.1',
  '--port', String(port),
], { cwd: APP_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const baseUrl = await waitForVite(viteProc);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
  });

  const drive = async (query, prefix) => {
    await page.goto(`${baseUrl}/${query}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=standard',
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(700);
    const standard = await capture(page, `${prefix}-standard`);
    await page.selectOption('#pipeline-select', 'custom');
    await page.waitForFunction(
      () => document.querySelector('#pipeline-status')?.textContent === 'M3_PIPELINE=custom',
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(700);
    const custom = await capture(page, `${prefix}-custom`);
    return { standard, custom, delta: distance(standard, custom) };
  };

  const live = await drive('', 'live');
  const falsified = await drive('?falsify-pipeline=1', 'falsified');
  const result = { live, falsified, liveDelta: live.delta, falsifiedDelta: falsified.delta };
  writeFileSync(resolve(ARTIFACT_DIR, 'browser-pipeline.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (live.delta < 0.05) throw new Error(`custom pipeline did not change canvas pixels: delta=${live.delta.toFixed(3)}`);
  if (falsified.delta >= 0.05) throw new Error(`pipeline falsifier did not kill delta: delta=${falsified.delta.toFixed(3)}`);
  console.log(`[m3-browser-pipeline] PASS - liveDelta=${live.delta.toFixed(3)} falsifiedDelta=${falsified.delta.toFixed(3)} artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  console.error(`[m3-browser-pipeline] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
  await browser?.close();
}
