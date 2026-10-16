#!/usr/bin/env node
// apps/learn-render/1.getting-started/4.textures/scripts/bench-screenshot.mjs
//
// Records the M8 golden PNG for `pnpm bench:pixel-parity` (entry
// `app-learn-render-1-getting-started-4-textures`, plan-strategy
// section 2.7 Open Q-1 option (a) - each milestone records its own
// baseline). Mirrors apps/learn-render/.../1.hello-window/scripts/
// bench-screenshot.mjs structure modulo the LO 1.4 specifics
// (port 5183 + capture hook name `__captureTextures` + output
// round-4-textures.png).
//
// Pipeline:
//   1. spawn vite preview on port 5183 (vite.config.ts strictPort).
//   2. wait-on tcp 30s.
//   3. chromium.launch(channel: chrome-beta) with the WebGPU flag set
//      mirroring scripts/bench/pixel-parity.mjs (charter F2 image
//      capture must run in the same browser the bench reads from).
//   4. page.goto -> wait for `[learn-render 1.4 textures] backend=...`
//      console signal -> wait for `__captureTextures` hook installation
//      -> page.evaluate the hook -> read pixels.
//   5. encode the captured RGBA buffer as PNG via pngjs (transitive
//      dep of pixelmatch) and write to
//      forgeax-engine-assets/feat-20260515-learn-render-getting-started/
//      screenshots/round-4-textures.png.
//
// charter F3 + P5 mapping: this script is the producer (subagent at
// implement time runs `pnpm --filter <app> exec node scripts/...`); the
// orchestrator at verify time reads the same PNG via the bench runner
// (`pnpm bench:pixel-parity`). The PNG itself is not interpreted by the
// subagent - it is captured byte-identically and committed under the
// `forgeax-engine-assets/` submodule.
//
// Idempotency: re-running this script overwrites the PNG (architecture
// principle 6). The output is deterministic for a fixed clearColor +
// canvas size + WebGPU driver: the LO 1.4 example does not pulse a
// time-driven uniform (unlike 1.3 shaders), so the wood-container
// texture sample at the cube center is byte-stable modulo driver noise
// within the PIXEL_PARITY_THRESHOLD tolerance epsilon <= 0.05.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..', '..', '..');
const SUBMODULE_DIR = resolve(
  REPO_ROOT,
  'forgeax-engine-assets',
  'feat-20260515-learn-render-getting-started',
  'screenshots',
);
const OUT_PATH = resolve(SUBMODULE_DIR, 'round-4-textures.png');

const PORT = 5183;
const CANVAS_W = 512;
const CANVAS_H = 512;

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveFn) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolveFn(undefined);
    }, 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolveFn(undefined);
    });
  });
}

async function main() {
  if (!existsSync(resolve(REPO_ROOT, 'forgeax-engine-assets', 'README.md'))) {
    throw new Error(
      "[bench-screenshot] forgeax-engine-assets submodule not initialised; run 'git submodule update --init --recursive forgeax-engine-assets'",
    );
  }
  mkdirSync(SUBMODULE_DIR, { recursive: true });

  // Defer heavy deps until after the submodule pre-check so a missing
  // submodule fails fast with a recovery hint (charter P3).
  const { default: waitOn } = await import('wait-on');
  const { chromium } = await import('playwright');

  let preview = null;
  let browser = null;
  try {
    preview = spawn(
      'pnpm',
      [
        '--filter',
        '@forgeax/app-learn-render-1-getting-started-4-textures',
        'exec',
        'vite',
        'preview',
        '--port',
        String(PORT),
        '--host',
        '127.0.0.1',
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    preview.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
    preview.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

    await waitOn({
      resources: [`tcp:127.0.0.1:${PORT}`],
      timeout: 30_000,
    });

    browser = await chromium.launch({
      headless: true,
      channel: 'chrome-beta',
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-driver-bug-workarounds',
      ],
      chromiumSandbox: true,
    });
    const ctx = await browser.newContext({ viewport: { width: CANVAS_W, height: CANVAS_H } });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      process.stderr.write(`[chromium.${msg.type()}] ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => {
      process.stderr.write(`[chromium.pageerror] ${err.message}\n`);
    });

    const backendReady = page.waitForEvent('console', {
      predicate: (msg) => msg.text().includes('[learn-render 1.4 textures] backend='),
      timeout: 30_000,
    });
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'load' });
    await backendReady;
    await page.waitForFunction(() => typeof window.__captureTextures === 'function', null, {
      timeout: 30_000,
    });
    const pixelsArray = await page.evaluate(async () => {
      const capture = window.__captureTextures;
      if (typeof capture !== 'function') {
        throw new Error('window.__captureTextures not installed after backendReady');
      }
      const u8 = await capture();
      return Array.from(u8);
    });
    if (pixelsArray.length !== CANVAS_W * CANVAS_H * 4) {
      throw new Error(
        `[bench-screenshot] capture length=${pixelsArray.length} expected ${CANVAS_W * CANVAS_H * 4}`,
      );
    }
    const cx = CANVAS_W >> 1;
    const cy = CANVAS_H >> 1;
    const idx = (cy * CANVAS_W + cx) * 4;
    const cr = pixelsArray[idx];
    const cg = pixelsArray[idx + 1];
    const cb = pixelsArray[idx + 2];
    console.warn(`[bench-screenshot] center RGB=(${cr}, ${cg}, ${cb})`);

    const { PNG } = await import('pngjs');
    const png = new PNG({ width: CANVAS_W, height: CANVAS_H });
    png.data = Buffer.from(pixelsArray);
    const pngBuffer = PNG.sync.write(png);
    writeFileSync(OUT_PATH, pngBuffer);
    console.warn(`[bench-screenshot] wrote ${OUT_PATH}`);
  } finally {
    if (browser !== null) await browser.close();
    if (preview !== null) await killChild(preview);
  }
}

await main();
