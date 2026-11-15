import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { createServer, loadConfigFromFile } from 'vite';

const root = resolve(import.meta.dirname, '..');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? process.argv[outputIndex + 1]
  : process.env.FORGEAX_OUTPUT_DIR;
if (!outputPath) throw new Error('Pass --output <directory> or set FORGEAX_OUTPUT_DIR');
const output = resolve(outputPath);
mkdirSync(output, { recursive: true });

const errors = [];
let server;
let browser;
let page;
let url;
try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'smoke' }, resolve(root, 'vite.config.ts'));
  assert(loaded, 'Terrain Provider Vite config missing');
  server = await createServer({
    ...loaded.config,
    configFile: false,
    root,
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  url = server.resolvedUrls?.local[0];
  assert(url, 'Terrain Provider URL missing');

  browser = await chromium.launch({
    ...browserLaunch,
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: [
      '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits', '--autoplay-policy=no-user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(new URL('?smoke', url).href, { waitUntil: 'domcontentloaded' });

  const waitForFrames = async (count = 2) => {
    const baseline = await page.evaluate(() => window.__waterTerrainProviderDemo?.app.renderer.inspect().frame.frameId ?? 0);
    await page.waitForFunction(({ frame, count: minimum }) => {
      const app = window.__waterTerrainProviderDemo?.app;
      return Boolean(app && app.renderer.inspect().frame.frameId >= frame + minimum);
    }, { frame: baseline, count }, { timeout: 60_000 });
  };
  await page.waitForFunction(() => {
    const demo = window.__waterTerrainProviderDemo;
    return Boolean(demo && document.querySelector('#render-state')?.textContent === '场景就绪');
  }, undefined, { timeout: 180_000 });
  await waitForFrames(4);
  await page.waitForFunction(() => document.querySelector('#water-info-geometry')?.dataset.ready === 'true', undefined, { timeout: 120_000 });

  const readState = () => page.evaluate(() => {
    const demo = window.__waterTerrainProviderDemo;
    const system = demo.world.getResource('WaterSystem');
    const body = system.snapshot(`scene-entity:${demo.bodyEntity}`);
    const geometry = document.querySelector('#water-info-geometry');
    return {
      selectedRevision: document.querySelector('button[data-revision="b"]')?.getAttribute('aria-pressed') === 'true' ? 'b' : 'a',
      providerEnabled: Boolean(document.querySelector('#provider-enabled')?.checked),
      statusMessage: document.querySelector('#status')?.textContent,
      zoneGuid: document.querySelector('#zone-guid')?.textContent,
      generation: Number(document.querySelector('#generation')?.textContent ?? 0),
      inputState: document.querySelector('#dirty-state')?.textContent,
      availability: document.querySelector('#availability')?.textContent,
      providerGuid: document.querySelector('#provider-guid')?.textContent,
      providerVersion: document.querySelector('#provider-version')?.textContent,
      providerBounds: document.querySelector('#provider-bounds')?.textContent,
      geometry: {
        text: geometry?.textContent,
        ready: geometry?.dataset.ready === 'true',
        receipt: geometry?.dataset.receipt,
        bodyReceipt: body?.outputReceipts.geometry?.digest,
        output: body?.outputs.geometry,
        dirty: body?.dirty.has('geometry'),
        outputGeneration: body?.outputGenerations.geometry,
        waterInfoRequested: body?.asset.flags.affectsWaterInfo,
        undilatedGuid: body?.asset.waterInfoMeshGuid,
        dilatedGuid: body?.asset.dilatedWaterInfoMeshGuid,
      },
      backendKind: demo.app.renderer.inspect().capabilities.backendKind,
      frameId: demo.app.renderer.inspect().frame.frameId,
    };
  });
  const assertGeometryReceipt = (state) => {
    assert.equal(state.geometry.ready, true, 'WaterInfo geometry resolver must report an accepted receipt');
    assert.equal(state.geometry.output, 'ready');
    assert.equal(state.geometry.dirty, false);
    assert.equal(state.geometry.receipt, state.geometry.bodyReceipt, 'UI receipt must match the accepted WaterSystem receipt');
    assert(state.geometry.outputGeneration > 0);
    assert(state.geometry.undilatedGuid && state.geometry.dilatedGuid, 'both undilated and dilated Pack meshes must be present');
  };
  const assertBounds = (state) => {
    const numbers = [...(state.providerBounds ?? '').matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    assert.equal(numbers.length, 4, `Expected finite min/max XZ bounds, got ${state.providerBounds}`);
    assert(numbers.every(Number.isFinite));
    assert(Math.abs((numbers[2] - numbers[0]) - 64) < 0.2, `Unexpected Terrain X bound span: ${state.providerBounds}`);
    assert(Math.abs((numbers[3] - numbers[1]) - 64) < 0.2, `Unexpected Terrain Z bound span: ${state.providerBounds}`);
  };

  const assertLayout = async (name, viewport) => {
    const result = await page.evaluate(() => {
      const rect = (node) => {
        if (!(node instanceof HTMLElement)) return undefined;
        const value = node.getBoundingClientRect();
        return { x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
      };
      const inspector = document.querySelector('.inspector');
      const toggle = document.querySelector('#panel-toggle');
      const fields = [...document.querySelectorAll('.inspector h1, .inspector h2, .inspector dt, .inspector dd, .inspector button, .inspector label, .inspector .status')];
      const overflows = fields.filter((node) => node.scrollWidth > node.clientWidth + 2).map((node) => node.id || node.textContent?.trim());
      const rowOverlaps = [...document.querySelectorAll('.inspector dl > div')].filter((row) => {
        const label = row.querySelector('dt')?.getBoundingClientRect();
        const value = row.querySelector('dd')?.getBoundingClientRect();
        return Boolean(label && value && label.right > value.left + 1);
      }).length;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        inspector: rect(inspector),
        toggle: rect(toggle),
        overflows,
        rowOverlaps,
        revisionButtons: [...document.querySelectorAll('button[data-revision]')].map((node) => rect(node)),
      };
    });
    const fits = (box) => box && box.x >= 0 && box.y >= 0 && box.right <= viewport.width && box.bottom <= viewport.height;
    assert(fits(result.inspector), `${name}: inspector leaves viewport: ${JSON.stringify(result)}`);
    assert(fits(result.toggle), `${name}: panel toggle leaves viewport: ${JSON.stringify(result)}`);
    assert(result.revisionButtons.every(fits), `${name}: a revision control leaves viewport: ${JSON.stringify(result)}`);
    assert.deepEqual(result.overflows, [], `${name}: clipped text: ${JSON.stringify(result.overflows)}`);
    assert.equal(result.rowOverlaps, 0, `${name}: Zone readout columns overlap`);
    return result;
  };
  const pixelSummary = (bytes, viewport) => {
    const image = PNG.sync.read(bytes);
    assert.equal(image.width, viewport.width);
    assert.equal(image.height, viewport.height);
    const colors = new Set();
    const base = [image.data[0], image.data[1], image.data[2]];
    let changed = 0;
    let opaque = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const [r, g, b, a] = image.data.subarray(offset, offset + 4);
      colors.add((r << 16) | (g << 8) | b);
      if (a > 250) opaque++;
      if (Math.max(Math.abs(r - base[0]), Math.abs(g - base[1]), Math.abs(b - base[2])) > 12) changed++;
    }
    assert(colors.size > 128, `Canvas screenshot is blank or nearly flat: ${colors.size} colors`);
    assert(changed > viewport.width * viewport.height * 0.02, `Canvas scene pixels do not vary from the clear corner: ${changed}`);
    assert.equal(opaque, viewport.width * viewport.height, 'Canvas screenshot must be fully opaque');
    return { width: image.width, height: image.height, distinctColors: colors.size, pixelsDifferentFromClearCorner: changed, opaquePixels: opaque };
  };
  const captureViewport = async (name, viewport) => {
    await page.setViewportSize(viewport);
    await waitForFrames(3);
    const layout = await assertLayout(name, viewport);
    const screenshotName = `terrain-provider-${name}.png`;
    const screenshotBytes = await page.screenshot({ fullPage: true });
    writeFileSync(resolve(output, screenshotName), screenshotBytes);
    const visibleFrameId = await page.evaluate(() => window.__waterTerrainProviderDemo.app.renderer.inspect().frame.frameId);
    await page.locator('#panel-toggle').click();
    const sceneName = `terrain-provider-${name}-scene.png`;
    const sceneBytes = await page.locator('#scene').screenshot();
    writeFileSync(resolve(output, sceneName), sceneBytes);
    const pixels = pixelSummary(sceneBytes, viewport);
    await page.locator('#panel-toggle').click();
    return {
      screenshot: screenshotName,
      screenshotDigest: `sha256:${createHash('sha256').update(screenshotBytes).digest('hex')}`,
      sceneScreenshot: sceneName,
      sceneScreenshotDigest: `sha256:${createHash('sha256').update(sceneBytes).digest('hex')}`,
      viewport, layout, pixels, visibleFrameId,
    };
  };

  const initial = await readState();
  assert.equal(initial.backendKind, 'webgpu', `Expected real WebGPU browser backend, received ${initial.backendKind}`);
  assert.equal(initial.selectedRevision, 'a');
  assert.equal(initial.providerEnabled, true);
  assert.match(initial.statusMessage, /方案 A/);
  assert(initial.generation > 0);
  assert(initial.providerGuid && initial.providerGuid !== '—');
  assert(initial.providerVersion && initial.providerVersion !== '—');
  assertBounds(initial);
  assertGeometryReceipt(initial);
  const desktopScreenshot = await captureViewport('desktop', { width: 1600, height: 900 });

  await page.locator('button[data-revision="b"]').click();
  await page.waitForFunction((generation) => Number(document.querySelector('#generation')?.textContent ?? 0) > generation
    && document.querySelector('#provider-guid')?.textContent !== '—', initial.generation, { timeout: 30_000 });
  const revisionB = await readState();
  assert.equal(revisionB.selectedRevision, 'b');
  assert.equal(revisionB.providerEnabled, true);
  assert.match(revisionB.statusMessage, /方案 B/);
  assert(revisionB.generation > initial.generation);
  assert.notEqual(revisionB.providerGuid, initial.providerGuid, 'A/B must bind distinct pre-cooked Terrain GUIDs');
  assert(revisionB.providerVersion && revisionB.providerVersion !== '—');
  assertBounds(revisionB);
  assertGeometryReceipt(revisionB);
  assert.equal(revisionB.geometry.receipt, initial.geometry.receipt, 'Terrain revision switch must not recook Water Body geometry');
  const revisionBScreenshot = await captureViewport('revision-b-desktop', { width: 1600, height: 900 });
  assert.notEqual(revisionBScreenshot.sceneScreenshotDigest, desktopScreenshot.sceneScreenshotDigest,
    'Pre-cooked Terrain A/B must produce distinct visible terrain frames');

  await page.locator('#provider-enabled').uncheck();
  await page.waitForFunction((generation) => Number(document.querySelector('#generation')?.textContent ?? 0) > generation
    && document.querySelector('#availability')?.textContent?.includes('无 Provider'), revisionB.generation, { timeout: 30_000 });
  const noProvider = await readState();
  assert.equal(noProvider.providerEnabled, false);
  assert.match(noProvider.statusMessage, /无 Terrain provider/);
  assert(noProvider.generation > revisionB.generation);
  assert.equal(noProvider.providerGuid, '—');
  assert.equal(noProvider.providerVersion, '—');
  assert.equal(noProvider.providerBounds, '—');
  assertGeometryReceipt(noProvider);
  assert.equal(noProvider.geometry.receipt, initial.geometry.receipt, 'Removing a Terrain provider must leave Body geometry receipt unchanged');
  const noProviderScreenshot = await captureViewport('no-provider-desktop', { width: 1600, height: 900 });
  const mobileScreenshot = process.argv.includes('--include-mobile')
    ? await captureViewport('mobile', { width: 390, height: 844 }) : undefined;

  const meshAssets = await page.evaluate(async () => {
    const demo = window.__waterTerrainProviderDemo;
    const unwrap = (result, label) => {
      if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
      return result.value;
    };
    const hash = async (view) => {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };
    const meshFacts = async (guid, category, label) => {
      const handle = typeof guid === 'number'
        ? guid
        : unwrap(await demo.app.assets.load(guid, 'mesh'), `${category} ${label} load (${guid})`);
      const assetGuid = typeof guid === 'string'
        ? guid
        : unwrap(demo.app.assets.source(handle), `${category} ${label} provenance (${guid})`)?.guid;
      if (!assetGuid) throw new Error(`${category} ${label} handle ${guid} has no Pack source GUID`);
      const mesh = unwrap(demo.app.assets.read(handle), `${category} ${label} read (${assetGuid})`);
      if (!mesh.indices) throw new Error(`${category} mesh ${guid} has no indices`);
      const indexFormat = mesh.indices instanceof Uint16Array ? 'uint16'
        : mesh.indices instanceof Uint32Array ? 'uint32' : undefined;
      if (!indexFormat) throw new Error(`${category} mesh ${guid} has an unsupported index array`);
      return {
        guid: assetGuid, category, label,
        vertexBytes: mesh.vertices.byteLength,
        vertexHash: await hash(mesh.vertices),
        vertexCount: mesh.attributes.position.length / 3,
        indexBytes: mesh.indices.byteLength,
        indexHash: await hash(mesh.indices),
        indexCount: mesh.indices.length,
        indexFormat,
      };
    };
    const terrain = unwrap(demo.app.assets.read(demo.terrainHandles.b), 'Selected Terrain B read');
    const body = demo.world.getResource('WaterSystem').snapshot(`scene-entity:${demo.bodyEntity}`);
    if (!body) throw new Error('River WaterSystem snapshot unavailable');
    const terrainGrids = await Promise.all(terrain.grids.map((guid, index) => meshFacts(guid, 'terrain-grid', `LOD ${index}`)));
    const riverSegments = await Promise.all((body.asset.riverSegmentMeshGuids ?? []).map((guid, index) => meshFacts(guid, 'river-segment', `Segment ${index}`)));
    return { selectedTerrainGuid: document.querySelector('#provider-guid')?.textContent, terrainGrids, riverSegments };
  });
  assert(meshAssets.terrainGrids.length > 0, 'Selected Terrain has no pre-cooked grid meshes');
  assert(meshAssets.riverSegments.length > 0, 'River has no pre-cooked visible segment meshes');

  const capture = await page.evaluate(async () => {
    const app = window.__waterTerrainProviderDemo?.app;
    if (!app?.rhiCapture?.captureFrame) throw new Error('Smoke app.rhiCapture.captureFrame unavailable');
    const backendKind = app.renderer.inspect().capabilities.backendKind;
    if (backendKind !== 'webgpu') throw new Error(`Expected WebGPU capture, received ${backendKind}`);
    const result = await app.rhiCapture.captureFrame();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const bytes = result.value.bytes;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const submitted = result.value.submittedFrame;
    const receipt = submitted.status === 'complete'
      ? { status: submitted.status, frameId: submitted.receipt.frameId, deviceGeneration: submitted.receipt.deviceGeneration, captureGeneration: submitted.captureGeneration }
      : submitted;
    return {
      base64: btoa(binary), digest: result.value.digest, receipt, backendKind,
      rendererCapabilities: app.renderer.inspect().capabilities,
      frameId: app.renderer.inspect().frame.frameId,
    };
  });
  const tapeBytes = Buffer.from(capture.base64, 'base64');
  const calculatedDigest = `sha256:${createHash('sha256').update(tapeBytes).digest('hex')}`;
  assert.equal(calculatedDigest, capture.digest, 'RHI tape digest must match the actual captured bytes');
  assert.equal(capture.receipt.status, 'complete', 'Capture must refer to a completed browser FrameReceipt');
  const tapeFile = 'terrain-provider.rhitape';
  writeFileSync(resolve(output, tapeFile), tapeBytes);

  const decoded = decodeTape(tapeBytes).unwrap();
  const model = buildFrameModel(decoded);
  const resources = new Map(model.resources.map((resource) => [resource.resourceId, resource]));
  const initialDataHashes = new Map(decoded.bootstrap.map((resource) => [
    resource.handleId,
    resource.initialData?.map((entry) => entry.hash) ?? [],
  ]));
  const drawKinds = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']);
  const describeDraw = (work) => ({
    workIndex: work.workIndex,
    kind: work.kind,
    passIndex: work.passIndex,
    drawCall: work.drawCall,
    pipeline: {
      status: work.pipeline?.status,
      label: work.pipeline?.descriptor?.desc?.label,
      topology: work.pipeline?.descriptor?.desc?.primitive?.topology,
      shaders: work.pipeline?.shaders?.map((shader) => {
        const source = shader.source ?? '';
        return {
          sha256: createHash('sha256').update(source).digest('hex'),
          byteLength: Buffer.byteLength(source),
          hasTerrainDecodeHeight: source.includes('fn terrainDecodeHeight'),
        };
      }) ?? [],
    },
    vertexBuffers: work.vertexBuffers.map((binding) => ({
      slot: binding.slot,
      bufferHandleId: binding.bufferHandleId,
      offset: binding.offset,
      size: resources.get(binding.bufferHandleId)?.descriptor?.desc?.size,
      hashes: initialDataHashes.get(binding.bufferHandleId) ?? [],
    })),
    indexBuffer: work.indexBuffer ? {
      bufferHandleId: work.indexBuffer.bufferHandleId,
      format: work.indexBuffer.format,
      offset: work.indexBuffer.offset,
      size: resources.get(work.indexBuffer.bufferHandleId)?.descriptor?.desc?.size,
      hashes: initialDataHashes.get(work.indexBuffer.bufferHandleId) ?? [],
    } : undefined,
    colorViewHandleIds: work.attachments?.colorViewHandleIds ?? [],
  });
  const draws = model.works.filter((work) => drawKinds.has(work.kind)).map(describeDraw);
  const terrainDraws = draws.filter((draw) => draw.pipeline.shaders.some((shader) => shader.hasTerrainDecodeHeight));
  assert(terrainDraws.length > 0, 'Captured FrameModel contains no actual Terrain raster shader draw');
  const actualColorDraw = (draw) => draw.pipeline.status === 'available'
    && draw.pipeline.topology === 'triangle-list'
    && draw.vertexBuffers.length > 0
    && (draw.indexBuffer?.format === 'uint16' || draw.indexBuffer?.format === 'uint32')
    && draw.colorViewHandleIds.length > 0;
  assert(terrainDraws.some(actualColorDraw), 'Terrain draw must bind an available pipeline, vertex/index buffers and color attachment');

  const matchAssetDraws = (asset, candidates) => candidates.filter((draw) =>
    draw.vertexBuffers.some((binding) => binding.hashes.includes(asset.vertexHash))
    && draw.indexBuffer?.hashes.includes(asset.indexHash));
  const terrainGridDraws = meshAssets.terrainGrids.map((asset) => {
    const matching = matchAssetDraws(asset, terrainDraws);
    return {
      ...asset,
      matchedWorks: matching.filter(actualColorDraw).map((draw) => ({
        workIndex: draw.workIndex,
        passIndex: draw.passIndex,
        pipelineLabel: draw.pipeline.label,
        vertexBuffers: draw.vertexBuffers,
        indexBuffer: draw.indexBuffer,
        colorViewHandleIds: draw.colorViewHandleIds,
      })),
    };
  });
  assert(terrainGridDraws.some((grid) => grid.matchedWorks.length > 0), 'No Terrain grid Pack mesh matched an actual colored RHI draw');
  for (const grid of terrainGridDraws.filter((asset) => asset.matchedWorks.length > 0)) {
    assert(grid.matchedWorks.every((draw) => draw.vertexBuffers.some((binding) => binding.hashes.includes(grid.vertexHash))
      && draw.vertexBuffers.some((binding) => binding.size === grid.vertexBytes)
      && draw.indexBuffer?.hashes.includes(grid.indexHash)
      && draw.indexBuffer.format === grid.indexFormat
      && draw.indexBuffer.size === grid.indexBytes
      && draw.colorViewHandleIds.length > 0), `Terrain LOD ${grid.label} draw is missing captured Pack buffer or color attachment evidence`);
  }

  const riverDraws = draws.filter((draw) => !draw.pipeline.shaders.some((shader) => shader.hasTerrainDecodeHeight));
  const riverSegmentDraws = meshAssets.riverSegments.map((asset) => {
    const matching = matchAssetDraws(asset, riverDraws).filter(actualColorDraw);
    for (const draw of matching) {
      assert.equal(draw.indexBuffer?.format, asset.indexFormat,
        `${asset.label} Pack index format must match the captured RHI draw`);
    }
    return {
      ...asset,
      matchedWorks: matching.map((draw) => ({
        workIndex: draw.workIndex,
        passIndex: draw.passIndex,
        pipelineLabel: draw.pipeline.label,
        vertexBuffers: draw.vertexBuffers,
        indexBuffer: draw.indexBuffer,
        colorViewHandleIds: draw.colorViewHandleIds,
      })),
    };
  });
  assert(riverSegmentDraws.every((segment) => segment.matchedWorks.length > 0), 'Every visible River Pack segment must map to an actual colored RHI draw');

  const finalState = await readState();
  assert.equal(finalState.providerEnabled, false, 'RHI tape should capture the visible Terrain while Zone provider is disabled');
  assertGeometryReceipt(finalState);
  assert.deepEqual(errors, [], `Browser console errors: ${JSON.stringify(errors)}`);
  const evidence = {
    url: new URL('?smoke', url).href,
    browser: {
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      adapterPath: 'Chrome WebGPU via the shared SwiftShader software Vulkan launch flags',
      backendKind: capture.backendKind,
      rendererCapabilities: capture.rendererCapabilities,
    },
    providerTransitions: { a: initial, b: revisionB, noProvider },
    screenshotFrameId: {
      revisionA: desktopScreenshot.visibleFrameId,
      revisionB: revisionBScreenshot.visibleFrameId,
      noProvider: noProviderScreenshot.visibleFrameId,
    },
    screenshots: [desktopScreenshot, revisionBScreenshot, noProviderScreenshot, ...(mobileScreenshot ? [mobileScreenshot] : [])],
    riverGeometry: {
      status: finalState.geometry.text,
      ready: finalState.geometry.ready,
      output: finalState.geometry.output,
      outputGeneration: finalState.geometry.outputGeneration,
      receipt: finalState.geometry.receipt,
      undilatedMeshGuid: finalState.geometry.undilatedGuid,
      dilatedMeshGuid: finalState.geometry.dilatedGuid,
    },
    terrainPackAssets: meshAssets.terrainGrids,
    riverPackAssets: meshAssets.riverSegments,
    capture: {
      file: tapeFile,
      digest: capture.digest,
      calculatedDigest,
      frameReceipt: capture.receipt,
      frameIdAfterCapture: capture.frameId,
      workCount: model.works.length,
      drawCount: draws.length,
      terrainShaderDrawCount: terrainDraws.length,
      terrainGridDraws,
      riverSegmentDraws,
      draws,
    },
    errors,
  };
  writeFileSync(resolve(output, 'terrain-provider-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const diagnostics = page ? await page.evaluate(() => {
    const demo = window.__waterTerrainProviderDemo;
    if (!demo) return { bootstrap: 'demo smoke handle unavailable' };
    const system = demo.world.getResource('WaterSystem');
    const body = system.snapshot(`scene-entity:${demo.bodyEntity}`);
    const zone = system.zoneGroundSnapshot(demo.zoneGuid);
    const sceneStatus = demo.world.getResource('WaterSceneStatus');
    const geometry = document.querySelector('#water-info-geometry');
    return {
      renderState: document.querySelector('#render-state')?.textContent,
      geometryReadout: { text: geometry?.textContent, ready: geometry?.dataset.ready, receipt: geometry?.dataset.receipt },
      body: body ? {
        guid: body.guid,
        sourceAssetGuid: body.sourceAssetGuid,
        worldMatrixM: body.worldMatrixM,
        geometryDirty: body.dirty.has('geometry'),
        geometryOutput: body.outputs.geometry,
        geometryGeneration: body.outputGenerations.geometry,
        geometryReceipt: body.outputReceipts.geometry,
        dependencies: body.dependencies.map(({ field, guid, kind, status, version, actualKind }) => ({ field, guid, kind, status, version, actualKind })),
        authoredWorldMatrixM: body.asset.geometryAuthoringWorldMatrixM,
        flags: body.asset.flags,
        waterInfoMeshGuid: body.asset.waterInfoMeshGuid,
        dilatedWaterInfoMeshGuid: body.asset.dilatedWaterInfoMeshGuid,
      } : undefined,
      zoneGround: zone ? {
        generation: zone.generation,
        dirty: zone.dirty,
        providers: zone.providers,
      } : undefined,
      waterGeometryRecookRequired: sceneStatus?.waterGeometryRecookRequired,
    };
  }).catch((diagnosticError) => ({ diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) })) : undefined;
  writeFileSync(resolve(output, 'terrain-provider-failure.json'), JSON.stringify({ url, errors, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, diagnostics }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
