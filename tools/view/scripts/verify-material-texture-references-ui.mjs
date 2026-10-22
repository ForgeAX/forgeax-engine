import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/material-texture-references-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-material-textures-'));
let browser, server, page;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/material-texture-references-ui.tsx'], outfile: resolve(temporary, 'ui.js'),
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{width:360px;height:900px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>'); return; }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'],
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = guid => page.getByTestId(`material-texture-${guid}`);
  const first = card('base-color'), thumb = first.getByTestId('asset-reference-thumbnail');
  const fixture = async (method, ...args) => page.evaluate(({ method, args }) => globalThis.materialTexturesFixture[method](...args), { method, args });
  const preview = async (guid, state = 'ready') => page.waitForFunction(({ guid, state }) => document.querySelector(`[data-testid="material-texture-${guid}"] [data-testid="asset-reference-thumbnail"]`)?.dataset.previewState === state, { guid, state });
  await preview('base-color');
  assert.equal(await page.locator('.material-texture-reference').count(), 3);
  const headings = page.locator('.material-properties-body > .fx-inspector-form > .fx-inspector-form__group > .fx-collapsible > .fx-collapsible__heading > .fx-collapsible__trigger');
  assert.deepEqual((await headings.allTextContents()).map(text => text.trim()), ['Material facts', 'Texture references', 'Passes']);
  const openCount = () => page.evaluate(() => globalThis.materialTexturesFixture.calls.filter(call => call.operation === 'asset.open').length);
  await first.getByRole('textbox').dblclick(); await thumb.click(); assert.equal(await openCount(), 0);
  await thumb.dblclick(); assert.equal(await openCount(), 1);
  await thumb.focus(); await page.keyboard.press('Enter'); assert.equal(await openCount(), 2);
  await first.getByTestId('asset-reference-open').click(); assert.equal(await openCount(), 3);
  await first.getByRole('button', { name: 'Browse to texture', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.materialTexturesFixture.calls.find(call => call.operation === 'asset.browse').args.guid), 'base-color');
  for (const theme of ['light', 'dark']) for (const width of [280, 360]) {
    await page.evaluate(({ theme, width }) => { document.documentElement.dataset.theme = theme; document.getElementById('app').style.width = `${width}px`; }, { theme, width });
    await first.scrollIntoViewIfNeeded();
    assert(await first.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert.equal(Math.round((await thumb.boundingBox()).width), 64);
    assert.equal(await first.locator('img').evaluate(element => getComputedStyle(element).objectFit), 'contain');
    await page.locator('#app').screenshot({ path: resolve(output, `${theme}-${width}.png`) });
  }
  await fixture('longName');
  assert(await first.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await fixture('set', { failed: true }); await preview('base-color', 'failed');
  assert.equal(await first.getByTestId('asset-reference-open').isEnabled(), true);
  await thumb.dblclick(); assert.equal(await openCount(), 4);
  await fixture('set', { failed: false, unsupported: true }); await preview('base-color', 'unsupported');
  assert.equal(await first.getByTestId('asset-reference-open').isEnabled(), true);
  await fixture('set', { unsupported: false, queued: true }); await preview('base-color', 'loading');
  const before = await thumb.boundingBox();
  await fixture('ready'); await preview('base-color');
  assert.deepEqual(await thumb.boundingBox(), before);
  await fixture('defer'); await fixture('replace');
  await page.waitForFunction(() => globalThis.materialTexturesFixture.pending());
  await fixture('select', 'other'); await fixture('finish');
  await card('other-texture').waitFor(); assert.equal(await first.count(), 0);
  await fixture('select', 'ground'); await preview('base-color');
  await page.evaluate(() => { document.getElementById('app').style.display = 'none'; });
  await page.waitForFunction(() => globalThis.materialTexturesFixture.listeners() === 0);
  assert(await page.evaluate(() => globalThis.materialTexturesFixture.calls.filter(call => call.operation === 'assets.thumbnails').every(call => call.aborted)));
  await page.evaluate(() => { document.getElementById('app').style.display = ''; }); await preview('base-color');
  await fixture('set', { missingReference: true });
  await page.getByText('Reference information incomplete: 1 assets unavailable').waitFor();
  assert.equal(await card('missing').count(), 0, 'Unknown asset identities must not become navigable texture cards');
  await fixture('set', { missingPublication: true });
  await page.getByText('Texture reference publication unavailable').waitFor(); assert.equal(await first.count(), 0);
  const inspections = await page.evaluate(() => globalThis.materialTexturesFixture.calls.filter(call => call.operation === 'asset.inspect').length);
  assert.equal(inspections, 0, 'A bound preview must never fall back to inspection');
  await fixture('set', { missingPublication: false, bound: false, missingReference: false }); await preview('base-color');
  assert(await page.evaluate(() => globalThis.materialTexturesFixture.calls.some(call => call.operation === 'asset.inspect')));
  await fixture('defer'); await fixture('replace');
  await page.waitForFunction(() => globalThis.materialTexturesFixture.pending());
  await fixture('select', 'other'); await fixture('finish'); await card('other-texture').waitFor();
  assert.equal(await first.count(), 0, 'A late inspection must not populate the next material');
  await fixture('select', 'ground'); await fixture('set', { bound: true, empty: true });
  await page.getByText('No texture references', { exact: true }).waitFor();
  await fixture('set', { empty: false, many: true }); await preview('extra-64');
  assert.equal(await page.locator('.material-texture-reference').count(), 65);
  assert(await page.evaluate(() => globalThis.materialTexturesFixture.calls.filter(call => call.operation === 'assets.thumbnails').every(call => call.args.guids.length <= 32)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output, opens: await openCount() }));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temporary, { recursive: true, force: true });
}
