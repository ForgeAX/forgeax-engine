/** Real Engine/browser acceptance for native resource owners and View navigation. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';

const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(view, 'artifacts/resource-preview-lifecycle'));
const root = await mkdtemp(join(tmpdir(), 'view-resource-lifecycle-'));
const errors = [], timings = [], opens = [];
let browser, live, page;
const wait = async (predicate, label) => {
  const end = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'assets'));
  const source = await readFile(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), 'utf8');
  await writeFile(join(root, 'assets/proof.pack.ts'), source.replace("'mesh/box':", "'mesh/other': { ...box.value, materialSlots: [{ slotName: 'surface', defaultMaterial: guid('material/box') }] },\n      'mesh/box':"));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-resource-lifecycle', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'view-resource-lifecycle', name: 'Resource lifecycle proof', schemaVersion: '3.0.0', roots: {} }));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('resource-open')) timings.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000 } });
  const workspace = live.pageWorkspace;
  const { assets } = await workspace.listAssets({ projectId: workspace.snapshot().project.id });
  const asset = key => { const value = assets.find(entry => entry.sourceKey === key); assert.ok(value, key); return value; };
  const projectId = workspace.snapshot().project.id;
  const previews = () => workspace.snapshot().previews.filter(entry => entry.asset?.kind === 'mesh');
  const open = async key => {
    const start = performance.now();
    await workspace.openAsset({ projectId, guid: asset(key).guid });
    const preview = workspace.snapshot().resourceOpens.mesh?.preview;
    opens.push({ key, elapsedMs: Math.round(performance.now() - start), target: preview?.target });
    return preview;
  };
  if (workspace.snapshot().scenePreview?.asset?.guid !== asset('scene/proof').guid)
    await workspace.openAsset({ projectId, guid: asset('scene/proof').guid });
  const firstPending = open('mesh/box');
  await page.locator('.fx-resource-page-status[data-phase="opening"]').waitFor();
  await page.screenshot({ path: join(output, 'opening.png') });
  const first = await firstPending;
  await page.locator(`[data-forgeax-asset-preview="${first.target.targetId}"]`).first().waitFor();
  await page.getByTestId('mesh-reset-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  const identity = { targetId: first.target.targetId, targetGeneration: first.target.generation };
  const camera = await workspace.getCamera(identity);
  const repeated = await open('mesh/box');
  for (const key of ['targetId', 'generation', 'sessionId', 'worldId']) assert.equal(repeated.target[key], first.target[key]);
  assert.equal(previews().length, 1);
  assert.deepEqual((await workspace.getCamera(identity)).camera, camera.camera);
  await page.getByRole('tab', { name: /^Scene/ }).click();
  assert.equal(previews()[0].target.targetId, first.target.targetId);
  await page.locator('[data-page-id="page-mesh"]').click();
  const results = await Promise.all([open('mesh/other'), open('mesh/other')]);
  assert.deepEqual(results[0].target, results[1].target);
  await wait(() => previews().length === 1, 'the superseded mesh to close');
  assert.notEqual(previews()[0].target.targetId, first.target.targetId);
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  const current = workspace.snapshot().resourceOpens.mesh.preview;
  const capture = await workspace.capture({ targetId: current.target.targetId, targetGeneration: current.target.generation });
  assert.match(capture.png, /^data:image\/png/);
  await writeFile(join(output, 'mesh-capture.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  const exact = { targetId: current.target.targetId, targetGeneration: current.target.generation };
  const tree = await workspace.getSceneTree(exact);
  await writeFile(join(output, 'diagnostics.json'), JSON.stringify({
    target: current.target, capture: { ...capture, png: undefined }, camera: await workspace.getCamera(exact), tree,
    entities: await Promise.all(tree.nodes.map(node => workspace.invoke('entity.inspect', { ...exact, entityId: node.entityId }))),
  }, null, 2));
  const pixels = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const center = Array.from(context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) { min = Math.min(min, data[i], data[i + 1], data[i + 2]); max = Math.max(max, data[i], data[i + 1], data[i + 2]); }
      return { center, contrast: max - min, width: bitmap.width, height: bitmap.height };
    } finally { bitmap.close(); }
  }, capture.png);
  await writeFile(join(output, 'pixels.json'), JSON.stringify(pixels, null, 2));
  assert(pixels.contrast > 20, `A completed replacement frame must have actual pixel variation: ${JSON.stringify(pixels)}`);
  assert(pixels.center[0] > pixels.center[1] + 20 && pixels.center[0] > pixels.center[2] + 20, 'The authored orange cube must occupy the center of the completed frame');
  await writeFile(join(output, 'mesh-capture.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  await page.screenshot({ path: join(output, 'replacement.png') });
  await workspace.openAsset({ projectId, guid: asset('material/box').guid });
  const material = workspace.snapshot().resourceOpens.material.preview;
  await page.locator('[data-page-id="page-material"]').waitFor();
  await page.locator('[data-page-id="page-mesh"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close to the right', exact: true }).click();
  await page.locator('[data-page-id="page-material"]').waitFor({ state: 'detached' });
  assert(!workspace.snapshot().previews.some(entry => entry.target.targetId === material.target.targetId));
  assert.equal(previews()[0].target.targetId, current.target.targetId);
  await page.locator('[data-page-id="page-mesh"]').click();
  await page.locator('[data-page-id="page-mesh"]').hover();
  await page.locator('[data-page-close="page-mesh"]').click();
  await page.locator('[data-page-id="page-mesh"]').waitFor({ state: 'detached' });
  assert.equal(previews().length, 0);
  const reopened = await open('mesh/other');
  assert.notEqual(reopened.target.targetId, current.target.targetId);
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-reset-view"]')?.disabled);
  await page.screenshot({ path: join(output, 'reopened.png') });
  await workspace.openAsset({ projectId, guid: asset('material/box').guid });
  await page.locator('[data-page-id="page-material"]').waitFor();
  await page.locator('[data-page-id="page-mesh"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close others', exact: true }).click();
  await page.locator('[data-page-id="page-material"]').waitFor({ state: 'detached' });
  assert.equal(previews()[0].target.targetId, reopened.target.targetId);
  assert.equal(await page.getByRole('tab', { name: /^Scene/ }).count(), 1);
  assert(!workspace.snapshot().previews.some(entry => entry.asset?.kind === 'material'));
  const closed = await live.backendHost.context.get('toolApi').run('view.workspace.call', { operation: 'presentation.page.close', args: { pageId: 'page-mesh' } }, { sourceId: 'view-workspace' }).terminal;
  assert.equal(closed.outcome, 'succeeded', JSON.stringify(closed));
  assert(!closed.result.pages.some(entry => entry.id === 'page-mesh'), 'The close API must return the committed page removal');
  await page.locator('[data-page-id="page-mesh"]').waitFor({ state: 'detached' });
  assert.equal(previews().length, 0);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, engine, opens, pixels, timings, errors, boundary: 'Paired Engine native owners; completed-ready capture verifies the exact replacement target.' }, null, 2));
  console.log(JSON.stringify({ passed: true, output, opens: opens.map(({ key, elapsedMs }) => ({ key, elapsedMs })) }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, errors, timings, root }, null, 2));
  throw error;
} finally {
  try { await live?.dispose(); }
  finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
}
