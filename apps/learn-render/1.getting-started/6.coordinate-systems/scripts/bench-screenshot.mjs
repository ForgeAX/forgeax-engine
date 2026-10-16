#!/usr/bin/env node
// apps/learn-render/1.getting-started/6.coordinate-systems/scripts/bench-screenshot.mjs
//
// Records the M10 golden PNG for `pnpm bench:pixel-parity` (entry
// `app-learn-render-1-getting-started-6-coordinate-systems`, plan-strategy
// section 2.7 Open Q-1 option (a) - each milestone records its own
// baseline). Mirrors apps/learn-render/.../5.transformations/scripts/
// bench-screenshot.mjs structure modulo the LO 1.6 specifics
// (port 5185 + capture hook name `__captureCoordinateSystems` + output
// round-6-coordinate-systems.png).
//
// Pipeline:
//   1. spawn vite preview on port 5185 (vite.config.ts strictPort).
//   2. wait-on tcp 30s.
//   3. chromium.launch(channel: chrome-beta) with the WebGPU flag set
//      mirroring scripts/bench/pixel-parity.mjs (charter F2 image
//      capture must run in the same browser the bench reads from).
//   4. page.goto -> wait for `[learn-render 1.6 coordinate-systems] backend=...`
//      console signal -> wait for `__captureCoordinateSystems` hook
//      installation -> page.evaluate the hook -> read pixels.
//   5. encode the captured RGBA buffer as PNG via pngjs (transitive
//      dep of pixelmatch) and write to
//      forgeax-engine-assets/feat-20260515-learn-render-getting-started/
//      screenshots/round-6-coordinate-systems.png.
//
// charter F3 + P5 mapping: this script is the producer (subagent at
// implement time runs `pnpm --filter <app> exec node scripts/...`); the
// orchestrator at verify time reads the same PNG via the bench runner
// (`pnpm bench:pixel-parity`). The PNG itself is not interpreted by the
// subagent - it is captured byte-identically and committed under the
// `forgeax-engine-assets/` submodule.
//
// Idempotency: re-running this script overwrites the PNG (architecture
// principle 6). The output is deterministic across runs (LO 1.6 chapter
// is static -- 10 cubes do not animate). The capture hook re-issues a
// fresh world.update(1 / 60).unwrap() + draw + samples through createImageBitmap +
// OffscreenCanvas (same shape as M7 / M8 / M9 so any future regression
// surfaces in all pipelines simultaneously).

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
const OUT_PATH = resolve(SUBMODULE_DIR, 'round-6-coordinate-systems.png');

const PORT = 5185;
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
        '@forgeax/app-learn-render-1-getting-started-6-coordinate-systems',
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
      predicate: (msg) => msg.text().includes('[learn-render 1.6 coordinate-systems] backend='),
      timeout: 30_000,
    });
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'load' });
    await backendReady;
    await page.waitForFunction(
      () => typeof window.__captureCoordinateSystems === 'function',
      null,
      { timeout: 30_000 },
    );
    const pixelsArray = await page.evaluate(async () => {
      const capture = window.__captureCoordinateSystems;
      if (typeof capture !== 'function') {
        throw new Error('window.__captureCoordinateSystems not installed after backendReady');
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
