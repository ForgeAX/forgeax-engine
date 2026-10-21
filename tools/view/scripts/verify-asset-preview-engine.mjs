/** Actual Engine/GPU evidence; the project, Pack, resource targets and View panels are production paths. */
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
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? join(view, 'artifacts/asset-preview-engine'));
const root = await mkdtemp(join(tmpdir(), 'view-asset-preview-engine-'));
let live, browser, page;
const errors = [];
const results = [];
const pixelFacts = async png => page.evaluate(async png => {
  const bitmap = await createImageBitmap(await (await fetch(png)).blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let red = 0, green = 0, amber = 0, min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 70 && r > g * 1.8 && r > b * 1.8) red++;
      if (g > 80 && g > r * 1.6 && g > b * 1.6) green++;
      if (r > 100 && g > 60 && r > g * 1.1 && g > b * 1.5) amber++;
      min = Math.min(min, r, g, b); max = Math.max(max, r, g, b);
    }
    return { red, green, amber, contrast: max - min };
  } finally { bitmap.close(); }
}, png);
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'assets'));
  await cp(join(view, 'scripts/fixtures/asset-preview.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'asset-preview-proof', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ id: 'asset-preview-proof', name: 'Asset Preview Proof', schemaVersion: '3.0.0', roots: {} }));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('forgeax.view.locale', 'en'));
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 120000,
    workspace: { viteServerFactory: config => createServer({ ...config, cacheDir: join(root, 'node_modules/.vite') }) },
  } });
  const workspace = live.pageWorkspace;
  const capture = async identity => {
    for (let attempt = 0; ; attempt++) {
      try { return await workspace.capture(identity); }
      catch (error) {
        if (error.code !== 'view-workspace-target-busy' || attempt >= 39) throw error;
        await page.waitForTimeout(100);
      }
    }
  };
  const projectId = workspace.snapshot().project.id;
  const { assets } = await workspace.listAssets({ projectId });
  const asset = key => { const found = assets.find(asset => asset.sourceKey === key); assert(found, key); return found; };
  const open = async key => {
    const selected = asset(key);
    await workspace.openAsset({ projectId, guid: selected.guid });
    const preview = workspace.snapshot().previews.find(preview => preview.asset.guid === selected.guid);
    assert(preview?.assetBinding?.meta, `Missing bound facts for ${key}`);
    return { preview, identity: { targetId: preview.target.targetId, targetGeneration: preview.target.generation } };
  };
  const { preview, identity } = await open('mesh/collision');
  await page.getByTestId('preview-stats').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-reset-view"]')?.disabled === false);
  assert.equal(preview.assetBinding.meta.triangleCount, 12);
  assert.equal(preview.assetBinding.meta.collision.triangleCount, 12);
  const camera = await workspace.getCamera(identity);
  const materialPixels = await pixelFacts((await capture(identity)).png);
  assert(materialPixels.red > 100, 'The source material must render real red subject pixels');
  await page.getByRole('button', { name: 'View mode', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Wireframe', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  let display;
  for (let attempt = 0; attempt < 40; attempt++) {
    display = await workspace.invoke('preview.display.get', identity);
    if (display.mode === 'wireframe') break;
    await page.waitForTimeout(100);
  }
  assert.equal(display.mode, 'wireframe');
  const wirePixels = await pixelFacts((await capture(identity)).png);
  assert(wirePixels.red < materialPixels.red * 0.5, 'Wireframe must remove the filled source material');
  assert(wirePixels.contrast > 10, 'Wireframe must remain nonblank');
  await page.screenshot({ path: join(output, 'mesh-wireframe.png') });
  await workspace.invoke('preview.display.set', { ...identity, collision: true, bounds: true });
  const overlayPixels = await pixelFacts((await capture(identity)).png);
  assert(overlayPixels.green > wirePixels.green + 10, 'Actual collision edges must produce green pixels');
  assert(overlayPixels.amber > wirePixels.amber + 10, 'Actual bounds must produce amber pixels');
  assert.deepEqual((await workspace.getCamera(identity)).camera, camera.camera);
  await page.screenshot({ path: join(output, 'mesh-overlays.png') });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Statistics', exact: true }).click();
  assert.equal(await page.getByTestId('preview-stats').count(), 0);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Statistics', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 780 });
  await page.screenshot({ path: join(output, 'mesh-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('mesh/plain');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  assert(await page.getByRole('menuitemcheckbox', { name: 'Collision', exact: true }).isDisabled());
  await page.keyboard.press('Escape');
  const texture = await open('texture/checker');
  await page.getByTestId('texture-information').waitFor();
  assert.match(await page.getByTestId('texture-information').innerText(), /8 x 4/);
  assert.equal(await page.getByTestId('panel-texture-preview').getByTestId('preview-stats').count(), 0);
  await page.screenshot({ path: join(output, 'texture-information.png') });
  const material = await open('material/red');
  await page.getByTestId('panel-material-stats').waitFor();
  await page.getByTestId('panel-material-stats').getByText('Compilation statistics unavailable').waitFor();
  await page.screenshot({ path: join(output, 'material-stats.png') });
  assert.equal((await capture(texture.identity)).errors?.length ?? 0, 0);
  assert.equal((await capture(material.identity)).errors?.length ?? 0, 0);
  assert.deepEqual(errors, []);
  results.push({ materialPixels, wirePixels, overlayPixels, mesh: preview.assetBinding, texture: texture.preview.assetBinding, material: material.preview.assetBinding });
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, detail: error.detail, errors }, null, 2));
  throw error;
} finally {
  await live?.dispose();
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
