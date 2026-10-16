#!/usr/bin/env node
// apps/hello/2d-flashlight/scripts/smoke-browser.mjs
//
// tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d M2 / m2-1.
//
// Browser e2e smoke for apps/hello/2d-flashlight. Spawns a local vite dev
// server, drives headed Chrome with WebGPU enabled, and asserts:
//
//   (a) zero `pageerror` + zero `console.error` from the runtime path
//       during boot + first ~3 s of rendering (the demo's main.ts log
//       channel uses console.warn for status; we treat console.error as
//       a hard regression).
//   (b) >=1 `createRenderPipeline` call whose label matches the
//       sprite-lit shader id -- the runtime labels pipelines with the
//       materialShader id ('forgeax::sprite-lit'), so a regression that
//       silently dispatches sprite-lit materials through the sprite
//       pipeline collapses the match count to zero here.
//   (c) zero `Invalid RenderPipeline.*sprite-lit` validation errors.
//
// Why a separate script from smoke-dawn.mjs (AGENTS.md "dawn-node smoke
// alone is necessary-but-not-sufficient"): dawn-node smoke skips the
// dev-server pack-body fetch + the WebGPU validation step; typed-array
// survival, BGL shape mismatch and vertex-attribute presence regressions
// only surface on the browser path.
//
// Invocation: `pnpm -F @forgeax/hello-2d-flashlight smoke:browser`
//
// Exit codes:
//   0 = green
//   1 = red (regression detected)
//   2 = harness error (vite did not boot / browser did not launch)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/hello/2d-flashlight/scripts -> apps/hello/2d-flashlight -> apps/hello -> apps -> repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
void REPO_ROOT;

const VITE_BOOT_DEADLINE_MS = 30_000;
const RUNTIME_RENDER_WAIT_MS = 3000;

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-2d-flashlight', 'dev'], {
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

const deadline = Date.now() + VITE_BOOT_DEADLINE_MS;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('[smoke-browser] FAIL - vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

let browser;
try {
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
} catch (err) {
  console.error(
    `[smoke-browser] FAIL - chromium launch threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  viteProc.kill();
  process.exit(2);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
page.on('console', (msg) => {
  const txt = msg.text();
  if (msg.type() === 'error') {
    errors.push(`CONSOLE-ERR: ${txt}`);
  }
});

await page.addInitScript(() => {
  if (navigator.gpu == null) return;
  globalThis.__forgeaxPipelines = [];
  globalThis.__forgeaxDeviceErrors = [];
  const origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (...a) => {
    const adapter = await origReqAdapter(...a);
    if (adapter == null) return adapter;
    const origReqDev = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...da) => {
      const dev = await origReqDev(...da);
      if (dev == null) return dev;
      const origCRP = dev.createRenderPipeline.bind(dev);
      dev.createRenderPipeline = (desc) => {
        try {
          globalThis.__forgeaxPipelines.push({
            label: desc.label,
            vertexEntryPoint: desc.vertex?.entryPoint,
            fragmentEntryPoint: desc.fragment?.entryPoint,
          });
        } catch (_e) {}
        return origCRP(desc);
      };
      dev.addEventListener('uncapturederror', (ev) => {
        globalThis.__forgeaxDeviceErrors.push(String(ev.error?.message ?? ev));
      });
      return dev;
    };
    return adapter;
  };
});

try {
  await page.goto(portUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
} catch (err) {
  console.error(
    `[smoke-browser] FAIL - page.goto threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  await browser.close();
  viteProc.kill();
  process.exit(2);
}

await sleep(RUNTIME_RENDER_WAIT_MS);

const pipelines = await page.evaluate(() => globalThis.__forgeaxPipelines ?? []);
const deviceErrors = await page.evaluate(() => globalThis.__forgeaxDeviceErrors ?? []);

console.log(
  `[smoke-browser] captured ${pipelines.length} createRenderPipeline calls; ${deviceErrors.length} device errors`,
);

const failures = [];

if (errors.length > 0) {
  failures.push(
    `runtime console errors / pageerrors: ${errors.length}\n  ${errors.slice(0, 3).join('\n  ')}`,
  );
}

const spriteLitPipelineHits = pipelines.filter((p) => {
  const label = String(p.label ?? '');
  return label.includes('sprite-lit') || label.includes('forgeax::sprite-lit');
});
console.log(`[smoke-browser] sprite-lit pipeline hits: ${spriteLitPipelineHits.length}`);
if (spriteLitPipelineHits.length < 1) {
  failures.push(
    'sprite-lit pipeline-variant count = 0; expected >=1. Pipeline labels seen: ' +
      pipelines
        .map((p) => p.label)
        .slice(0, 8)
        .join(' | '),
  );
}

if (deviceErrors.length > 0) {
  const spriteLitDeviceErrors = deviceErrors.filter((m) => m.includes('sprite-lit'));
  if (spriteLitDeviceErrors.length > 0) {
    failures.push(
      `sprite-lit device validation errors: ${spriteLitDeviceErrors.length}\n  ${spriteLitDeviceErrors.slice(0, 3).join('\n  ')}`,
    );
  } else {
    console.warn(
      `[smoke-browser] unrelated device errors: ${deviceErrors.length}\n  ${deviceErrors.slice(0, 3).join('\n  ')}`,
    );
  }
}

await browser.close();
viteProc.kill();

if (failures.length > 0) {
  console.error(`[smoke-browser] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `[smoke-browser] PASS - ${pipelines.length} pipelines created, ${spriteLitPipelineHits.length} sprite-lit, ${errors.length} console-err, ${deviceErrors.length} device-err`,
);
process.exit(0);
