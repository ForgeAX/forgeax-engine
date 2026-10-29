/** Native Engine acceptance; only the disposable project and View outputs are writable. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startViewLiveIntegration } from './workspace-fixture.mjs';

const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/mesh-material-slots-engine');
const root = await mkdtemp(join(tmpdir(), 'view-mesh-slots-engine-'));
const candidate = await mkdtemp(join(tmpdir(), 'view-mesh-slots-candidate-'));
let browser, live, page;
const errors = [];
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'assets'));
  const source = await readFile(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), 'utf8');
  await writeFile(join(root, 'assets/proof.pack.ts'), source.replace("materialSlots: [{ slotName: 'surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }]",
    "materialSlots: [{ slotName: 'Surface', sourceKey: 'proof:box', defaultMaterial: guid('material/box') }, { slotName: 'Repeated', defaultMaterial: guid('material/box') }, { slotName: 'Engine default' }]"));
  for (const file of ['dist', 'package.json', 'README.md', 'host.pack.json']) await cp(join(view, file), join(candidate, file), { recursive: true });
  await symlink(join(view, 'node_modules'), join(candidate, 'node_modules'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(candidate, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'view-mesh-material-slots-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'view-mesh-material-slots-proof', name: 'Mesh material slots proof', schemaVersion: '3.0.0', roots: {} }));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  console.error('Opening native Engine project');
  live = await startViewLiveIntegration({ page, projectRoot: root, config: {
    readyTimeout: 120_000,
    workspace: { viteServerFactory: config => createServer({ ...config, cacheDir: join(root, 'node_modules/.vite') }) },
  } });
  console.error('Native project ready; opening Mesh');
  const workspace = live.pageWorkspace;
  const projectId = workspace.snapshot().project.id;
  const { assets } = await workspace.listAssets({ projectId });
  const mesh = assets.find(asset => asset.sourceKey === 'mesh/box');
  const material = assets.find(asset => asset.sourceKey === 'material/box');
  assert(mesh && material);
  await workspace.openAsset({ projectId, guid: mesh.guid });
  const preview = workspace.snapshot().resourceOpens.mesh.preview;
  const exact = { targetId: preview.target.targetId, targetGeneration: preview.target.generation };
  const tree = await workspace.invoke('scene.tree.get', { ...exact, offset: 0, limit: 50 });
  const inspections = await Promise.all(tree.nodes.filter(node => node.componentNames.includes('MeshFilter'))
    .map(node => workspace.invoke('entity.inspect', { ...exact, entityId: node.entityId })));
  await writeFile(join(output, 'native-references.json'), JSON.stringify({ preview, tree, inspections }, null, 2));
  const slot = page.getByTestId('mesh-material-slot-0');
  const open = slot.getByTestId('asset-reference-open');
  await open.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-open"]')?.disabled);
  assert.equal(await page.getByTestId('mesh-material-slot-1').getByTestId('asset-reference-open').isEnabled(), true);
  assert.equal(await page.getByTestId('mesh-material-slot-2').getByTestId('asset-reference-open').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-material-slot-0"] img')?.naturalWidth > 0, undefined, { timeout: 60_000 });
  await slot.scrollIntoViewIfNeeded();
  const capture = await workspace.capture(exact);
  assert.match(capture.png, /^data:image\/png/);
  const contrast = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255, max = 0;
    for (let index = 0; index < values.length; index += 4) { const value = (values[index] + values[index + 1] + values[index + 2]) / 3; min = Math.min(min, value); max = Math.max(max, value); }
    return max - min;
  }, capture.png);
  assert(contrast > 5, 'Mesh capture must contain nonblank rendered pixels');
  await writeFile(join(output, 'native-mesh-capture.png'), Buffer.from(capture.png.split(',')[1], 'base64'));
  await page.screenshot({ path: join(output, 'native-mesh-cards.png') });
  await workspace.invoke('preview.display.set', { ...exact, mode: 'wireframe' });
  assert.equal(await open.isEnabled(), true);
  await open.click();
  const waitForMaterial = async () => {
    const deadline = Date.now() + 60_000;
    while (workspace.snapshot().resourceOpens.material?.asset?.guid !== material.guid || !workspace.snapshot().resourceOpens.material?.preview) {
      const pending = workspace.snapshot().resourceOpens.material?.pending;
      if (pending?.phase === 'failed') throw new Error(JSON.stringify(pending.failure));
      if (Date.now() > deadline) throw new Error('Material page did not open');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await waitForMaterial();
  await page.getByTestId('panel-material-properties').waitFor({ state: 'visible', timeout: 60_000 });
  const materialTarget = workspace.snapshot().resourceOpens.material.preview.target;
  await page.screenshot({ path: join(output, 'native-material-navigation.png') });
  assert.equal(workspace.snapshot().resourceOpens.mesh.preview.target.targetId, exact.targetId);
  assert(!workspace.snapshot().play);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, engine, mesh: mesh.guid, material: material.guid,
    meshTarget: exact, materialTarget, contrast, errors, boundary: 'Native Engine preview, real thumbnail PNG and Mesh-to-Material navigation.' }, null, 2));
  console.log(JSON.stringify({ ok: true, output, contrast }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  const status = await page?.getByTestId('panel-mesh-properties').locator('[role="status"]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, title: node.title }))).catch(() => []);
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: String(error), errors, status }, null, 2));
  throw error;
} finally {
  await live?.dispose().catch(() => {});
  await browser?.close();
  await rm(root, { recursive: true, force: true });
  await rm(candidate, { recursive: true, force: true });
}
