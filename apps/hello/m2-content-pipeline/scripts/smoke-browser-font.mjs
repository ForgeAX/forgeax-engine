#!/usr/bin/env node
// M2 browser-host font smoke: prove the real @zappar MSDF generator can use
// its Worker + WASM path with a real TTF when plain Node has no Worker global.

import { chromium } from 'playwright';
import { stripVTControlCharacters } from 'node:util';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const artifactDir = resolve(
  process.env.FORGEAX_M2_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m2-content-pipeline', 'browser-font-worker'),
);
mkdirSync(artifactDir, { recursive: true });

const vite = spawn(
  process.execPath,
  [resolve(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '0'],
  { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
);
let baseUrl;
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  baseUrl ??= stripVTControlCharacters(text).match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

let browser;
try {
  const deadline = Date.now() + 30_000;
  while (baseUrl === undefined && Date.now() < deadline) await sleep(200);
  if (baseUrl === undefined) throw new Error('Vite did not become ready in 30s');

  browser = await chromium.launch({ headless: true, channel: browserLaunch.channel, chromiumSandbox: true});
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(`${baseUrl}/apps/hello/m2-content-pipeline/font-worker-probe.html`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });

  const summary = await page.evaluate(async () => {
    const { MSDF } = await import('/apps/hello/m2-content-pipeline/node_modules/@zappar/msdf-generator/dist/index.js');
    const response = await fetch('/forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf');
    if (!response.ok) throw new Error(`TTF fetch failed: ${response.status}`);
    const font = new Uint8Array(await response.arrayBuffer());
    const generator = new MSDF();
    await generator.initialize();
    const atlas = await generator.generateAtlas({
      font,
      charset: 'ABCabc123',
      fontSize: 32,
      textureSize: [256, 256],
      fieldRange: 4,
      fixOverlaps: true,
    });
    let nonZeroTextureBytes = 0;
    for (const value of atlas.texture.data) if (value !== 0) nonZeroTextureBytes++;
    const result = {
      workerAvailable: typeof Worker === 'function',
      fontBytes: font.byteLength,
      textureWidth: atlas.textureSize[0],
      textureHeight: atlas.textureSize[1],
      textureBytes: atlas.texture.data.length,
      nonZeroTextureBytes,
      glyphs: atlas.glyphs.length,
      distanceRange: atlas.fieldRange,
      fontName: atlas.info.name,
    };
    await generator.dispose();
    return result;
  });

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
  if (!summary.workerAvailable) throw new Error('browser host has no Worker global');
  if (summary.fontBytes < 300_000) throw new Error(`unexpected TTF size: ${summary.fontBytes}`);
  if (summary.textureWidth !== 256 || summary.textureHeight !== 256 || summary.textureBytes === 0) {
    throw new Error(`invalid atlas: ${summary.textureWidth}x${summary.textureHeight} bytes=${summary.textureBytes}`);
  }
  if (summary.nonZeroTextureBytes === 0 || summary.glyphs < 9 || summary.distanceRange !== 4) {
    throw new Error(`atlas oracle failed: ${JSON.stringify(summary)}`);
  }
  const artifactPath = resolve(artifactDir, 'font-worker-bake.json');
  writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `[m2-browser-font] PASS - worker=${summary.workerAvailable} fontBytes=${summary.fontBytes} atlas=${summary.textureWidth}x${summary.textureHeight} textureBytes=${summary.textureBytes} glyphs=${summary.glyphs} distanceRange=${summary.distanceRange} artifact=${artifactPath}`,
  );
} catch (error) {
  console.error(`[m2-browser-font] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser !== undefined) await browser.close();
  vite.kill('SIGTERM');
}
