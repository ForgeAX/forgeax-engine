import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { createServer, loadConfigFromFile } from 'vite';
import { buildFrameModel, decodeTape } from '../../../../packages/rhi-debug/dist/index.mjs';
import { assertScenePixels, captureCanvas, countPixelsInCircle, projectWorldPoint } from '../../visual-smoke-helpers.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const outputIndex = process.argv.indexOf('--output');
const outputArg = outputIndex >= 0 ? process.argv[outputIndex + 1] : process.env.FORGEAX_OUTPUT_DIR;
if (!outputArg) throw new Error('Pass --output <directory> or set FORGEAX_OUTPUT_DIR');
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const diagnostic = process.env.FORGEAX_VISUAL_DIAGNOSTIC === '1';
const desktopOnly = !process.argv.includes('--include-mobile');
const appIndex = process.argv.indexOf('--app');
const appFilter = appIndex >= 0 ? process.argv[appIndex + 1] : undefined;
if (appFilter !== undefined && !['mesh', 'info'].includes(appFilter)) throw new Error(`Unknown --app ${appFilter}`);
const urlArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const failures = [];
const servers = [];
let browser;
const startServer = async (appName) => {
  const root = resolve(repoRoot, `apps/water/${appName}`);
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'visual-smoke' }, resolve(root, 'vite.config.ts'));
  assert(loaded, `${appName} Vite config missing`);
  const server = await createServer({
    ...loaded.config, configFile: false, root,
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false },
  });
  servers.push(server);
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  assert(url, `${appName} URL missing`);
  return url;
};

const sleep = (ms = 500) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const pixelStats = (bytes) => {
  const image = PNG.sync.read(bytes);
  const colors = new Set();
  const base = [image.data[0], image.data[1], image.data[2]];
  let different = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const color = `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`;
    colors.add(color);
    if (Math.max(Math.abs(image.data[i] - base[0]), Math.abs(image.data[i + 1] - base[1]), Math.abs(image.data[i + 2] - base[2])) > 12) different++;
  }
  return { width: image.width, height: image.height, distinctColors: colors.size, pixelsDifferentFromClearCorner: different };
};
const changedPixels = (leftBytes, rightBytes) => {
  const left = PNG.sync.read(leftBytes); const right = PNG.sync.read(rightBytes);
  assert.equal(left.width, right.width); assert.equal(left.height, right.height);
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (Math.abs(left.data[i] - right.data[i]) > 3 || Math.abs(left.data[i + 1] - right.data[i + 1]) > 3 || Math.abs(left.data[i + 2] - right.data[i + 2]) > 3) changed++;
  }
  return changed;
};
const waterPixelsBelow = (bytes, startRow) => {
  const image = PNG.sync.read(bytes);
  let pixels = 0;
  for (let y = startRow; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const offset = (y * image.width + x) * 4;
    const [red, green, blue] = image.data.subarray(offset, offset + 3);
    if (red < 140 && blue > red + 25 && blue > green + 8) pixels++;
  }
  return pixels;
};
const islandClearPixels = (bytes) => {
  const image = PNG.sync.read(bytes);
  const view = { eye: [26 + 66 * 0.67, 50, 20 + 66 * 0.74], target: [26, 1.2, 20], fov: 0.88 };
  const corners = Array.from({ length: 24 }, (_, index) => {
    const angle = index * Math.PI / 12;
    const shape = 1 + 0.08 * Math.sin(3 * angle + 0.4) + 0.05 * Math.cos(5 * angle - 0.7);
    return projectWorldPoint([26 + (18 * shape + 2) * Math.cos(angle), -0.15, 20 + (16 * shape + 2) * Math.sin(angle)], view, image.width, image.height);
  });
  const inside = (x, y) => {
    let result = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const a = corners[i], b = corners[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
  };
  let clear = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (!inside(x + 0.5, y + 0.5)) continue;
    const offset = (y * image.width + x) * 4;
    if (image.data[offset] > 175 && image.data[offset + 1] > 175 && image.data[offset + 2] > 175) clear++;
  }
  return clear;
};
const readWaterInfoState = async (page) => page.evaluate(() => {
  const state = window.__waterInfoVisualDebug?.readWaterState();
  const river = state?.bodies.find((body) => body.body.type === 'river');
  return {
    zone: state?.zone ? { generation: state.zone.generation, waterInfo: state.zone.asset.waterInfo } : null,
    ground: state?.ground ? {
      generation: state.ground.generation,
      zoneGeneration: state.ground.zoneGeneration,
      dirty: state.ground.dirty,
      terrainGuids: state.ground.providers.map((provider) => provider.terrainGuid),
    } : null,
    river: river ? {
      binding: river.binding,
      dirty: [...river.dirty],
      outputs: river.outputs,
      waterInfoGeneration: river.outputGenerations.waterInfo,
      waterInfoReceipt: river.outputReceipts.waterInfo,
    } : null,
    probe: state?.probe ?? null,
    view: state?.view ?? null,
    renderState: document.querySelector('#render-state')?.textContent ?? '',
  };
});
const submittedFrame = (state) => Number(/^第 (\d+) 帧已提交$/.exec(state?.renderState ?? '')?.[1] ?? 0);
const assertWaterInfoPublication = (current, previous, label) => {
  const receipt = current.river?.waterInfoReceipt;
  assert(current.zone, `${label}: WaterZone snapshot missing`);
  assert.equal(current.river?.binding.kind, 'bound', `${label}: WaterInfo River must be bound`);
  assert.equal(current.river?.outputs.waterInfo, 'ready', `${label}: WaterInfo River output must be accepted`);
  assert(receipt?.digest, `${label}: accepted WaterInfo receipt missing`);
  assert.equal(receipt.outputGeneration, current.river.waterInfoGeneration,
    `${label}: WaterInfo receipt generation does not match the current body output generation`);
  if (!previous) return;
  const previousReceipt = previous.river?.waterInfoReceipt;
  assert(previousReceipt?.digest, `${label}: prior WaterInfo receipt missing`);
  assert(current.zone.generation > previous.zone.generation,
    `${label}: WaterZone generation did not advance after the control change`);
  assert(current.river.waterInfoGeneration > previous.river.waterInfoGeneration,
    `${label}: Body WaterInfo output generation did not advance after the control change`);
  assert(receipt.consumerGeneration > previousReceipt.consumerGeneration,
    `${label}: accepted WaterInfo consumer receipt did not advance`);
  assert.notEqual(receipt.digest, previousReceipt.digest,
    `${label}: accepted WaterInfo source digest did not advance with the Zone generation`);
};
const assertTerrainWaterInfoPublication = (current, previous, label) => {
  const receipt = current.river?.waterInfoReceipt;
  const previousReceipt = previous.river?.waterInfoReceipt;
  assert(current.zone, `${label}: WaterZone snapshot missing`);
  assert(current.ground, `${label}: Zone ground snapshot missing`);
  assert(previous.ground, `${label}: prior Zone ground snapshot missing`);
  assert.equal(current.ground.zoneGeneration, current.zone.generation,
    `${label}: Zone ground snapshot does not match the active WaterZone generation`);
  assert(current.ground.generation > previous.ground.generation,
    `${label}: Zone ground generation did not advance after the Terrain provider change`);
  assert.equal(current.ground.dirty, false,
    `${label}: changed Zone ground input was not accepted by a submitted WaterInfo capture`);
  assert.equal(current.river?.binding.kind, 'bound', `${label}: WaterInfo River must be bound`);
  assert.equal(current.river?.outputs.waterInfo, 'ready', `${label}: WaterInfo River output must be accepted`);
  assert(!current.river?.dirty.includes('waterInfo'), `${label}: Body WaterInfo output remains dirty`);
  assert(receipt?.digest, `${label}: accepted WaterInfo receipt missing`);
  assert.equal(receipt.outputGeneration, current.river.waterInfoGeneration,
    `${label}: WaterInfo receipt generation does not match the current Body output generation`);
  assert.equal(current.river.waterInfoGeneration, previous.river.waterInfoGeneration,
    `${label}: Terrain-only input change must update the accepted receipt without changing Body output generation`);
  assert(previousReceipt?.digest, `${label}: prior WaterInfo receipt missing`);
  assert(receipt.consumerGeneration > previousReceipt.consumerGeneration,
    `${label}: accepted WaterInfo consumer receipt did not advance after the Terrain provider change`);
  assert.notEqual(receipt.digest, previousReceipt.digest,
    `${label}: accepted WaterInfo source digest did not advance with the ground generation`);
};
const assertNoOverlaps = async (page, viewport, appName) => {
  const result = await page.evaluate(() => {
    const inspector = document.querySelector('.inspector');
    const visibleLeaves = [...inspector.querySelectorAll('*')].filter((node) => {
      if (node.children.length || !node.getClientRects().length || node.closest('details:not([open])')) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const collisions = [];
    for (let i = 0; i < visibleLeaves.length; i++) for (let j = i + 1; j < visibleLeaves.length; j++) {
      const a = visibleLeaves[i].getBoundingClientRect(); const b = visibleLeaves[j].getBoundingClientRect();
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 2 && overlapY > 2) collisions.push({ a: visibleLeaves[i].outerHTML.slice(0, 100), b: visibleLeaves[j].outerHTML.slice(0, 100), overlap: [overlapX, overlapY] });
    }
    return { scrollHeight: inspector.scrollHeight, clientHeight: inspector.clientHeight, collisions };
  });
  assert.deepEqual(result.collisions, [], `${appName} ${viewport} UI overlaps: ${JSON.stringify(result.collisions)}`);
  assert(result.clientHeight <= viewport.height, `${appName} inspector exceeds viewport`);
  return result;
};

try {
  const meshUrl = urlArg('--mesh-url') ?? await startServer('water-mesh');
  const infoUrl = urlArg('--info-url') ?? await startServer('water-info');
  browser = await chromium.launch({
    ...browserLaunch, headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    chromiumSandbox: true,
  });
  const results = [];
  for (const spec of [
    { name: 'mesh', url: meshUrl, expectedReceipt: /GPU 帧已提交/, ready: async (page) => page.locator('#tiles').waitFor({ state: 'visible' }) },
    { name: 'info', url: infoUrl, expectedReceipt: /第 \d+ 帧已提交/, ready: async (page) => page.locator('#ground').waitFor({ state: 'visible' }) },
  ].filter((entry) => appFilter === undefined || entry.name === appFilter)) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push({ kind: 'pageerror', message: error.message }));
    page.on('console', async (message) => {
      if (message.type() !== 'error') return;
      const entry = { kind: 'console', message: message.text() };
      const first = message.args()[0];
      if (first) {
        try {
          entry.object = await first.evaluate((value) => {
            const seen = new WeakSet();
            const describe = (item, depth = 0) => {
              if (item === null || typeof item !== 'object') return item;
              if (seen.has(item)) return '[Circular]';
              seen.add(item);
              if (depth >= 9) return `[${item.constructor?.name ?? 'Object'}]`;
              const properties = {};
              for (const key of Object.getOwnPropertyNames(item).slice(0, 30)) {
                try { properties[key] = describe(item[key], depth + 1); } catch { properties[key] = '[unreadable]'; }
              }
              return { type: item.constructor?.name ?? 'Object', properties };
            };
            return describe(value);
          });
        } catch (error) { entry.objectReadError = error instanceof Error ? error.message : String(error); }
      }
      errors.push(entry);
    });
    page.on('response', (response) => { if (response.status() >= 400) errors.push({ kind: 'http', status: response.status(), url: response.url() }); });
    const targetUrl = new URL(spec.url);
    targetUrl.searchParams.set('visual-smoke', '1');
    await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded' });
    await spec.ready(page);
    if (diagnostic) await sleep(1_500);
    else await page.waitForFunction((pattern) => new RegExp(pattern).test(document.querySelector('#render-state')?.textContent ?? ''), spec.expectedReceipt.source, { timeout: 180_000 });
    const waitReceipt = async () => {
      if (!diagnostic) await page.waitForFunction((pattern) => new RegExp(pattern).test(document.querySelector('#render-state')?.textContent ?? ''), spec.expectedReceipt.source, { timeout: 30_000 });
      if (!diagnostic && spec.name === 'mesh') await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('视图已提交'), { timeout: 30_000 });
      await sleep(diagnostic ? 350 : 250);
    };
    const capture = async (caseName, viewport = { width: 1600, height: 900 }) => {
      await page.setViewportSize(viewport);
      await waitReceipt();
      const layout = await assertNoOverlaps(page, viewport, spec.name);
      const bytes = await page.screenshot({ fullPage: true });
      const filename = `${diagnostic ? 'diagnostic-' : ''}${spec.name}-${caseName}.png`;
      writeFileSync(resolve(output, filename), bytes);
      const stats = pixelStats(bytes);
      const canvasFilename = `${diagnostic ? 'diagnostic-' : ''}${spec.name}-${caseName}-canvas.png`;
      const canvasCapture = await captureCanvas(page, { name: `${spec.name} ${caseName}`, path: resolve(output, canvasFilename), assertScene: false });
      const canvasBytes = canvasCapture.bytes;
      const canvasStats = canvasCapture.metrics;
      const renderer = await page.evaluate((includeDetails) => {
        const demo = window.__waterMeshVisualDebug ?? window.__waterInfoVisualDebug;
        if (!demo?.app?.renderer) return { unavailable: 'visual-smoke app handle not attached' };
        if (!includeDetails) {
          const inspection = demo.app.renderer.inspect();
          return { frameId: inspection.frame?.frameId, features: inspection.features, rendererErrors: demo.errors, errorCount: demo.errors.length };
        }
        const seen = new WeakSet();
        const simplify = (value, depth = 0) => {
          if (value === null || typeof value !== 'object') return value;
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (depth >= 9) return `[${value.constructor?.name ?? 'Object'}]`;
          if (Array.isArray(value)) return value.slice(0, 64).map((entry) => simplify(entry, depth + 1));
          const properties = {};
          for (const key of Object.getOwnPropertyNames(value).slice(0, 64)) {
            try { properties[key] = simplify(value[key], depth + 1); } catch { properties[key] = '[unreadable]'; }
          }
          return { type: value.constructor?.name ?? 'Object', properties };
        };
        try {
          const inspection = demo.app.renderer.inspect();
          return { frame: simplify(inspection.frame), capabilities: simplify(inspection.capabilities), features: simplify(inspection.features),
            featureDiagnostics: simplify(inspection.featureDiagnostics), featureHost: simplify(inspection.featureHost),
            rendererErrors: simplify(demo.errors), water: simplify(demo.readWaterState()) };
        } catch (error) { return { inspectError: error instanceof Error ? error.message : String(error) }; }
      }, diagnostic);
      const waterInfoState = spec.name === 'info' ? await readWaterInfoState(page) : undefined;
      const status = await page.locator('#status').textContent();
      const evidence = { case: caseName, screenshot: filename, sha256: createHash('sha256').update(bytes).digest('hex'), viewport, stats, layout,
        canvasScreenshot: canvasFilename, canvasStats, canvasSurface: canvasCapture.surface,
        renderState: await page.locator('#render-state').textContent(), status,
        publicationReady: spec.name !== 'mesh' || status?.startsWith('视图已提交'),
        ...(waterInfoState === undefined ? {} : { waterInfoState }) };
      evidence.renderer = renderer;
      results.push({ app: spec.name, ...evidence });
      if (!diagnostic) {
        if (spec.name === 'mesh') {
          assert(waterPixelsBelow(canvasBytes, 0) > 2_000,
            `${spec.name} ${caseName} has no visible water surface: ${JSON.stringify(canvasStats)}`);
        } else assertScenePixels(canvasStats, `${spec.name} ${caseName}`);
        assert.equal(renderer.errorCount, 0, `${spec.name} renderer errors: ${JSON.stringify(renderer)}`);
        assert.deepEqual(renderer.rendererErrors, [], `${spec.name} renderer errors: ${JSON.stringify(renderer.rendererErrors)}`);
        if (spec.name === 'mesh') assert(evidence.publicationReady, `Mesh has no submitted camera publication: ${status}`);
      }
      return { pageBytes: bytes, canvasBytes, waterInfoState };
    };

    if (spec.name === 'mesh') {
      const ocean = await capture('ocean-desktop');
      const firstIsland = await page.evaluate(async () => {
        const demo = window.__waterMeshVisualDebug;
        demo.app.pause().unwrap();
        document.querySelector('button[data-mode="island"]').click();
        const receipts = [];
        for (let attempt = 0; attempt < 8; attempt++) {
          const capture = await demo.app.rhiCapture.captureFrame({ snapshotTimeoutMs: 120_000 });
          if (!capture.ok) throw new Error(`Island frame capture failed: ${JSON.stringify(capture.error)}`);
          const submitted = capture.value.submittedFrame;
          if (submitted?.status !== 'complete') throw new Error(`Island frame has no complete receipt: ${JSON.stringify(submitted)}`);
          const { presentation, presentationPendingReason } = submitted.receipt;
          const status = document.querySelector('#status')?.textContent ?? '';
          const renderState = document.querySelector('#render-state')?.textContent ?? '';
          receipts.push({ frameId: submitted.receipt.frameId, presentation, pendingReason: presentationPendingReason?.code, status, renderState });
          if (presentation === 'pending') {
            if (status.startsWith('视图已提交') || renderState === 'GPU 帧已提交')
              throw new Error(`Pending Island frame reported as presented: ${JSON.stringify(receipts.at(-1))}`);
            continue;
          }
          if (!status.startsWith('视图已提交') || renderState !== 'GPU 帧已提交')
            throw new Error(`Ready Island frame did not publish the view: ${JSON.stringify(receipts.at(-1))}`);
          const uploaded = await demo.app.rhiCapture.upload(capture.value, { runId: 'water-mesh-first-ready-island-smoke' });
          if (!uploaded.ok) throw new Error(`Island frame upload failed: ${JSON.stringify(uploaded.error)}`);
          return { receipts, tapePath: uploaded.value.path, digest: capture.value.digest };
        }
        throw new Error(`Island view did not become ready after eight frames: ${JSON.stringify(receipts)}`);
      });
      const firstIslandTape = decodeTape(readFileSync(firstIsland.tapePath)).unwrap();
      const firstIslandFrame = buildFrameModel(firstIslandTape);
      const firstIslandMain = firstIslandFrame.passes.find((pass) =>
        firstIslandTape.events[pass.beginEventIndex]?.desc?.label === 'main');
      assert(firstIslandMain, 'First ready Island frame has no main pass');
      const firstIslandWorks = firstIslandMain.workIndices.map((index) => firstIslandFrame.works[index]);
      const firstIslandTerrainDraws = firstIslandWorks.filter((work) => work.kind === 'drawIndexedIndirect').length;
      const firstIslandWaterDraws = firstIslandWorks.filter((work) => work.kind === 'drawIndexed').length;
      assert(firstIslandTerrainDraws > 0, 'First ready Island frame has no terrain draw');
      assert(firstIslandWaterDraws > 0, 'First ready Island frame has no water draw');
      const firstIslandPicture = await capture('island-first-ready-desktop');
      assert(islandClearPixels(firstIslandPicture.canvasBytes) < 50,
        'First ready Island frame exposes clear pixels inside the island footprint');
      await page.evaluate(() => window.__waterMeshVisualDebug.app.resume().unwrap());
      await page.locator('button[data-mode="ocean"]').click(); await waitReceipt();
      results.push({ app: spec.name, checks: { firstIslandPresentation: {
        receipts: firstIsland.receipts, digest: firstIsland.digest,
        terrainDraws: firstIslandTerrainDraws, waterDraws: firstIslandWaterDraws,
      } } });
      const meshState = async () => page.evaluate(() => {
        const state = window.__waterMeshVisualDebug?.readWaterState();
        const instances = state?.meshView?.receipt?.instances ?? [];
        return {
          mode: state?.mode,
          boundBodies: state?.bodies.filter((body) => body.binding.kind === 'bound').map((body) => body.body.type),
          groundProviders: state?.ground?.providers.length ?? 0,
          farInstances: state?.meshView?.receipt?.farInstanceCount,
          lods: [...new Set(instances.filter((tile) => !tile.far).map((tile) => tile.lod0))].sort(),
        };
      });
      const oceanState = await meshState();
      await page.locator('#edge-toggle').check();
      const oceanEdges = await capture('ocean-edges-desktop');
      await page.locator('#edge-toggle').uncheck();
      const modes = {};
      const states = { ocean: oceanState };
      for (const mode of ['river', 'lake', 'island']) {
        await page.locator(`button[data-mode="${mode}"]`).click(); await waitReceipt();
        modes[mode] = await capture(`${mode}-desktop`);
        states[mode] = await meshState();
      }
      const lakeDripPixels = waterPixelsBelow(modes.lake.canvasBytes, 700);
      const islandGapPixels = islandClearPixels(modes.island.canvasBytes);
      if (!diagnostic) assert(lakeDripPixels < 20,
        `Lake surface extends far below its footprint: ${lakeDripPixels} pixels`);
      if (!diagnostic) assert(islandGapPixels < 50,
        `Island ring and lagoon leave ${islandGapPixels} clear pixels inside their footprint`);
      await page.locator('button[data-mode="ocean"]').click(); await waitReceipt();
      await page.locator('#camera-distance').fill('150'); await page.locator('#camera-height').fill('105'); await waitReceipt();
      const farHigh = await capture('ocean-far-high-desktop');
      const farState = await meshState();
      await page.locator('#camera-distance').fill('24'); await page.locator('#camera-height').fill('8'); await waitReceipt();
      const nearLow = await capture('ocean-near-low-desktop');
      const nearState = await meshState();
      const deltaChecks = { riverLakeShoreline: changedPixels(modes.river.canvasBytes, modes.lake.canvasBytes), lakeIsland: changedPixels(modes.lake.canvasBytes, modes.island.canvasBytes),
        cameraNearFar: changedPixels(ocean.canvasBytes, nearLow.canvasBytes), cameraLodMorph: changedPixels(farHigh.canvasBytes, nearLow.canvasBytes),
        edgeOverlay: changedPixels(ocean.canvasBytes, oceanEdges.canvasBytes) };
      if (!diagnostic) {
        assert.equal(oceanState.mode, 'ocean');
        assert.deepEqual(oceanState.boundBodies, ['ocean']);
        assert(oceanState.farInstances > 0, 'Ocean must publish far WaterMesh instances');
        assert.deepEqual(states.river.boundBodies, ['river']);
        assert.deepEqual(states.lake.boundBodies, ['lake']);
        assert.deepEqual(states.island.boundBodies.toSorted(), ['lake', 'ocean']);
        assert.equal(states.island.groundProviders, 1, 'Island terrain must feed WaterInfo ground depth');
        assert(farState.lods.length > 0 && nearState.lods.length > 0, 'Camera controls must retain native LOD tiles');
        assert(deltaChecks.riverLakeShoreline > 0, 'River and Lake shoreline scenes must differ');
        assert(deltaChecks.lakeIsland > 0, 'Island mode must alter the rendered water footprint');
        assert(deltaChecks.cameraNearFar > 0, 'Camera near/far changes must affect rendered pixels');
        assert(deltaChecks.cameraLodMorph > 0, 'Camera LOD/morph views must differ visually');
        assert(deltaChecks.edgeOverlay > 0, 'Tile / LOD overlay must alter the visible page');
      }
      if (!desktopOnly) for (const mode of ['ocean', 'river', 'lake', 'island']) {
        if (mode !== 'ocean') { await page.locator(`button[data-mode="${mode}"]`).click(); await waitReceipt(); }
        await capture(`${mode}-mobile`, { width: 390, height: 844 });
      }
      results.push({ app: spec.name, checks: { modes: states, farState, nearState, deltaChecks, lakeDripPixels, islandGapPixels } });
    } else {
      const rgba16 = await capture('rgba16f-desktop');
      const baselineInfo = rgba16.waterInfoState;
      const waterCenter = projectWorldPoint([32, -0.27, 32], baselineInfo.view, 1600, 900);
      const waterPixels = countPixelsInCircle(rgba16.canvasBytes, waterCenter, 42, (r, g, b) => g > r + 18 && b > r + 20 && g > 45 && b > 50);
      if (!diagnostic) {
        assertWaterInfoPublication(baselineInfo, undefined, 'initial WaterInfo');
        assert.equal(baselineInfo.zone.waterInfo.localTessellation, false, 'WaterInfo starts in shared-zone mode');
        assert.match(await page.locator('#slice').textContent() ?? '', /区域共享视图/);
        assert(waterPixels > 8, `Water surface pixels missing near the authored River center: ${waterPixels}`);
      }
      await page.locator('button[data-format="rgba32f"]').click(); await waitReceipt();
      const rgba32 = await capture('rgba32f-desktop');
      const formatReadout = await page.locator('#generation').textContent();
      if (!diagnostic) {
        assertWaterInfoPublication(rgba32.waterInfoState, baselineInfo, 'format change');
        assert.match(formatReadout ?? '', /rgba32f/);
        assert.equal(rgba32.waterInfoState.zone.waterInfo.format, 'rgba32f');
        assert(submittedFrame(rgba32.waterInfoState) > submittedFrame(baselineInfo), 'Format change must receive a newer submitted frame');
      }
      await page.locator('#blur').fill('12'); await waitReceipt();
      const blurred = await capture('blur-12-desktop');
      if (!diagnostic) {
        assertWaterInfoPublication(blurred.waterInfoState, rgba32.waterInfoState, 'blur change');
        assert.equal(blurred.waterInfoState.zone.waterInfo.blurRadius, 12, 'Blur control must update the WaterInfo target parameter');
        assert(submittedFrame(blurred.waterInfoState) > submittedFrame(rgba32.waterInfoState), 'Blur change must receive a newer submitted frame');
      }
      await page.locator('button[data-terrain="b"]').click(); await waitReceipt();
      const terrainB = await capture('terrain-b-desktop');
      if (!diagnostic) {
        assertTerrainWaterInfoPublication(terrainB.waterInfoState, blurred.waterInfoState, 'Terrain B change');
        assert.notDeepEqual(terrainB.waterInfoState.ground.terrainGuids, blurred.waterInfoState.ground.terrainGuids, 'Terrain B must replace the active WaterInfo provider');
        assert(submittedFrame(terrainB.waterInfoState) > submittedFrame(blurred.waterInfoState), 'Terrain B change must receive a newer submitted frame');
      }
      await page.locator('#local').check(); await waitReceipt();
      const local = await capture('local-desktop');
      const deltaChecks = { terrainAB: changedPixels(blurred.canvasBytes, terrainB.canvasBytes) };
      if (!diagnostic) {
        assertWaterInfoPublication(local.waterInfoState, terrainB.waterInfoState, 'local mode change');
        assert.equal(local.waterInfoState.zone.waterInfo.localTessellation, true, 'Local mode must be set on the WaterInfo target');
        assert.match(await page.locator('#slice').textContent() ?? '', /局部视图/);
        assert(submittedFrame(local.waterInfoState) > submittedFrame(terrainB.waterInfoState), 'Local mode must receive a newer submitted frame');
      }
      if (!diagnostic) {
        assert(deltaChecks.terrainAB > 0, 'Terrain A/B must alter the rendered scene');
      }
      const beforeProbe = await capture('local-before-probe-desktop');
      const canvas = page.locator('#scene');
      const box = await canvas.boundingBox();
      assert(box, 'Water Info canvas missing');
      await page.mouse.click(box.x + box.width * 0.78, box.y + box.height * 0.48);
      if (!diagnostic) await page.waitForFunction(() => !document.querySelector('#probe-texel')?.textContent?.includes('—'), { timeout: 10_000 });
      const probe = await page.locator('#probe-state').textContent();
      const probeDesktop = await capture('local-probe-desktop');
      const probeBeforeXZ = beforeProbe.waterInfoState.probe.worldXZ;
      const probeAfterXZ = probeDesktop.waterInfoState.probe.worldXZ;
      const markerScreen = projectWorldPoint([probeAfterXZ[0], probeDesktop.waterInfoState.probe.markerY, probeAfterXZ[1]], probeDesktop.waterInfoState.view, 1600, 900);
      const markerPixels = countPixelsInCircle(probeDesktop.canvasBytes, markerScreen, 16, (r, g, b) => r > 150 && g > 85 && r > g * 1.1 && g > b * 1.15);
      const probeDelta = changedPixels(beforeProbe.canvasBytes, probeDesktop.canvasBytes);
      if (!diagnostic) {
        assert.match(probe ?? '', /世界坐标/);
        assert(Math.hypot(probeAfterXZ[0] - probeBeforeXZ[0], probeAfterXZ[1] - probeBeforeXZ[1]) > 1, 'Scene click must move the world probe');
        assert(submittedFrame(probeDesktop.waterInfoState) > submittedFrame(beforeProbe.waterInfoState), 'Probe movement must receive a newer submitted frame');
        assert(markerPixels > 0, `Probe marker pixels missing at projected world position: ${JSON.stringify({ markerScreen, markerPixels })}`);
        assert(probeDelta > 0, 'Probe interaction must change the visible scene canvas');
      }
      if (!desktopOnly) await capture('local-probe-mobile', { width: 390, height: 844 });
      results.push({ app: spec.name, checks: {
        formats16f32f: true,
        blur: { value: blurred.waterInfoState.zone.waterInfo.blurRadius, receiptFrame: submittedFrame(blurred.waterInfoState) },
        terrainAB: { deltaPixels: deltaChecks.terrainAB, providerGuids: terrainB.waterInfoState.ground.terrainGuids },
        localView: { enabled: local.waterInfoState.zone.waterInfo.localTessellation, slice: await page.locator('#slice').textContent(), receiptFrame: submittedFrame(local.waterInfoState) },
        waterSurface: { center: waterCenter, matchingPixels: waterPixels },
        probe: { text: probe, worldXZ: probeAfterXZ, markerScreen, markerPixels, deltaPixels: probeDelta },
      } });
    }
    results.push({ app: spec.name, browserErrors: errors });
    await page.close();
  }
  writeFileSync(resolve(output, `${diagnostic ? `visual-smoke-${appFilter ?? 'all'}-diagnostic` : 'visual-smoke-evidence'}.json`), JSON.stringify({ urls: { mesh: meshUrl, info: infoUrl }, browser: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', sandboxed: true }, diagnostic, appFilter, results }, null, 2));
  console.log(JSON.stringify({ urls: { mesh: meshUrl, info: infoUrl }, results }, null, 2));
} catch (error) {
  writeFileSync(resolve(output, 'visual-smoke-failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, failures }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
}
