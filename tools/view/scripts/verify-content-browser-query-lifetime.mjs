import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

export async function verifyContentBrowserQueryLifetime({ output = resolve(process.env.FORGEAX_EVIDENCE_DIR ?? '/tmp/content-browser-query-lifetime') } = {}) {
  const view = resolve(import.meta.dirname, '..');
  const temporary = await mkdtemp(join(tmpdir(), 'view-catalog-lifetime-'));
  let server, browser, page;
  const errors = [];
  try {
    await mkdir(output, { recursive: true });
    await build({ absWorkingDir: view, entryPoints: ['test/fixtures/content-browser-query-lifetime-ui.tsx'],
      outfile: join(temporary, 'fixture.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic' });
    server = createServer(async (request, response) => {
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}#app{height:760px}</style><div id="app"></div><script type="module" src="/fixture.js"></script></html>');
      } else if (['/fixture.js', '/fixture.css'].includes(request.url)) {
        response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
        response.end(await readFile(join(temporary, request.url.slice(1))));
      } else response.writeHead(404).end();
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true,
      ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' }), chromiumSandbox: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(() => globalThis.contentBrowserLifetimeFixture.run());
    await writeFile(join(output, 'receipt.json'), JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    assert.equal(result.cases.length, 47);
    assert.equal(result.ok, true, JSON.stringify(result.cases.filter(entry => Object.values(entry.checks).some(value => !value))));
    assert.deepEqual(errors, []);
    return result;
  } catch (error) {
    await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await new Promise(done => server ? server.close(done) : done());
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyContentBrowserQueryLifetime();
  console.log(JSON.stringify({ ok: result.ok, cases: result.cases.length }));
}
