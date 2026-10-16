#!/usr/bin/env node
// hello-fbx-cube browser e2e smoke (M3 / t38).
//
// Playwright + chromium + WebGPU: exercises the dev-server import -> pack-body
// -> typed-array roundtrip -> scene-instantiate path that dawn-node smoke skips.
// Asserts canvas present, WebGPU backend, scene instantiated, no draw errors.
// (Pixel non-blackness is NOT asserted: headless WebGPU does not composite into
// screenshots reliably on all machines; see hello/level-switch for the
// page.screenshot()-based visual gate where a renderer runner is available.)
// Mirrors hello-fbx-skin smoke-browser.mjs shape.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_FRAMES = 300;
const WIDTH = 800;
const HEIGHT = 600;

const here = fileURLToPath(import.meta.url);

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
  chromiumSandbox: true,
});

const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });

// Intercept console for log observation
const logs = [];
page.on('console', (msg) => logs.push(msg.text()));

// Launch the vite dev server
const { createServer } = await import('vite');
const rootPath = new URL('..', import.meta.url).pathname;
const server = await createServer({ root: rootPath, server: { port: 5173 } });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await delay(5000); // Wait for 300 frames (~5s at 60fps)

  // Check that the canvas has WebGPU context
  const canvasExists = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c !== null && c.width > 0;
  });
  if (!canvasExists) {
    console.error('[smoke] FAIL - canvas not found');
    process.exit(1);
  }

  // Check for backend log
  const backendLog = logs.find((l) => l.includes('backend=webgpu'));
  if (!backendLog) {
    console.error('[smoke] FAIL - no WebGPU backend detected in logs');
    process.exit(1);
  }

  // Check for scene-instantiated log. main.ts logs this only after
  // loadByGuid<SceneAsset> + instantiate both succeed (both early-return on
  // failure), so its presence proves the dev-server import -> pack-body ->
  // typed-array roundtrip -> scene instantiate path completed end-to-end.
  const sceneLog = logs.find((l) => l.includes('scene root entity='));
  if (!sceneLog) {
    console.error('[smoke] FAIL - scene-instantiated log not found');
    process.exit(1);
  }

  // Check for errors in draw log
  const drawErrors = logs.filter((l) => l.includes('draw error'));
  if (drawErrors.length > 0) {
    console.error(`[smoke] FAIL - draw errors: ${drawErrors.join('; ')}`);
    process.exit(1);
  }

  // Typed-array survival (Float32Array/Uint16Array prototypes intact across the
  // JSON.stringify(pack) -> fetch -> JSON.parse dev-server path) is validated
  // implicitly by scene instantiate succeeding: if typed arrays lost prototypes,
  // registerWithGuid would fail-fast at GPU upload before this log.

  console.log(`[smoke] PASS - backend=webgpu, sceneLog=${sceneLog}`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(0);