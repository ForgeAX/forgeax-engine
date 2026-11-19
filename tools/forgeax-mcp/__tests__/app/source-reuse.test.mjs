import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { RESOURCE_ACTION_TOOL } from '../../src/contract.ts';

test('an inline resource card with a completed reused disposition neither expands nor mounts another View', async () => {
  const evidence = process.env.FORGEAX_REUSE_EVIDENCE ? resolve(process.env.FORGEAX_REUSE_EVIDENCE)
    : await mkdtemp(join(tmpdir(), 'forgeax-source-reuse-'));
  await mkdir(evidence, { recursive: true });
  const artifact = process.env.FORGEAX_TEST_CARRIER ?? new URL('../../dist/carrier.html', import.meta.url);
  const carrier = (await readFile(artifact, 'utf8')).replace('__FX_VIEW_ENTRY_SCOPE__', '"workspace"').replace('__FX_VIEW_ENTRY_KIND__', '"card"');
  await writeFile(join(evidence, 'frozen-carrier.html'), carrier);
  const host = (await build({ entryPoints: [join(import.meta.dirname, 'support/source-reuse-host.ts')], bundle: true,
    write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text;
  let browser, server, result;
  const errors = [];
  try {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/carrier') { response.end(carrier); return; }
      response.end(`<!doctype html><div id="existing-presenter">Existing full View</div><iframe id="card" sandbox="allow-scripts" style="width:700px;height:240px"></iframe><script id="test-config" type="application/json">${JSON.stringify({ actionTool: RESOURCE_ACTION_TOOL })}</script><script type="module">${host.replaceAll('</script', '<\\/script')}</script>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({
      ...(process.env.FORGEAX_BROWSER_EXECUTABLE
        ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE }
        : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }),
      headless: false, chromiumSandbox: true,
    });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const card = page.frameLocator('#card');
    const button = card.locator('#resource-card button');
    await button.click();
    await button.evaluate(element => new Promise((done, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (!element.disabled) return done(true);
        if (Date.now() >= deadline) return reject(new Error('Selection did not finish'));
        setTimeout(check, 20);
      }; check();
    }));
    result = await page.evaluate(() => ({ calls: window.sourceReuseHost.calls(), displayRequests: window.sourceReuseHost.displayRequests() }));
    result.status = await card.locator('[role="status"]').textContent();
    result.localViewMounted = !!await card.locator('#view').getAttribute('srcdoc');
    result.cardVisible = await card.locator('#resource-card').isVisible();
    result.errors = errors;
    await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: join(evidence, 'card-after-reused.png') });
    assert.deepEqual(result.displayRequests, [], 'Already dispatched to the existing presenter: a second fullscreen request creates a duplicate native tab');
    const selected = result.calls.filter(call => call.name === RESOURCE_ACTION_TOOL);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].arguments.path, '/consumer/assets/archway.scene.pack.json');
    assert.equal(selected[0].arguments.entryScope, 'workspace');
    assert.equal(selected[0].arguments.displayMode, 'inline');
    assert.match(selected[0].arguments.appDocumentId, /^[0-9a-f-]{36}$/);
    assert.equal(result.calls.some(call => ['view-document', 'backend-start', 'host-open'].includes(call.arguments?.action)), false);
    assert.equal(result.localViewMounted, false); assert.equal(result.cardVisible, true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, backendStarted: false }));
  }
});
