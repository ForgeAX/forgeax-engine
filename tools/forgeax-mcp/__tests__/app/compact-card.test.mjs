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

test('compact card resizes across pending, error, recovery and collapse while retaining first-open fullscreen', async () => {
  const evidence = process.env.FORGEAX_COMPACT_EVIDENCE ? resolve(process.env.FORGEAX_COMPACT_EVIDENCE)
    : await mkdtemp(join(tmpdir(), 'forgeax-compact-card-'));
  await mkdir(evidence, { recursive: true });
  const carrier = (await readFile(process.env.FORGEAX_TEST_CARRIER ?? new URL('../../dist/carrier.html', import.meta.url), 'utf8'))
    .replace('__FX_VIEW_ENTRY_SCOPE__', '"workspace"').replace('__FX_VIEW_ENTRY_KIND__', '"card"');
  await writeFile(join(evidence, 'frozen-carrier.html'), carrier);
  const host = (await build({ entryPoints: [join(import.meta.dirname, 'support/compact-card-host.ts')], bundle: true,
    write: false, platform: 'browser', format: 'esm' })).outputFiles[0].text;
  let browser, server;
  const errors = [];
  try {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(request.url === '/carrier' ? carrier : `<!doctype html><iframe id="card" sandbox="allow-scripts" style="width:400px;height:480px;border:0"></iframe><script id="test-config" type="application/json">${JSON.stringify({ actionTool: RESOURCE_ACTION_TOOL })}</script><script type="module">${host.replaceAll('</script', '<\\/script')}</script>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({
      ...(process.env.FORGEAX_BROWSER_EXECUTABLE
        ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE }
        : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }),
      headless: false, chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 620, height: 640 } });
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const card = page.frameLocator('#card'), button = card.locator('#resource-card button').first();
    await button.waitFor({ state: 'visible' });
    const measure = () => card.locator('body').evaluate(body => ({ bodyHeight: body.getBoundingClientRect().height,
      contentHeight: document.querySelector('#resource-card').getBoundingClientRect().height, text: body.innerText,
      buttonHeight: document.querySelector('#resource-card button').getBoundingClientRect().height }));
    const finish = () => button.evaluate(element => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => !element.disabled ? resolve() : Date.now() >= deadline ? reject(new Error('Resource action did not finish')) : setTimeout(check, 10);
      check();
    }));
    const assertResize = async height => {
      await page.waitForFunction(height => window.compactCardHost.sizes().some(value => Math.abs(value.height - height) <= 2), height);
    };
    const idle = await measure(); await page.screenshot({ path: join(evidence, 'idle-400px.png') });
    await page.evaluate(() => window.compactCardHost.pause());
    await button.click();
    await card.locator('[role="status"]').waitFor({ state: 'visible' });
    assert.equal(await button.isDisabled(), true);
    const pending = await measure();
    assert.ok(pending.bodyHeight > idle.bodyHeight, 'Pending status adds natural height');
    assert.ok(pending.text.includes('Opening asset source'));
    await assertResize(pending.bodyHeight);
    await page.evaluate(() => window.compactCardHost.release());
    await finish();
    const success = await measure();
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ idle, success, sizes: await page.evaluate(() => window.compactCardHost.sizes()) }, null, 2));
    assert.ok(idle.bodyHeight <= 80, `Idle body should fit its content, received ${idle.bodyHeight}px`);
    assert.equal(idle.text.includes('ForgeAX View'), false, 'Native header already supplies the title');
    assert.equal(success.text.split('archway.scene.pack.json').length - 1, 1, 'Successful selection must not duplicate the button label');
    assert.ok(idle.buttonHeight >= 30 && idle.buttonHeight <= 36);
    await assertResize(idle.bodyHeight);
    await page.evaluate(() => window.compactCardHost.fail());
    await button.click();
    await card.locator('[role="alert"]').waitFor({ state: 'visible' });
    await finish();
    const failed = await measure();
    assert.ok(failed.bodyHeight > idle.bodyHeight, 'Visible error increases natural content height');
    assert.ok(failed.text.includes('This source was removed'));
    assert.equal(failed.text.split('This source was removed').length - 1, 1);
    assert.equal(await card.locator('#carrier-error').count(), 0, 'Action failure stays in the card status');
    await assertResize(failed.bodyHeight);
    await page.screenshot({ path: join(evidence, 'error-400px.png') });
    await page.evaluate(() => window.compactCardHost.recover());
    await button.click();
    await card.locator('[role="alert"]').waitFor({ state: 'detached' });
    await finish();
    const recovered = await measure(); assert.ok(recovered.bodyHeight <= 80);
    assert.equal(await card.locator('[role="status"]').isHidden(), true);
    await page.evaluate(() => window.compactCardHost.resources([
      { path: '/consumer/archway.scene.pack.json', label: 'archway.scene.pack.json' },
      { path: '/consumer/link-demo.pack.ts', label: 'link-demo.pack.ts' },
    ]));
    await card.locator('#resource-card button').nth(1).waitFor({ state: 'visible' });
    await page.locator('#card').evaluate(element => { element.style.width = '180px'; });
    await card.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const wrapped = await measure(); assert.ok(wrapped.bodyHeight > recovered.bodyHeight, 'Narrow grouped buttons wrap and resize');
    await assertResize(wrapped.bodyHeight);
    await page.screenshot({ path: join(evidence, 'wrapped-180px.png') });
    await page.evaluate(() => window.compactCardHost.mode('fullscreen'));
    await card.locator('#resource-card').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.compactCardHost.mode('inline'));
    await card.locator('#resource-card').waitFor({ state: 'visible' });
    const collapsed = await measure(); assert.ok(Math.abs(collapsed.bodyHeight - wrapped.bodyHeight) <= 2);
    await assertResize(collapsed.bodyHeight);
    assert.deepEqual(await page.evaluate(() => window.compactCardHost.displayRequests()), [], 'Reuse and host context changes must not request fullscreen');
    await page.evaluate(() => window.compactCardHost.open());
    await card.locator('#resource-card button').first().click();
    await card.locator('[role="alert"]').waitFor({ state: 'visible' });
    await finish();
    assert.match(await card.locator('[role="alert"]').textContent(), /host did not expand/);
    assert.deepEqual(await page.evaluate(() => window.compactCardHost.displayRequests()), ['fullscreen'], 'First open retains the one supported fullscreen request');
    const calls = await page.evaluate(() => window.compactCardHost.calls());
    const cancelled = calls.filter(call => call.name === RESOURCE_ACTION_TOOL && call.arguments?.cancel);
    assert.equal(cancelled.length, 1, 'Denied fullscreen releases the owned initial reservation');
    assert.equal(cancelled[0].arguments.path, '/consumer/archway.scene.pack.json');
    assert.equal(!!await card.locator('#view').getAttribute('srcdoc'), false);
    assert.deepEqual(errors, [], 'Manual mode and card actions must not create page errors');
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ idle, pending, success, failed, recovered, wrapped, collapsed,
      sizes: await page.evaluate(() => window.compactCardHost.sizes()), displayRequests: await page.evaluate(() => window.compactCardHost.displayRequests()),
      firstOpen: { deniedByReferenceHost: true, reservationCancelled: cancelled.length, localViewMounted: false }, errors }, null, 2));
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, backendStarted: false }));
  }
});
