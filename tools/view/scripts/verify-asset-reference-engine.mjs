/** Production frontend adapter and navigation against actual Engine inspection. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
import { createAssetReferenceSession } from '../packages/view-plugin-asset-references/src/session.ts';

const suppliedProject = process.env.FORGEAX_REFERENCE_PROJECT;
const root = suppliedProject ? resolve(suppliedProject) : await mkdtemp(join(tmpdir(), 'view-asset-reference-engine-'));
const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/view-asset-reference-engine';
let browser, page, live, referencesSession;
const errors = [];
try {
  await mkdir(output, { recursive: true });
  if (!suppliedProject) {
  await mkdir(join(root, 'assets'));
  await cp(join(view, 'scripts/fixtures/mesh-inspector.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-reference-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'asset-reference-proof', name: 'Asset reference proof', roots: {} }));
  }
  browser = await chromium.launch({ headless: false,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  live = await startViewLiveIntegration({ page, projectRoot: root });
  const workspace = live.pageWorkspace;
  const client = { subscribe: listener => workspace.subscribe(listener), call: (...args) => workspace.invoke(...args) };
  referencesSession = createAssetReferenceSession({ client });
  const initial = referencesSession.getState();
  assert.equal(initial.phase, 'ready', JSON.stringify(initial));
  const state = workspace.snapshot();
  const scene = state.assets.find(asset => asset.kind === 'scene' && (!process.env.FORGEAX_REFERENCE_SCENE || asset.sourceKey === process.env.FORGEAX_REFERENCE_SCENE));
  assert(scene, 'The requested scene must be in the project Catalog');
  if (workspace.snapshot().scenePreview?.asset?.guid !== scene.guid)
    await workspace.openAsset({ projectId: state.project.id, guid: scene.guid });
  const target = workspace.snapshot().scenePreview.target;
  const scope = { projectId: state.project.id, targetId: target.targetId, targetGeneration: target.generation };
  const tree = await workspace.getSceneTree(scope);
  const mesh = tree.nodes.find(node => node.name === (process.env.FORGEAX_REFERENCE_ENTITY ?? 'Inspector proof mesh'))
    ?? tree.nodes.find(node => node.componentNames.includes('MeshFilter'));
  assert(mesh);
  const references = await referencesSession.query(mesh.entityId);
  assert.equal(references.references.find(ref => ref.key === 'MeshFilter.assetHandle')?.status, 'resolved');
  if (!suppliedProject) assert.equal(references.references.filter(ref => ref.origin === 'mesh-default' && ref.guid).length, 2);
  const current = referencesSession.getState();
  const additionalReferences = [];
  for (const node of tree.nodes.filter(node => node.componentNames.some(name => ['SceneInstance', 'Skylight', 'SkyboxBackground', 'Skin'].includes(name))).slice(0, 8)) {
    const value = await referencesSession.query(node.entityId);
    additionalReferences.push({ name: node.name, references: value.references });
  }
  assert(additionalReferences.some(entry => entry.references.some(ref => ref.component === 'SceneInstance' && ref.status === 'resolved')));
  await workspace.selectSceneEntity({ ...scope, entityId: mesh.entityId });
  const body = page.getByTestId('insp-entity-body');
  const meshField = body.getByTestId('insp-section-mesh').getByTestId('asset-reference-field');
  await meshField.getByTestId('asset-reference-open').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="insp-section-mesh"] [data-testid="asset-reference-open"]')?.disabled);
  const beforeName = workspace.snapshot().openRequest?.requestId;
  await meshField.getByRole('textbox').click();
  await meshField.getByRole('textbox').dblclick();
  await meshField.getByRole('textbox').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  assert.equal(workspace.snapshot().openRequest?.requestId, beforeName);
  const row = page.getByTestId(`hier-row-${mesh.entityId}`);
  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.browse"]')?.disabled);
  assert.equal(await page.locator('[data-operation="related-assets"]').count(), 0);
  await page.screenshot({ path: join(output, 'scene-asset-menu.png') });
  await page.locator('[data-operation="scene-tree.asset.browse"]').click();
  const meshGuid = references.references.find(ref => ref.key === 'MeshFilter.assetHandle').guid;
  await page.locator(`[data-cb-guid="${meshGuid}"][aria-selected="true"]`).waitFor();
  assert.equal(workspace.snapshot().sceneSelection.primary.entityId, mesh.entityId);
  await page.screenshot({ path: join(output, 'browse-exact-asset.png') });
  await page.keyboard.press('Escape');
  await body.locator('.insp-header').click();
  await body.getByTestId('insp-section-mesh').getByRole('button', { name: 'Browse to Asset', exact: true }).click();
  await page.locator(`[data-cb-guid="${meshGuid}"][aria-selected="true"]`).waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(output, 'asset-reference-card.png') });
  await body.locator('.insp-header').click();
  await meshField.getByTestId('asset-reference-open').click();
  const asset = workspace.snapshot().assets.find(asset => asset.guid === meshGuid);
  const assetName = asset.name ?? asset.sourceKey?.split('/').at(-1);
  await page.getByRole('tab').filter({ hasText: assetName }).waitFor();
  assert.equal(await page.getByRole('tab').filter({ hasText: assetName }).count(), 1);
  await page.getByTestId('panel-mesh-preview').locator('canvas[data-forgeax-asset-preview]').waitFor({ state: 'visible' });
  const meshPreview = workspace.snapshot().openRequest?.preview;
  assert(meshPreview);
  assert.equal(meshPreview.asset.guid, meshGuid);
  const capture = await workspace.capture({ projectId: state.project.id, targetId: meshPreview.target.targetId, targetGeneration: meshPreview.target.generation });
  assert.equal(capture.errors?.length ?? 0, 0);
  await writeFile(join(output, 'mesh-preview-pixels.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  await page.screenshot({ path: join(output, 'named-asset-preview.png') });
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  const countBeforeReopen = workspace.snapshot().previews.length;
  await meshField.getByTestId('asset-reference-open').click();
  await page.getByRole('tab').filter({ hasText: assetName }).waitFor();
  assert.equal(workspace.snapshot().previews.length, countBeforeReopen);
  assert.equal(workspace.snapshot().sceneSelection.primary.entityId, mesh.entityId);
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  const material = references.references.find(ref => ref.component === 'MeshRenderer' && ref.guid);
  if (material) {
    const materialField = body.getByTestId(`insp-material-slot-${material.index}`).getByTestId('asset-reference-field');
    await materialField.getByRole('button', { name: 'Browse to Asset', exact: true }).click();
    await page.locator(`[data-cb-guid="${material.guid}"][aria-selected="true"]`).waitFor();
    await page.keyboard.press('Escape');
    await body.locator('.insp-header').click();
    await materialField.getByTestId('asset-reference-open').click();
    await page.getByTestId('panel-material-properties').waitFor();
    assert.equal(workspace.snapshot().openRequest.asset.guid, material.guid);
    await page.screenshot({ path: join(output, 'material-asset-viewer.png') });
  }
  assert.deepEqual(referencesSession.getState().scope, current.scope);
  const fallback = workspace.snapshot().assets.find(asset => ['skeleton', 'animation-clip', 'font', 'audio'].includes(asset.kind));
  if (fallback) {
    const count = workspace.snapshot().previews.length;
    await workspace.openAsset({ projectId: state.project.id, guid: fallback.guid, detailsOnly: true });
    await page.getByTestId('panel-asset-properties').waitFor();
    assert.equal(workspace.snapshot().openRequest.detailsOnly, true);
    assert.equal(workspace.snapshot().previews.length, count);
    await page.screenshot({ path: join(output, 'generic-asset-details.png') });
  }
  const installations = await workspace.invoke('runtime-pack.plugin-inspect', { ...scope, worldId: target.worldId });
  assert(!installations.plugins.some(plugin => plugin.name === 'forgeax:view-asset-reference-query'), JSON.stringify(installations));
  referencesSession.dispose();
  const withoutConsumer = await workspace.invoke('entity.inspect', { ...scope, entityId: mesh.entityId });
  assert.deepEqual(withoutConsumer.assetReferences.references, references.references.map(({ primary, ...reference }) => reference));
  referencesSession = createAssetReferenceSession({ client });
  await referencesSession.query(mesh.entityId);
  assert.equal(referencesSession.getState().phase, 'ready');
  await page.screenshot({ path: join(output, 'resident-service.png') });
  const result = { passed: true, beforeScene: initial.phase, afterScene: current.phase, references,
    additionalReferences, legacyQueryPluginAbsent: true, nativeWithoutConsumer: true, consumerRestored: true, nameDoesNotNavigate: true,
    fieldBrowse: true, contextBrowse: true, fieldOpen: true, reopenRetainsPreviewCount: true,
    materialFieldNavigation: Boolean(material), genericFallback: Boolean(fallback), errors };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, errors,
    service: referencesSession?.getState() }, null, 2));
  throw error;
} finally {
  referencesSession?.dispose();
  await live?.dispose().catch(error => console.error('proof cleanup', error));
  await browser?.close();
  if (!suppliedProject) await rm(root, { recursive: true, force: true });
}
