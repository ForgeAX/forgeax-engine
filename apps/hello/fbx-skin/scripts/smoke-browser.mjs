#!/usr/bin/env node
// hello-fbx-skin browser e2e smoke (M5 / t57).
//
// Playwright + chromium + WebGPU: exercises the dev-server import -> pack-body
// -> typed-array roundtrip -> skinned-scene-instantiate path that dawn-node
// smoke skips. Asserts canvas present, WebGPU backend, 3 skinned instances
// spawned (via the HUD the demo writes only after instantiate succeeds), and
// no draw errors.
// (Pixel non-blackness is NOT asserted: headless WebGPU does not composite into
// screenshots reliably on all machines; see hello/level-switch for the
// page.screenshot()-based visual gate where a renderer runner is available.)
// Mirrors hello-fbx-cube smoke-browser.mjs shape.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_FRAMES = 60;
const WIDTH = 800;
const HEIGHT = 600;

const here = fileURLToPath(import.meta.url);

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
  chromiumSandbox: true,
});

const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });

const logs = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (msg) => {
  logs.push(msg.text());
  if (msg.type() === 'error') errors.push(`${msg.text()} (${msg.location().url})`);
});
await page.addInitScript(() => {
  globalThis.__gpuValidationErrors = [];
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (...args) => {
    const adapter = await requestAdapter(...args);
    if (!adapter) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...options) => {
      const device = await requestDevice(...options);
      device.addEventListener('uncapturederror', (event) => globalThis.__gpuValidationErrors.push(event.error.message));
      return device;
    };
    return adapter;
  };
});

const { createServer } = await import('vite');
const rootPath = new URL('..', import.meta.url).pathname;
const server = await createServer({ root: rootPath, server: { port: 5174 } });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

try {
  await page.goto(`${url}/?gpu-evidence=1&gpu-ssao=1`, { waitUntil: 'domcontentloaded' });
  // Cold-start budget: a fresh vite server may re-optimize deps + compile the
  // wgpu wasm before the demo's async instantiate writes the HUD. 5s was flaky
  // on cold caches; poll the HUD up to 20s instead of a single fixed wait.
  let hudReady = false;
  for (let waited = 0; waited < 20000; waited += 1000) {
    await delay(1000);
    hudReady = await page.evaluate(() => {
      const el = document.getElementById('fbx-skin-hud');
      return el !== null && /\d+x humanoid instances/.test(el.textContent ?? '');
    });
    if (hudReady) break;
  }

  const canvasExists = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c !== null && c.width > 0;
  });
  if (!canvasExists) {
    console.error('[smoke] FAIL - canvas not found');
    process.exit(1);
  }

  const backend = await page.evaluate(() => globalThis.__forgeaxGpuEvidence?.().backend);
  if (backend !== 'webgpu') {
    console.error('[smoke] FAIL - no WebGPU backend detected in logs');
    process.exit(1);
  }

  // The demo writes the HUD ("Nx humanoid instances") only after at least one
  // skinned scene instantiate succeeds (it early-returns with an error log if
  // none do), so a HUD count >= 1 proves the dev-server import -> pack-body ->
  // typed-array roundtrip -> skinned-scene-instantiate path completed.
  const hudText = await page.evaluate(() => {
    const el = document.getElementById('fbx-skin-hud');
    return el ? el.textContent ?? '' : '';
  });
  const hudMatch = hudText.match(/(\d+)x humanoid instances/);
  if (!hudMatch || Number(hudMatch[1]) < 1) {
    console.error(`[smoke] FAIL - no skinned instances in HUD (text="${hudText}")`);
    process.exit(1);
  }

  console.log('[smoke] initial GPU evidence', JSON.stringify(await page.evaluate(() => globalThis.__forgeaxGpuEvidence?.())));
  await page.waitForFunction(() => globalThis.__forgeaxGpuEvidence?.().frames >= 60, null, { timeout: 60000 }).catch(async (error) => {
    console.error('[smoke] GPU evidence at timeout', await page.evaluate(() => globalThis.__forgeaxGpuEvidence?.()));
    throw error;
  });
  const gpuEvidence = await page.evaluate(() => globalThis.__forgeaxGpuEvidence());
  console.log('[smoke] GPU-driven skin', JSON.stringify(gpuEvidence));
  if (gpuEvidence.failures.length > 0) throw new Error(JSON.stringify(gpuEvidence));

  errors.push(...await page.evaluate(() => globalThis.__gpuValidationErrors));
  const drawErrors = [...errors, ...logs.filter((l) => l.includes('draw error'))];
  if (drawErrors.length > 0) {
    console.error(`[smoke] FAIL - draw errors: ${drawErrors.join('; ')}`);
    process.exit(1);
  }

  console.log(`[smoke] PASS - backend=webgpu, instances=${hudMatch[1]}`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(0);