import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Context, startNativePlugin } from '@forgeax/engine/plugin';
import { assertNoRuntimeFailure, assertScenePixels } from './app/acceptance.mjs';

const evidence = resolve(process.argv[2] ?? 'artifacts/view-integration/runtime-acceptance');
const source = await build({
  entryPoints: [resolve(import.meta.dirname, '../../../packages/devkit/src/host/startup-source.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { hostStartupDocument, hostStartupScript } = await import(
  `data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`
);
const context = new Context();
let browser;
try {
  const result = await startNativePlugin(context, {
    name: 'project-root',
    apply(ctx) {
      ctx.plugin({ name: 'gomoku/ui', apply() {
        throw new Error('Call initialize() before using vag-platform-sdk');
      } });
    },
  });
  assert.equal(result.ok, false);
  const failure = JSON.stringify(result.error, (_key, value) =>
    value instanceof Error ? { message: value.message, cause: value.cause } : value);
  browser = await chromium.launch({
    executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE,
    headless: true, args: ['--disable-gpu'], chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const document = hostStartupDocument('Runtime acceptance').replace('</body>', `<script>
    ${hostStartupScript(false)};
    document.documentElement.dataset.forgeaxFrameCompleted = '60';
    const canvas = document.querySelector('#app'); canvas.width = 128; canvas.height = 128;
    const draw = canvas.getContext('2d');
    draw.fillStyle = '#123456'; draw.fillRect(0, 0, 128, 128);
    draw.fillStyle = '#ffee44'; draw.fillRect(16, 16, 96, 96);
    globalThis.triggerFailure = () => globalThis.__forgeaxStartup.fail(${failure});
    </script></body>`);
  const pendingFrame = page.frameLocator('iframe');
  await assertNoRuntimeFailure(pendingFrame, 'Pending native document', errors, consoleErrors);
  await page.setContent('<iframe sandbox="allow-scripts" style="width:620px;height:460px;border:0"></iframe>');
  await page.locator('iframe').evaluate((element, html) => { element.srcdoc = html; }, document);
  const frame = page.frameLocator('iframe');
  await frame.locator('html[data-forgeax-frame-completed="60"]').waitFor({ state: 'attached' });
  await assertNoRuntimeFailure(frame, 'Healthy native document', errors, consoleErrors);
  const positivePng = await frame.locator('canvas').evaluate(canvas => canvas.toDataURL());
  const positive = await assertScenePixels(page, positivePng, 'Positive canvas');
  for (const color of ['#000000', '#ffffff']) {
    const png = await frame.locator('canvas').evaluate((canvas, color) => {
      const draw = canvas.getContext('2d'); draw.fillStyle = color;
      draw.fillRect(0, 0, canvas.width, canvas.height); return canvas.toDataURL();
    }, color);
    await assert.rejects(() => assertScenePixels(page, png, color), /flat canvas/);
  }
  await frame.locator('html').evaluate(() => globalThis.triggerFailure());
  assert.equal(await frame.locator('html').getAttribute('data-forgeax-frame-completed'), '60');
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  await assert.rejects(() => assertNoRuntimeFailure(frame, 'Failed native document', errors, consoleErrors),
    /Call initialize\(\) before using vag-platform-sdk/);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, 'fatal-after-60-frames.png') });
  await frame.locator('#forgeax-fatal').evaluate(node => { node.style.display = 'none'; });
  await assertNoRuntimeFailure(frame, 'Hidden placeholder', errors, consoleErrors);
  await frame.locator('html').evaluate(() => console.error('RendererOperationError: device-operation-failed'));
  await page.waitForFunction(() => true);
  assert.equal(consoleErrors.length, 1);
  await assert.rejects(() => assertNoRuntimeFailure(frame, 'Console failure', errors, consoleErrors),
    /no browser console errors/);
  const summary = { ok: true, positive, retainedFrameCount: 60,
    rejected: ['visible native fatal with empty browser errors', 'black PNG', 'white PNG', 'runtime console error'],
    boundary: 'Actual native child failure in a sandboxed iframe, generated startup DOM and decoded 2D pixels; no GPU qualification' };
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await browser?.close();
  await context.fiber.dispose();
}
