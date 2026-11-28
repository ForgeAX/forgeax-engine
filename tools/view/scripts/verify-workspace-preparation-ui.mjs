import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

export async function verifyWorkspacePreparationUi({ output = '/tmp/view-workspace-preparation' } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'view-preparation-ui-'));
  const errors = [];
  let server, browser;
  try {
    await mkdir(output, { recursive: true });
    await build({ absWorkingDir: resolve(import.meta.dirname, '..'),
      entryPoints: ['test/fixtures/workspace-preparation-ui.tsx'], outfile: join(temporary, 'fixture.js'),
      bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
    server = createServer(async (request, response) => {
      if (new URL(request.url, 'http://localhost').pathname === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"><div id="app"></div><script type="module" src="/fixture.js"></script></html>');
      } else if (['/fixture.js', '/fixture.css'].includes(request.url)) {
        response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
        response.end(await readFile(join(temporary, request.url.slice(1))));
      } else response.writeHead(404).end();
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true,
      ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }), chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    const panel = page.getByRole('complementary', { name: 'Project preparation' });
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await panel.getByText('assets/lighting.pack.ts', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Hide preparation details' }).click();
    assert.ok((await panel.boundingBox()).height <= 40, 'collapsed preparation is one compact row');
    await page.getByRole('button', { name: 'Underlying control', exact: true }).click();
    await page.getByRole('button', { name: 'Underlying control clicked', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Show preparation details' }).click();
    await page.evaluate(() => globalThis.preparationFixture.beforePack());
    await panel.getByText('Preparing project server', { exact: true }).waitFor();
    await panel.getByText('Creating Vite and starting its producer plugins', { exact: true }).waitFor();
    await panel.getByText('42s', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.preparationFixture.shader());
    await panel.getByText('Preparing shaders', { exact: true }).waitFor();
    await panel.getByText('12 / 128 variants compiled for this source', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.preparationFixture.locale('zh'));
    const chinesePanel = page.getByRole('complementary', { name: '项目准备进度' });
    await chinesePanel.getByText('正在准备 Shader', { exact: true }).waitFor();
    await chinesePanel.getByText('当前源文件已编译 12 / 128 个变体', { exact: true }).waitFor();
    await chinesePanel.getByRole('button', { name: '收起准备详情', exact: true }).click();
    await chinesePanel.getByRole('button', { name: '展开准备详情', exact: true }).click();
    await page.evaluate(() => globalThis.preparationFixture.locale('en'));
    await panel.getByText('Preparing shaders', { exact: true }).waitFor();
    assert.match(await panel.textContent(), /default-standard-pbr.wgsl/);
    assert.doesNotMatch(await panel.textContent(), /Waiting for the backend preparation status/);
    await page.reload();
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    await panel.getByText('assets/lighting.pack.ts', { exact: true }).waitFor();
    await panel.getByText('Cached', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.preparationFixture.locale('zh'));
    await chinesePanel.getByText('正在准备资产', { exact: true }).waitFor();
    await chinesePanel.getByText('缓存命中', { exact: true }).waitFor();
    await chinesePanel.getByText('2 个源文件处理中', { exact: true }).waitFor();
    assert.match(await chinesePanel.textContent(), /assets\/lighting\.pack\.ts/);
    assert.doesNotMatch(await chinesePanel.textContent(), /view\.preparation\./);
    await page.evaluate(() => globalThis.preparationFixture.locale('en'));
    await page.screenshot({ path: join(output, 'desktop.png') });
    await page.setViewportSize({ width: 375, height: 667 });
    assert.equal(await panel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        && element.scrollWidth <= element.clientWidth;
    }), true);
    await page.screenshot({ path: join(output, 'mobile.png') });
    await page.evaluate(() => globalThis.preparationFixture.offline());
    await panel.getByText('Host offline, progress paused', { exact: true }).waitFor();
    const elapsed = await panel.locator('.fx-workspace-preparation__elapsed').textContent();
    await page.waitForTimeout(1100);
    assert.equal(await panel.locator('.fx-workspace-preparation__elapsed').textContent(), elapsed);
    await page.evaluate(() => globalThis.preparationFixture.reconnect());
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    await page.reload();
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.preparationFixture.failed());
    await panel.getByText('Project preparation failed', { exact: true }).waitFor();
    assert.match(await panel.textContent(), /Repair assets\/lighting.pack.ts/);
    await panel.getByRole('button', { name: 'Hide preparation details' }).click();
    assert.ok((await panel.boundingBox()).height <= 40, 'collapsed failures hide their diagnostic body');
    await panel.getByRole('button', { name: 'Show preparation details' }).click();
    assert.match(await panel.textContent(), /Repair assets\/lighting.pack.ts/);
    await page.evaluate(() => globalThis.preparationFixture.engineConflict());
    await panel.getByText("Start View from the project's own Engine installation.", { exact: false }).waitFor();
    assert.match(await panel.textContent(), /host=\/source\/engine; project=\/games\/meadow/);
    assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: join(output, 'engine-conflict-mobile.png') });
    await page.evaluate(() => globalThis.preparationFixture.chooser());
    await page.getByRole('button', { name: 'Choose project', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open project' }).waitFor({ state: 'detached' });
    await panel.getByRole('button', { name: 'Hide preparation details' }).click();
    await page.evaluate(() => globalThis.preparationFixture.switchProject());
    await panel.getByText('Preparing project', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Hide preparation details' }).waitFor();
    assert.doesNotMatch(await panel.textContent(), /lighting|geometry|very-long/);
    await page.reload();
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.preparationFixture.ready());
    await panel.getByText('Assets ready, connecting to scene', { exact: true }).waitFor();
    assert.equal(await panel.locator('.fx-workspace-preparation__elapsed').count(), 0);
    await page.goto(`${url}?completed`);
    await panel.getByText('Assets ready, connecting to scene', { exact: true }).waitFor();
    await page.reload();
    await panel.getByText('Assets ready, connecting to scene', { exact: true }).waitFor();
    assert.equal(await panel.locator('.fx-workspace-preparation__elapsed').count(), 0);
    await page.evaluate(() => globalThis.preparationFixture.nextTask());
    await panel.getByText('Preparing assets', { exact: true }).waitFor();
    await panel.getByText('0s', { exact: true }).waitFor();
    assert.doesNotMatch(await panel.textContent(), /lighting|geometry|very-long/);
    await page.evaluate(() => globalThis.preparationFixture.clear());
    await panel.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    return { ok: true, viewports: ['1440x900', '375x667'], locales: ['en', 'zh'], checks: 32 };
  } finally {
    await browser?.close();
    await new Promise(done => server ? server.close(done) : done());
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyWorkspacePreparationUi()));
