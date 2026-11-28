/** Real Chromium UI probe over explicit fixture responses; no Engine/GPU acceptance. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { importRuntimeContent, openRuntimeContent, saveRuntimeContent } from './runtime-content-import.mjs';
import { browserProofWorkload } from './browser-proof-workload.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/runtime-content-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-runtime-content-ui-'));
let browser;
let server;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/runtime-content-ui.ts'], outfile: resolve(temporary, 'ui.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  const html = '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{height:100vh}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>';
  server = createServer(async (request, response) => {
    if (request.url === '/' || request.url === '/?defer-inspection=1' || request.url === '/?thumbnail-revision=1') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }), args: ['--disable-gpu'], chromiumSandbox: true});
  const page = await browser.newPage({ viewport: browserProofWorkload().runtimeViewport, acceptDownloads: true });
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    const exports = new Set();
    URL.createObjectURL = blob => {
      const url = create(blob);
      if (blob.type === 'application/json') exports.add(url);
      return url;
    };
    URL.revokeObjectURL = url => { exports.delete(url); revoke(url); };
    globalThis.__runtimeContentExports = exports;
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openRuntimeContent(page);
  assert.equal(await page.evaluate(() => globalThis.runtimeContentFixture.revealed()), 1);
  await page.getByLabel('Generator', { exact: true }).selectOption({ label: 'Box generator' });
  await page.getByLabel('width', { exact: true }).fill('8');
  const selectedGenerator = await page.getByLabel('Generator', { exact: true }).inputValue();
  const readsBeforeLocaleChange = await page.evaluate(() => globalThis.runtimeContentFixture.calls.length);
  await page.evaluate(() => {
    globalThis.__localizedWidthInput = document.querySelector('input[aria-label="width"]');
    globalThis.runtimeContentFixture.setLocale('zh');
  });
  await page.getByRole('button', { name: '生成', exact: true }).waitFor();
  assert.equal(await page.getByLabel('生成器', { exact: true }).inputValue(), selectedGenerator);
  assert.equal(await page.getByLabel('width', { exact: true }).inputValue(), '8');
  assert.equal(await page.evaluate(() => globalThis.__localizedWidthInput === document.activeElement), true,
    'switching locale retains the actual parameter input and focus');
  assert.equal(await page.evaluate(() => globalThis.runtimeContentFixture.calls.length), readsBeforeLocaleChange,
    'translation does not remount the panel or repeat Engine reads');
  await page.screenshot({ path: resolve(output, 'runtime-content-zh.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'runtime-content-zh-mobile.png') });
  await page.setViewportSize(browserProofWorkload().runtimeViewport);
  await page.evaluate(() => globalThis.runtimeContentFixture.setLocale('en'));
  await page.getByRole('button', { name: 'Generate', exact: true }).waitFor();
  assert.equal(await page.getByLabel('width', { exact: true }).inputValue(), '8');
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
  await page.evaluate(() => globalThis.runtimeContentFixture.deferSnapshot());
  const downloadEvent = saveRuntimeContent(page, page.getByTestId('runtime-content'));
  // The real snapshot crosses a process boundary and may outlive transient activation.
  await page.waitForTimeout(5100);
  await page.evaluate(() => globalThis.runtimeContentFixture.completeSnapshot());
  const download = await downloadEvent;
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(saved.instances[0].values.width, 3);
  assert.equal(await page.evaluate(() => globalThis.__runtimeContentExports.size), 1,
    'the asynchronous native download retains its bytes for the panel lifetime');
  const previousExport = await page.evaluate(() => [...globalThis.__runtimeContentExports][0]);
  const nextDownload = saveRuntimeContent(page, page.getByTestId('runtime-content'));
  assert.deepEqual(JSON.parse(await readFile(await (await nextDownload).path(), 'utf8')), saved);
  assert.equal(await page.evaluate(previous => globalThis.__runtimeContentExports.size === 1
    && !globalThis.__runtimeContentExports.has(previous), previousExport), true,
  'repeated saves retain only the latest export');
  await importRuntimeContent(page, page.getByTestId('runtime-content'), { name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.some(call => call.operation === 'runtime-pack.restore'));
  const currentSnapshot = { ...saved, schemaVersion: 'runtime-pack-source/3' };
  await importRuntimeContent(page, page.getByTestId('runtime-content'), {
    name: 'saved-v3.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(currentSnapshot)),
  });
  await page.waitForFunction(() => globalThis.runtimeContentFixture.calls.some(call =>
    call.operation === 'runtime-pack.restore' && call.args.snapshot.schemaVersion === 'runtime-pack-source/3'));
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
  await page.waitForFunction(() => globalThis.__runtimeContentExports.size === 0);
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
  // Readiness may exceed the download budget; no export starts while disabled.
  await page.goto(`http://127.0.0.1:${server.address().port}/?defer-inspection=1`);
  await openRuntimeContent(page);
  const pendingSave = page.getByTestId('runtime-content');
  assert.equal(await pendingSave.getByRole('button', { name: 'Save content', exact: true }).isDisabled(), true);
  const [coldDownload] = await Promise.all([
    saveRuntimeContent(page, pendingSave, { timeout: 200 }),
    (async () => {
      await page.waitForTimeout(400);
      await page.evaluate(() => globalThis.runtimeContentFixture.completeInspection());
    })(),
  ]);
  assert.equal(JSON.parse(await readFile(await coldDownload.path(), 'utf8')).schemaVersion, 'runtime-pack-source/2');
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
