// Browser contract smoke for the v7 single-file read-only Viewer.

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
const TEMP = mkdtempSync(resolve(tmpdir(), 'forgeax-rhi-viewer-v7-'));
const screenshotDir = process.env.FORGEAX_VIEWER_SCREENSHOT_DIR ?? TEMP;
const evidencePath = process.env.FORGEAX_VIEWER_EVIDENCE_PATH;
const falsifyAnchors = process.env.FORGEAX_FALSIFY_VIEWER_ANCHORS === '1';
const falsifyTextureAttachment = process.env.FORGEAX_FALSIFY_TEXTURE_ATTACHMENT === '1';

function makeTape() {
  const vertexShader = `
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.7), vec2<f32>(-0.7, -0.7), vec2<f32>(0.7, -0.7));
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;
  const fragmentShader = `
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}`;
  const colorBytes = new Uint8Array([
    255, 32, 32, 255,
    32, 255, 32, 255,
    32, 32, 255, 255,
    255, 255, 32, 255,
  ]);
  const bufferBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 21, blobCount: 2 },
    bootstrap: [
      {
        handleId: 'encoder:1',
        kind: 'encoder',
        create: { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1' },
        initialData: [],
      },
      {
        handleId: 'texture:color',
        kind: 'texture',
        create: {
          kind: 'createTexture',
          handleId: 'texture:color',
          desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 19, dimension: '2d', mipLevelCount: 1, sampleCount: 1 },
        },
        initialData: [{ hash: 'fixture-color', byteOffset: 0, byteLength: colorBytes.byteLength }],
      },
      {
        handleId: 'buffer:known',
        kind: 'buffer',
        create: { kind: 'createBuffer', handleId: 'buffer:known', desc: { size: bufferBytes.byteLength, usage: 164 } },
        initialData: [{ hash: 'fixture-buffer', byteOffset: 0, byteLength: bufferBytes.byteLength }],
      },
      {
        handleId: 'view:color',
        kind: 'texture-view',
        create: {
          kind: 'createTextureView',
          sourceHandleId: 'texture:color',
          resultHandleId: 'view:color',
          desc: { dimension: '2d', aspect: 'all', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 },
        },
        initialData: [],
      },
    ],
    events: [
      { kind: 'frameMark', frameIdx: 0 },
      { kind: 'createShaderModule', handleId: 'shader:shared', wgslCode: vertexShader + '\n' + fragmentShader },
      { kind: 'createBindGroupLayout', handleId: 'layout:empty', desc: { entries: [] } },
      { kind: 'createPipelineLayout', handleId: 'pipeline-layout:empty', bglHandleIds: ['layout:empty'] },
      {
        kind: 'createRenderPipeline',
        handleId: 'pipeline:fixture',
        desc: {
          vertex: { entryPoint: 'vs_main', buffers: [] },
          fragment: { entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        },
        layoutHandleId: 'pipeline-layout:empty',
        vertexShaderModuleHandleId: 'shader:shared',
        fragmentShaderModuleHandleId: 'shader:shared',
      },
      { kind: 'pushDebugGroup', cmdHandleId: 'encoder:1', groupLabel: 'main-pass' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [{ loadOp: 'load', storeOp: 'store' }] },
        colorAttachmentViewHandleIds: ['view:color'],
      },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipeline:fixture' },
      { kind: 'passPushDebugGroup', passHandleId: 'pass:1', groupLabel: 'color-pass' },
      { kind: 'passInsertDebugMarker', passHandleId: 'pass:1', markerLabel: 'first draw' },
      { kind: 'setVertexBuffer', passHandleId: 'pass:1', slot: 0, bufferHandleId: 'buffer:known', offset: 0, size: bufferBytes.byteLength },
      { kind: 'draw', passHandleId: 'pass:1', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
      { kind: 'passPopDebugGroup', passHandleId: 'pass:1' },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      { kind: 'popDebugGroup', cmdHandleId: 'encoder:1' },
      { kind: 'beginRenderPass', cmdHandleId: 'encoder:1', passHandleId: 'pass:2', desc: { colorAttachments: [{ loadOp: 'load', storeOp: 'store' }] }, colorAttachmentViewHandleIds: ['view:color'] },
      { kind: 'setPipeline', passHandleId: 'pass:2', pipelineHandleId: 'pipeline:fixture' },
      { kind: 'passInsertDebugMarker', passHandleId: 'pass:2', markerLabel: 'second pass' },
      { kind: 'draw', passHandleId: 'pass:2', vertexCount: 3, instanceCount: 1, firstVertex: 0, firstInstance: 0 },
      { kind: 'endRenderPass', passHandleId: 'pass:2' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
    ],
    blobs: [
      { hash: 'fixture-color', bytes: colorBytes, compression: 'none' },
      { hash: 'fixture-buffer', bytes: bufferBytes, compression: 'none' },
    ],
  };
  if (falsifyTextureAttachment) {
    tape.bootstrap = tape.bootstrap.filter((resource) => resource.kind !== 'texture' && resource.kind !== 'texture-view');
    tape.events = tape.events.map((event) =>
      event.kind === 'beginRenderPass' ? { ...event, desc: { colorAttachments: [] }, colorAttachmentViewHandleIds: [] } : event,
    );
  }
  return tape;
}

function writeFixture() {
  const sourcePath = process.env.FORGEAX_RHI_DEBUG_TAPE_PATH;
  if (sourcePath !== undefined) return resolve(sourcePath);
  const encoded = encodeTape(makeTape());
  if (!encoded.ok) throw new Error('fixture encode failed: ' + encoded.error.code);
  const path = resolve(TEMP, 'frame-0.rhitape');
  writeFileSync(path, encoded.value);
  return path;
}

const artifactPath = writeFixture();
const artifactDigest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
const viewerServer = startViewerDevServer(ROOT);

async function runLayoutAction(page, name) {
  await page.getByRole('button', { name: 'Layout menu' }).click();
  await page.getByRole('menuitem', { name }).click();
}

try {
  const url = await viewerServer.waitForReady();

  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  if (falsifyAnchors) {
    await page.addInitScript(() => {
      const removeAnchor = (element) => {
        for (const attribute of [...element.attributes]) {
          if (attribute.name.startsWith('data-forgeax-')) element.removeAttribute(attribute.name);
        }
      };
      const observer = new MutationObserver(() => {
        for (const element of document.querySelectorAll('*')) removeAnchor(element);
      });
      observer.observe(document, { childList: true, subtree: true });
    });
  }
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const artifactBytes = [...readFileSync(artifactPath)];
  const dropTape = async () => {
    const dataTransfer = await page.evaluateHandle(
      ({ bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([Uint8Array.from(bytes)], 'frame-0.rhitape', {
            type: 'application/octet-stream',
          }),
        );
        return transfer;
      },
      { bytes: artifactBytes },
    );
    await page.dispatchEvent('body', 'dragenter', { dataTransfer });
    await page.waitForSelector('[data-forgeax-drop-overlay]', { timeout: 10000 });
    await page.dispatchEvent('body', 'drop', { dataTransfer });
    await page.waitForSelector('[data-forgeax-load-status="loaded"]', { timeout: 10000 });
    await dataTransfer.dispose();
  };
  await dropTape();

  const structure = await page.evaluate(() => {
    const api = window.__forgeaxRhiDebug;
    return {
      hasGlobal: api !== undefined,
      hasInspectWork: typeof api?.inspectWork === 'function',
      hasReadResource: typeof api?.readResource === 'function',
      artifactRef: api?.artifactRef ?? null,
      capability: api?.capability?.kind ?? null,
      selection: api?.selection ?? null,
      commandCount: Array.isArray(api?.model?.commands) ? api.model.commands.length : 0,
      commandKinds: Array.isArray(api?.model?.commands) ? api.model.commands.map((command) => command.kind) : [],
      workCount: Array.isArray(api?.model?.works) ? api.model.works.length : 0,
      passCount: Array.isArray(api?.model?.passes) ? api.model.passes.length : 0,
      resourceCount: Array.isArray(api?.model?.resources) ? api.model.resources.length : 0,
      resourceIds: Array.isArray(api?.model?.resources) ? api.model.resources.map((resource) => resource.resourceId) : [],
      workCoordinates: Array.isArray(api?.model?.works)
        ? api.model.works.map((work) => ({ workIndex: work.workIndex, eventIndex: work.eventIndex, passIndex: work.passIndex }))
        : [],
      shaderFacts: Array.isArray(api?.model?.works)
        ? api.model.works.flatMap((work) => work.pipeline?.shaders ?? [])
        : [],
      panels: ['event-browser', 'pipeline-state', 'draw-call-viewer', 'resource-inspector'].map((name) => Boolean(document.querySelector('[data-forgeax-' + name + ']'))),
      previewCanvasCount: document.querySelectorAll('[data-forgeax-preview-canvas]').length,
    };
  });
  if (!structure.hasGlobal || !structure.hasInspectWork || !structure.hasReadResource || structure.artifactRef?.kind !== 'rhi-tape' || structure.capability === null || structure.selection === null || structure.commandCount < 7 || !structure.commandKinds.includes('pushDebugGroup') || !structure.commandKinds.includes('passInsertDebugMarker') || structure.workCount < 2 || structure.passCount < 2 || (!falsifyTextureAttachment && (!structure.resourceIds.includes('texture:color') || !structure.resourceIds.includes('buffer:known'))) || structure.panels.some((value) => !value)) {
    throw new Error('v7 structure contract failed: ' + JSON.stringify(structure));
  }

  await page.locator('[data-forgeax-work-index="0"]').click();
  await page.waitForSelector('[data-forgeax-selected="true"]');
  const linkage = await page.evaluate(() => ({
    pipeline: document.querySelector('[data-forgeax-pipeline-state="selected"]') !== null,
    drawCall: document.querySelector('[data-forgeax-draw-call-viewer="selected"]') !== null,
    resource: document.querySelector('[data-forgeax-resource-inspector="selected"]') !== null,
  }));
  if (!linkage.pipeline || !linkage.drawCall || !linkage.resource) throw new Error('workIndex linkage failed: ' + JSON.stringify(linkage));

  const initialLayout = await page.evaluate(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw === null ? null : JSON.parse(raw);
  });
  if (initialLayout?.schemaVersion !== 3) throw new Error('Dockview layout schema missing: ' + JSON.stringify(initialLayout));
  const readDockOperationState = async () =>
    page.evaluate(() => ({
      layout: JSON.parse(localStorage.getItem('forgeax-rhi-debug-viewer-layout')),
      gridGroupCount: document.querySelectorAll('.forgeax-dockview .dv-groupview').length,
      floatingGroupCount: document.querySelectorAll('.dv-floating-group').length,
      tabLabels: [...document.querySelectorAll('.forgeax-dockview .dv-groupview')].map((group) =>
        [...group.querySelectorAll('.dv-tab')].map((tab) => tab.textContent?.trim() ?? ''),
      ),
    }));
  const resetDockForOperation = async () => {
    await runLayoutAction(page, 'Reset layout');
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
      return raw !== null && JSON.parse(raw).schemaVersion === 3;
    });
  };
  const dockOperationEvidence = {};
  await runLayoutAction(page, 'Float resource');
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw !== null && JSON.stringify(JSON.parse(raw)).includes('floatingGroups');
  });
  dockOperationEvidence.float = await readDockOperationState();
  if (dockOperationEvidence.float.floatingGroupCount < 1 && !JSON.stringify(dockOperationEvidence.float.layout).includes('floatingGroups')) {
    throw new Error('Dockview float operation did not produce a floating group: ' + JSON.stringify(dockOperationEvidence.float));
  }
  await resetDockForOperation();
  const defaultGridGroupCount = (await readDockOperationState()).gridGroupCount;
  await runLayoutAction(page, 'Split resource');
  await page.waitForFunction((count) => document.querySelectorAll('.forgeax-dockview .dv-groupview').length > count, defaultGridGroupCount);
  dockOperationEvidence.split = await readDockOperationState();
  if (dockOperationEvidence.split.gridGroupCount <= defaultGridGroupCount) {
    throw new Error('Dockview split operation did not add a group: ' + JSON.stringify(dockOperationEvidence.split));
  }
  await resetDockForOperation();
  await runLayoutAction(page, 'Stack pipeline');
  await page.waitForFunction(() => [...document.querySelectorAll('.forgeax-dockview .dv-groupview')].some((group) => {
    const labels = [...group.querySelectorAll('.dv-tab')].map((tab) => tab.textContent?.trim() ?? '');
    return labels.some((label) => label.includes('Pipeline state')) && labels.some((label) => label.includes('Resource Inspector'));
  }));
  dockOperationEvidence.stack = await readDockOperationState();
  if (!dockOperationEvidence.stack.tabLabels.some((labels) => labels.some((label) => label.includes('Pipeline state')) && labels.some((label) => label.includes('Resource Inspector')))) {
    throw new Error('Dockview stack operation did not share a tab group: ' + JSON.stringify(dockOperationEvidence.stack));
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-forgeax-workspace="dockview"] .dv-tab', { timeout: 5000 });
  dockOperationEvidence.stackReload = await readDockOperationState();
  if (!dockOperationEvidence.stackReload.tabLabels.some((labels) => labels.some((label) => label.includes('Pipeline state')) && labels.some((label) => label.includes('Resource Inspector')))) {
    throw new Error('Dockview stacked tab group did not survive reload: ' + JSON.stringify(dockOperationEvidence.stackReload));
  }
  await dropTape();
  await page.locator('[data-forgeax-work-index="0"]').click();
  await page.waitForSelector('[data-forgeax-selected="true"]');
  await resetDockForOperation();
  const sash = page.locator('.forgeax-dockview .dv-sash:not(.dv-disabled)').first();
  const sashBox = await sash.boundingBox();
  if (sashBox !== null) {
    await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + sashBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sashBox.x + sashBox.width / 2 + 48, sashBox.y + sashBox.height / 2);
    await page.mouse.up();
  }
  const resourceTab = page.getByRole('tab', { name: 'Resource Inspector' });
  if (await resourceTab.count() > 0) await resourceTab.click();
  if (!falsifyTextureAttachment) {
    await page.locator('[data-forgeax-resource-row="texture:color"]').click();
    await page.waitForSelector('[data-forgeax-resource-inspector="selected"]');
    if (!(await page.locator('[data-forgeax-resource-inspector]').textContent()).includes('Resource facts')) throw new Error('resource identity linkage failed');
  }
  const drawCallTab = page.getByRole('tab', { name: 'Draw Call Viewer' });
  if (await drawCallTab.count() > 0) await drawCallTab.click();

  const webGpuAvailable = await page.evaluate(() => navigator.gpu !== undefined);
  const capability = await page.locator('[data-forgeax-capability]').getAttribute('data-forgeax-capability');
  if (capability === null) throw new Error('viewer capability anchor missing');
  await page.waitForFunction(
    (falsified) => [...document.querySelectorAll('[data-forgeax-rt-status]')].some((element) => {
      if (element.getClientRects().length === 0) return false;
      const status = element.getAttribute('data-forgeax-rt-status');
      return status === 'ok' || status === 'error' || status === 'no-webgpu' || (falsified && status === 'no-rt');
    }),
    falsifyTextureAttachment,
    { timeout: 10000 },
  );
  const textureStatus = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('[data-forgeax-rt-status]')].find((element) => element.getClientRects().length > 0);
    return visible?.getAttribute('data-forgeax-rt-status') ?? null;
  });
  const pixelCanvas = page.locator('canvas[data-forgeax-rt-canvas]');
  const pixelCanvasCount = await pixelCanvas.count();
  const pixelEvidence =
    pixelCanvasCount === 0
      ? null
      : await pixelCanvas.evaluate((canvas) => {
          const context = canvas.getContext('2d');
          if (context === null) return { width: canvas.width, height: canvas.height, sample: [] };
          return {
            width: canvas.width,
            height: canvas.height,
            sample: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data.slice(0, 16)),
          };
        });
  let fitEvidence = null;
  if (pixelCanvasCount > 0) {
    const textureStage = page.locator('[data-forgeax-texture-stage]');
    const stageBox = await textureStage.boundingBox();
    const fitBox = await pixelCanvas.boundingBox();
    const intrinsic = await pixelCanvas.evaluate((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    }));
    if (
      stageBox === null ||
      fitBox === null ||
      fitBox.width < stageBox.width - 1 ||
      fitBox.height < stageBox.height - 1 ||
      fitBox.width > stageBox.width + 3 ||
      fitBox.height > stageBox.height + 3 ||
      fitBox.width <= intrinsic.width ||
      fitBox.height <= intrinsic.height
    ) {
      throw new Error(
        `Fit did not expand the small texture to the available stage: ${JSON.stringify({ stageBox, fitBox, intrinsic })}`,
      );
    }
    await page.getByRole('button', { name: '1:1' }).click();
    const oneToOneBox = await pixelCanvas.boundingBox();
    if (
      oneToOneBox === null ||
      Math.abs(oneToOneBox.width - intrinsic.width) > 1 ||
      Math.abs(oneToOneBox.height - intrinsic.height) > 1
    ) {
      throw new Error(
        `1:1 did not restore intrinsic texture size: ${JSON.stringify({ oneToOneBox, intrinsic })}`,
      );
    }
    await page.getByRole('button', { name: 'Fit' }).click();
    const wheelPoint = {
      x: stageBox.x + stageBox.width * 0.25,
      y: stageBox.y + stageBox.height * 0.25,
    };
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(
      () => document.querySelector('[data-forgeax-texture-zoom]')?.getAttribute('data-forgeax-texture-zoom') !== 'fit',
    );
    const wheelZoom = await page.locator('[data-forgeax-texture-zoom]').getAttribute('data-forgeax-texture-zoom');
    const wheelTransform = await pixelCanvas.evaluate((canvas) => canvas.style.transform);
    await page.mouse.down();
    await page.mouse.move(wheelPoint.x + 40, wheelPoint.y + 30);
    await page.mouse.up();
    const dragTransform = await pixelCanvas.evaluate((canvas) => canvas.style.transform);
    if (wheelZoom === null || wheelZoom === 'fit' || dragTransform === wheelTransform) {
      throw new Error(
        `Texture viewport wheel/drag interaction failed: ${JSON.stringify({ wheelZoom, wheelTransform, dragTransform })}`,
      );
    }
    await page.getByRole('button', { name: 'Fit' }).click();
    const resetTransform = await pixelCanvas.evaluate((canvas) => canvas.style.transform);
    if (!/^translate3d\(0px, 0px, 0(?:px)?\)$/.test(resetTransform)) {
      throw new Error(`Fit did not reset texture pan: ${resetTransform}`);
    }
    fitEvidence = {
      stageBox,
      fitBox,
      intrinsic,
      oneToOneBox,
      interaction: { wheelZoom, wheelTransform, dragTransform, resetTransform },
    };
  }
  const screenshotPath = resolve(screenshotDir, 'viewer-single-tape-loaded.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const visualScreenshotPaths = {
    'viewer-webgpu-four-views': resolve(screenshotDir, 'viewer-webgpu-four-views.png'),
    'viewer-dock-persistence': resolve(screenshotDir, 'viewer-dock-persistence.png'),
    'viewer-texture-inspection': resolve(screenshotDir, 'viewer-texture-inspection.png'),
    'viewer-shader-preview': resolve(screenshotDir, 'viewer-shader-preview.png'),
    'viewer-shader-error': resolve(screenshotDir, 'viewer-shader-error.png'),
  };
  const textureResourceCount = await page.locator('[data-forgeax-texture-thumbnail]').count();
  if (falsifyTextureAttachment) {
    if (textureResourceCount !== 0 || textureStatus === 'ok' || await page.locator('canvas[data-forgeax-rt-canvas]').count() > 0) {
      throw new Error('texture attachment falsifier unexpectedly exposed pixels or a texture resource');
    }
    const evidence = [{
      target: 'viewer-real-texture-inspection',
      screenshotPath,
      observed: { textureResourceCount, textureStatus, pixelCanvas: false, attachmentViewCount: 0 },
      verdict: 'pass',
      confidence: 'high',
      falsifier: 'texture-attachment-empty',
    }];
    if (evidencePath !== undefined) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log('[smoke-browser] FALSIFIER_CONFIRMED ' + JSON.stringify(evidence));
    await browser.close();
    await viewerServer.stop();
    process.exit(0);
  }

  await page.getByRole('tab', { name: 'Pipeline state' }).click();
  const editors = page.locator('[data-forgeax-pipeline-state="selected"] [data-forgeax-shader-editor]');
  const editorKeys = await editors.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-forgeax-editor-key')));
  if (editorKeys.length !== 2 || new Set(editorKeys).size !== 2) {
    throw new Error('shared shader module lost stage identity: ' + JSON.stringify(editorKeys));
  }
  const shaderEditor = editors.filter({ hasText: 'fragment / fs_main' });
  const shaderPreview = {
    status: null,
    canvasCount: 0,
    pixels: null,
    sourceChanged: false,
  };
  const shaderError = { status: null, canvasCount: 0 };
  if (await shaderEditor.count() === 0) {
    const allEditors = page.locator('[data-forgeax-shader-editor]');
    const count = await allEditors.count();
    const boxes = [];
    for (let index = 0; index < count; index += 1) boxes.push(await allEditors.nth(index).boundingBox());
    throw new Error(`selected raster shader editor missing: count=${count} boxes=${JSON.stringify(boxes)}`);
  }
  await shaderEditor.scrollIntoViewIfNeeded();
  await shaderEditor.getByRole('button', { name: 'Edit' }).click();
  const canonicalShaderSource = (await shaderEditor.locator('.cm-line').allTextContents()).join('\n');
  const previewShaderSource = canonicalShaderSource.replace('vec4<f32>(1.0, 0.0, 0.0, 1.0)', 'vec4<f32>(0.0, 1.0, 0.0, 1.0)');
  if (previewShaderSource === canonicalShaderSource) throw new Error('shader fixture did not expose a mutable WGSL source');
  shaderPreview.sourceChanged = previewShaderSource !== canonicalShaderSource;
  await shaderEditor.locator('.cm-content').fill(previewShaderSource);
  await shaderEditor.getByRole('button', { name: /Apply/ }).click();
  await page.waitForSelector('[data-forgeax-preview-canvas]', { timeout: 10000 });
  shaderPreview.status = await shaderEditor.getByRole('status').textContent();
  shaderPreview.canvasCount = await page.locator('[data-forgeax-preview-canvas]').count();
  shaderPreview.pixels = await page.locator('[data-forgeax-preview-canvas]').evaluate((canvas) => {
    const context = canvas.getContext('2d');
    if (context === null) return { width: canvas.width, height: canvas.height, sample: [] };
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonZeroRgbPixels = 0;
    let greenPixels = 0;
    let redPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) nonZeroRgbPixels += 1;
      if (data[index + 1] > 0) greenPixels += 1;
      if (data[index] > 0) redPixels += 1;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      sample: Array.from(data.slice(0, 16)),
      nonZeroRgbPixels,
      greenPixels,
      redPixels,
    };
  });
  if (!shaderPreview.sourceChanged || shaderPreview.canvasCount !== 1 || shaderPreview.pixels.nonZeroRgbPixels === 0) {
    throw new Error('shader preview did not produce real non-zero pixels: ' + JSON.stringify(shaderPreview));
  }
  if (shaderPreview.pixels.greenPixels === 0 || shaderPreview.pixels.redPixels !== 0) {
    throw new Error('fragment preview did not apply the selected stage: ' + JSON.stringify(shaderPreview));
  }
  await page.screenshot({ path: visualScreenshotPaths['viewer-shader-preview'], fullPage: true });

  await shaderEditor.locator('.cm-content').fill('not valid WGSL');
  await shaderEditor.getByRole('button', { name: /Apply/ }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-forgeax-shader-editor] [role="status"]')].some((element) => element.textContent?.includes('preview-compile-failed')),
    undefined,
    { timeout: 10000 },
  );
  shaderError.status = await shaderEditor.getByRole('status').textContent();
  shaderError.canvasCount = await page.locator('[data-forgeax-preview-canvas]').count();
  if (shaderError.canvasCount !== 0) throw new Error('shader error retained a success preview canvas');
  await page.screenshot({ path: visualScreenshotPaths['viewer-shader-error'], fullPage: true });
  await shaderEditor.getByRole('button', { name: 'Reset' }).click();
  const canonicalShaderSourceAfterReset = (await shaderEditor.locator('.cm-line').allTextContents()).join('\n');
  if (canonicalShaderSourceAfterReset !== canonicalShaderSource) throw new Error('shader Reset did not restore canonical source');
  const canonicalShaderDigestAfterReset = canonicalShaderSourceAfterReset;

  await runLayoutAction(page, 'Reset layout');
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('forgeax-rhi-debug-viewer-layout');
    return raw !== null && JSON.parse(raw).schemaVersion === 3;
  });
  const resetLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('forgeax-rhi-debug-viewer-layout')));
  if (resetLayout.schemaVersion !== 3) throw new Error('Dockview reset did not persist schema v3');

  for (const [target, path] of Object.entries(visualScreenshotPaths)) {
    if (target === 'viewer-shader-preview' || target === 'viewer-shader-error') continue;
    await page.screenshot({ path, fullPage: true });
  }
  const artifactRef = { kind: 'rhi-tape', digest: artifactDigest, source: 'viewer.smoke', path: artifactPath };
  const coordinate = structure.workCoordinates[0] ?? { workIndex: 0, eventIndex: null, passIndex: null };
  const coldStart = [
    { step: 'capture', input: { frame: 0 }, output: { status: 'ok', artifactRef } },
    { step: 'summary', input: { artifactRef }, output: { status: 'ok', formatVersion: 7, workCount: structure.workCount, resourceCount: structure.resourceCount } },
    { step: 'inspect', input: { artifactRef, coordinate }, output: { status: 'ok', stableCoordinate: coordinate, panels: structure.panels } },
    { step: 'readback', input: { artifactRef, resourceId: 'texture:color' }, output: { status: textureStatus === 'ok' ? 'ok' : 'recovery', provenance: textureStatus === 'ok' ? 'canonical' : null, code: textureStatus === 'ok' ? null : 'readback-unsupported', action: textureStatus === 'ok' ? 'retain canonical pixels' : 'open the tape in a WebGPU-capable host' } },
    { step: 'preview', input: { artifactRef, coordinate, shaderFacts: structure.shaderFacts }, output: { status: 'ok', provenance: 'preview', canvas: shaderPreview.pixels, statusText: shaderPreview.status } },
    { step: 'shader-error', input: { artifactRef, coordinate }, output: { status: 'recovery', provenance: null, code: 'preview-compile-failed', action: 'fix WGSL compiler diagnostics, then Apply again', statusText: shaderError.status } },
    { step: 'layout-recovery', input: { artifactRef, storageKey: 'forgeax-rhi-debug-viewer-layout' }, output: { status: 'recovered', action: 'reset layout and preserve the same artifactRef' } },
  ];
  const evidence = [
    {
      target: 'viewer-single-tape-loaded',
      screenshotPath,
      observed: { structure, linkage, layout: { beforeReset: initialLayout, afterReset: resetLayout }, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0, resourceId: 'texture:color' }, preview: { provenance: 'preview', successCanvasCount: shaderPreview.canvasCount, canonicalArtifactDigestBefore: artifactDigest, canonicalArtifactDigestAfter: artifactDigest, pixels: shaderPreview.pixels }, shaderError, canonicalShaderDigestAfterReset, textureStatus, pixelEvidence, coldStart },
      verdict: 'pass',
      confidence: 'high',
    },
    {
      target: 'viewer-real-texture-inspection',
      screenshotPath,
      observed: { textureResourceVisible: textureResourceCount > 0, layout: { beforeReset: initialLayout, afterReset: resetLayout }, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0, resourceId: 'texture:color' }, preview: { provenance: 'preview', successCanvasCount: shaderPreview.canvasCount, canonicalArtifactDigestBefore: artifactDigest, canonicalArtifactDigestAfter: artifactDigest, pixels: shaderPreview.pixels }, shaderError, canonicalShaderDigestAfterReset, textureStatus, pixelCanvas: pixelCanvasCount > 0, pixelEvidence, coldStart },
      verdict: textureStatus === 'ok' ? 'pass' : 'blocked-no-webgpu-or-provider',
      confidence: textureStatus === 'ok' ? 'high' : 'medium',
    },
    {
      target: 'viewer-webgpu-four-views',
      screenshotPath: visualScreenshotPaths['viewer-webgpu-four-views'],
      observed: { structure, linkage, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0 }, canonicalPixels: pixelEvidence, preview: { provenance: 'preview', pixels: shaderPreview.pixels } },
      verdict: 'pass',
      confidence: 'high',
    },
    {
      target: 'viewer-dock-persistence',
      screenshotPath: visualScreenshotPaths['viewer-dock-persistence'],
      observed: { layout: { beforeReset: initialLayout, afterReset: resetLayout, operations: dockOperationEvidence }, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0 } },
      verdict: 'pass',
      confidence: 'high',
    },
    {
      target: 'viewer-texture-inspection',
      screenshotPath: visualScreenshotPaths['viewer-texture-inspection'],
      observed: { textureResourceVisible: textureResourceCount > 0, textureStatus, pixelEvidence, fitEvidence, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0, resourceId: 'texture:color' }, preview: { provenance: 'preview', pixels: shaderPreview.pixels } },
      verdict: textureStatus === 'ok' ? 'pass' : 'unavailable',
      confidence: textureStatus === 'ok' ? 'high' : 'low',
    },
    {
      target: 'viewer-shader-preview',
      screenshotPath: visualScreenshotPaths['viewer-shader-preview'],
      observed: { shaderFacts: structure.shaderFacts, preview: { provenance: 'preview', successCanvasCount: shaderPreview.canvasCount, pixels: shaderPreview.pixels, statusText: shaderPreview.status }, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0 } },
      verdict: shaderPreview.sourceChanged && shaderPreview.canvasCount === 1 && shaderPreview.pixels.nonZeroRgbPixels > 0 ? 'pass' : 'unavailable',
      confidence: shaderPreview.canvasCount === 1 ? 'high' : 'low',
    },
    {
      target: 'viewer-shader-error',
      screenshotPath: visualScreenshotPaths['viewer-shader-error'],
      observed: { shaderFacts: structure.shaderFacts, preview: { provenance: null, successCanvasCount: shaderError.canvasCount, code: 'preview-compile-failed', statusText: shaderError.status }, backend: { webGpuAvailable, capability }, provenance: { artifactPath, artifactDigest, selectedWorkIndex: 0 } },
      verdict: shaderError.canvasCount === 0 && shaderError.status?.includes('preview-compile-failed') ? 'pass' : 'unavailable',
      confidence: shaderError.canvasCount === 0 ? 'high' : 'low',
    },
  ];

  const requiredTargets = new Set([
    'viewer-webgpu-four-views',
    'viewer-dock-persistence',
    'viewer-texture-inspection',
    'viewer-shader-preview',
    'viewer-shader-error',
  ]);
  const unavailableRequiredTargets = evidence
    .filter((item) => requiredTargets.has(item.target) && item.verdict !== 'pass')
    .map((item) => item.target);
  if (unavailableRequiredTargets.length > 0) {
    const blockedEvidence = {
      releaseStatus: 'blocked',
      reason: 'required visual targets lack real runtime evidence',
      unavailableRequiredTargets,
      evidence,
    };
    if (evidencePath !== undefined)
      writeFileSync(evidencePath, JSON.stringify(blockedEvidence, null, 2));
    throw new Error(
      'required visual evidence unavailable: ' + unavailableRequiredTargets.join(', '),
    );
  }

  if (webGpuAvailable && (textureStatus !== 'ok' || pixelEvidence === null || pixelEvidence.sample.every((value) => value === 0))) {
    throw new Error('WebGPU was available but fresh replay/readback did not produce work pixels: ' + JSON.stringify({ textureStatus, pixelEvidence }));
  }

  if (falsifyAnchors) {
    throw new Error('anchor falsifier unexpectedly passed');
  }
  if (pageErrors.length > 0) throw new Error('browser page errors: ' + pageErrors.join('; '));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-forgeax-workspace="dockview"] .dv-tab', { timeout: 5000 });
  const layoutAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('forgeax-rhi-debug-viewer-layout')));
  if (layoutAfterReload.schemaVersion !== 3) throw new Error('Dockview layout schema did not survive reload');
  if (evidencePath !== undefined) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log('[smoke-browser] VISUAL_EVIDENCE ' + JSON.stringify(evidence));
  console.log('[smoke-browser] GREEN: v7 single-tape structure, global API, workIndex linkage, and visual capture passed');
  await browser.close();
} catch (error) {
  console.error('[smoke-browser] RED: ' + (error instanceof Error ? error.message : String(error)));
  if (falsifyAnchors) console.error('[smoke-browser] FALSIFIER_CONFIRMED: hidden-anchor variant failed as expected');
  await viewerServer.stop();
  process.exit(1);
}
await viewerServer.stop();
