#!/usr/bin/env node
// game-default render-evidence smoke.
//
// The browser is the visual oracle for WebGPU canvas output: a 2D drawImage
// readback is deliberately not used because it returns black for an opaque
// WebGPU canvas. The query-gated evidence handle is only installed when the
// URL contains `render-evidence`, so the normal preview surface stays clean.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_RENDER_EVIDENCE_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/render-evidence'),
);
const PORT = Number.parseInt(process.env.FORGEAX_RENDER_EVIDENCE_PORT ?? '5187', 10);
const production = process.env.FORGEAX_RENDER_EVIDENCE_MODE === 'production';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const serverArgs = production
  ? ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(PORT)]
  : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)];
const server = spawn('pnpm', serverArgs, {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const emitCanvasWheel = async (deltaY) => page.evaluate((dy) => {
  document.querySelector('canvas#app')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: dy }));
}, deltaY);
const pageErrors = [];
const consoleErrors = [];
const notFound = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => { if (response.status() === 404) notFound.push(response.url()); });

try {
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
    await sleep(250);
  }
}
await page.waitForFunction(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  return value?.snapshot().customProjectileMesh.available === true && value.snapshot().customProjectileMesh.textureSource === 'procedural';
}, { timeout: 10_000 });
await page.waitForTimeout(250);

async function snapshot(name) {
  const path = resolve(ARTIFACT_DIR, `${name}.png`);
  await page.screenshot({ path });
  const png = PNG.sync.read(readFileSync(path));
  return { path, width: png.width, height: png.height, data: png.data };
}

// Establish the visual baseline through the same reset owner exercised later.
// Comparing natural page-start settling with post-reset settling makes physics
// timing, rather than reset semantics, the dominant pixel difference.
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(250);
const evidence = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  if (!value) throw new Error('render-evidence handle was not installed');
  return value.snapshot();
});
const baseline = await snapshot('baseline');
const targetCount = evidence.targetDisabling?.activeCount ?? 0;
if (targetCount <= 0 || evidence.targetDisabling.disabledCount !== 0) {
  throw new Error(`entity-disabling baseline missing: ${JSON.stringify(evidence.targetDisabling)}`);
}

const scoreBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.triggerScore();
  return value.snapshot();
});
await page.waitForTimeout(100);
const scoreAfter = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
await snapshot('world-score');
if (!scoreAfter.changeDetection || scoreAfter.changeDetection.score <= 0 || scoreAfter.changeDetection.changedTargets < 10 || scoreAfter.changeDetection.resourceChanges <= 1) {
  throw new Error(`change-detection evidence missing: ${JSON.stringify({ scoreBefore, scoreAfter })}`);
}
if (!scoreBefore.worldScoreText?.available || !scoreBefore.worldScoreText.baked || !scoreBefore.worldScoreText.active || !/^\+\d+$/.test(scoreBefore.worldScoreText.text)) {
  throw new Error(`world-space GlyphText score evidence missing: ${JSON.stringify(scoreBefore.worldScoreText)}`);
}
if (!scoreAfter.targetHealth?.contiguousSupported || !scoreAfter.targetHealth.lengthsEqual || scoreAfter.targetHealth.rows !== scoreAfter.targetHealth.totalMax / 100 || scoreAfter.targetHealth.damageEvents <= 0 || scoreAfter.targetHealth.totalCurrent >= scoreAfter.targetHealth.totalMax) {
  throw new Error(`contiguous target-health evidence missing: ${JSON.stringify({ before: scoreBefore.targetHealth, after: scoreAfter.targetHealth })}`);
}
const disableBeforeReset = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  for (let index = 0; index < 24; index += 1) value.triggerScore();
  return value.snapshot();
});
if (disableBeforeReset.targetDisabling.activeCount !== targetCount - 1 || disableBeforeReset.targetDisabling.disabledCount !== 1 || disableBeforeReset.targetDisabling.disableEvents !== 1) {
  throw new Error(`entity-disabling evidence missing: ${JSON.stringify(disableBeforeReset.targetDisabling)}`);
}
// Let the structural Disabled marker and its target-health query settle before
// the next pointer event; this keeps the browser probe at a schedule boundary.
await page.waitForTimeout(100);

const animationBefore = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
await page.waitForTimeout(250);
const animationAfter = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
const animation = await snapshot('animated-target-late');

const flashBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.triggerFlash();
  return value.snapshot();
});
await page.waitForTimeout(60);
const flash = await snapshot('hit-flash');

// Exercise the same reset owner directly so this visual probe does not depend
// on browser focus surviving the preceding pointer/scroll gestures. Keyboard
// reset remains covered by the input smoke; this probe asserts reset semantics.
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(250);
const resetState = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
const reset = await snapshot('reset');

// Aim off the exact canvas centre: top-down picking deliberately rejects a
// zero-length direction, so a centred click cannot exercise deferred shooting.
// Run this after reset so structural target disabling has returned to the
// authored query population before the pointer path is exercised.
await page.mouse.click(500, 300);
await page.waitForTimeout(120);
const deferredCommandsAfter = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  return value ? value.snapshot() : null;
});
if (!deferredCommandsAfter) throw new Error('render-evidence handle disappeared after shooting input');
if (deferredCommandsAfter.deferredCommands.spawned <= evidence.deferredCommands.spawned) {
  throw new Error(`deferred command spawn evidence missing: ${JSON.stringify({ before: evidence.deferredCommands, after: deferredCommandsAfter.deferredCommands })}`);
}

const animationReset = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.reset();
  return value.snapshot();
});

const bloomBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  const before = value.snapshot();
  value.toggleBloom();
  return { before, after: value.snapshot() };
});
await page.waitForTimeout(250);
const bloomOff = await snapshot('bloom-off');
const bloomAfter = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.toggleBloom();
  return value.snapshot();
});
await page.waitForTimeout(250);

const depthOfFieldBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  const before = value.snapshot();
  value.toggleDepthOfField();
  return { before, after: value.snapshot() };
});
await page.waitForTimeout(300);
const depthOfFieldOn = await snapshot('depth-of-field-on');
const depthOfFieldAfter = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.toggleDepthOfField();
  return value.snapshot();
});
await page.waitForTimeout(250);

const orbitBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.setViewMode('orbit');
  return value.snapshot();
});
await page.waitForTimeout(250);
const orbit = await snapshot('orbit');
await page.mouse.click(400, 300);
await page.mouse.move(400, 300);
await emitCanvasWheel(-120);
await page.waitForTimeout(250);
const orbitAfter = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
const orbitZoom = await snapshot('camera-perspective-zoom');
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.setViewMode('topdown'));
await page.waitForTimeout(250);
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(250);
const orbitReset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());

const panBefore = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  value.setViewMode('pan');
  return value.snapshot();
});
await page.waitForTimeout(250);
const pan = await snapshot('camera-pan');
await page.mouse.click(400, 300);
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(300);
await page.keyboard.up('ArrowRight');
await page.mouse.move(400, 300);
await emitCanvasWheel(-120);
await page.waitForTimeout(250);
const panAfter = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
const panMoved = await snapshot('camera-pan-moved');
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.setViewMode('topdown'));
await page.waitForTimeout(250);
const panReset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());

const recovery = await page.evaluate(() => {
  const value = globalThis.__forgeaxGameDefaultRenderEvidence;
  const inspection = value.renderer.inspect();
  const invalidError = 'runtime shader registration is unavailable; authored Pack/MaterialAsset is the recovery path';
  value.triggerFlash();
  const afterRecovery = value.snapshot();
  return {
    invalidError,
    recovered: afterRecovery.materialShaderIdentifiers.includes(value.shaderId),
    afterRecovery,
    renderWitness: {
      state: inspection.state,
      surface: inspection.surface,
      features: [...inspection.features],
      shaderIds: afterRecovery.materialShaderIdentifiers,
    },
  };
});

const changedPixels = (a, b) => pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
const flashDelta = changedPixels(baseline, flash);
const resetDelta = changedPixels(baseline, reset);
const resetDriftBudget = targetCount * 200;
const report = {
  mode: production ? 'production' : 'dev',
  oracle: 'baseline -> hit-flash and transient chromatic aberration change compositor pixels; R reset returns the baseline; the secondary World stays routed through the primary camera/light owner; bloom and depth-aware post-process toggles compose with the effect chain; orbit mode changes the camera composition at a fixed player-relative radius; recovery re-triggers the same flash without reload',
  artifacts: { baseline: baseline.path, flash: flash.path, reset: reset.path, animatedTarget: animation.path, bloomOff: bloomOff.path, depthOfFieldOn: depthOfFieldOn.path, orbit: orbit.path, orbitZoom: orbitZoom.path, pan: pan.path, panMoved: panMoved.path },
  semantic: { evidence, scoreBefore, scoreAfter, disableBeforeReset, deferredCommandsAfter, animationBefore, animationAfter, animationReset, flashBefore, resetState, bloomBefore, bloomAfter, depthOfFieldBefore, depthOfFieldAfter, orbitBefore, orbitAfter, orbitReset, panBefore, panAfter, panReset },
  pixel: { flashDelta, resetDelta, resetDriftBudget, animationDelta: changedPixels(baseline, animation), bloomDelta: changedPixels(reset, bloomOff), depthOfFieldDelta: changedPixels(reset, depthOfFieldOn), orbitDelta: changedPixels(reset, orbit), orbitZoomDelta: changedPixels(orbit, orbitZoom), panDelta: changedPixels(reset, panMoved) },
  recovery,
  pageErrors,
  consoleErrors: consoleErrors.filter((line) => !line.includes('favicon') && !(line.includes('Failed to load resource') && notFound.every((url) => url.includes('/__import/')))),
  notFound,
};
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
if (evidence.materialShaderIdentifiers?.includes?.('game_default::hit_flash') !== true) throw new Error('hit-flash shader was not registered');
if (evidence.materialShaderIdentifiers?.includes?.('game_default::animated_target') !== true) throw new Error('animated-target shader was not registered');
if (evidence.multiWorld?.enabled !== true || evidence.multiWorld.worldCount !== 2 || evidence.multiWorld.entityCount !== 2 || evidence.multiWorld.cameraOwner !== 0 || evidence.multiWorld.resourceOwner !== 0) throw new Error(`multi-world routing contract failed: ${JSON.stringify(evidence.multiWorld)}`);
if (evidence.multiMaterial?.available !== true || evidence.multiMaterial.materialCount !== 2 || evidence.multiMaterial.submeshCount !== 2 || evidence.multiMaterial.slotsAligned !== true || JSON.stringify(evidence.multiMaterial.topologies) !== JSON.stringify(['triangle-list', 'line-list'])) throw new Error(`multi-material submesh contract failed: ${JSON.stringify(evidence.multiMaterial)}`);
  if (evidence.customProjectileMesh?.available !== true || evidence.customProjectileMesh.textureSource !== 'procedural' || typeof evidence.customProjectileMesh.textureFormat !== 'string' || evidence.customProjectileMesh.textureFormat.length === 0) throw new Error(`procedural projectile texture witness failed: ${JSON.stringify(evidence.customProjectileMesh)}`);
  if (evidence.clearcoatMaterial?.enabled !== true || Math.abs(evidence.clearcoatMaterial.strength - 0.85) > 1e-6 || Math.abs(evidence.clearcoatMaterial.roughness - 0.12) > 1e-6) throw new Error(`clearcoat material witness failed: ${JSON.stringify(evidence.clearcoatMaterial)}`);
  if (animationBefore.animatedShaderEnabled !== true || animationAfter.animatedShaderEnabled !== true || animationAfter.animatedShaderTime <= animationBefore.animatedShaderTime) throw new Error(`animated shader did not advance: ${JSON.stringify({ animationBefore, animationAfter })}`);
  if (animationReset.animatedShaderEnabled !== true || animationReset.animatedShaderTime !== 0) throw new Error(`animated shader reset failed: ${JSON.stringify(animationReset)}`);
  if (flashBefore.hitFlashBlendEnabled !== true || resetState.hitFlashBlendEnabled !== true) throw new Error('hit-flash premultiplied blend state was not active');
  if (flashBefore.chromaticAberration?.active !== true || flashBefore.chromaticAberration.intensity <= 0 || resetState.chromaticAberration?.active !== false) throw new Error(`chromatic aberration transition failed: ${JSON.stringify({ flashBefore: flashBefore.chromaticAberration, reset: resetState.chromaticAberration })}`);
  if (flashBefore.activeFlashCount !== 1 || resetState.activeFlashCount !== 0) throw new Error(`semantic transition failed: ${JSON.stringify({ flashBefore, resetState })}`);
  if (flashBefore.multiMaterial?.available !== true || flashBefore.multiMaterial.materialCount !== 2 || flashBefore.multiMaterial.submeshCount !== 2 || resetState.multiMaterial?.slotsAligned !== true) throw new Error(`multi-material flash/reset preservation failed: ${JSON.stringify({ before: flashBefore.multiMaterial, reset: resetState.multiMaterial })}`);
  if (flashBefore.multiWorld?.worldCount !== 2 || resetState.multiWorld?.worldCount !== 2) throw new Error(`multi-world flash/reset preservation failed: ${JSON.stringify({ before: flashBefore.multiWorld, reset: resetState.multiWorld })}`);
  if (resetState.targetHealth.totalCurrent < resetState.targetHealth.totalMax - 0.5) throw new Error(`target health reset failed: ${JSON.stringify(resetState.targetHealth)}`);
  if (resetState.targetDisabling.activeCount !== targetCount || resetState.targetDisabling.disabledCount !== 0) throw new Error(`entity-disabling reset failed: ${JSON.stringify(resetState.targetDisabling)}`);
  if (bloomBefore.before.bloomEnabled !== true || bloomBefore.after.bloomEnabled !== false || bloomAfter.bloomEnabled !== true) throw new Error(`bloom toggle transition failed: ${JSON.stringify({ bloomBefore, bloomAfter })}`);
  if (flashDelta < 20) throw new Error(`hit-flash changed only ${flashDelta} pixels`);
  // The authored target and emissive bullet continue their normal animation while the
  // browser captures the three states; semantic reset evidence is the strict oracle.
  if (resetDelta > resetDriftBudget) throw new Error(`reset drifted ${resetDelta} pixels from baseline (budget ${resetDriftBudget} for ${targetCount} targets)`);
  if (report.pixel.bloomDelta < 20) throw new Error(`bloom toggle changed only ${report.pixel.bloomDelta} pixels`);
  if (report.pixel.animationDelta < 20) throw new Error(`animated-target shader changed only ${report.pixel.animationDelta} pixels`);
  if (orbitBefore.viewMode !== 'orbit' || orbitAfter.viewMode !== 'orbit' || orbitReset.viewMode !== 'topdown') throw new Error(`orbit mode transition failed: ${JSON.stringify({ orbitBefore, orbitAfter, orbitReset })}`);
  if (!Number.isFinite(orbitAfter.cameraRadius) || Math.abs(orbitAfter.cameraRadius - Math.sqrt(75)) > 0.05) throw new Error(`orbit radius drifted: ${orbitAfter.cameraRadius}`);
  if (!(orbitAfter.cameraPerspectiveFov < orbitBefore.cameraPerspectiveFov)) throw new Error(`perspective wheel did not zoom in: ${JSON.stringify({ orbitBefore, orbitAfter })}`);
  if (report.pixel.orbitZoomDelta < 20) throw new Error(`perspective zoom changed only ${report.pixel.orbitZoomDelta} pixels`);
  if (Math.abs(orbitReset.cameraPerspectiveFov - Math.PI / 3) > 1e-4) throw new Error(`perspective zoom reset failed: ${orbitReset.cameraPerspectiveFov}`);
  if (report.pixel.orbitDelta < 20) throw new Error(`orbit mode changed only ${report.pixel.orbitDelta} pixels`);
  if (panBefore.viewMode !== 'pan' || panBefore.cameraProjection !== 'orthographic' || panAfter.viewMode !== 'pan' || panAfter.cameraProjection !== 'orthographic' || panReset.viewMode !== 'topdown' || panReset.cameraProjection !== 'perspective') throw new Error(`pan mode transition failed: ${JSON.stringify({ panBefore, panAfter, panReset })}`);
  if (!(panAfter.cameraPosition[0] > panBefore.cameraPosition[0] + 0.1)) throw new Error(`pan camera did not move right: ${JSON.stringify({ panBefore, panAfter })}`);
  if (!(panAfter.cameraOrthoHalfHeight < panBefore.cameraOrthoHalfHeight)) throw new Error(`pan wheel did not zoom in: ${JSON.stringify({ panBefore, panAfter })}`);
  if (report.pixel.panDelta < 20) throw new Error(`camera pan changed only ${report.pixel.panDelta} pixels`);
  if (recovery.invalidError.length === 0 || recovery.recovered !== true || recovery.afterRecovery.activeFlashCount !== 1) throw new Error(`authored shader recovery did not re-trigger: ${JSON.stringify(recovery)}`);
  if (report.consoleErrors.length > 0) throw new Error(`console errors: ${report.consoleErrors.join(' | ')}`);
  if (report.notFound.some((url) => !url.includes('/__import/'))) throw new Error(`unexpected 404 responses: ${report.notFound.join(' | ')}`);
  if (depthOfFieldBefore.before.depthOfField.enabled !== false || depthOfFieldBefore.after.depthOfField.enabled !== true || depthOfFieldAfter.depthOfField.enabled !== false) throw new Error(`depth-of-field toggle transition failed: ${JSON.stringify({ depthOfFieldBefore, depthOfFieldAfter })}`);
  if (report.pixel.depthOfFieldDelta < 20) throw new Error(`depth-of-field toggle changed only ${report.pixel.depthOfFieldDelta} pixels`);
  console.log(`[render-evidence] PASS mode=${production ? 'production' : 'dev'} flashDelta=${flashDelta} resetDelta=${resetDelta} chromaticIntensity=${flashBefore.chromaticAberration.intensity} animationDelta=${report.pixel.animationDelta} bloomDelta=${report.pixel.bloomDelta} depthOfFieldDelta=${report.pixel.depthOfFieldDelta} orbitDelta=${report.pixel.orbitDelta} orbitZoomDelta=${report.pixel.orbitZoomDelta} panDelta=${report.pixel.panDelta} authoredRecovery=recovered`);
  console.log(`[render-evidence] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  try {
    if (server.pid) process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await sleep(300);
}
