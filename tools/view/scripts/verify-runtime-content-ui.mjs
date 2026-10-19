/** Real Chromium UI probe over explicit fixture responses; no Engine/GPU acceptance. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { importRuntimeContent, openRuntimeContent } from './runtime-content-import.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/runtime-content-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-runtime-content-ui-'));
let browser;
let server;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/runtime-content-ui.ts'], outfile: resolve(temporary, 'ui.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{height:800px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>';
  server = createServer(async (request, response) => {
    if (request.url === '/' || request.url === '/?defer-inspection=1' || request.url === '/?thumbnail-revision=1') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), args: ['--disable-gpu'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openRuntimeContent(page);
  assert.equal(await page.evaluate(() => globalThis.runtimeContentFixture.revealed()), 1);
  await page.getByLabel('Generator', { exact: true }).selectOption({ label: 'Box generator' });
  await page.getByLabel('width', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Width must be at most 5' }).waitFor();
  const failedId = await page.evaluate(() => globalThis.runtimeContentFixture.calls.find(call => call.operation === 'runtime-pack.generate').args.instance.packageId);
  assert.equal(await page.getByLabel('Instance', { exact: true }).inputValue(), failedId);
  await page.getByLabel('width', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByText('current · Published generation 1', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Instance', { exact: true }).inputValue(), failedId);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByText('#21 · active', { exact: true }).waitFor();
  await page.locator('.cb-source-name').filter({ hasText: /^content$/ }).click();
  await page.screenshot({ path: resolve(output, 'generated.png') });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save content', exact: true }).click();
  const download = await downloadEvent;
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(saved.instances[0].values.width, 3);
  await importRuntimeContent(page, page.getByTestId('runtime-content'), { name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.some(call => call.operation === 'runtime-pack.restore'));
  await page.getByLabel('width', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Width must be at most 5' }).waitFor();
  await page.getByText('failed · Published generation 1 · Previous successful result', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'failed.png') });
  await page.getByRole('button', { name: 'Dispose', exact: true }).click();
  await page.getByText('No installations.', { exact: true }).waitFor();
  await page.getByLabel('width', { exact: true }).fill('2');
  await page.evaluate(() => globalThis.runtimeContentFixture.deferGeneration());
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.filter(call => call.operation === 'runtime-pack.generate').length === 4);
  await page.evaluate(() => globalThis.runtimeContentFixture.replaceTarget());
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.filter(call => call.operation === 'runtime-pack.generate').at(-1).aborted);
  await page.evaluate(() => globalThis.runtimeContentFixture.completeGeneration());
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.filter(call => call.operation === 'runtime-pack.generate').at(-1).completed);
  await page.getByLabel('Generator', { exact: true }).selectOption({ label: 'Box generator' });
  assert.equal(await page.getByLabel('width', { exact: true }).inputValue(), '1');
  assert.equal(await page.getByLabel('Instance', { exact: true }).inputValue(), '');
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('Download unavailable'); }; });
  await page.getByRole('button', { name: 'Save content', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Download unavailable' }).waitFor();
  await page.evaluate(() => globalThis.runtimeContentFixture.failSave());
  await page.getByRole('button', { name: 'Save content', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Snapshot storage unavailable' }).waitFor();
  const calls = await page.evaluate(() => globalThis.runtimeContentFixture.calls);
  assert(calls.filter(call => call.operation === 'runtime-pack.generate').every(call => call.args.targetId === 'project-target' && call.args.worldId === 'project-world'));
  // A fresh panel deliberately holds its initial Engine inspection. Import
  // must use the same enabled button as a user before delivering saved bytes.
  await page.goto(`http://127.0.0.1:${server.address().port}/?defer-inspection=1`);
  await openRuntimeContent(page);
  const coldPanel = page.getByTestId('runtime-content');
  await coldPanel.getByRole('status').filter({ hasText: 'Waiting for Engine...' }).waitFor();
  assert.equal(await coldPanel.getByRole('button', { name: 'Import content', exact: true }).isDisabled(), true);
  const importing = importRuntimeContent(page, coldPanel, { name: 'cold-content.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await page.screenshot({ path: resolve(output, 'cold-inspection-pending.png') });
  await page.evaluate(() => globalThis.runtimeContentFixture.completeInspection());
  await importing;
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.filter(call => call.operation === 'runtime-pack.restore').length === 1);
  await coldPanel.getByRole('button', { name: 'Save content', exact: true }).click({ trial: true });
  await page.screenshot({ path: resolve(output, 'cold-imported.png') });
  assert.deepEqual(errors, []);
  const coldCalls = await page.evaluate(() => globalThis.runtimeContentFixture.calls);
  assert.equal(coldCalls.filter(call => call.operation === 'runtime-pack.restore').length, 1);
  // A Catalog update can be followed by a thumbnail notification while the new
  // query is pending. Old ready images must not suppress that replacement read.
  await page.goto(`http://127.0.0.1:${server.address().port}/?thumbnail-revision=1`);
  await page.locator('.cb-source-name').filter({ hasText: /^content$/ }).click();
  await page.locator('.cb-group-badge').click();
  const image = page.locator('[data-cb-guid="image-guid"] img');
  await image.waitFor();
  const before = await image.getAttribute('src');
  await page.evaluate(() => globalThis.runtimeContentFixture.reviseThumbnail());
  await page.waitForFunction(() => !document.querySelector('[data-cb-guid="image-guid"] img'));
  await page.evaluate(() => globalThis.runtimeContentFixture.notifyThumbnail());
  await page.evaluate(() => globalThis.runtimeContentFixture.completeThumbnails());
  await page.waitForFunction(before => {
    const image = document.querySelector('[data-cb-guid="image-guid"] img');
    return image && image.getAttribute('src') !== before;
  }, before);
  console.log(JSON.stringify({ evidence: 'Chromium UI with explicit fixture responses; no Engine or renderer', passed: true, screenshots: output, calls: calls.map(call => call.operation), coldCalls: coldCalls.map(call => call.operation) }));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
