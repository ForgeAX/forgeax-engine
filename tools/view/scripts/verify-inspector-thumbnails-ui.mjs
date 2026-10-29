/** Actual Engine PNGs in the changed Inspector; fixture transport tests UI, not GPU execution. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/inspector-asset-thumbnails');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-inspector-thumbnails-'));
let browser, server;
try {
  await mkdir(output, { recursive: true });
  const previews = await Promise.all(['astral-bloom', 'fantasy-azure'].map(async name =>
    `data:image/png;base64,${(await readFile(resolve(root, `packages/view-components/src/story-assets/${name}.png`))).toString('base64')}`));
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/mesh-inspector-ui.tsx'], outfile: resolve(temporary, 'ui.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  server = createServer(async (request, response) => {
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{height:960px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>');
      return;
    }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const panel = page.getByTestId('panel-inspector');
  const mesh = () => panel.getByTestId('insp-section-mesh').getByTestId('asset-reference-thumbnail');
  const opens = () => page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'asset.open'));
  await panel.getByTestId('insp-entity-body').waitFor();
  assert.equal(await mesh().isDisabled(), true, 'opaque World handle cannot navigate');
  await page.evaluate(previews => {
    globalThis.meshInspectorFixture.thumbnails([
      ['mesh-guid', { state: 'ready', dataUrl: previews[0] }],
      ['ground-material', { state: 'ready', dataUrl: previews[1] }],
      ['trim-material', { state: 'cooking' }],
    ]);
    globalThis.meshInspectorFixture.explicitGuids();
  }, previews);
  await mesh().locator('img').waitFor();
  await mesh().locator('img').evaluate(image => image.decode());
  assert.deepEqual(await mesh().locator('img').evaluate(image => [image.naturalWidth, image.naturalHeight]), [128, 128]);
  const count = (await opens()).length;
  await mesh().click();
  assert.equal((await opens()).length, count);
  await panel.getByTestId('insp-section-mesh').locator('.asset-ref-combo').click();
  assert.equal((await opens()).length, count);
  await mesh().dblclick();
  assert.equal((await opens()).length, count + 1);
  const opened = (await opens()).at(-1);
  assert.equal(opened.args.guid, 'mesh-guid');
  assert.equal(opened.args.targetId, 'scene');
  assert.equal(opened.args.targetGeneration, 1);
  await mesh().press('Enter');
  assert.equal((await opens()).length, count + 2);
  const trim = panel.getByTestId('insp-material-slot-1').getByTestId('asset-reference-thumbnail');
  assert.equal(await trim.getAttribute('data-preview-state'), 'loading');
  await trim.dblclick();
  assert.equal((await opens()).at(-1).args.guid, 'trim-material');
  await page.evaluate(preview => globalThis.meshInspectorFixture.thumbnails([['trim-material', { state: 'ready', dataUrl: preview }]]), previews[1]);
  await trim.locator('img').waitFor();
  assert.equal(await panel.getByTestId('insp-material-slot-2').getByTestId('asset-reference-thumbnail').isDisabled(), true);
  for (const theme of ['light', 'dark']) for (const width of [220, 280, 360, 640]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const geometry = await panel.locator('.asset-ref').evaluateAll(references => references.filter(element => element.getClientRects().length).map(element => {
      const thumb = element.querySelector('.asset-ref-thumb'), image = thumb.querySelector('img');
      const rect = thumb.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fit: image ? getComputedStyle(image).objectFit : null,
        escaped: element.getBoundingClientRect().right > innerWidth + 1 };
    }));
    assert(geometry.length >= 4);
    assert(geometry.every(rect => rect.width === 64 && rect.height === 64 && !rect.escaped), `${width}/${theme}: ${JSON.stringify(geometry)}`);
    assert(geometry.filter(rect => rect.fit).every(rect => rect.fit === 'contain'));
    await panel.getByTestId('insp-scroll').evaluate(element => { element.scrollTop = 200; });
    await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
  }
  const beforeReturn = await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').length);
  await page.evaluate(() => { globalThis.meshInspectorFixture.select('part'); globalThis.meshInspectorFixture.select('floor'); });
  await page.waitForFunction(previous => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').length > previous, beforeReturn);
  await mesh().locator('img').waitFor();
  const beforeHide = await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').length);
  await page.locator('#app').evaluate(element => { element.hidden = true; });
  await page.waitForFunction(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').every(call => call.aborted));
  await page.evaluate(() => globalThis.meshInspectorFixture.thumbnails([['mesh-guid', { state: 'cooking' }]]));
  assert.equal(await page.evaluate(() => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').length), beforeHide);
  await page.locator('#app').evaluate(element => { element.hidden = false; });
  await page.waitForFunction(previous => globalThis.meshInspectorFixture.calls.filter(call => call.operation === 'assets.thumbnails').length > previous, beforeHide);
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-section-mesh"] .asset-ref-thumb')?.dataset.previewState === 'loading');
  await page.evaluate(preview => globalThis.meshInspectorFixture.thumbnails([['mesh-guid', { state: 'ready', dataUrl: preview }]]), previews[0]);
  await mesh().locator('img').waitFor();
  await page.evaluate(() => {
    globalThis.meshInspectorFixture.thumbnails([
      ['mesh-guid', { state: 'failed' }], ['trim-material', { state: 'unsupported' }],
      ['texture-guid', { state: 'ready', dataUrl: 'data:image/png;base64,broken' }],
    ]);
    globalThis.meshInspectorFixture.textureReference();
    globalThis.meshInspectorFixture.catalogChanged();
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-section-mesh"] .asset-ref-thumb')?.dataset.previewState === 'failed');
  assert.equal(await mesh().isDisabled(), false);
  assert.match(await mesh().getAttribute('title'), /资产预览失败/);
  await mesh().dblclick();
  assert.equal((await opens()).at(-1).args.guid, 'mesh-guid');
  assert.equal(await trim.getAttribute('data-preview-state'), 'unsupported');
  assert.equal(await trim.isDisabled(), false);
  await panel.getByTestId('insp-group-all').click();
  const texture = panel.getByTestId('insp-field-CustomTexture-map').getByTestId('asset-reference-thumbnail');
  await texture.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-field-CustomTexture-map"] .asset-ref-thumb')?.dataset.previewState === 'failed');
  assert.equal(await texture.locator('img').count(), 0, 'invalid image uses the type icon');
  await texture.dblclick();
  assert.equal((await opens()).at(-1).args.guid, 'texture-guid');
  await panel.getByTestId('insp-group-common').click();
  await page.evaluate(() => globalThis.meshInspectorFixture.fail('asset.open'));
  await mesh().dblclick();
  await panel.getByRole('alert').filter({ hasText: 'asset.open unavailable' }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'verification.json'), JSON.stringify({ pngSource: 'Game 3D Engine assets.thumbnails cached PNGs',
    rendererScope: 'Changed Inspector with fixture transport; no new native Codex/GPU acceptance claim',
    themes: ['light', 'dark'], widths: [220, 280, 360, 640], errors, passed: true }, null, 2));
  console.log(`Inspector thumbnail UI passed: ${output}`);
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temporary, { recursive: true, force: true });
}
