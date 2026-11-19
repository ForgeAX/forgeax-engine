import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/volumetric-cloud-inspection-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'view-cloud-inspection-'));
let browser, server, page;
try {
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/volumetric-cloud-inspection-ui.tsx'], outfile: resolve(temporary, 'ui.js'),
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
  server = createServer(async (request, response) => {
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><style>body{margin:0}#app{width:360px;height:950px}</style><div id="app"></div><script type="module" src="/ui.js"></script></html>');
      return;
    }
    if (!['/ui.js', '/ui.css'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(resolve(temporary, request.url.slice(1))));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true,
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : {}), chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1100, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const cloud = page.getByTestId('insp-comprow-VolumetricCloudLayer');
  const field = key => page.getByTestId(`insp-field-VolumetricCloudLayer-${key}`);
  const section = key => page.getByTestId(`insp-section-VolumetricCloudLayer.${key}`);
  const fixture = (method, ...args) => page.evaluate(({ method, args }) => globalThis.cloudInspectionFixture[method](...args), { method, args });
  await cloud.waitFor();
  assert.equal(await page.getByTestId('panel-inspector').getAttribute('data-view-readonly'), 'true');
  assert.equal(await page.getByRole('button', { name: /^(Save|Generate|Expose)/ }).count(), 0);
  assert.equal(await field('bottomMeters').locator('input').inputValue(), '5000');
  assert.match(await field('bottomMeters').innerText(), /Layer bottom \(m\)/);
  assert.equal(await field('extinctionOverridePerMeter').getByText('Inherit material', { exact: true }).count(), 1);
  assert.equal(await field('diagnosticMode').isVisible(), false);
  await fixture('setLocale', 'zh');
  await cloud.getByText('体积云', { exact: true }).waitFor();
  await page.getByTestId('insp-search').fill('视图采样倍率');
  await field('viewSampleCountScale').waitFor();
  assert.equal(await field('viewSampleCountScale').locator('input').inputValue(), '1');
  assert.equal(await field('viewSampleCountScale').locator('input').isEditable(), false);
  await page.getByTestId('insp-search').fill('停止透射阈值');
  await field('stopTransmittance').waitFor();
  assert.equal(await field('stopTransmittance').locator('input').inputValue(), '0.005');
  assert.equal(await field('stopTransmittance').locator('input').isEditable(), false);
  await field('stopTransmittance').getByRole('button', { name: '复制值', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.clipboard.at(-1)), '0.005');
  await page.getByTestId('insp-search').fill('诊断模式');
  await field('diagnosticMode').waitFor();
  assert.equal(await field('diagnosticMode').isVisible(), true);
  await cloud.click();
  assert.equal(await page.getByTestId('insp-search').inputValue(), '');
  assert.equal(await page.getByTestId('insp-group-all').getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByTestId('insp-section-Transform').count(), 1);
  await section('layer').getByRole('button', { name: '云层', exact: true }).waitFor();
  await section('advanced').getByRole('button', { name: '渲染与高级（ForgeaX 扩展）', exact: true }).click();
  await field('viewSampleCountScale').scrollIntoViewIfNeeded();
  await page.locator('#app').screenshot({ path: resolve(output, 'zh-advanced.png') });
  await section('overrides').getByRole('button', { name: '材质覆盖（ForgeaX 扩展）', exact: true }).click();
  await section('overrides').getByRole('button', { name: '材质覆盖（ForgeaX 扩展）', exact: true }).click();
  await field('extinctionOverridePerMeter').getByRole('button', { name: '复制值', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.clipboard.at(-1)), '-1');
  await field('material').getByTestId('asset-reference-open').click();
  assert.deepEqual(await page.evaluate(() => globalThis.cloudInspectionFixture.calls.find(call => call.operation === 'asset.open').args), {
    projectId: 'cloud-project', targetId: 'scene-preview', targetGeneration: 3, guid: 'material-guid',
  });
  assert.equal(await field('material').getByTestId('asset-reference-field').count(), 1);
  assert.equal(await field('material').getByRole('button', { name: '使用选中的资源', exact: true }).count(), 0);
  assert.equal(await field('material').getByRole('button', { name: '浏览至资产', exact: true }).count(), 0);
  await field('material').getByRole('button', { name: '在内容浏览器中定位', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.calls.find(call => call.operation === 'asset.browse').args.guid), 'material-guid');
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.calls.filter(call => call.operation === 'asset.browse').length), 1);
  await field('material').getByRole('button', { name: '更多引用操作', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: '清除', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '复制 GUID', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.clipboard.at(-1)), 'material-guid');
  const captures = ['zh-advanced.png'];
  for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) for (const width of [280, 360, 520]) {
    await fixture('setLocale', locale);
    await page.evaluate(({ theme, width }) => { document.documentElement.dataset.theme = theme; document.getElementById('app').style.width = `${width}px`; }, { theme, width });
    await cloud.click();
    await field('bottomMeters').scrollIntoViewIfNeeded();
    const overflow = await page.getByTestId('insp-entity-body').evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, `${locale}/${theme}/${width} overflows`);
    const name = `${locale}-${theme}-${width}.png`;
    await page.locator('#app').screenshot({ path: resolve(output, name) });
    captures.push(name);
  }
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.calls.some(call => /draft|generate|update|conversation/.test(call.operation))), false);
  await fixture('setLocale', 'en');
  await page.getByTestId('insp-search').fill('Renderer Observation');
  await field('runtimeAcceptedFrame').waitFor();
  assert.equal(await field('runtimeAcceptedFrame').locator('input').inputValue(), '41');
  assert.equal(await field('runtimeDeviceGeneration').locator('input').inputValue(), '3');
  assert.equal(await field('runtimeAcceptedFrame').locator('input').isEditable(), false);
  await field('runtimeAcceptedFrame').scrollIntoViewIfNeeded();
  await page.locator('#app').screenshot({ path: resolve(output, 'c-renderer-observation.png') });
  captures.push('c-renderer-observation.png');
  await fixture('setRuntimeState', true);
  await field('runtimeObservation').waitFor();
  assert.match(await field('runtimeObservation').innerText(), /Unavailable/);
  assert.equal(await field('runtimeAcceptedFrame').count(), 0);
  await fixture('setRuntimeState', false);
  await field('runtimeAcceptedFrame').waitFor();
  assert.equal(await field('runtimeAcceptedFrame').locator('input').inputValue(), '41');
  await fixture('deferNextInspection');
  await page.waitForFunction(() => globalThis.cloudInspectionFixture.hasDeferredInspection());
  await fixture('replaceTarget');
  await page.waitForFunction(() => globalThis.cloudInspectionFixture.calls.some(call => call.operation === 'entity.inspect' && call.args.targetGeneration === 4));
  // The new selection remounts the body and resets its search; expose the runtime group again.
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-search"]')?.value === '');
  await page.getByTestId('insp-search').fill('Renderer Observation');
  await page.waitForFunction(() => document.querySelector('[data-testid="insp-field-VolumetricCloudLayer-runtimeAcceptedFrame"] input')?.value === '83');
  assert.equal(await field('runtimeDeviceGeneration').locator('input').inputValue(), '4');
  assert.equal(await fixture('hasDeferredInspection'), true);
  await fixture('releaseDeferredInspection');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await field('runtimeAcceptedFrame').locator('input').inputValue(), '83', 'late retired inspection must not replace the current generation');
  assert.equal(await field('runtimeDeviceGeneration').locator('input').inputValue(), '4');
  assert.equal(await page.evaluate(() => globalThis.cloudInspectionFixture.calls.some(call => call.operation === 'entity.inspect' && call.args.targetGeneration === 4)), true);
  assert.deepEqual(errors, []);
  const receipt = { ok: true, scope: 'View presentation fixture; no Engine rendering claim', captures,
    clipboard: await page.evaluate(() => globalThis.cloudInspectionFixture.clipboard),
    calls: await page.evaluate(() => globalThis.cloudInspectionFixture.calls), pageErrors: errors };
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, output, captures: captures.length }));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => server ? server.close(done) : done());
  await rm(temporary, { recursive: true, force: true });
}
