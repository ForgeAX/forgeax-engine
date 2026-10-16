import { browserProofWorkload } from './browser-proof-workload.mjs';
import { verifyInlinePreviews } from './verify-inline-previews.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { chromium } from 'playwright';
import { connectViewWorkspace } from '../packages/view-workspace-core/src/resident.ts';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
import { VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID } from '../dist/modules/workspace/contract.mjs';
import { verifyEditorPlay, verifyEditorPlayFailure } from './verify-editor-play.mjs';
import { verifyRuntimeCapture } from './verify-runtime-capture.mjs';
import { verifyPagePlugins } from './verify-page-plugins.mjs';
import { writeProofGameAssets } from './fixtures/plugin-assets.mjs';
import { savePreviewRhiEvidence } from './preview-rhi-evidence.mjs';

// Use the same installed SDK graph as View, including its prepared shader inputs.
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const view = resolve(import.meta.dirname, '..');
const evidence = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(view, 'artifacts/plugin-boundary'));
const root = await mkdtemp(join(tmpdir(), 'view-plugin-boundary-'));
const viewCandidate = await mkdtemp(join(tmpdir(), 'view-plugin-candidate-'));
const errors = [];
const workload = browserProofWorkload();
let browser;
let browserServer;
let page;
let live;
let startedRun;
const run = async (operation, args = []) => {
  const result = await runUnifiedCli(['engine', 'run', ...operation.split('.'), '--root', root, '--json', ...args]);
  if (!result.ok) {
    const status = await runUnifiedCli(['engine', 'run', 'status', '--root', root, '--json']);
    console.error('Engine run failure status', JSON.stringify(status));
    const logPath = status.value?.error?.match(/inspect (.+\/dev\.log)$/)?.[1];
    if (logPath) {
      const log = await readFile(logPath, 'utf8').catch(() => '');
      console.error('Engine run failure log', log.slice(-16_384).replace(/((?:https?|wss?):\/\/[^\s?#]+)\?[^\s]+/g, '$1?<redacted>'));
    }
    const observed = await runUnifiedCli(['engine', 'run', 'observe', '--root', root, '--json']);
    console.error('Engine run failure observation', JSON.stringify(observed, (key, value) => key === 'png' ? '<image>' : value));
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const playOnly = process.env.FORGEAX_PROBE_PLAY_ONLY === '1';
const sameRun = async () => {
  if (playOnly) return;
  const current = await run('status');
  for (const key of ['runId', 'inputVersion', 'revision', 'worldIdentity']) assert.equal(current[key], startedRun[key], key);
  assert.equal(current.phase, 'ready');
  return current;
};
const previousStateFile = process.env.FORGEAX_VIEW_STATE_FILE;
const previousEvidenceDir = process.env.FORGEAX_EVIDENCE_DIR;
const previousPreviewRhiWindow = process.env.FORGEAX_PREVIEW_RHI_WINDOW;
process.env.FORGEAX_EVIDENCE_DIR = evidence;
process.env.FORGEAX_PREVIEW_RHI_WINDOW = '1';
// This independent-run image probe qualifies fixed DOM/Shadow DOM pixels and
// natural-size presentation at 1280x720, including after reload and View loss.
// Keep that contract explicit when the ordinary CI capture default is smaller.
if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') {
  process.env.FORGEAX_BROWSER_CI_VIEWPORT_WIDTH = '1280';
  process.env.FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT = '720';
}
try {
  await mkdir(evidence, { recursive: true });
  console.error('Engine SDK', engine);
  await mkdir(join(root, 'assets'), { recursive: true });
  await cp(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await cp(join(view, 'scripts/fixtures/workspace-proof.plugin.ts'), join(root, 'assets/game.plugin.ts'));
  await cp(join(view, 'scripts/fixtures/runtime-capture-ui.plugin.ts'), join(root, 'assets/ui.plugin.ts'));
  await writeFile(join(root, 'snapshot-proof.txt'), 'before start');
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'dir');
  for (const file of ['dist', 'package.json', 'README.md', 'host.pack.json']) await cp(join(view, file), join(viewCandidate, file), { recursive: true });
  await symlink(join(view, 'node_modules'), join(viewCandidate, 'node_modules'), 'dir');
  await symlink(viewCandidate, join(root, 'node_modules/@forgeax/view'), 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-plugin-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  const roots = await writeProofGameAssets(root, { ui: true });
  await writeFile(join(root, 'forge.json'), JSON.stringify({
    id: 'view-plugin-proof', name: 'Plugin boundary proof', schemaVersion: '3.0.0', roots,
  }));
  process.env.FORGEAX_VIEW_STATE_FILE = join(root, 'view-owner.json');
  if (!playOnly) {
  const startupStarted = performance.now();
  startedRun = await run('start', ['--headless', 'true', '--backend', 'software']);
  assert.equal(startedRun.carrier, 'private-browser');
  assert.match(startedRun.inputVersion, /^sha256:/);
  console.error('AI started before View', startedRun.runId, 'startupMs', Math.round(performance.now() - startupStarted));
  await writeFile(join(root, 'snapshot-proof.txt'), 'edited after start');
  assert.equal((await run('start', ['--headless', 'true', '--backend', 'software'])).runId, startedRun.runId);
  await sameRun();
  }
  if (!playOnly && process.env.FORGEAX_PROBE_LIBRARY_ONLY !== '1') {
  const backend = await runUnifiedCli(['backend', 'start', '--host-pack', join(viewCandidate, 'host.pack.json'), '--root', root, '--json']);
  assert.equal(backend.ok, true, JSON.stringify(backend));
  const help = await runUnifiedCli(['help', 'view', 'start', '--root', root, '--json']);
  assert.equal(help.ok, true, JSON.stringify(help));
  const status = await runUnifiedCli(['view', 'status', '--root', root, '--json']);
  assert.equal(status.value.phase, 'stopped', JSON.stringify(status));
  const started = await runUnifiedCli(['view', 'start', '--root', root, '--json']);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.value.phase, 'ready');
  const resident = await runUnifiedCli(['view', 'status', '--root', root, '--json']);
  assert.equal(resident.value.phase, 'ready');
  assert.equal('connection' in resident.value, false);
  assert.equal(new URL(resident.value.url).search, '');
  const bootstrap = await fetch(`${resident.value.url}/__forgeax/view/bootstrap`).then(response => response.json());
  const observer = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'empty-observer-proof' });
  try {
    assert.equal((await observer.getState()).project ?? null, null);
    await observer.call('display.bind', { root, runId: startedRun.runId });
    const deadline = Date.now() + 30_000;
    let observed;
    do {
      observed = await observer.call('display.status');
      if (observed.observation?.image?.png) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    assert.equal(observed.observation?.status.runId, startedRun.runId);
    assert.match(observed.observation?.image?.png ?? '', /^data:image\/png/);
    assert.equal((await observer.getState()).project ?? null, null);
    console.error('independent AI screenshot observed with no Editor project or View browser');
  } finally { observer.close('empty observation complete'); }
  const stopped = await runUnifiedCli(['view', 'stop', '--root', root, '--json']);
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const finalStatus = await runUnifiedCli(['view', 'status', '--root', root, '--json']);
  assert.equal(finalStatus.value.phase, 'stopped');
  assert.equal((await runUnifiedCli(['backend', 'status', '--root', root, '--json'])).value.phase, 'ready');
  assert.equal((await runUnifiedCli(['backend', 'stop', '--root', root, '--json'])).ok, true);
  const exitDeadline = Date.now() + 5000;
  const backendAlive = () => {
    try { process.kill(backend.value.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  while (backendAlive() && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(backendAlive(), false, 'backend stop must terminate its owned process after disposal');
  console.error('native CLI start/status/stop passed');
  }
  browserServer = await chromium.launchServer({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    ...(process.env.FORGEAX_CHROME_CHANNEL ? { channel: process.env.FORGEAX_CHROME_CHANNEL } : {}),
    headless: false,
    args: [
      '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader', '--use-angle=swiftshader',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    ],
    chromiumSandbox: true,
  });
  browserServer.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage({ viewport: workload.gameViewport });
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGE', error.message); });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error('CONSOLE', message.text(), { source: message.location().url?.split('?')[0] });
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      console.error('HTTP failure', { status: response.status(), path: new URL(response.url()).pathname,
        frame: response.request().frame().url().split('?')[0] });
    }
  });
  const progress = setInterval(() => console.error('waiting for workspace document'), 10_000);
  progress.unref();
  // Engine serializes target commands behind cold preview initialization. Give
  // queued queries the same bounded budget as startup under software rendering.
  live = await startViewLiveIntegration({ page, projectRoot: root, config: {
    readyTimeout: 120_000,
    workspace: { readyTimeoutMs: Number(process.env.FORGEAX_PROBE_READY_TIMEOUT ?? 120_000) },
  } });
  clearInterval(progress);
  assert.equal(live.hostBinding.backend, live.backendHost);
  const state = live.workspaceCore.snapshot();
  const pageWorkspace = () => live.pageWorkspace;
  const assets = await live.workspaceCore.listAssets({ projectId: state.project.id, tabId: VIEW_WORKSPACE_TAB_ID });
  assert.ok(assets);
  for (const asset of assets.assets) {
    const result = await live.workspaceCore.inspectAsset({ projectId: state.project.id, guid: asset.guid, tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal(result.inspection.guid, asset.guid);
    assert.equal(result.inspection.asset.kind, asset.kind);
  }
  console.error('all catalog assets inspect through the active Engine session', assets.assets.length);
  const scene = assets.assets.find((asset) => asset.kind === 'scene');
  assert.ok(scene, 'the fixture must expose a real cooked scene');
  const contentBrowser = page.locator('[data-forgeax-view="content-browser-root"]');
  await page.waitForFunction(name => document.querySelector('[data-forgeax-view="content-browser-root"]')?.textContent.includes(name), state.project.name);
  if (!(await contentBrowser.isVisible())) {
    await page.locator('.fx-view-workspace-row.is-active .dv-groupview-edge .dv-tab')
      .filter({ hasText: /^Content Browser$/ }).click();
  }
  await contentBrowser.waitFor({ state: 'visible' });
  assert.ok(!(await contentBrowser.textContent()).includes('47 game'), 'live panels must not display the demo project');
  await contentBrowser.locator('.cb-address-crumb button').getByText(state.project.name, { exact: true }).click();
  await contentBrowser.locator('.cb-grid-folder').filter({ hasText: /^assets$/ }).dblclick();
  const search = contentBrowser.locator('input[data-action="content-browser.search"]');
  await search.fill('scene');
  const sceneName = (scene.sourcePath ?? scene.path ?? '').toLowerCase().endsWith('.pack.ts')
    ? scene.sourceKey ?? scene.name ?? scene.label ?? scene.guid
    : scene.name ?? scene.label ?? scene.guid;
  const sceneItem = contentBrowser.locator('.cb-grid-item').getByText(sceneName, { exact: true });
  await sceneItem.click();
  const inspectDeadline = Date.now() + 30_000;
  while (pageWorkspace().snapshot().inspection?.guid !== scene.guid && Date.now() < inspectDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await contentBrowser.locator('[role="alert"]').count(), 0, await contentBrowser.textContent());
  assert.equal(pageWorkspace().snapshot().inspection.guid, scene.guid);
  assert.equal(pageWorkspace().snapshot().inspection.asset.kind, 'scene');
  assert.equal(await page.locator('[data-testid="insp-empty"]').count(), 1, 'object inspector must not mirror content-browser asset selection');
  await page.getByText('Scene tree unavailable', { exact: true }).waitFor();
  await contentBrowser.locator('[data-action="content-browser.refresh"]').click();
  await sceneItem.dblclick();
  const previewDeadline = Date.now() + 60_000;
  while (pageWorkspace().snapshot().preview?.asset?.guid !== scene.guid && Date.now() < previewDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await page.locator('.fx-page-tab-btn--new').click();
  await page.getByRole('menuitem', { name: 'Asset', exact: true }).click();
  await page.getByTestId('panel-asset-properties').waitFor();
  const editorBeforeRefocus = pageWorkspace().snapshot().editorPreview;
  const editorCanvas = await page.locator('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas').elementHandle();
  assert.ok(editorCanvas, 'the Editor owns its original Engine canvas');
  const refocused = await pageWorkspace().openAsset({ projectId: state.project.id, guid: scene.guid, tabId: VIEW_WORKSPACE_TAB_ID });
  await page.locator('[data-page-id="page-editor"][aria-selected="true"]').waitFor();
  const repeatedScene = refocused.editorPreview;
  assert.equal(repeatedScene.asset.kind, 'scene');
  assert.equal(repeatedScene.asset.guid, scene.guid);
  assert.equal(refocused.preview.target.targetId, repeatedScene.target.targetId, 'asset.open binds the exact opened scene as Editor');
  assert.equal(refocused.openRequest.preview, undefined, 'Scenes must not be published as asset-tab previews');
  assert.equal(await page.locator('[data-page-id="page-scene"]').count(), 0, 'Scene opens focus the existing Editor page');
  assert.equal(repeatedScene.target.targetId, editorBeforeRefocus.target.targetId);
  const opened = pageWorkspace().snapshot();
  assert.equal(opened.editorPreview.target.targetId, editorBeforeRefocus.target.targetId);
  assert.equal(opened.editorPreview.target.worldId, editorBeforeRefocus.target.worldId);
  assert.equal(await editorCanvas.evaluate(canvas => canvas === document.querySelector('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas')), true, 'closing the repeated scene preserves the original Editor owner canvas');
  await editorCanvas.dispose();
  assert.equal(opened.preview?.asset?.guid, scene.guid, 'UI activation must open the exact Engine asset');
  assert.equal(await contentBrowser.locator('[role="alert"]').count(), 0);
  console.error('live catalog navigation, search, selection, inspection, refresh and scene activation passed');
  const targetId = opened.preview.target.targetId;
  const targetGeneration = opened.preview.target.generation;
  assert.equal(await page.locator('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas').count(), 1);
  assert.equal(await page.locator('canvas:visible').count(), 1, 'only the Editor canvas may be visible');
  assert.equal(page.frames().filter((frame) => frame.url() === page.url()).length, 1);
  console.error('native shared Host, asset discovery and exact single surface passed');
  const tree = await live.workspaceCore.getSceneTree({ targetId, targetGeneration });
  assert.ok(tree.nodes.length > 0, 'the tools plugin exposes the real World');
  assert.equal(tree.worldId, opened.preview.target.worldId);
  const entity = tree.nodes.find(node => node.name !== null) ?? tree.nodes[0];
  await pageWorkspace().selectSceneEntity({ targetId, targetGeneration, entityId: entity.entityId });
  await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.getAttribute('data-entity-id') === id, entity.entityId);
  assert.ok((await live.workspaceCore.invoke('entity.inspect', { targetId, targetGeneration, entityId: entity.entityId })).components.length > 0);
  await assert.rejects(pageWorkspace().selectSceneEntity({ targetId, targetGeneration, entityId: 'another-world:0' }));
  assert.equal(pageWorkspace().snapshot().sceneSelection.primary.entityId, entity.entityId);
  console.error('real hierarchy, target-scoped selection and component inspector passed');
  const meshEntity = tree.nodes.find(node => node.componentNames.includes('MeshFilter') && !node.componentNames.includes('Skin'));
  assert.ok(meshEntity, 'the proof scene must contain an ordinary mesh entity');
  await pageWorkspace().selectSceneEntity({ targetId, targetGeneration, entityId: meshEntity.entityId });
  const meshInspector = page.getByTestId('insp-entity-body');
  await meshInspector.waitFor();
  const meshInspection = await live.workspaceCore.invoke('entity.inspect', { targetId, targetGeneration, entityId: meshEntity.entityId });
  await meshInspector.getByTestId('insp-component-list').waitFor();
  assert.equal(await meshInspector.getByTestId('insp-component-list').locator('button').count(), meshInspection.components.length);
  assert.equal(await meshInspector.getByTestId('insp-group-common').getAttribute('aria-checked'), 'true');
  assert.deepEqual(await meshInspector.locator('.insp-detail-section').evaluateAll(sections =>
    sections.map(section => section.getAttribute('data-testid'))), ['insp-section-Transform', 'insp-section-mesh', 'insp-section-materials']);
  const sceneSelection = pageWorkspace().snapshot().sceneSelection;
  await meshInspector.getByTestId('insp-comprow-MeshFilter').click();
  assert.equal(await meshInspector.getAttribute('data-group'), 'all');
  assert.equal(await meshInspector.getByTestId('insp-comprow-MeshFilter').getAttribute('aria-current'), 'location');
  assert.deepEqual(pageWorkspace().snapshot().sceneSelection, sceneSelection);
  for (const component of meshInspection.components) {
    await meshInspector.getByTestId(`insp-comprow-${component.name}`).waitFor();
    await meshInspector.getByTestId(`insp-section-${component.name}`).waitFor();
  }
  await meshInspector.getByTestId('insp-group-common').click();
  const filterValues = meshInspection.components.find(component => component.name === 'MeshFilter').values;
  assert.equal(typeof filterValues.assetHandle, 'number');
  const meshReference = meshInspector.getByTestId('insp-section-mesh');
  const meshAsset = assets.assets.find(asset => asset.kind === 'mesh' && asset.sourceKey === 'mesh/box');
  assert.ok(meshAsset, 'The fixture mesh has a registered asset identity');
  await meshReference.getByText(meshAsset.sourceKey, { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="insp-section-mesh"] [data-testid="asset-reference-open"]')?.disabled);
  await page.screenshot({ path: join(evidence, 'mesh-inspector.png') });
  await meshInspector.getByTestId('insp-group-all').click();
  for (const component of meshInspection.components) await meshInspector.getByTestId(`insp-section-${component.name}`).waitFor();
  await meshInspector.getByTestId('insp-field-MeshFilter-assetHandle').waitFor();
  await meshInspector.getByTestId('insp-group-common').click();
  assert.equal(pageWorkspace().snapshot().editorPreview.target.targetId, targetId);
  await sameRun();
  console.error('real read-only mesh references and component Inspector passed without Engine changes');
  const closeInlinePreviews = process.env.FORGEAX_PROBE_MULTI_PREVIEWS === '0' ? async () => {} : await verifyInlinePreviews({ page, workspace: pageWorkspace(),
    onCaptureFailure: async ({ target, error }) => {
      const observation = await page.evaluate(targetId => {
        const canvas = [...document.querySelectorAll('canvas[data-forgeax-asset-preview]')]
          .find(candidate => candidate.dataset.forgeaxAssetPreview === targetId);
        const encoded = canvas?.dataset.forgeaxPreviewRhiWindow;
        if (encoded === undefined || encoded.length > 65_536) return undefined;
        try { return JSON.parse(encoded); } catch { return undefined; }
      }, target.targetId).catch(() => undefined);
      await savePreviewRhiEvidence({ target, observation, evidence,
        captureRoot: process.env.FORGEAX_ENGINE_RHI_DEBUG === '1' ? root : evidence });
      await writeFile(join(evidence, 'failure-preview-capture.json'), JSON.stringify({ target,
        error: { name: error.name, message: error.message, code: error.code, detail: error.detail } }, null, 2));
    },
  });
  await verifyEditorPlay({ page, live, root, sameRun, cycles: Number(process.env.FORGEAX_PLAY_CYCLES ?? 10) });
  await verifyEditorPlayFailure({ page, live, sameRun });
  await closeInlinePreviews();
  assert.deepEqual(errors, [], 'combined target use and disposal must not emit browser errors');

  if (playOnly) console.log(JSON.stringify({ passed: true, boundary: 'editor-play', cycles: Number(process.env.FORGEAX_PLAY_CYCLES ?? 10) }));
  else {
  const frameProgress = setInterval(() => { void page.evaluate(() => ({ frame: document.documentElement.dataset.forgeaxFrameSubmitted, error: document.querySelector('#forgeax-fatal-details')?.textContent })).then(value => console.error('preview progress', JSON.stringify(value))).catch(() => {}); }, 10_000);
  frameProgress.unref();
  try { await page.waitForFunction(() => Number(document.documentElement.dataset.forgeaxFrameSubmitted ?? 0) >= 60 || !!document.querySelector('#forgeax-fatal-details')?.textContent, undefined, { timeout: 180_000 }); } finally { clearInterval(frameProgress); }
  assert.equal(await page.evaluate(() => document.querySelector('#forgeax-fatal-details')?.textContent || ''), '', 'the renderer must stay healthy');
  const camera = await live.workspaceCore.getCamera({ tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration });
  assert.ok(camera);
  const capture = await live.workspaceCore.capture({ tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration });
  assert.ok(capture);
  await writeFile('/tmp/view-plugin-frame.png', Buffer.from(capture.png.split(',')[1], 'base64'));
  const pixelRange = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let minimum = 255;
      let maximum = 0;
      for (let index = 0; index < data.length; index += 4) {
        const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
        minimum = Math.min(minimum, luminance);
        maximum = Math.max(maximum, luminance);
      }
      return maximum - minimum;
    } finally { bitmap.close(); }
  }, capture.png);
  console.error('captured pixel luminance range', pixelRange);
  console.error('renderer', JSON.stringify(await page.evaluate(() => globalThis.__forgeaxGameInspection.renderer())));
  console.error('capture errors', JSON.stringify(capture.errors?.slice(0, 1)));
  assert.deepEqual(capture.errors ?? [], [], 'capture must contain no renderer errors');
  assert.ok(pixelRange > 5, 'the fixture preview must not be a flat image');
  if (process.env.FORGEAX_ENGINE_RHI_DEBUG === '1') {
    const tape = await page.evaluate(async () => {
      const result = await globalThis.__forgeax.captureFrame();
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return { digest: result.value.digest, bytes: Array.from(result.value.bytes) };
    });
    await writeFile('/tmp/view-plugin-frame.rhitape', Buffer.from(tape.bytes));
    const { decodeTape, buildFrameModel } = await import('@forgeax/engine/rhi-debug');
    const decoded = decodeTape(new Uint8Array(tape.bytes));
    assert.equal(decoded.ok, true);
    console.error('RHI', JSON.stringify({ digest: tape.digest, works: buildFrameModel(decoded.value.tape).works.length }));
  }
  await page.screenshot({ path: '/tmp/view-plugin-boundary.png' });
  // The UI-removal proof closed this page without owning the Engine target.
  // Reopening it after target disposal must fail closed, without a new canvas.
  await page.locator('.fx-page-tab-btn--new').click();
  await page.getByRole('menuitem', { name: 'Material', exact: true }).click();
  await page.getByTestId('panel-material-preview').getByText('Material preview unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('panel-material-preview').locator('canvas').count(), 0);
  await page.locator('[data-page-id="page-editor"]').click();
  // Page activation restores the panel before ResizeObserver fits its surface.
  // Wait for the observable layout condition, not a fixed rendering delay.
  const fittedViewport = await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas');
    const host = document.querySelector('[data-forgeax-view-mount-host="viewport"]');
    if (!canvas || !host) return false;
    const frame = host.getBoundingClientRect();
    const content = canvas.getBoundingClientRect();
    return content.width > 0 && content.height > 0 &&
      content.left >= frame.left - 1 && content.top >= frame.top - 1 &&
      content.right <= frame.right + 1 && content.bottom <= frame.bottom + 1 &&
      { frame: frame.toJSON(), content: content.toJSON() };
  }, undefined, { timeout: 5000 });
  console.error('whole target fits the product viewport', JSON.stringify(await fittedViewport.jsonValue()));
  await fittedViewport.dispose();
  assert.equal(await page.locator('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas').count(), 1);
  assert.equal(await page.locator('canvas:visible').count(), 1, 'only the Editor canvas may be visible');
  assert.equal(await page.locator('.fx-view-app[data-forgeax-view="shell"]').count(), 1);
  assert.equal(page.frames().filter((frame) => frame.url() === page.url()).length, 1);
  assert.deepEqual(errors, []);
  const client = live.backendHost.transport.connect({ kind: 'cli', sourceId: 'joint-proof' });
  const call = (operation, args = {}) => client.request('engine.workspace.call', { operation, args });
  try {
    const target = { targetId, targetGeneration };
    const beforeCamera = await call('engine.camera.get', target);
    const { frameId: beforeCameraFrame, ...beforeRunCamera } = await run('camera.get');
    const interaction = { ...target, interactionId: 'combined-camera-proof' };
    await call('engine.camera.begin', { ...interaction, baseVersion: beforeCamera.version });
    await call('engine.camera.update', { ...interaction, camera: { position: [1, 0, 6], target: [0, 0, 0] } });
    await assert.rejects(call('engine.preview.capture', target), /busy/);
    const commit = { ...interaction, operationId: 'combined-camera-commit', expectedVersion: beforeCamera.version };
    const committed = await call('engine.camera.commit', commit);
    assert.equal(committed.version, beforeCamera.version + 1);
    assert.deepEqual(await call('engine.camera.commit', commit), committed, 'commit retries must be idempotent');
    await assert.rejects(call('engine.camera.begin', { ...interaction, baseVersion: beforeCamera.version }), /conflict/);
    const { frameId: afterCameraFrame, ...afterRunCamera } = await run('camera.get');
    assert.ok(afterCameraFrame >= beforeCameraFrame);
    assert.deepEqual(afterRunCamera, beforeRunCamera, 'Editor camera must not change the AI camera');
    const abandoned = live.backendHost.transport.connect({ kind: 'cli', sourceId: 'disconnect-proof' });
    await abandoned.request('engine.workspace.call', { operation: 'engine.camera.begin', args: { ...target, interactionId: 'abandoned-camera', baseVersion: committed.version } });
    abandoned.close();
    const releaseDeadline = Date.now() + 5000;
    while (!(await call('engine.camera.get', target)).committed && Date.now() < releaseDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await call('engine.camera.get', target)).committed, true, 'disconnect must revoke the camera draft');
    assert.equal((await call('engine.preview.capture', target)).width, capture.width);
    console.error('camera draft, busy capture, idempotent commit, stale version and disconnect recovery passed');
    for (const operation of ['start', 'stop', 'reload', 'eval', 'capture', 'camera.set']) {
      await assert.rejects(call(`engine.run.${operation}`, { root }));
    }
    // Editor and AI use independent render loops; Editor progress cannot prove
    // that the AI has submitted the required frames.
    const frameDeadline = Date.now() + 180_000;
    let aiProgress = await sameRun();
    while (aiProgress.frameId < 300 && Date.now() < frameDeadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      aiProgress = await sameRun();
    }
    assert.ok(aiProgress.frameId >= 300, JSON.stringify(aiProgress));
    console.error('independent AI frame barrier passed', aiProgress.frameId);
    assert.equal(await page.locator('iframe[data-forgeax-view-display-owner="frontend-fiber"]').count(), 0);
    assert.equal(await page.locator('section[data-forgeax-view-surface="run-observer"]').count(), 1);
    const updateUi = async revision => {
      await run('eval', ['--revision', startedRun.revision, '--code', `globalThis.__runtimeCaptureProof = ${revision}`]);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const applied = await run('eval', ['--revision', startedRun.revision, '--code', 'globalThis.__runtimeCaptureProofApplied ?? 0']);
        if (applied.result === revision) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('The frontend fixture did not apply the Engine-owned capture state');
    };
    await updateUi(1);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'continuous-editor-input';
      input.style.cssText = 'position:fixed;top:60px;right:20px;z-index:999999';
      document.body.append(input);
      input.focus();
      globalThis.inputProof = { samples: 0, hidden: 0, blurred: 0 };
      globalThis.inputProofTimer = setInterval(() => {
        const proof = globalThis.inputProof;
        proof.samples++;
        if (document.activeElement !== input) proof.blurred++;
        let node = input;
        while (node) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') { proof.hidden++; break; }
          node = node.parentElement;
        }
      }, 16);
    });
    const typing = page.keyboard.type('editor-input-remains-uninterrupted', { delay: 100 });
    const runCapture = await run('capture', ['--revision', startedRun.revision, '--require-ui', 'true']);
    await typing;
    assert.equal(runCapture.pixels.rendered, true);
    assert.equal(runCapture.pixels.width, 1280, 'Independent image probe must retain its qualified width');
    assert.equal(runCapture.pixels.height, 720, 'Independent image probe must retain its qualified height');
    assert.ok(runCapture.frameId >= 300);
    const finalPixels = await page.evaluate(async uri => {
      const bitmap = await createImageBitmap(await (await fetch(uri)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return [Array.from(context.getImageData(50, 60, 1, 1).data), Array.from(context.getImageData(50, 160, 1, 1).data)];
    }, `data:image/png;base64,${(await readFile(runCapture.screenshot.uri)).toString('base64')}`);
    assert.deepEqual(finalPixels, [[255, 0, 255, 255], [0, 255, 255, 255]]);
    assert.deepEqual(runCapture.errors, { console: 0, page: 0 });
    await cp(runCapture.screenshot.uri, '/tmp/view-plugin-ai-frame.png');
    const proof = await page.evaluate(() => {
      clearInterval(globalThis.inputProofTimer);
      return { ...globalThis.inputProof, value: document.querySelector('#continuous-editor-input').value };
    });
    assert.ok(proof.samples > 10);
    assert.equal(proof.hidden, 0);
    if (process.env.FORGEAX_PROBE_SKIP_NATIVE_WINDOW !== '1') assert.equal(proof.blurred, 0);
    assert.equal(proof.value, 'editor-input-remains-uninterrupted');
    await writeFile('/tmp/view-independent-input-proof.json', JSON.stringify(proof, null, 2));
    await page.locator('#continuous-editor-input').evaluate(input => input.remove());
    await verifyRuntimeCapture({ page, root, runId: startedRun.runId, sameRun,
      updateImage: () => updateUi(2),
      bindExact: args => live.pageWorkspace.invoke('display.bind', args),
    });
    const observer = await call('engine.run.observe', { root });
    assert.equal(observer.status.runId, startedRun.runId);
    assert.equal('endpoint' in observer.status, false);
    assert.equal('url' in observer.status, false);
    const nativeWindows = async mode => {
      const result = await promisify(execFile)('python3', [join(view, 'scripts/native-window-proof.py'), mode]);
      const windows = JSON.parse(result.stdout);
      assert.ok(windows.length > 0, 'the headed View must have a real X11 window');
      return windows;
    };
    if (process.env.FORGEAX_PROBE_SKIP_NATIVE_WINDOW !== '1') {
      const beforeBackground = await sameRun();
      await nativeWindows('hide');
      try {
        // Status is sampled by the Engine image producer; its next revision also
        // includes capture latency, so a fixed sleep is not a readiness barrier.
        const deadline = Date.now() + 30000;
        let background = await sameRun();
        while (background.frameId <= beforeBackground.frameId && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          background = await sameRun();
        }
        assert.ok(background.frameId > beforeBackground.frameId, JSON.stringify({ beforeBackground, background }));
        const hiddenCapture = await run('capture', ['--revision', startedRun.revision, '--require-ui', 'true']);
        assert.deepEqual(hiddenCapture.errors, { console: 0, page: 0 });
        assert.equal(hiddenCapture.pixels.rendered, true);
      } finally { await nativeWindows('show'); }
    }
    console.error('read-only observer, tab/resize isolation and uninterrupted Editor input passed', proof);

    await verifyPagePlugins({ page, backendHost: live.backendHost });
    await sameRun();
    assert.ok((await call('engine.assets.list', { projectId: state.project.id })).assets.length);
    const afterPageChecks = await call('engine.preview.capture', { targetId, targetGeneration });
    assert.ok(afterPageChecks.width > 0 && afterPageChecks.height > 0);
    assert.equal((await live.workspaceCore.getSceneTree({ targetId, targetGeneration })).worldId, tree.worldId);
    await sameRun();
    assert.equal(await page.locator('.fx-view-run-observer').count(), 1);
    console.error('page tab removal leaves Engine domain operations and preview callable');
  } finally { client.close(); }
  const refreshClient = live.backendHost.transport.connect({ kind: 'cli', sourceId: 'browser-refresh-proof' });
  try {
    const readWorkspace = () => refreshClient.request('engine.workspace.call', { operation: 'engine.workspace.get' });
    const beforeRefresh = await readWorkspace();
    await page.reload();
    const refreshedAssets = await refreshClient.request('engine.workspace.call', {
      operation: 'engine.assets.list', args: { projectId: beforeRefresh.project.id },
    });
    assert.ok(refreshedAssets.assets.length);
    const afterRefresh = await readWorkspace();
    assert.equal(afterRefresh.projectPhase, 'running');
    assert.equal(afterRefresh.project.id, beforeRefresh.project.id);
    for (const key of ['targetId', 'sessionId'])
      assert.equal(afterRefresh.projectTarget[key], beforeRefresh.projectTarget[key], key);
    assert.equal(afterRefresh.browserGeneration, beforeRefresh.browserGeneration + 1);
    await sameRun();
    console.error('refresh retains the exact project server and reattaches one new browser generation');
  } finally { refreshClient.close(); }
  await live.dispose();
  await live.dispose();
  await sameRun();
  live = undefined;
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), 'about:blank');
  assert.equal(browser.isConnected(), true);
  console.error('borrowed Page/browser survive repeated integration disposal');
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 60_000, ...(process.env.FORGEAX_PROBE_READY_TIMEOUT ? { workspace: { readyTimeoutMs: Number(process.env.FORGEAX_PROBE_READY_TIMEOUT) } } : {}) } });
  await sameRun();
  const lossClient = live.backendHost.transport.connect({ kind: 'cli', sourceId: 'browser-loss-proof' });
  try {
    assert.deepEqual(errors, [], 'ordinary workspace use must remain free of browser errors before the intentional process kill');
    const lossProject = live.workspaceCore.snapshot().project;
    const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
    browserServer.process().kill('SIGKILL');
    await disconnected;
    await sameRun();
    const afterClose = await run('capture', ['--revision', startedRun.revision, '--require-ui', 'true']);
    assert.deepEqual(afterClose.errors, { console: 0, page: 0 });
    assert.equal(afterClose.pixels.width, 1280);
    assert.equal(afterClose.pixels.height, 720);
    const detached = await lossClient.request('engine.workspace.call', { operation: 'engine.workspace.get' });
    assert.equal(detached.project.id, lossProject.id);
    assert.equal(detached.projectPhase, 'starting');
    assert.equal(live.workspaceCore.snapshot().workspaceTargetLost, false);
    assert.equal(detached.projectTarget.targetId, live.target.targetId);
    assert.equal(detached.projectTarget.sessionId, live.target.sessionId);
    assert.ok(await lossClient.request('engine.workspace.capabilities', {}));
    const retired = await lossClient.request('engine.workspace.call', {
      operation: 'engine.project.close', args: { projectId: lossProject.id },
    });
    assert.equal(retired.project, null);
    await assert.rejects(
      lossClient.request('engine.workspace.call', { operation: 'engine.assets.list', args: { projectId: lossProject.id } }),
      error => error.detail?.failure?.detail?.code === 'engine-workspace-project-mismatch',
    );
    assert.ok(await lossClient.request('engine.workspace.capabilities', {}));
    console.error('browser disconnect preserves its project until explicit retirement, which rejects the old identity');
    const beforeReload = startedRun;
    startedRun = await run('reload');
    assert.equal(startedRun.runId, beforeReload.runId);
    assert.equal(startedRun.inputVersion, beforeReload.inputVersion, 'reload must keep the frozen inputs despite author edits');
    assert.notEqual(startedRun.revision, beforeReload.revision);
    await sameRun();
    const stale = await runUnifiedCli(['engine', 'run', 'eval', '--root', root, '--revision', beforeReload.revision, '--code', 'return 1', '--json']);
    assert.equal(stale.ok, false, 'reload must reject the previous revision');
    assert.equal((await run('capture', ['--revision', startedRun.revision])).pixels.rendered, true);
    await run('stop');
    await run('stop');
    assert.ok(await lossClient.request('engine.workspace.capabilities', {}));
    console.error('independent reload, frozen inputs, stale revision, capture and idempotent stop passed after View browser loss');
  } finally { lossClient.close(); }
  assert.deepEqual(capture.errors ?? [], [], 'capture must contain no renderer errors');
  assert.ok(pixelRange > 5, 'the fixture preview must not be a flat image');
  console.log(JSON.stringify({ passed: true, screenshot: '/tmp/view-plugin-boundary.png', assetCount: assets.assets.length, frameId: capture.frameId, captureErrors: capture.errors }));
  }
} catch (error) {
  console.error('joint probe failed', error);
  const ownerLog = await readFile(join(root, 'owner.log'), 'utf8').catch(() => '');
  if (ownerLog) console.error('View owner startup log', ownerLog.slice(-16_384).replace(/((?:https?|wss?):\/\/[^\s?#]+)\?[^\s]+/g, '$1?<redacted>'));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 5000 }).catch(() => {});
    console.error('failure renderer', JSON.stringify(await page.evaluate(() => ({
      diagnostics: document.querySelector('#forgeax-fatal-details')?.textContent,
      submitted: document.documentElement.dataset.forgeaxFrameSubmitted,
      renderer: globalThis.__forgeaxGameInspection?.renderer(),
      viewport: document.querySelector('[data-forgeax-view-mount-host="viewport"]')?.getBoundingClientRect().toJSON(),
      canvas: document.querySelector('canvas[data-forgeax-view-surface="engine-canvas"], [data-forgeax-view-surface="engine-canvas"] canvas')?.getBoundingClientRect().toJSON(),
    })).catch(() => null)));
  }
  throw error;
} finally {
  await runUnifiedCli?.(['engine', 'run', 'stop', '--root', root, '--json']);
  await live?.dispose();
  await rm(viewCandidate, { recursive: true, force: true });
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => {});
  await runUnifiedCli?.(['view', 'stop', '--root', root, '--json']);
  await runUnifiedCli?.(['backend', 'stop', '--root', root, '--json']);
  await cp(join(root, 'owner.log'), '/tmp/view-plugin-owner.log').catch(() => {});
  if (previousStateFile === undefined) delete process.env.FORGEAX_VIEW_STATE_FILE;
  else process.env.FORGEAX_VIEW_STATE_FILE = previousStateFile;
  if (previousEvidenceDir === undefined) delete process.env.FORGEAX_EVIDENCE_DIR;
  else process.env.FORGEAX_EVIDENCE_DIR = previousEvidenceDir;
  if (previousPreviewRhiWindow === undefined) delete process.env.FORGEAX_PREVIEW_RHI_WINDOW;
  else process.env.FORGEAX_PREVIEW_RHI_WINDOW = previousPreviewRhiWindow;
  await rm(root, { recursive: true, force: true });
}
