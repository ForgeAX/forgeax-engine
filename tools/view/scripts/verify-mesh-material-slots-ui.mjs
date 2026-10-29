import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/mesh-material-slots-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-mesh-slots-'));
let browser, server, page;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/mesh-material-slots-ui.tsx'], outfile: resolve(temporary, 'ui.js'),
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{width:360px;height:900px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>'); return; }
    if (request.url === '/thumbnail.png') { response.setHeader('content-type', 'image/png'); response.end(await readFile(resolve(root, 'packages/view-components/src/story-assets/fantasy-azure.png'))); return; }
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
  const slot = index => page.getByTestId(`mesh-material-slot-${index}`);
  const first = slot(0), thumb = first.getByTestId('asset-reference-thumbnail');
  await first.getByTestId('asset-reference-open').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-material-slot-0"] img')?.naturalWidth > 0);
  const sectionHeaders = page.locator('.mesh-properties-body > .fx-inspector-form > .fx-inspector-form__group > .fx-collapsible > .fx-collapsible__heading > .fx-collapsible__trigger');
  assert.deepEqual((await sectionHeaders.allTextContents()).map(text => text.trim()), ['Mesh facts', 'Material slots', 'Submeshes', 'Collision']);
  const sectionStyles = await sectionHeaders.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderLeftColor, borderWidth: style.borderLeftWidth, padding: style.paddingLeft, height: element.getBoundingClientRect().height, icons: element.querySelectorAll('.fx-inspector-form__icon svg').length };
  }));
  assert.equal(sectionStyles[1].background, sectionStyles[0].background);
  assert.equal(sectionStyles[1].padding, sectionStyles[0].padding);
  assert.equal(sectionStyles[1].height, sectionStyles[0].height);
  assert.equal(sectionStyles[1].borderWidth, sectionStyles[0].borderWidth);
  assert.equal(sectionStyles[1].icons, 1);
  assert(sectionStyles.filter((_, index) => index !== 1).every(style => style.border !== sectionStyles[1].border));
  assert.equal(await slot(3).getByTestId('asset-reference-open').isDisabled(), true);
  assert.equal(await first.getByText('Source Key', { exact: true }).isVisible(), false);
  const openCount = () => page.evaluate(() => globalThis.meshSlotsFixture.calls.filter(call => call.operation === 'asset.open').length);
  await first.getByRole('textbox').dblclick(); assert.equal(await openCount(), 0);
  await thumb.click(); assert.equal(await openCount(), 0);
  await first.getByTestId('asset-reference-open').click(); assert.equal(await openCount(), 1);
  await thumb.dblclick(); assert.equal(await openCount(), 2);
  await thumb.focus(); await page.keyboard.press('Enter'); assert.equal(await openCount(), 3);
  await slot(2).getByTestId('asset-reference-open').click();
  assert.equal(await page.evaluate(() => globalThis.meshSlotsFixture.calls.filter(call => call.operation === 'asset.open').at(-1).args.guid), 'material-0');
  await first.getByRole('button', { name: 'Browse to Asset', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.meshSlotsFixture.calls.filter(call => call.operation === 'asset.browse').at(-1).args.guid), 'material-0');
  await first.getByRole('button', { name: 'Slot details' }).click();
  await first.getByText('Source Key', { exact: true }).waitFor({ state: 'visible' });
  await first.getByRole('button', { name: 'Slot details' }).click();
  for (const theme of ['light', 'dark']) for (const width of [220, 280, 360, 640]) {
    await page.evaluate(({ theme, width }) => { document.documentElement.dataset.theme = theme; document.getElementById('app').style.width = `${width}px`; }, { theme, width });
    await first.scrollIntoViewIfNeeded();
    const bounds = await first.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert(bounds.content <= bounds.width + 1, `${theme} ${width}: horizontal overflow`);
    assert.equal(Math.round((await thumb.boundingBox()).width), 64);
    await page.locator('#app').screenshot({ path: resolve(output, `${theme}-${width}.png`) });
  }
  await page.evaluate(() => { globalThis.meshSlotsFixture.longName(); document.getElementById('app').style.width = '220px'; });
  assert(await first.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.evaluate(() => globalThis.meshSlotsFixture.wireframe(true));
  await page.evaluate(() => { document.getElementById('app').style.display = 'none'; });
  await page.waitForFunction(() => globalThis.meshSlotsFixture.calls.filter(call => ['entity.inspect', 'assets.thumbnails'].includes(call.operation)).every(call => call.aborted));
  await page.evaluate(() => { document.getElementById('app').style.display = ''; });
  await first.getByTestId('asset-reference-open').waitFor({ state: 'visible' });
  assert.equal(await first.getByTestId('asset-reference-open').isEnabled(), true);
  await page.evaluate(() => globalThis.meshSlotsFixture.replace());
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-open"]')?.disabled);
  await page.evaluate(() => globalThis.meshSlotsFixture.wireframe(false));
  await page.getByRole('button', { name: 'Reload material references' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-open"]')?.disabled);
  await page.evaluate(() => { globalThis.meshSlotsFixture.defer(); globalThis.meshSlotsFixture.replace(); });
  await page.waitForFunction(() => globalThis.meshSlotsFixture.pending());
  await page.evaluate(() => { globalThis.meshSlotsFixture.wireframe(true); globalThis.meshSlotsFixture.replace(); globalThis.meshSlotsFixture.finish(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-open"]')?.disabled);
  await page.evaluate(() => { globalThis.meshSlotsFixture.wireframe(false); globalThis.meshSlotsFixture.removeMaterial(); });
  await page.waitForFunction(() => !document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-open"]')?.disabled);
  assert.equal(await slot(1).getByTestId('asset-reference-open').isDisabled(), true);
  await page.evaluate(() => { globalThis.meshSlotsFixture.failThumbnails(); document.getElementById('app').style.display = 'none'; });
  await page.waitForFunction(() => globalThis.meshSlotsFixture.calls.filter(call => call.operation === 'assets.thumbnails').every(call => call.aborted));
  await page.evaluate(() => { document.getElementById('app').style.display = ''; });
  await page.waitForFunction(() => document.querySelector('[data-testid="mesh-material-slot-0"] [data-testid="asset-reference-thumbnail"]')?.dataset.previewState === 'failed');
  assert.equal(await first.getByTestId('asset-reference-open').isEnabled(), true);
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
