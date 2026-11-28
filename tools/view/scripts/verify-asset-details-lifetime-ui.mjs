import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/asset-details-lifetime-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-asset-details-'));
const checks = [], errors = [];
let browser, server, page;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/asset-details-lifetime-ui.tsx'], outfile: resolve(temporary, 'ui.js'),
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  server = createServer(async (request, response) => {
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{width:480px;height:850px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>');
      return;
    }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }), chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 900, height: 950 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const fixture = (method, ...args) => page.evaluate(({ method, args }) => globalThis.assetDetailsFixture[method](...args), { method, args });
  const value = text => page.locator(`input[value="${text}"]`);
  const check = async (name, verify) => {
    try { await verify(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: String(error.message ?? error) }); }
  };
  await value('generation-1').waitFor();
  await check('exact-project-target', async () => {
    const call = await page.evaluate(() => globalThis.assetDetailsFixture.calls.at(-1));
    assert.equal(call.targetId, 'project-target');
    assert.equal(call.targetGeneration, 1);
  });
  await fixture('defer', true);
  await fixture('select', 'cloud-two');
  await page.waitForFunction(() => globalThis.assetDetailsFixture.pending() > 0);
  await check('previous-guid-hidden-during-read', async () => assert.equal(await value('generation-1').count(), 0));
  await fixture('finish');
  await value('cloud-two').first().waitFor();
  await fixture('select', 'cloud-three');
  await page.waitForFunction(() => globalThis.assetDetailsFixture.pending() > 0);
  const before = await page.evaluate(() => globalThis.assetDetailsFixture.calls.length);
  await fixture('replace');
  await check('old-target-read-cancelled-at-publication', async () => {
    assert.equal(await page.evaluate(index => globalThis.assetDetailsFixture.calls[index - 1].aborted, before), true);
  });
  await check('same-guid-new-generation-reinspected', async () => {
    await page.waitForFunction(before => globalThis.assetDetailsFixture.calls.length > before, before, { timeout: 2500 });
  });
  await fixture('finish');
  await fixture('defer', false);
  await check('late-old-generation-cannot-publish', async () => {
    await value('generation-2').waitFor({ timeout: 2500 });
    assert.equal(await value('generation-1').count(), 0);
  });
  await fixture('select', 'program-current');
  await page.getByTestId('cloud-material-details').waitFor();
  await page.getByRole('button', { name: 'Cooked program and variants', exact: true }).click();
  await page.getByRole('button', { name: 'Declared asset dependencies', exact: true }).click();
  await check('public-program-and-static-choice', async () => {
    for (const text of ['cook-2', 'density-kernel', 'authored-program', 'program-digest', 'compiler-identity', 'renderer-digest', 'Selected']) {
      await value(text).waitFor();
      assert.equal(await value(text).isEditable(), false);
    }
    assert.equal(await page.locator('input').evaluateAll(inputs => inputs.some(input => input.value === '{"detail":false}' && input.readOnly)), true);
    assert.match(await page.getByTestId('cloud-material-details').innerText(), /Registry-resolved static choices/);
    assert.equal(await page.getByRole('button', { name: /^(Apply|Save|Generate)$/ }).count(), 0);
  });
  await check('declarations-retain-identity-and-missing-state', async () => {
    const references = page.getByTestId('asset-reference-field');
    assert.equal(await references.count(), 2);
    await references.filter({ hasText: 'Declared noise' }).getByTestId('asset-reference-open').click();
    assert.deepEqual(await page.evaluate(() => globalThis.assetDetailsFixture.actions), [{ action: 'open', guid: 'declared-noise' }]);
    assert.equal(await references.filter({ hasText: 'Missing asset' }).getByTestId('asset-reference-open').isDisabled(), true);
    assert.match(await page.getByTestId('cloud-material-details').innerText(), /do not prove GPU sampling/);
    assert.match(await page.getByTestId('cloud-material-details').innerText(), /first 512 declared dependencies/);
  });
  for (const locale of ['en', 'zh']) for (const width of [280, 480]) {
    await fixture('setLocale', locale);
    await page.evaluate(width => { document.getElementById('app').style.width = `${width}px`; }, width);
    await check(`program-details-layout-${locale}-${width}`, async () => {
      assert.equal(await page.getByTestId('panel-asset-properties').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    });
    await page.locator('#app').screenshot({ path: resolve(output, `program-${locale}-${width}.png`) });
  }
  await fixture('setLocale', 'en');
  await fixture('select', 'program-missing');
  await page.waitForFunction(() => document.querySelector('[data-testid="panel-asset-properties"]')?.getAttribute('data-asset-guid') === 'program-missing');
  await page.getByRole('button', { name: 'Cooked program and variants', exact: true }).click();
  await check('missing-program-facts-are-unavailable', async () => {
    await page.getByText('Program identities and declared dependencies are unavailable from this Engine inspection.').first().waitFor();
    assert.equal(await value('program-digest').count(), 0);
  });
  await fixture('select', 'program-uniform');
  await page.waitForFunction(() => document.querySelector('[data-testid="panel-asset-properties"]')?.getAttribute('data-asset-guid') === 'program-uniform');
  await page.getByRole('button', { name: 'Cooked program and variants', exact: true }).click();
  await page.getByRole('button', { name: 'Declared asset dependencies', exact: true }).click();
  await check('empty-owner-arrays-stay-empty', async () => {
    await page.getByText('No cooked shader variants.', { exact: true }).waitFor();
    await page.getByText('No declared asset dependencies.', { exact: true }).waitFor();
    assert.equal(await value('program-digest').count(), 0);
  });
  assert.deepEqual(errors, []);
  await page.locator('#app').screenshot({ path: resolve(output, 'asset-details.png') });
  const receipt = { ok: checks.every(check => check.ok), scope: 'View UI lifetime fixture; no Engine rendering or asset-pixel claim', checks,
    calls: await page.evaluate(() => globalThis.assetDetailsFixture.calls), pageErrors: errors };
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  assert(receipt.ok, 'Asset details lifetime regression failed');
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temporary, { recursive: true, force: true });
}
