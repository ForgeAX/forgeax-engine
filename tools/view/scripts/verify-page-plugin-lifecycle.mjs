const additionalPages = JSON.parse(process.env.FORGEAX_VIEW_ADDITIONAL_PAGES ?? '[]');
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startViewLiveIntegration } from './workspace-fixture.mjs';
import { pages, verifyPagePlugins } from './verify-page-plugins.mjs';

// Focused real Engine/browser acceptance, without the long Play stress cycles.
const root = await mkdtemp(join(tmpdir(), 'view-page-lifecycle-'));
const view = resolve(import.meta.dirname, '..');
const engine = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
const errors = [];
let browser;
let live;
try {
  await mkdir(join(root, 'assets'));
  await cp(join(view, 'scripts/fixtures/workspace-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'));
  await symlink(view, join(root, 'node_modules/@forgeax/view'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'view-page-lifecycle', type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' },
  }));
  await writeFile(join(root, 'forge.json'), JSON.stringify({
    id: 'view-page-lifecycle', name: 'Page lifecycle proof', schemaVersion: '3.0.0', roots: {},
  }));
  browser = await chromium.launch({
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}),
    headless: false,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader',
      '--use-angle=swiftshader', '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });
  page.on('pageerror', error => errors.push(error.message));
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 60_000 } });
  const projectId = live.workspaceCore.snapshot().project.id;
  const { assets } = await live.workspaceCore.listAssets({ projectId });
  const scene = assets.find(asset => asset.kind === 'scene');
  assert.ok(scene);
  const opened = await live.workspaceCore.openAsset({ projectId, guid: scene.guid });
  const target = opened.preview.target;
  await live.workspaceCore.capture({ targetId: target.targetId, targetGeneration: target.generation });
  await page.locator('[role="tab"][data-page-id="page-editor"]').waitFor();
  await verifyPagePlugins({ page, backendHost: live.backendHost });
  await live.dispose();
  const disabledPages = [...pages.map(([, type]) => type), 'html'];
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 60_000, disabledPages } });
  for (const type of disabledPages) await page.locator(`[role="tab"][data-page-id="page-${type}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator('[role="tab"][data-page-id]').count(), additionalPages.length);
  const absentProject = live.workspaceCore.snapshot().project;
  const absentAssets = await live.workspaceCore.listAssets({ projectId: absentProject.id });
  const absentScene = absentAssets.assets.find(asset => asset.kind === 'scene');
  assert.ok(absentScene);
  const absentOpened = await live.workspaceCore.openAsset({ projectId: absentProject.id, guid: absentScene.guid });
  const absentTarget = absentOpened.preview.target;
  const capture = await live.workspaceCore.capture({ targetId: absentTarget.targetId, targetGeneration: absentTarget.generation });
  assert.ok(capture.width > 0 && capture.height > 0, 'Engine stays callable without View pages');
  await live.dispose();
  live = await startViewLiveIntegration({ page, projectRoot: root, config: { readyTimeout: 60_000 } });
  await page.locator('[role="tab"][data-page-id="page-editor"]').waitFor();
  assert.deepEqual(live.backendHost.assembly.current.root.config.disabledPages, []);
  for (const [, type, title] of pages) {
    if (await page.locator(`[role="tab"][data-page-id="page-${type}"]`).count()) continue;
    await page.locator('.fx-page-tab-btn--new').click();
    await page.getByRole('menuitem', { name: title, exact: true }).click();
  }
  assert.equal(await page.locator('[role="tab"][data-page-id]').count(), pages.length + additionalPages.length);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, boundary: 'real-page-plugin-lifecycles', disabledPages }));
} finally {
  await live?.dispose();
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
