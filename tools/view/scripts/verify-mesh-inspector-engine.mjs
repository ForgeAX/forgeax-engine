/** Real Engine/browser proof using existing SDK builds and a disposable project. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startViewLiveIntegration } from './workspace-fixture.mjs';

const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(view, 'artifacts/mesh-inspector-engine'));
const root = await mkdtemp(join(tmpdir(), 'view-mesh-inspector-engine-'));
const candidate = await mkdtemp(join(tmpdir(), 'view-mesh-inspector-candidate-'));
const errors = [];
const hotUpdates = [];
let browser;
let browserServer;
let page;
let live;
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'assets'));
  await cp(join(view, 'scripts/fixtures/mesh-inspector.pack.ts'), join(root, 'assets/proof.pack.ts'));
  for (const file of ['dist', 'package.json', 'README.md', 'host.pack.json']) {
    await cp(join(view, file), join(candidate, file), { recursive: true });
  }
  await symlink(join(view, 'node_modules'), join(candidate, 'node_modules'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(candidate, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-mesh-inspector-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'view-mesh-inspector-proof', name: 'Mesh inspector proof', schemaVersion: '3.0.0', roots: {} }));
  browserServer = await chromium.launchServer({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader',
      '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  browserServer.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  browserServer.process().on('exit', (code, signal) => console.error('proof browser exit', { code, signal }));
  browser = await chromium.connect(browserServer.wsEndpoint());
  browser.on('disconnected', () => console.error('proof browser disconnected'));
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { localStorage.setItem('forgeax.view.locale', 'en'); });
  page.on('pageerror', error => errors.push(error.message));
  console.error('opening real Engine workspace');
  live = await startViewLiveIntegration({ page, projectRoot: root, config: {
    readyTimeout: 120_000,
    workspace: { viteServerFactory: config => createServer({ ...config, cacheDir: join(root, 'node_modules/.vite'), plugins: [
      { name: 'mesh-inspector-proof-events', hotUpdate(context) { hotUpdates.push(context.file); } },
      ...config.plugins,
    ] }) },
  } });
  console.error('real Engine workspace ready');
  const workspace = live.pageWorkspace;
  const projectId = workspace.snapshot().project.id;
  const { assets } = await workspace.listAssets({ projectId });
  const scene = assets.find(asset => asset.kind === 'scene' && asset.sourceKey === 'scene/proof');
  assert.ok(scene);
  const opened = await workspace.openAsset({ projectId, guid: scene.guid });
  const target = opened.editorPreview.target;
  const binding = { projectId, targetId: target.targetId, targetGeneration: target.generation };
  const tree = await workspace.getSceneTree(binding);
  const mesh = tree.nodes.find(node => node.name === 'Inspector proof mesh');
  const child = tree.nodes.find(node => node.parentId === mesh?.entityId);
  assert.ok(mesh && child);
  assert.equal(child.name, null);
  await workspace.selectSceneEntity({ ...binding, entityId: mesh.entityId });
  const panel = page.getByTestId('panel-inspector');
  const body = panel.getByTestId('insp-entity-body');
  await body.waitFor();
  assert.equal(await body.getByTestId('insp-group-common').getAttribute('aria-checked'), 'true');
  assert.equal(await body.locator('.insp-detail-section').count(), 3);
  const inspection = await workspace.invoke('entity.inspect', { ...binding, entityId: mesh.entityId });
  const handle = inspection.components.find(component => component.name === 'MeshFilter').values.assetHandle;
  assert.equal(typeof handle, 'number');
  await body.getByText(`Handle ${handle}`, { exact: true }).waitFor();
  assert.equal(await body.getByTestId('insp-section-mesh').getByRole('button', { name: 'Open resource', exact: true }).isDisabled(), true);
  await body.getByText('No instance overrides', { exact: true }).waitFor();
  await body.getByText('Material slot inspection unavailable', { exact: true }).waitFor();
  await body.getByTestId('insp-group-all').click();
  await body.getByTestId('insp-field-GlobalTransform-world').waitFor();
  await body.getByTestId('insp-comprow-MeshFilter').click();
  assert.equal(await body.getAttribute('data-group'), 'all');
  assert.equal(workspace.snapshot().sceneSelection.primary.entityId, mesh.entityId);
  assert.equal(await body.locator('.insp-detail-section').count(), inspection.components.length);
  assert.equal(await body.getByTestId('insp-field-Transform-pos').count(), 1);
  await body.getByTestId('insp-group-common').click();
  assert.equal(await body.locator('.insp-detail-section').count(), 3);
  await workspace.selectSceneEntity({ ...binding, entityId: child.entityId });
  await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.dataset.entityId === id, child.entityId);
  await body.getByTestId('insp-material-slot-1').getByText('Inherited material', { exact: true }).waitFor();
  await workspace.selectSceneEntity({ ...binding, entityId: mesh.entityId });
  await page.waitForFunction(id => document.querySelector('[data-testid="panel-inspector"]')?.dataset.entityId === id, mesh.entityId);
  const checkedKinds = ['mesh'];
  for (const node of tree.nodes.filter(node => node.name?.startsWith('Details proof / '))) {
    const kind = node.name.split(' / ')[1];
    await workspace.selectSceneEntity({ ...binding, entityId: node.entityId });
    await page.waitForFunction(kind => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === kind, kind);
    const inspected = await workspace.invoke('entity.inspect', { ...binding, entityId: node.entityId });
    assert(inspected.components.every(component => component.writable === false));
    await body.getByTestId('insp-group-all').click();
    for (const component of inspected.components) await body.getByTestId(`insp-section-${component.name}`).waitFor();
    checkedKinds.push(kind);
    if (['camera', 'directionalLight', 'physics', 'animation'].includes(kind)) {
      await body.getByTestId('insp-group-common').click();
      await page.screenshot({ path: join(output, `${kind}.png`) });
    }
  }
  const instance = tree.nodes.find(node => node.componentNames.includes('SceneInstance'));
  assert(instance, 'opening the real scene must create a SceneInstance entity');
  await workspace.selectSceneEntity({ ...binding, entityId: instance.entityId });
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === 'sceneInstance');
  assert.equal(await body.locator('.insp-detail-section').count(), 2);
  assert.equal(await body.getByTestId('insp-section-mesh').count(), 0);
  assert.equal(await body.getByRole('treeitem', { name: 'Inspector proof mesh', exact: true }).count(), 0);
  assert.equal(await body.getByTestId('insp-comprow-SceneInstance').count(), 1);
  checkedKinds.push('sceneInstance');
  await page.screenshot({ path: join(output, 'scene-instance.png') });
  await workspace.selectSceneEntity({ ...binding, entityId: mesh.entityId });
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-entity-body"]')?.dataset.entityKind === 'mesh');
  const capture = await workspace.capture(binding);
  assert.deepEqual(capture.errors ?? [], []);
  const contrast = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
        min = Math.min(min, value); max = Math.max(max, value);
      }
      return max - min;
    } finally { bitmap.close(); }
  }, capture.png);
  assert.ok(contrast > 5, 'the actual Engine scene must render nonblank pixels');
  assert.equal(workspace.snapshot().editorPreview.target.targetId, target.targetId);
  assert.equal(workspace.snapshot().editorPreview.target.generation, target.generation);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'mesh-inspector.png') });
  const uiFixtureOnlyKinds = ['skinnedMesh', 'instancedMesh', 'spotLight', 'areaLight', 'fog', 'reflection', 'postProcess', 'physics', 'animation', 'audio', 'vfx', 'sprite', 'tilemap', 'text', 'geometry', 'decal', 'terrain', 'navigation', 'npc', 'video'];
  const result = { passed: true, boundary: 'existing Engine tools, actual scene and Chromium; entity schemas, not simulation or media playback', checkedKinds, uiFixtureOnlyKinds, target: { ...target, url: undefined }, contrast, hotUpdates };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, code: error.code, detail: error.detail, errors, hotUpdates }, null, 2));
  throw error;
} finally {
  await live?.dispose();
  await browser?.close();
  await browserServer?.close();
  await rm(root, { recursive: true, force: true });
  await rm(candidate, { recursive: true, force: true });
}
