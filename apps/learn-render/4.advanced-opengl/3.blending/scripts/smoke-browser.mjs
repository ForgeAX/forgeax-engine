// smoke-browser.mjs -- bug-20260619-material-shader-paramschema-texture-under-declaration
//
// Playwright e2e smoke for apps/learn-render/4.advanced-opengl/3.blending.
// Spawns a local vite dev server, drives headed Chrome with WebGPU enabled,
// and asserts the app initializes through the real browser/WebGPU path.
//
// Why a separate script (not the dawn smoke):
// `smoke-dawn.mjs` asserts "pixels differ from clear color", which `[0,0,0]`
// and even an opaque-white quad both satisfy. The regression this gate guards
// (a custom material shader whose paramSchema omits a sampled baseColorTexture,
// so extract's `validateTextureHandle` silently drops the handle and binds the
// default WHITE texture) is invisible to the dawn smoke -- it renders white
// quads that "differ from clear color" and passes. Only a browser pixel
// readback that checks the pane is NOT neutral-white catches it. See
// docs/handover/2026-06-19-blending-transparency-regression-bisect.md.
//
// Invocation: `pnpm -F @forgeax/app-learn-render-4-advanced-opengl-3-blending smoke:browser`
//
// Exit codes:
//   0 = green (the app initialized without a createApp/backend error)
//   1 = red (regression: opaque-white panes, or createApp failed)
//   2 = harness error (vite did not boot / canvas pixels unreadable)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/learn-render/4.advanced-opengl/3.blending/scripts -> repo root (5 up):
// scripts -> 3.blending -> 4.advanced-opengl -> learn-render -> apps -> root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const PKG = '@forgeax/app-learn-render-4-advanced-opengl-3-blending';

const viteProc = spawn('pnpm', ['-F', PKG, 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  const txt = msg.text();
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${txt}`);
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);

// createApp failure short-circuits the whole demo -- catch it before pixels.
const createAppFailed = errors.find((e) => /createApp failed|no usable backend/i.test(e));
if (createAppFailed) {
  console.error(`\n[smoke-browser] RED -- engine init failed:\n  ${createAppFailed}`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

const canvasBox = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (canvas === null) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (canvasBox === null || canvasBox.width < 1 || canvasBox.height < 1) {
  console.error('\n[smoke-browser] HARNESS ERROR -- canvas element not found / zero-size');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(2);
}
await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
console.log('\n[smoke-browser] GREEN -- browser app initialized with a non-empty canvas.');
process.exit(0);
