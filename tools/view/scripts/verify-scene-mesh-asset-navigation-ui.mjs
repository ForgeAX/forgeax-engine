/** Chromium proof of scene mesh actions with explicit Engine-style inspection facts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/scene-mesh-asset-navigation-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-scene-mesh-navigation-'));
let browser;
let server;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/scene-mesh-asset-navigation-ui.tsx'],
    outfile: resolve(temporary, 'ui.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const html = '<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:12px;height:760px}#scene,#browser-mount{min-height:0}#browser[hidden]{display:none}</style><div id="layout"><div id="scene"></div><div id="browser" hidden><div id="browser-mount" style="height:760px"></div></div></div><script type="module" src="/ui.js"></script></html>';
  server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'],
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('hier-row-scene:world:2').waitFor();
  await page.waitForFunction(() => globalThis.sceneMeshAssetFixture?.browserReady());
  for (const [id, reason] of [['missing-asset', 'Missing asset'], ['unregistered-asset', 'Asset identity unavailable'], ['unavailable-viewer', 'Asset viewer unavailable']]) {
    const button = page.getByTestId(id).getByTestId('asset-reference-open');
    assert.equal(await button.isDisabled(), true);
    assert.ok((await button.getAttribute('title')).includes(reason));
  }
  const row = page.getByTestId('hier-row-scene:world:2');
  await row.click({ button: 'right' });
  const browse = page.locator('[data-operation="scene-tree.asset.browse"]');
  const edit = page.locator('[data-operation="scene-tree.asset.edit"]');
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.browse"]')?.disabled);
  assert.equal(await browse.textContent(), '浏览至资产');
  assert.equal(await edit.textContent(), '编辑 cube');
  await page.screenshot({ path: resolve(output, 'mesh-context-menu.png') });
  await browse.click();
  await page.waitForFunction(() => document.querySelector('[data-cb-guid="cube-guid"]')?.getAttribute('aria-selected') === 'true');
  assert.equal(await page.locator('#browser').isVisible(), true);
  assert.equal(await page.locator('[data-cb-path="assets/geometry.pack.ts"]').count(), 1);
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.selected()), 'scene:world:2');
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length), 0);
  const inspected = await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.find(call => call.operation === 'asset.inspect'));
  assert.deepEqual(inspected.args, { guid: 'cube-guid', projectId: 'project', tabId: 'forgeax-user-workspace', targetId: 'scene', targetGeneration: 1 });
  await page.screenshot({ path: resolve(output, 'browse-exact-asset.png') });

  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.edit"]')?.disabled);
  await edit.click();
  const opened = await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.find(call => call.operation === 'asset.open'));
  assert.deepEqual(opened.args, { projectId: 'project', tabId: 'forgeax-user-workspace', guid: 'cube-guid', targetId: 'scene', targetGeneration: 1 });

  await page.evaluate(() => globalThis.sceneMeshAssetFixture.setHandle(1028));
  await row.click({ button: 'right' });
  const ambiguousTitle = '无法确定唯一主资产，请在检查器的资产引用字段中操作';
  await page.waitForFunction(title => document.querySelector('[data-operation="scene-tree.asset.edit"]')?.closest('[title]')?.title === title, ambiguousTitle);
  assert.equal(await browse.isDisabled(), true);
  assert.equal(await edit.isDisabled(), true);
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length), 1);
  await page.evaluate(() => { globalThis.sceneMeshAssetFixture.setHandle(1028); globalThis.sceneMeshAssetFixture.enableNativeMapping(); });
  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.edit"]')?.disabled);
  assert.equal(await page.locator('[data-operation="related-assets"]').count(), 0);
  await page.keyboard.press('Escape');
  await row.click();
  const meshField = page.getByTestId('insp-section-mesh').getByTestId('asset-reference-field');
  await meshField.getByTestId('asset-reference-open').waitFor({ state: 'visible' });
  const beforeName = await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length);
  const nameField = meshField.getByRole('textbox');
  await nameField.click();
  await nameField.dblclick();
  await nameField.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length), beforeName);
  await meshField.getByTestId('asset-reference-open').click();
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').at(-1).args.guid), 'cube-guid');
  const materialField = page.getByTestId('insp-section-materials').getByTestId('asset-reference-field').first();
  await materialField.getByRole('button', { name: '浏览至资产', exact: true }).click();
  await page.locator('[data-cb-guid="material-guid"][aria-selected="true"]').waitFor();
  await materialField.getByTestId('asset-reference-open').click();
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').at(-1).args.guid), 'material-guid');
  const audio = page.getByTestId('hier-row-scene:world:4');
  await audio.click({ button: 'right' });
  await page.waitForFunction(() => document.querySelector('[data-operation="scene-tree.asset.edit"]')?.textContent?.includes('ambient'));
  await edit.click();
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').at(-1).args.guid), 'audio-guid');
  const combined = page.getByTestId('hier-row-scene:world:5');
  await combined.click({ button: 'right' });
  await page.waitForFunction(title => document.querySelector('[data-operation="scene-tree.asset.edit"]')?.closest('[title]')?.title === title, ambiguousTitle);
  assert.equal(await browse.isDisabled(), true);
  assert.equal(await edit.isDisabled(), true);
  assert.equal(await page.locator('.hier-context-submenu').count(), 0);
  await page.keyboard.press('Escape');
  await page.getByTestId('hier-row-scene:world:6').click({ button: 'right' });
  await page.waitForFunction(title => document.querySelector('[data-operation="scene-tree.asset.edit"]')?.closest('[title]')?.title === title, ambiguousTitle);
  assert.equal(await browse.isDisabled(), true);
  assert.equal(await edit.isDisabled(), true);
  await page.keyboard.press('Escape');
  await audio.click();
  await page.getByTestId('fixture-inspector').scrollIntoViewIfNeeded();
  await page.getByTestId('insp-field-AudioSource-clip').getByRole('button', { name: '浏览至资产', exact: true }).click();
  await page.locator('[data-cb-guid="audio-guid"][aria-selected="true"]').waitFor();
  await page.screenshot({ path: resolve(output, 'audio-field-navigation.png') });
  await page.evaluate(() => globalThis.sceneMeshAssetFixture.useLongAssetName());
  const inspector = page.getByTestId('fixture-inspector');
  for (const theme of ['light', 'dark']) for (const width of [320, 480, 640]) {
    await page.evaluate(({ theme, width }) => {
      document.documentElement.dataset.theme = theme;
      document.querySelector('[data-testid="fixture-inspector"]').style.width = `${width}px`;
    }, { theme, width });
    await inspector.scrollIntoViewIfNeeded();
    const dimensions = await inspector.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(dimensions.content <= dimensions.width + 1, `${theme} ${width}px: Inspector overflowed`);
    await inspector.screenshot({ path: resolve(output, `inspector-${width}-${theme}.png`) });
  }
  await page.setViewportSize({ width: 414, height: 740 });
  await page.evaluate(() => globalThis.sceneMeshAssetFixture.useManyReferences(true));
  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.edit"]')?.disabled);
  assert.equal(await page.locator('[data-operation="related-assets"]').count(), 0);
  assert.equal(await page.locator('.hier-context-submenu').count(), 0);
  const menuBounds = await page.locator('.hier-context-menu').boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 414 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 740);
  await page.screenshot({ path: resolve(output, 'primary-asset-menu-mobile.png') });
  await page.keyboard.press('Escape');
  const beforeReplacement = await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length);
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.evaluate(() => globalThis.sceneMeshAssetFixture.useManyReferences(false));

  await page.keyboard.press('Escape');
  await page.evaluate(async () => { await globalThis.sceneMeshAssetFixture.removeBrowser(); globalThis.sceneMeshAssetFixture.setHandle('cube-guid'); });
  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.edit"]')?.disabled);
  assert.equal(await browse.isDisabled(), true);
  assert.equal(await edit.isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => globalThis.sceneMeshAssetFixture.restoreBrowser());
  await page.waitForFunction(() => globalThis.sceneMeshAssetFixture.browserReady());
  await row.click({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.browse"]')?.disabled);

  await page.keyboard.press('Escape');
  await page.evaluate(() => globalThis.sceneMeshAssetFixture.deferInspection());
  await row.click({ button: 'right' });
  await page.waitForFunction(() => globalThis.sceneMeshAssetFixture.inspectionPending());
  await page.evaluate(() => { globalThis.sceneMeshAssetFixture.replaceTarget(); globalThis.sceneMeshAssetFixture.finishInspection(); });
  await page.waitForFunction(() => !document.querySelector('[data-operation="scene-tree.asset.edit"]'));
  assert.equal(await page.evaluate(() => globalThis.sceneMeshAssetFixture.calls.filter(call => call.operation === 'asset.open').length), beforeReplacement);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, screenshots: output }) + '\n');
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
