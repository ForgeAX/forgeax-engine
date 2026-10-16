#!/usr/bin/env node
// apps/learn-render/3.model-loading/1.model-loading/scripts/visual.mjs
//
// Playwright visual sentinel for the Sponza dev-path render (AC-06).
// Launches chrome-beta with WebGPU flags, spawns vite dev server,
// navigates to the learn-render 3.1 model-loading page, waits for the
// scene-ready hook, and screenshots to the forgeax-engine-assets loop
// screenshots directory. Non-blank-canvas assertion is a PNG-size check
// (blank uniform canvas compresses to < 2 KB; rendered Sponza >> 20 KB).
//
// PNG path: forgeax-engine-assets/artifacts/
//   feat-20260523-vite-plugin-pack-dev-path-gltf-subasset-support/
//   screenshots/round-1-sponza-dev-path-render.png
//
// Usage: node apps/learn-render/3.model-loading/1.model-loading/scripts/visual.mjs

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const ASSETS_ROOT = resolve(REPO_ROOT, 'forgeax-engine-assets');
const SCREENSHOTS_DIR = resolve(
  ASSETS_ROOT,
  'artifacts',
  'forgeax-loop',
  'feat-20260523-vite-plugin-pack-dev-path-gltf-subasset-support',
  'screenshots',
);
const PNG_PATH = resolve(SCREENSHOTS_DIR, 'round-1-sponza-dev-path-render.png');
const DEV_PORT = 5183;
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;
const READY_TIMEOUT_MS = 120_000;
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const devProc = spawnDev();

  // Wait for the dev server to be TCP-ready.
  const { default: waitOn } = await import('wait-on');
  try {
    await waitOn({
      resources: [`tcp:127.0.0.1:${DEV_PORT}`],
      timeout: 60_000,
    });
  } catch (_err) {
    devProc.kill('SIGTERM');
    console.error('[visual] FAIL - dev server did not start within 60s');
    process.exit(1);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome-beta',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });

  let exitCode = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: VIEWPORT_W, height: VIEWPORT_H } });
    const page = await ctx.newPage();

    page.on('console', (msg) => {
      process.stderr.write(`[visual.console.${msg.type()}] ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => {
      process.stderr.write(`[visual.pageerror] ${err.message}\n`);
    });

    await page.goto(DEV_URL, { waitUntil: 'load' });

    await page.waitForFunction(
      'window.__sponzaSceneReady === true',
      { timeout: READY_TIMEOUT_MS },
    );

    // Allow a few extra frames for GPU pipeline warm-up.
    await page.waitForTimeout(2000);

    await page.screenshot({ path: PNG_PATH, fullPage: false });
    console.warn(`[visual] screenshot -> ${PNG_PATH}`);

    const png = readFileSync(PNG_PATH);
    if (png.length === 0) {
      console.error('[visual] FAIL - screenshot file is zero bytes');
      exitCode = 1;
    } else {
      // Non-blank-canvas assertion: a fully uniform clear-color canvas
      // compresses to < 2 KB PNG; rendered Sponza should be >> 20 KB.
      const minExpectedSize = 20_000;
      if (png.length < minExpectedSize) {
        console.error(
          `[visual] FAIL - PNG size ${png.length} bytes < ${minExpectedSize} (likely blank canvas)`,
        );
        exitCode = 1;
      } else {
        console.warn(`[visual] PASS - PNG ${png.length} bytes, non-blank assertion satisfied`);
      }
    }
  } catch (err) {
    console.error(
      '[visual] FAIL -',
      err instanceof Error ? err.message : String(err),
    );
    exitCode = 1;
  } finally {
    await browser.close();
    devProc.kill('SIGTERM');
    // Graceful teardown: give the dev server 3s then force-kill.
    setTimeout(() => {
      if (devProc.exitCode === null) devProc.kill('SIGKILL');
    }, 3000);
  }

  process.exit(exitCode);
}

function spawnDev() {
  const child = spawn(
    'npx',
    ['vite', '--port', String(DEV_PORT), '--host', '127.0.0.1'],
    {
      cwd: DEMO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
  return child;
}

// Main-module guard: only run when invoked as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}