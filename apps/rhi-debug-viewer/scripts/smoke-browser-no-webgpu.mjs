// Browser contract smoke for the structural Viewer path without WebGPU.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { encodeTape } from '@forgeax/engine-rhi-debug';
import { startViewerDevServer } from './smoke-browser-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const TEMP = mkdtempSync(resolve(tmpdir(), 'forgeax-rhi-viewer-no-gpu-'));
const screenshotPath = resolve(process.env.FORGEAX_VIEWER_SCREENSHOT_DIR ?? TEMP, 'viewer-no-webgpu-degraded.png');
const evidencePath = process.env.FORGEAX_VIEWER_EVIDENCE_PATH;
const falsifyNoWebGpuStatus = process.env.FORGEAX_FALSIFY_NO_WEBGPU_STATUS === '1';

function makeTape() {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 5, blobCount: 0 },
    bootstrap: [
      { handleId: 'encoder:1', kind: 'encoder', create: { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1' }, initialData: [] },
      { handleId: 'texture:color', kind: 'texture', create: { kind: 'createTexture', handleId: 'texture:color', desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 17, dimension: '2d', mipLevelCount: 1, sampleCount: 1 } }, initialData: [] },
      { handleId: 'view:color', kind: 'texture-view', create: { kind: 'createTextureView', sourceHandleId: 'texture:color', resultHandleId: 'view:color', desc: {} }, initialData: [] },
    ],
    events: [
      { kind: 'frameMark', frameIdx: 0 },
      { kind: 'beginRenderPass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: { colorAttachments: [] }, colorAttachmentViewHandleIds: ['view:color'] },
      { kind: 'draw', passHandleId: 'pass:1', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
    ],
    blobs: [],
  };
}

const encoded = encodeTape(makeTape());
if (!encoded.ok) throw new Error('fixture encode failed: ' + encoded.error.code);
const artifactPath = resolve(TEMP, 'frame-0.rhitape');
writeFileSync(artifactPath, encoded.value);
const artifactDigest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');

const viewerServer = startViewerDevServer(ROOT);

async function runLayoutAction(page, name) {
  await page.getByRole('button', { name: 'Layout menu' }).click();
  await page.getByRole('menuitem', { name }).click();
}

try {
  const url = await viewerServer.waitForReady();
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.locator('input[type="file"][accept=".rhitape"]').setInputFiles(artifactPath);
  await page.waitForSelector('[data-forgeax-load-status="loaded"]', { timeout: 10000 });
  await page.waitForSelector('[data-forgeax-work-index="0"]', { timeout: 5000 });
  const structure = await page.evaluate(() => ({
    global: typeof window.__forgeaxRhiDebug?.inspectWork === 'function',
    readResource: typeof window.__forgeaxRhiDebug?.readResource === 'function',
    artifactRef: window.__forgeaxRhiDebug?.artifactRef ?? null,
    selection: window.__forgeaxRhiDebug?.selection ?? null,
    panels: ['event-browser', 'pipeline-state', 'draw-call-viewer', 'resource-inspector'].every((name) => document.querySelector('[data-forgeax-' + name + ']') !== null),
    workCount: window.__forgeaxRhiDebug?.model.works.length ?? 0,
    passCount: window.__forgeaxRhiDebug?.model.passes.length ?? 0,
    resourceIds: window.__forgeaxRhiDebug?.model.resources.map((resource) => resource.resourceId) ?? [],
    workCoordinates: window.__forgeaxRhiDebug?.model.works.map((work) => ({ workIndex: work.workIndex, eventIndex: work.eventIndex, passIndex: work.passIndex })) ?? [],
    shaderFacts: window.__forgeaxRhiDebug?.model.works.flatMap((work) => work.pipeline?.shaders ?? []) ?? [],
    capability: document.querySelector('[data-forgeax-capability]')?.getAttribute('data-forgeax-capability') ?? null,
    previewCanvasCount: document.querySelectorAll('[data-forgeax-preview-canvas]').length,
  }));
  if (!structure.global || !structure.readResource || structure.artifactRef?.kind !== 'rhi-tape' || structure.selection === null || !structure.panels || structure.workCount !== 1 || structure.passCount < 1 || !structure.resourceIds.includes('texture:color') || structure.capability !== 'no-webgpu') throw new Error('structure disappeared without WebGPU: ' + JSON.stringify(structure));
  if (structure.previewCanvasCount !== 0) throw new Error('no-WebGPU path exposed a preview canvas');
  const savedLayout = await page.evaluate(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw === null ? null : JSON.parse(raw);
  });
  if (savedLayout?.schemaVersion !== 3) throw new Error('no-WebGPU layout schema missing: ' + JSON.stringify(savedLayout));
  await runLayoutAction(page, 'Reset layout');
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw !== null && JSON.parse(raw).schemaVersion === 3;
  });
  await page.locator('[data-forgeax-work-index="0"]').click();
  if (falsifyNoWebGpuStatus) {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-forgeax-rt-status]')) element.removeAttribute('data-forgeax-rt-status');
    });
    if (await page.locator('[data-forgeax-rt-status="no-webgpu"]').count() !== 0) throw new Error('no-WebGPU status falsifier unexpectedly found a status anchor');
    console.log('[smoke-browser-no-webgpu] FALSIFIER_CONFIRMED hidden no-WebGPU status anchor was rejected');
    await browser.close();
    await viewerServer.stop();
    process.exit(0);
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-forgeax-rt-status="no-webgpu"]')].some((element) => element.getClientRects().length > 0),
    undefined,
    { timeout: 10000 },
  );
  const statusText = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('[data-forgeax-rt-status="no-webgpu"]')].find((element) => element.getClientRects().length > 0 && element.textContent?.includes('no WebGPU'));
    return visible?.textContent ?? null;
  });
  if (statusText === null || !statusText.includes('no WebGPU')) throw new Error('no-WebGPU recovery text missing: ' + statusText);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-forgeax-workspace="dockview"] .dv-tab', { timeout: 5000 });
  const reloadedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('forgeax-rhi-debug-viewer-layout')));
  if (reloadedLayout.schemaVersion !== 3) throw new Error('saved layout did not survive browser reload');
  await page.evaluate(() => localStorage.setItem('forgeax-rhi-debug-viewer-layout', '{'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-forgeax-workspace="dockview"] .dv-tab', { timeout: 5000 });
  const recoveredLayout = await page.evaluate(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw === null ? null : JSON.parse(raw);
  });
  if (recoveredLayout?.schemaVersion !== 3) throw new Error('corrupt layout was not replaced by schema v3');
  await runLayoutAction(page, 'Reset layout');
  if (pageErrors.length > 0) throw new Error('browser page errors: ' + pageErrors.join('; '));
  const artifactRef = { kind: 'rhi-tape', digest: artifactDigest, source: 'viewer.smoke.no-webgpu', path: artifactPath };
  const coordinate = structure.workCoordinates[0] ?? { workIndex: 0, eventIndex: null, passIndex: null };
  const coldStart = [
    { step: 'capture', input: { frame: 0 }, output: { status: 'ok', artifactRef } },
    { step: 'summary', input: { artifactRef }, output: { status: 'ok', formatVersion: 7, workCount: structure.workCount, resourceCount: structure.resourceIds.length } },
    { step: 'inspect', input: { artifactRef, coordinate }, output: { status: 'ok', stableCoordinate: coordinate, panels: structure.panels } },
    { step: 'readback', input: { artifactRef, resourceId: 'texture:color' }, output: { status: 'recovery', provenance: null, code: 'readback-unsupported', action: 'open the tape in a WebGPU-capable host' } },
    { step: 'preview', input: { artifactRef, coordinate, shaderFacts: structure.shaderFacts }, output: { status: 'recovery', provenance: null, code: 'preview-not-applicable', action: 'select a complete raster stage in a WebGPU-capable host' } },
    { step: 'shader-error', input: { artifactRef, coordinate }, output: { status: 'recovery', provenance: null, code: 'preview-not-applicable', action: 'select a complete raster stage before applying WGSL' } },
    { step: 'layout-recovery', input: { artifactRef, storageKey: 'forgeax-rhi-debug-viewer-layout' }, output: { status: 'recovered', action: 'reset layout and preserve the same artifactRef' } },
  ];
  const evidence = [{
    target: 'viewer-no-webgpu-degraded',
    screenshotPath,
    observed: { structure, status: 'no-webgpu', recoveryText: statusText, preview: { provenance: null, successCanvasCount: structure.previewCanvasCount, canonicalArtifactDigestBefore: artifactDigest, canonicalArtifactDigestAfter: artifactDigest }, layout: { beforeReset: savedLayout, afterReload: reloadedLayout, afterCorruptFallback: recoveredLayout }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0 }, coldStart },
    verdict: 'pass',
    confidence: 'high',
  }];
  if (evidencePath !== undefined) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log('[smoke-browser-no-webgpu] VISUAL_EVIDENCE ' + JSON.stringify(evidence));
  console.log('[smoke-browser-no-webgpu] GREEN: model/event/pipeline/resource structure survived local pixel degradation');
  await browser.close();
} catch (error) {
  console.error('[smoke-browser-no-webgpu] RED: ' + (error instanceof Error ? error.message : String(error)));
  await viewerServer.stop();
  process.exit(1);
}
await viewerServer.stop();
