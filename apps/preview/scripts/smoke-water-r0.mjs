import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer, loadConfigFromFile } from 'vite';
import { PNG } from 'pngjs';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'artifacts/water-r0/browser');
mkdirSync(output, { recursive: true });
process.env.FORGEAX_ENGINE_RHI_DEBUG = '1';
let server;
let browser;
const errors = [];
try {
  const args = process.argv.slice(2);
  let url = args.find((arg) => !arg.startsWith('--'));
  if (url === undefined) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(root, 'apps/preview/vite.config.ts'));
    assert(loaded, 'Preview configuration missing');
    server = await createServer({ ...loaded.config, configFile: false, root: resolve(root, 'apps/preview'), server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    url = server.resolvedUrls?.local[0];
  }
  assert(url, 'Preview URL missing');
  const launch = JSON.parse(readFileSync(resolve(root, 'scripts/ci/browser-launch.json'), 'utf8'));
  browser = await chromium.launch({ ...launch, headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(new URL('water-r0.html?smoke', url).href, { waitUntil: 'domcontentloaded' });
  const waitFrames = async (count) => {
    try {
      await page.waitForFunction((minimum) => document.body.dataset.error || document.querySelector('#status')?.textContent?.startsWith('Unable to render') || Number(document.body.dataset.frames ?? 0) >= minimum, count, { timeout: 180_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({ title: document.title, body: document.body.innerText, status: document.querySelector('#status')?.textContent, frames: document.body.dataset.frames, ready: document.body.dataset.ready }));
      throw new Error(`${error.message}; page=${JSON.stringify(state)}; browserErrors=${JSON.stringify(errors)}`);
    }
    const state = await page.evaluate(() => ({ error: document.body.dataset.error, status: document.querySelector('#status')?.textContent }));
    assert.equal(state.error, undefined, JSON.stringify({ ...state, errors }));
    assert(!state.status?.startsWith('Unable to render'), JSON.stringify({ ...state, errors }));
  };
  await waitFrames(60);
  const snapshots = () => page.evaluate(() => globalThis.__waterR0.world.getResource('WaterSystem').snapshots().map(({ guid, sourceAssetGuid, sourceVersion, sceneGeneration, worldMatrixM, binding, asset }) => ({ guid, sourceAssetGuid, type: asset.type, sourceVersion, sceneGeneration, worldMatrixM, binding, queryFootprint: asset.queryFootprint })));
  const initial = await snapshots();
  assert.equal(initial.length, 4);
  const sceneTypes = async () => (await snapshots()).map((entry) => entry.type).sort();
  const expectSceneTypes = async (expected) => assert.deepEqual(await sceneTypes(), [...expected].sort());
  const sceneSequence = [];
  assert(initial.every((entry) => entry.binding.kind === 'zone-unbound'));
  await page.locator('#bind-zone').click();
  await page.waitForFunction(() => document.body.dataset.zoneBound === 'true');
  const beforeReload = await page.evaluate(() => {
    const snapshot = globalThis.__waterR0.world.getResource('WaterSystem').snapshots().find(({ asset }) => asset.type === 'river');
    return { sourceVersion: snapshot?.sourceVersion, sceneGeneration: snapshot?.sceneGeneration };
  });
  await page.locator('#body-actors [data-action="reload"][data-kind="river"]').click();
  await page.waitForFunction((previous) => globalThis.__waterR0.world.getResource('WaterSystem').snapshots().find(({ asset }) => asset.type === 'river')?.sourceVersion !== previous.sourceVersion, beforeReload);
  const reloadedRiver = await page.evaluate(() => globalThis.__waterR0.world.getResource('WaterSystem').snapshots().find(({ asset }) => asset.type === 'river'));
  const riverSplineWidthM = reloadedRiver.asset.spline.points[0].widthM;
  const riverQueryWidthM = Math.max(...reloadedRiver.asset.queryFootprint.map((point) => point[1])) - Math.min(...reloadedRiver.asset.queryFootprint.map((point) => point[1]));
  assert.equal(riverSplineWidthM, 16, 'River hot reload must update its authored control point width in meters');
  assert.equal(riverQueryWidthM, riverSplineWidthM, 'River query footprint width must match its spline width');
  assert(reloadedRiver.sceneGeneration > beforeReload.sceneGeneration, 'River hot reload must advance its Scene generation');
  let panelsHidden = false;
  const setPanelsHidden = async (hidden) => {
    if (panelsHidden === hidden) return;
    await page.locator('#toggle-panels').click();
    panelsHidden = hidden;
    await page.waitForFunction((value) => document.body.classList.contains('panel-hidden') === value, hidden);
  };
  const canvasFrame = async (name, expectedTypes) => {
    await setPanelsHidden(true);
    await expectSceneTypes(expectedTypes);
    const bytes = await page.locator('#water').screenshot();
    writeFileSync(resolve(output, `${name}.png`), bytes);
    sceneSequence.push({ screenshot: `${name}.png`, types: [...expectedTypes] });
    return PNG.sync.read(bytes);
  };
  const countColor = (image, kind) => {
    let count = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, b, a] = image.data.subarray(i, i + 4);
      if (a < 240) continue;
      if (kind === 'river' ? r < 130 && g > 160 && b > 190 && b - g < 85 : r > 175 && g > 120 && b < 150 && r > g) count++;
    }
    return count;
  };
  const visual = [];
  visual.push(await canvasFrame('step-00-four-bodies', ['river', 'lake', 'ocean', 'custom']));
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="river"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '3');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  visual.push(await canvasFrame('step-01-river-unloaded', ['lake', 'ocean', 'custom']));
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="lake"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '2');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  visual.push(await canvasFrame('step-02-lake-unloaded', ['ocean', 'custom']));
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="river"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '3');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  visual.push(await canvasFrame('step-03-river-mounted', ['river', 'ocean', 'custom']));
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="lake"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '4');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  visual.push(await canvasFrame('step-04-lake-mounted', ['river', 'lake', 'ocean', 'custom']));
  const riverPixels = visual.map((image) => countColor(image, 'river'));
  const lakePixels = visual.map((image) => countColor(image, 'lake'));
  assert(riverPixels[0] > 20 && riverPixels[1] < riverPixels[0] * 0.1 && riverPixels[2] < riverPixels[0] * 0.1 && riverPixels[3] > riverPixels[0] * 0.8 && riverPixels[4] > riverPixels[0] * 0.8, `River cyan pixels must disappear and return: ${riverPixels.join(',')}`);
  assert(lakePixels[0] > 20 && lakePixels[1] > lakePixels[0] * 0.8 && lakePixels[2] < lakePixels[0] * 0.1 && lakePixels[3] < lakePixels[0] * 0.1 && lakePixels[4] > lakePixels[0] * 0.8, `Lake yellow pixels must disappear and return: ${lakePixels.join(',')}`);
  const visualOnly = args.includes('--visual-only');
  if (visualOnly) {
    await setPanelsHidden(true);
    const panelsActuallyHidden = await page.evaluate(() => document.body.classList.contains('panel-hidden') && getComputedStyle(document.querySelector('aside')).display === 'none' && getComputedStyle(document.querySelector('.body-panel')).display === 'none');
    assert.equal(panelsActuallyHidden, true);
    assert.deepEqual(errors, []);
    const evidence = { completedFrames: await page.evaluate(() => Number(document.body.dataset.frames)), initial, sceneSequence, panelsHidden: panelsActuallyHidden, visualSequence: ['4', '3', '2', '3', '4'], coloredPixelCounts: { desktop: { riverCyan: riverPixels, lakeYellow: lakePixels } }, background: 'R0 renderer without legacy shoreline, reflection target or environment assets', errors };
    writeFileSync(resolve(output, 'visual-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    await browser.close();
    browser = undefined;
    await server?.close();
    server = undefined;
  } else {
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 3);
  const captureTape = async () => {
    const capture = await page.evaluate(async () => {
      const result = await globalThis.__waterR0.app.rhiCapture.captureFrame();
      if (!result.ok) throw result.error;
      const bytes = result.value.bytes;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      const submitted = result.value.submittedFrame;
      const receipt = submitted.status === 'complete' ? { status: submitted.status, frameId: submitted.receipt.frameId, deviceGeneration: submitted.receipt.deviceGeneration, captureGeneration: submitted.captureGeneration } : submitted;
      return { digest: result.value.digest, base64: btoa(binary), receipt, backendKind: globalThis.__waterR0.app.renderer.inspect().capabilities.backendKind };
    });
    const bytes = Buffer.from(capture.base64, 'base64');
    const tape = decodeTape(bytes).unwrap();
    const model = buildFrameModel(tape);
    const overlay = tape.events.findLast((event) => event.kind === 'beginRenderPass' && event.desc.label === 'debug-overlay');
    const draw = overlay && model.works.find((work) => work.drawCall.passHandleId === overlay.passHandleId);
    assert(draw, 'WaterBody overlay draw missing');
    const pass = model.passes.find(({ passIndex }) => passIndex === draw.passIndex);
    const vertexBuffers = draw.vertexBuffers.map((binding) => {
      const resource = model.resources.find(({ resourceId }) => resourceId === binding.bufferHandleId);
      const writes = tape.events.filter((event) => event.kind === 'writeBuffer' && event.handleId === binding.bufferHandleId).map(({ bufferOffset, size, dataHash }) => ({ bufferOffset, size, dataHash }));
      return { ...binding, descriptor: resource?.descriptor ?? null, writes };
    });
    return { bytes, digest: capture.digest, draw, pass, receipt: capture.receipt, backendKind: capture.backendKind, unseededResources: model.unseededResources, vertexBuffers };
  };
  const vertices = [];
  const rhiSequence = [];
  const recordOverlay = async (expected, name, expectedTypes) => {
    await expectSceneTypes(expectedTypes);
    const tape = await captureTape();
    assert.equal(tape.draw.drawCall.vertexCount, expected);
    assert.equal(tape.receipt.status, 'complete', `RHI capture ${name} must include a completed FrameReceipt`);
    assert.equal(tape.draw.pipeline.status, 'available', `RHI capture ${name} must bind its debug-overlay pipeline`);
    assert(tape.vertexBuffers.length > 0, `RHI capture ${name} must bind vertex data`);
    assert((tape.draw.attachments?.colorViewHandleIds.length ?? 0) > 0, `RHI capture ${name} must write a color attachment`);
    vertices.push(expected);
    await setPanelsHidden(true);
    const screenshotName = `rhi-${name}.png`;
    writeFileSync(resolve(output, screenshotName), await page.locator('#water').screenshot());
    const screenshotFrameId = await page.evaluate(() => globalThis.__waterR0.app.renderer.inspect().frame.frameId);
    rhiSequence.push({ screenshot: screenshotName, sceneTypes: expectedTypes, receipt: tape.receipt, screenshotFrameId, screenshotMatchesReceipt: screenshotFrameId === tape.receipt.frameId, pairing: screenshotFrameId === tape.receipt.frameId ? 'same submitted FrameReceipt' : 'same fixed Scene/input state; screenshot taken after capture receipt', digest: tape.digest, recordingBackend: tape.backendKind, pixelReplayStatus: 'unavailable: Dawn native module missing; no fresh-device pixel assertion', replayBackend: null, structureAnalysis: 'static FrameModel projection only; separate rhi-null structural inspect is not pixel replay', workIndex: tape.draw.workIndex, passIndex: tape.draw.passIndex, pass: { beginEventIndex: tape.pass?.beginEventIndex, colorAttachmentViewHandleIds: tape.pass?.colorAttachmentViewHandleIds, depthStencilViewHandleId: tape.pass?.depthStencilViewHandleId }, draw: { kind: tape.draw.kind, vertexCount: tape.draw.drawCall.vertexCount, instanceCount: tape.draw.drawCall.instanceCount, pipelineStatus: tape.draw.pipeline.status, pipelineHandleId: tape.draw.pipeline.status === 'available' ? tape.draw.pipeline.pipelineHandleId : null, vertexBuffers: tape.vertexBuffers, attachments: tape.draw.attachments }, unseededResources: tape.unseededResources });
    return tape;
  };
  const fourBodies = await recordOverlay(216, 'step-00-four-bodies', ['river', 'lake', 'ocean', 'custom']);
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="river"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '3');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  await recordOverlay(162, 'step-01-river-unloaded', ['lake', 'ocean', 'custom']);
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="lake"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '2');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  await recordOverlay(108, 'step-02-lake-unloaded', ['ocean', 'custom']);
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="river"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '3');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  await recordOverlay(162, 'step-03-river-mounted', ['river', 'ocean', 'custom']);
  await setPanelsHidden(false);
  await page.locator('#body-actors [data-action="toggle"][data-kind="lake"]').click();
  await page.waitForFunction(() => document.body.dataset.waterBodies === '4');
  await waitFrames(Number(await page.evaluate(() => document.body.dataset.frames)) + 2);
  const restoredFourBodies = await recordOverlay(216, 'step-04-lake-mounted', ['river', 'lake', 'ocean', 'custom']);
  writeFileSync(resolve(output, 'water.rhitape'), restoredFourBodies.bytes);
  const lifecycle = await snapshots();
  assert(lifecycle.every((entry) => entry.binding.kind === 'bound'));
  await setPanelsHidden(true);
  const panelsActuallyHidden = await page.evaluate(() => document.body.classList.contains('panel-hidden') && getComputedStyle(document.querySelector('aside')).display === 'none' && getComputedStyle(document.querySelector('.body-panel')).display === 'none');
  assert.equal(panelsActuallyHidden, true);
  assert.deepEqual(errors, []);
  const evidence = { completedFrames: await page.evaluate(() => Number(document.body.dataset.frames)), initial, lifecycle, sceneSequence, rhiSequence, panelsHidden, visualSequence: ['4', '3', '2', '3', '4'], coloredPixelCounts: { desktop: { riverCyan: riverPixels, lakeYellow: lakePixels } }, overlayVertices: vertices, overlayWithFourBodies: { vertexCount: restoredFourBodies.draw.drawCall.vertexCount, digest: restoredFourBodies.digest }, background: 'R0 renderer without legacy shoreline, reflection target or environment assets', errors };
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  }
} finally {
  await browser?.close();
  await server?.close();
}
