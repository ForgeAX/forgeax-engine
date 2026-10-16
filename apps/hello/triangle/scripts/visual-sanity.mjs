#!/usr/bin/env node
// visual-sanity.mjs — M5 sanity dogfood (feat-20260512-sandbox-visual-verify w18)
//
// Uses playwright chromium.launch to navigate hello-triangle dev server,
// waits for canvas first frame readiness (per requirements.md §4.3.6 notes),
// screenshots to the provided output path, then exits.
//
// This script is the sandbox-side counterpart that the AIUserSimulatorSandbox
// persona would emit (see .claude/skills/forgeax-step-verify/agents/ai-user-simulator-sandbox.md).
// It is intentionally minimal — no baseline diff, no pixelmatch, just capture.
//
// Usage:
//   node apps/hello/triangle/scripts/visual-sanity.mjs <url> <out-path>
// Example:
//   node apps/hello/triangle/scripts/visual-sanity.mjs \
//     http://localhost:5173/ \
//     /tmp/sandbox-m5/.sandbox-artefacts/screenshots/round-1-localhost-5173-root.png

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5173/';
const outPath = process.argv[3];
const minimumFrames = 60;
if (!outPath) {
  console.error('usage: node visual-sanity.mjs <url> <out-path>');
  process.exit(2);
}
mkdirSync(dirname(outPath), { recursive: true });

// WebGPU in headless chromium requires explicit flag set (unstable-webgpu channel);
// see https://github.com/microsoft/playwright/issues/23007. hello-triangle prefers WebGPU
// and throws EngineEnvironmentError when no WebGPU adapter is available.
const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
const context = await browser.newContext({
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const pageErrors = [];
page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') {
    console.log(`[browser:${type}]`, msg.text());
  }
  if (type === 'error' && !msg.text().includes('favicon.ico')) pageErrors.push(msg.text());
});
page.on('pageerror', (err) => {
  pageErrors.push(err.message);
  console.log('[pageerror]', err.message);
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas#app');
await page.waitForFunction(
  (minimumFrames) =>
    typeof globalThis.__forgeax_smoke_frames__ === 'function' &&
    globalThis.__forgeax_smoke_frames__() >= minimumFrames,
  minimumFrames,
  { timeout: 8000 },
);

await page.screenshot({ path: outPath, fullPage: false });
console.log(`wrote screenshot: ${outPath}`);

if (pageErrors.length > 0) {
  throw new Error(`hello-triangle baseline emitted browser errors: ${pageErrors.join(' | ')}`);
}

await browser.close();
