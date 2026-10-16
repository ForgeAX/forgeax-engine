import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const compiled = await build({ entryPoints: ['test/fixtures/panel-observation.mjs'], bundle: true,
  write: false, outdir: '/tmp/forgeax-panel-observation', format: 'esm', platform: 'browser' });
const code = compiled.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = compiled.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const server = createServer((_, response) => { response.setHeader('content-type', 'text/html'); response.end(
  `<html><head><style>${css}</style></head><body><button id="toggle">Toggle panels</button><output id="sceneReads">0</output><output id="inspectorReads">0</output><main id="panels"><div id="scene"></div><div id="inspector"></div></main><script type="module">${code.replaceAll('</script','<\\/script')}</script></body></html>`); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE, headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const read = async () => Promise.all(['sceneReads', 'inspectorReads'].map(async id => Number(await page.locator(`#${id}`).innerText())));
  try { await page.waitForFunction(() => Number(document.getElementById('sceneReads').textContent) >= 2 && Number(document.getElementById('inspectorReads').textContent) >= 2); } catch(error) { console.log(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error; }
  await page.getByRole('button', { name: 'Toggle panels' }).click();
  await page.locator('#panels').waitFor({ state: 'hidden' });
  const hidden = await read();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(await read(), hidden, 'Hidden panels must issue no observation requests');
  await page.getByRole('button', { name: 'Toggle panels' }).click();
  await page.waitForFunction(([scene, inspector]) => Number(document.getElementById('sceneReads').textContent) > scene && Number(document.getElementById('inspectorReads').textContent) > inspector, hidden);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ hidden, resumed: await read(), errors, boundary: 'actual React panel mounts and DOM visibility; deterministic public-client fixture, no Engine/GPU assertion' }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
