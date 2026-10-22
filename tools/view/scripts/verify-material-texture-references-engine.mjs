/** Real Game 3D inputs are copied; Engine and the source project remain read-only. */
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
const source = resolve(process.env.FORGEAX_GAME3D_ROOT ?? join(view, '../../../forgeax-engine/templates/game-3d'));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/material-texture-references-engine');
const root = await mkdtemp(join(tmpdir(), 'view-material-textures-game-'));
const candidate = await mkdtemp(join(tmpdir(), 'view-material-textures-candidate-'));
let browser, live, page;
const errors = [];
const engineDiagnostics = new Set();
try {
  await mkdir(output, { recursive: true });
  for (const file of ['assets', 'forge.json', 'package.json']) await cp(join(source, file), join(root, file), { recursive: true });
  for (const file of ['dist', 'package.json', 'README.md', 'host.pack.json']) await cp(join(view, file), join(candidate, file), { recursive: true });
  await symlink(join(view, 'node_modules'), join(candidate, 'node_modules'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(candidate, join(root, 'node_modules/@forgeax/view'));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (text.includes('has no unique published program')) engineDiagnostics.add('Scene material has no unique published program');
    if (text.includes('material-skin-attr-missing')) engineDiagnostics.add('Scene material-skin-attr-missing');
  });
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  console.error('Opening disposable Game 3D copy with the candidate View build');
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120_000,
    workspace: { viteServerFactory: config => createServer({ ...config, cacheDir: join(root, 'node_modules/.vite') }) },
  } });
  const workspace = live.pageWorkspace;
  const projectId = workspace.snapshot().project.id;
  const { assets } = await workspace.listAssets({ projectId });
  const material = assets.find(asset => asset.sourceKey === 'material/ground');
  const textures = ['base-color', 'normal', 'roughness'].map(suffix => assets.find(asset => asset.sourceKey === `texture/brick-floor-${suffix}`));
  assert(material && textures.every(Boolean), 'Game 3D must contain ground and its three authored brick textures');
  const waitForPreview = async (kind, guid) => {
    const deadline = Date.now() + 60_000;
    while (true) {
      const entry = workspace.snapshot().resourceOpens[kind];
      if (entry?.asset?.guid === guid && entry.preview) return entry.preview;
      if (entry?.pending?.phase === 'failed') throw new Error(JSON.stringify(entry.pending.failure));
      if (Date.now() > deadline) throw new Error(`${kind} viewer did not open`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const results = [];
  for (const [index, texture] of textures.entries()) {
    console.error(`Verifying texture reference ${texture.sourceKey}`);
    await workspace.openAsset({ projectId, guid: material.guid });
    const materialPreview = await waitForPreview('material', material.guid);
    const ownOutput = materialPreview.assetBinding.publication.outputs.find(output => output.guid === material.guid);
    assert(ownOutput.refs.includes(texture.guid));
    const card = page.getByTestId(`material-texture-${texture.guid}`);
    await card.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(guid => {
      const image = document.querySelector(`[data-testid="material-texture-${guid}"] img`);
      return image?.complete && image.naturalWidth > 0;
    }, texture.guid, { timeout: 90_000 });
    const png = await card.locator('img').getAttribute('src');
    assert.match(png, /^data:image\/png/);
    const contrast = await card.locator('img').evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < pixels.length; i += 4) { const light = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3; min = Math.min(min, light); max = Math.max(max, light); }
      return max - min;
    });
    assert(contrast > 5, 'Real texture PNG must contain nonblank pixels');
    await writeFile(join(output, `${texture.sourceKey.split('/').at(-1)}.png`), Buffer.from(png.split(',')[1], 'base64'));
    if (index === 0) {
      assert.equal(await page.locator('.material-texture-reference').count(), 3);
      await page.getByRole('button', { name: 'Material facts', exact: true }).click();
      await page.screenshot({ path: join(output, 'native-material-texture-cards.png') });
    }
    await card.getByTestId('asset-reference-thumbnail').dblclick();
    const texturePreview = await waitForPreview(texture.kind, texture.guid);
    await page.getByTestId('panel-texture-properties').waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(workspace.snapshot().resourceOpens.material.preview.target.targetId, materialPreview.target.targetId);
    assert(!workspace.snapshot().play);
    results.push({ guid: texture.guid, name: texture.sourceKey, target: texturePreview.target.targetId, generation: texturePreview.target.generation, contrast });
    await page.screenshot({ path: join(output, `native-texture-viewer-${index}.png`) });
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, engine, source, material: material.guid, textures: results, errors, engineDiagnostics: [...engineDiagnostics],
    boundary: 'Candidate View build, copied Game 3D sources, real Engine PNG thumbnails and three texture viewer targets; no Play.' }, null, 2));
  console.log(JSON.stringify({ ok: true, output, textures: results.length }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: String(error), errors }, null, 2));
  throw error;
} finally {
  await live?.dispose().catch(() => {});
  await browser?.close();
  await rm(root, { recursive: true, force: true });
  await rm(candidate, { recursive: true, force: true });
}
