#!/usr/bin/env node
// P7 WebKit admission smoke: exercise the real game-default Preview through
// the existing rhi-wgpu WebGL2 fallback and authored material manifest.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { webkit } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PORT = Number.parseInt(process.env.FORGEAX_WEBGL2_PORT ?? '5213', 10);
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_WEBGL2_DIR ?? resolve(ROOT, '.forgeax-debug/webgl2-material'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const production = process.env.FORGEAX_WEBGL2_MODE === 'production';
const server = spawn(
  'pnpm',
  production
    ? ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(PORT)]
    : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

// Let the Node runner observe Vite readiness before Playwright navigates. A
// WebKit navigation retry after a short `networkidle` timeout can leave the
// first page alive long enough to cancel its music import, which reports as an
// unrelated access-control page error on the second navigation.
const serverDeadline = Date.now() + 30_000;
while (Date.now() < serverDeadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  await sleep(250);
}
if (Date.now() >= serverDeadline) throw new Error(`Preview server did not start: ${serverOutput}`);

const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
    consoleErrors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&audio-evidence=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  // WebKit's WASM + audio decode path is slower than Chromium. Waiting for a
  // fixed sleep races the template bootstrap: the music import can still be
  // in flight when the probe starts, and WebKit cancels the pending fetch with
  // an opaque "access control" page error. The inspection registry is created
  // before bootstrap but its game-owned actions are registered only after all
  // scene/FBX/audio loads complete, so this is the real readiness boundary.
  await page.waitForFunction(
    () => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const listed = inspection?.list();
      return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
    },
    null,
    { timeout: 30_000, polling: 100 },
  );

  const probe = await page.evaluate(async (isProduction) => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    const inspection = globalThis.__forgeaxPreviewInspection;
    const manifestResponse = await fetch('/shaders/manifest.json');
    const manifest = manifestResponse.ok ? await manifestResponse.json() : null;
    const animated = manifest?.materialShaders?.find(
      (entry) => entry.identifier === 'game_default::animated_target',
    ) ?? null;
    const before = inspection
      ? await inspection.read('game-default.snapshot')
      : null;
    const triggerHit = inspection
      ? await inspection.run('game-default.trigger-hit')
      : null;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const snapshot = inspection
      ? await inspection.read('game-default.snapshot')
      : null;
    const reset = inspection
      ? await inspection.run('game-default.reset')
      : null;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterReset = inspection
      ? await inspection.read('game-default.snapshot')
      : null;
    const audio = globalThis.__forgeaxGameDefaultAudioEvidence?.snapshot() ?? null;
    return {
      navigatorGpu: 'gpu' in navigator && navigator.gpu !== null,
      webgl2: gl !== null,
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      inspection: inspection?.list() ?? null,
      captureResult: isProduction ? await inspection?.captureFrame?.(1) : null,
      health: inspection?.renderer.health() ?? null,
      before,
      triggerHit,
      snapshot,
      reset,
      afterReset,
      audio,
      animatedManifest: animated
        ? {
            paramSchema: animated.paramSchema,
            variants: animated.variants?.map((variant) => ({
              definesKey: variant.definesKey,
              defines: variant.defines,
              usesUniformMeshes: variant.composedWgsl?.includes('var<uniform> meshes') ?? false,
            })),
          }
        : null,
    };
  }, production);
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'preview-webkit.png') });

  const schema = probe.animatedManifest?.paramSchema;
  const parsedSchema = typeof schema === 'string' ? JSON.parse(schema) : null;
  const variantKeys = (probe.animatedManifest?.variants ?? []).map((variant) => variant.definesKey);
  if (probe.navigatorGpu !== false) throw new Error(`expected navigator.gpu=false: ${JSON.stringify(probe)}`);
  if (probe.webgl2 !== true) throw new Error(`WebGL2 context unavailable: ${JSON.stringify(probe)}`);
  if (probe.inspection === null || probe.health?.reason !== 'alive') {
    throw new Error(`Preview inspection/health failed: ${JSON.stringify(probe)}`);
  }
  if (
    production &&
    (probe.captureResult?.ok !== false || probe.captureResult.error?.code !== 'rhi-debug-unavailable')
  ) {
    throw new Error(`production Preview capture boundary was not explicit: ${JSON.stringify(probe.captureResult)}`);
  }
  if (!probe.triggerHit?.ok || probe.snapshot?.value?.state?.phase !== 'Play') {
    throw new Error(`game action/snapshot failed: ${JSON.stringify(probe)}`);
  }
  const fbxBefore = probe.before?.value?.fbxSkinnedTarget;
  const fbxAfter = probe.snapshot?.value?.fbxSkinnedTarget;
  if (
    fbxBefore?.available !== true ||
    fbxBefore.jointCount < 50 ||
    fbxBefore.clipGuid !== '019ecd87-179b-71f7-b9f8-4c8518326b65' ||
    Math.abs(fbxBefore.scale[0] - 0.03) > 0.001 ||
    fbxAfter?.hitPulses !== 1 ||
    fbxAfter.animationTime === fbxBefore.animationTime
  ) {
    throw new Error(`WebGL2 FBX skin loop failed: ${JSON.stringify({ before: fbxBefore, after: fbxAfter })}`);
  }
  if (!probe.reset?.ok || probe.afterReset?.value?.state?.phase !== 'Play' || probe.afterReset?.value?.state?.resetTransitions < 1) {
    throw new Error(`WebGL2 reset loop failed: ${JSON.stringify({ reset: probe.reset, afterReset: probe.afterReset })}`);
  }
  if (probe.audio?.music?.clipLoaded !== true || probe.audio?.music?.playing !== true) {
    throw new Error(`WebGL2 audio asset loop failed: ${JSON.stringify(probe.audio)}`);
  }
  if (!Array.isArray(parsedSchema) || parsedSchema.length !== 2 || !variantKeys.includes('STORAGE_BUFFER_AVAILABLE=false')) {
    throw new Error(`authored WebGL2 material manifest contract failed: ${JSON.stringify(probe.animatedManifest)}`);
  }
  if (pageErrors.length > 0 || badResponses.length > 0 || consoleErrors.length > 0) {
    throw new Error(`browser errors: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }

  const report = { probe, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[webgl2-material] PASS mode=${production ? 'production' : 'dev'} navigator.gpu=${probe.navigatorGpu} webgl2=${probe.webgl2} health=${probe.health.reason} schema=${parsedSchema.length} variants=${variantKeys.join(',')} pageErrors=0 badResponses=0`);
  console.log(`[webgl2-material] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await sleep(300);
}
