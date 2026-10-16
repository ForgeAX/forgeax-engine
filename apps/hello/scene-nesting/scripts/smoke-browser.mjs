#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? resolve(here, '..', '.forgeax-debug', 'm30-browser'),
);
const port = Number.parseInt(process.env.FORGEAX_SCENE_NESTING_PORT ?? '5198', 10);
mkdirSync(artifactDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decodePng(buffer) {
  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (cursor < buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.toString('ascii', cursor + 4, cursor + 8);
    const dataStart = cursor + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    cursor = dataStart + length + 4;
  }
  assert(bitDepth === 8 && (colorType === 2 || colorType === 6), 'unsupported screenshot PNG');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  let rawCursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawCursor++];
    const row = y * stride;
    const previous = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawCursor++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y > 0 ? pixels[previous + x] : 0;
      const upperLeft = x >= channels && y > 0 ? pixels[previous + x - channels] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + above;
      else if (filter === 3) restored = value + Math.floor((left + above) / 2);
      else if (filter === 4) {
        const predictor = left + above - upperLeft;
        const leftDistance = Math.abs(predictor - left);
        const aboveDistance = Math.abs(predictor - above);
        const upperLeftDistance = Math.abs(predictor - upperLeft);
        const estimate = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
          ? left
          : aboveDistance <= upperLeftDistance ? above : upperLeft;
        restored = value + estimate;
      } else throw new Error(`unsupported PNG filter ${filter}`);
      pixels[row + x] = restored & 0xff;
    }
  }

  const pixelAt = (x, y) => {
    const offset = y * stride + x * channels;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
  const region = (x0, x1) => {
    let count = 0;
    let sum = 0;
    let sumSquared = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = x0; x < x1; x += 4) {
        const [r, g, b] = pixelAt(x, y);
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        count += 1;
        sum += luma;
        sumSquared += luma * luma;
      }
    }
    const mean = sum / count;
    return { meanLuma: mean, stddevLuma: Math.sqrt(Math.max(0, sumSquared / count - mean * mean)) };
  };
  return {
    width,
    height,
    sample: {
      left: pixelAt(Math.floor(width * 0.25), Math.floor(height * 0.5)),
      center: pixelAt(Math.floor(width * 0.5), Math.floor(height * 0.5)),
      right: pixelAt(Math.floor(width * 0.75), Math.floor(height * 0.5)),
    },
    regions: { left: region(0, Math.floor(width / 2)), right: region(Math.floor(width / 2), width) },
  };
}

const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: resolve(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
);
let viteOutput = '';
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stdout.write(`[vite] ${text}`);
});
vite.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stderr.write(`[vite-err] ${text}`);
});

let browser;
try {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await delay(200);
  }
  assert(Date.now() < deadline, `Vite did not start: ${viteOutput}`);

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
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#scene-nesting-report')?.dataset.status === 'baseline',
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const readReport = async () => JSON.parse(await page.locator('#scene-nesting-report').textContent());
  const baselineReport = await readReport();
  const baselinePath = resolve(artifactDir, 'scene-nesting-baseline.png');
  await page.locator('#canvas').screenshot({ path: baselinePath });

  assert(baselineReport.baseline.diagnostics.length === 0, `baseline diagnostics: ${JSON.stringify(baselineReport)}`);
  assert(baselineReport.baseline.siblingRenderable === true, 'healthy sibling is not renderable');
  assert(baselineReport.baseline.mountedRenderable === true, 'mounted member is not renderable');

  await page.locator('#scene-nesting-recover').click();
  await page.waitForFunction(
    () => document.querySelector('#scene-nesting-report')?.dataset.status === 'repaired',
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const repairedReport = await readReport();
  const repairedPath = resolve(artifactDir, 'scene-nesting-repaired.png');
  await page.locator('#canvas').screenshot({ path: repairedPath });
  const recovery = repairedReport.recovery;
  assert(recovery.rejectedBeforeSpawn === true, `rejection mismatch: ${JSON.stringify(recovery)}`);
  assert(recovery.error?.code === 'asset-package-invalid', `wrong rejection code: ${JSON.stringify(recovery.error)}`);
  assert(recovery.error?.detail?.reason === 'unknown component field', `wrong rejection detail: ${JSON.stringify(recovery.error)}`);
  assert(recovery.inputUnchanged === true && recovery.correctedInputUnchanged === true, 'scene input was mutated');
  assert(recovery.loadedInputsUnchanged === true, 'loader-fed SceneAsset payload changed');
  assert(recovery.noOrphanAfterFault === true, 'fault cleanup left an orphan');
  assert(
    recovery.healthyRetained === true && recovery.healthyRetainedAfterFault === true,
    `healthy baseline was lost: ${JSON.stringify(repairedReport)}`,
  );
  assert(recovery.correctedEmpty === true, `corrected diagnostics: ${JSON.stringify(recovery.correctedDiagnostics)}`);
  assert(recovery.freshIdentity === true, 'corrected instance reused faulty identity');
  assert(recovery.rendererErrors.length === 0, `renderer errors: ${JSON.stringify(recovery.rendererErrors)}`);

  await page.locator('#scene-nesting-cleanup').click();
  await page.waitForFunction(
    () => document.querySelector('#scene-nesting-report')?.dataset.status === 'cleaned',
    undefined,
    { timeout: 30_000 },
  );
  const cleanedReport = await readReport();
  assert(cleanedReport.cleanup.idempotent === true, `cleanup was not idempotent: ${JSON.stringify(cleanedReport)}`);
  assert(cleanedReport.cleanup.healthyRetainedBeforeFinalTeardown === true, 'cleanup removed healthy scene too early');
  assert(cleanedReport.cleanup.finalEntityCount === 0, `entity leak: ${JSON.stringify(cleanedReport.cleanup)}`);
  assert(Object.values(cleanedReport.cleanup.sharedRefCounts).every((count) => count === 0), `shared-ref leak: ${JSON.stringify(cleanedReport.cleanup)}`);
  assert(cleanedReport.cleanup.rendererErrors.length === 0, `cleanup renderer errors: ${JSON.stringify(cleanedReport.cleanup)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);

  const baselinePng = await import('node:fs/promises').then(({ readFile }) => readFile(baselinePath));
  const repairedPng = await import('node:fs/promises').then(({ readFile }) => readFile(repairedPath));
  const baselineStats = decodePng(baselinePng);
  const repairedStats = decodePng(repairedPng);
  for (const [name, stats] of Object.entries(baselineStats.regions)) {
    assert(stats.meanLuma > 3 && stats.stddevLuma > 2, `${name} baseline region is blank: ${JSON.stringify(baselineStats)}`);
  }
  for (const [name, stats] of Object.entries(repairedStats.regions)) {
    assert(stats.meanLuma > 3 && stats.stddevLuma > 2, `${name} repaired region is blank: ${JSON.stringify(repairedStats)}`);
  }
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const evidence = {
    baselineReport,
    repairedReport,
    cleanedReport,
    pixels: {
      baseline: { path: baselinePath, sha256: hash(baselinePng), stats: baselineStats },
      repaired: { path: repairedPath, sha256: hash(repairedPng), stats: repairedStats },
    },
    pageErrors,
    consoleErrors,
  };
  writeFileSync(resolve(artifactDir, 'scene-nesting-browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[m30] Browser scene unknown-field recovery: PASS baseline=${hash(baselinePng)} repaired=${hash(repairedPng)}`);
} catch (error) {
  console.error(`[m30] Browser scene unknown-field recovery: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close();
  vite.kill('SIGTERM');
  await delay(300);
}
