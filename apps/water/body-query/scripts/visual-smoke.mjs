import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { assertScenePixels, captureCanvas } from '../../visual-smoke-helpers.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5174';
const outputDir = resolve(process.argv[3] ?? 'visual-evidence');
const desktopOnly = !process.argv.includes('--include-mobile');
await mkdir(outputDir, { recursive: true });
const pageErrors = [];
const consoleErrors = [];

async function assertLayout(page, name) {
  const result = await page.evaluate(() => {
    const width = innerWidth;
    const nodes = [...document.querySelectorAll('.panel h1,.panel h2,.panel p,.panel code,.panel button,.panel label,.panel strong,.panel span,.panel output')]
      .filter((node) => node.textContent.trim() && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('details:not([open])'));
    const boxes = nodes.map((node) => ({ node, text: node.textContent.trim().replace(/\s+/g, ' ').slice(0, 48), rect: node.getBoundingClientRect() }));
    const overflows = boxes.filter(({ rect }) => rect.left < -0.5 || rect.right > width + 0.5).map(({ text, rect }) => ({ text, left: rect.left, right: rect.right }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
      if (a.rect.right > b.rect.left + 1 && b.rect.right > a.rect.left + 1 && a.rect.bottom > b.rect.top + 1 && b.rect.bottom > a.rect.top + 1)
        overlaps.push({ a: a.text, b: b.text });
    }
    return { visibleTextNodes: boxes.length, overflows, overlaps };
  });
  assert.deepEqual(result.overflows, [], `${name} text/control overflow: ${JSON.stringify(result.overflows)}`);
  assert.deepEqual(result.overlaps, [], `${name} text/control overlap: ${JSON.stringify(result.overlaps)}`);
  return result;
}

const browser = await chromium.launch({ ...browserLaunch, headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', chromiumSandbox: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`${baseUrl}/?smoke=1`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => Number(document.querySelector('#render-state')?.textContent?.match(/第 (\d+) 帧已提交/)?.[1] ?? 0) >= 8 || (window.__waterBodyQueryDemo?.rendererErrors.length ?? 0) > 0 || /启动失败/.test(document.querySelector('#render-state')?.textContent ?? ''), undefined, { timeout: 20_000 });
  await page.waitForTimeout(2_000);
  const desktopLayout = await assertLayout(page, 'body-query desktop');
  const initialCapture = await captureCanvas(page, { name: 'body-query desktop', path: resolve(outputDir, 'body-query-desktop-canvas.png'), assertScene: false });
  await page.screenshot({ path: resolve(outputDir, 'body-query-desktop.png') });
  const initialMetrics = initialCapture.metrics;

  const initial = await page.evaluate(() => ({ frames: Number(document.querySelector('#render-state').textContent.match(/第 (\d+) 帧已提交/)?.[1] ?? 0), bodyGuid: document.querySelector('#body-guid').textContent, source: document.querySelector('#source').textContent, valid: document.querySelector('#valid').textContent, trace: document.querySelector('#trace').textContent, renderer: document.querySelector('#render-state').textContent, rendererErrors: window.__waterBodyQueryDemo?.rendererErrors ?? [], startupError: window.__waterBodyQueryStartupError ?? null, status: document.querySelector('#status').textContent }));
  await writeFile(resolve(outputDir, 'body-query-boot-diagnostic.json'), `${JSON.stringify({ app: 'body-query', url: baseUrl, chromiumSandbox: true, engine: initial, canvas: initialMetrics, canvasSurface: initialCapture.surface, rendererErrors: initial.rendererErrors, layout: desktopLayout, pageErrors }, null, 2)}\n`);
  if (initial.frames < 8 || initial.rendererErrors.length > 0 || initial.startupError) {
    if (!desktopOnly) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      const mobileLayout = await assertLayout(page, 'body-query mobile startup failure');
      await page.screenshot({ path: resolve(outputDir, 'body-query-mobile.png') });
      const mobileCapture = await captureCanvas(page, { name: 'body-query mobile startup failure', path: resolve(outputDir, 'body-query-mobile-canvas.png'), assertScene: false });
      const mobileRendererErrors = await page.evaluate(() => window.__waterBodyQueryDemo?.rendererErrors ?? []);
      await page.locator('.panel').evaluate((panel) => { panel.scrollTop = panel.scrollHeight; });
      await page.waitForTimeout(100);
      await page.screenshot({ path: resolve(outputDir, 'body-query-mobile-controls.png') });
      await writeFile(resolve(outputDir, 'body-query-boot-diagnostic.json'), `${JSON.stringify({ app: 'body-query', url: baseUrl, chromiumSandbox: true, engine: initial, canvas: { desktop: initialMetrics, desktopSurface: initialCapture.surface, mobile: mobileCapture.metrics, mobileSurface: mobileCapture.surface }, rendererErrors: { desktop: initial.rendererErrors, mobile: mobileRendererErrors }, layout: { desktop: desktopLayout, mobile: mobileLayout }, pageErrors }, null, 2)}\n`);
    }
    throw new Error(`Engine startup/render blocked: ${JSON.stringify({ frames: initial.frames, rendererErrors: initial.rendererErrors, startupError: initial.startupError, status: initial.status })}`);
  }
  assertScenePixels(initialMetrics, 'body-query desktop');
  assert(initial.frames >= 8);
  assert.deepEqual(initial.rendererErrors, [], `Renderer errors: ${JSON.stringify(initial.rendererErrors)}`);
  assert.match(initial.bodyGuid, /^[0-9a-f-]{36}$/i, `expected stable WaterBody asset GUID, got ${initial.bodyGuid}`);

  await page.locator('#body').selectOption('upper');
  await page.waitForFunction((oldGuid) => document.querySelector('#body-guid')?.textContent !== oldGuid, initial.bodyGuid);
  const upperGuid = await page.locator('#body-guid').innerText();
  assert.notEqual(upperGuid, initial.bodyGuid, 'upper owner must resolve to its own asset GUID');
  await page.screenshot({ path: resolve(outputDir, 'body-query-upper-ocean.png') });

  await page.locator('#body').selectOption('lower');
  await page.locator('.advanced summary').click();
  await page.locator('[data-flag="location"]').uncheck();
  await page.waitForFunction(() => document.querySelector('#valid')?.textContent?.includes('位置'));
  const adjustedFlags = await page.locator('#adjusted').innerText();
  assert.equal(Number.parseInt(adjustedFlags.slice(2), 16) & 1, 1, 'Depth must implicitly add ComputeLocation');
  await page.locator('[data-flag="location"]').check();

  await page.locator('#exclusion-toggle').check();
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '排除区');
  const exclusionTrace = await page.locator('#trace').innerText();
  assert.match(exclusionTrace, /已排除/);
  await page.screenshot({ path: resolve(outputDir, 'body-query-exclusion.png') });
  await page.locator('#exclusion-toggle').uncheck();
  await page.locator('#terrain-toggle').uncheck();
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '样条');
  const missingTerrainTrace = await page.locator('#trace').innerText();
  await page.screenshot({ path: resolve(outputDir, 'body-query-terrain-missing.png') });
  await page.locator('#terrain-toggle').check();
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '地形');

  await page.locator('#baked-toggle').check();
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '预烘焙');
  const bakedInterior = await page.locator('#normal').innerText();
  await page.screenshot({ path: resolve(outputDir, 'body-query-baked-interior.png') });
  await page.locator('#point').selectOption('edge');
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '预烘焙' && document.querySelector('#normal')?.textContent?.endsWith('/ 0.00 m'));
  const bakedEdge = await page.locator('#normal').innerText();
  assert.notEqual(bakedInterior, bakedEdge, 'Baked strict interior and edge-outside samples must differ');
  await page.screenshot({ path: resolve(outputDir, 'body-query-baked-edge.png') });
  await page.locator('#baked-toggle').uncheck();
  await page.waitForFunction(() => document.querySelector('#source')?.textContent === '地形');
  const clearedBakedTrace = await page.locator('#trace').innerText();
  assert.match(clearedBakedTrace, /来源 地形/);
  const errorsAfterBakedClear = await page.evaluate(() => window.__waterBodyQueryDemo?.rendererErrors ?? []);
  assert.deepEqual(errorsAfterBakedClear, [], `Renderer errors after clearing Baked data: ${JSON.stringify(errorsAfterBakedClear)}`);
  await page.screenshot({ path: resolve(outputDir, 'body-query-baked-cleared.png') });

  await page.locator('.advanced summary').click();
  let mobile;
  if (!desktopOnly) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.panel').evaluate((panel) => { panel.scrollTop = 0; });
    await page.waitForTimeout(200);
    const layout = await assertLayout(page, 'body-query mobile');
    await page.screenshot({ path: resolve(outputDir, 'body-query-mobile.png') });
    const capture = await captureCanvas(page, { name: 'body-query mobile', path: resolve(outputDir, 'body-query-mobile-canvas.png'), assertScene: false });
    const rendererErrors = await page.evaluate(() => window.__waterBodyQueryDemo?.rendererErrors ?? []);
    assert.deepEqual(rendererErrors, [], `Renderer errors on mobile: ${JSON.stringify(rendererErrors)}`);
    assertScenePixels(capture.metrics, 'body-query mobile');
    await page.locator('.panel').evaluate((panel) => { panel.scrollTop = panel.scrollHeight; });
    await page.waitForTimeout(100);
    await page.screenshot({ path: resolve(outputDir, 'body-query-mobile-controls.png') });
    mobile = { layout, capture, rendererErrors };
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  const finalState = await page.evaluate(() => ({ frames: Number(document.querySelector('#render-state').textContent.match(/第 (\d+) 帧已提交/)[1]), render: document.querySelector('#render-state').textContent, bodyGuid: document.querySelector('#body-guid').textContent, source: document.querySelector('#source').textContent, valid: document.querySelector('#valid').textContent, trace: document.querySelector('#trace').textContent }));
  assert.doesNotMatch(finalState.render, /错误|失败/);
  const report = {
    app: 'body-query', url: baseUrl, browser: 'Chromium', chromiumSandbox: true,
    screenshots: ['body-query-desktop.png', 'body-query-desktop-canvas.png', 'body-query-upper-ocean.png', 'body-query-exclusion.png', 'body-query-terrain-missing.png', 'body-query-baked-interior.png', 'body-query-baked-edge.png', 'body-query-baked-cleared.png', ...(mobile ? ['body-query-mobile.png', 'body-query-mobile-canvas.png', 'body-query-mobile-controls.png'] : [])],
    engine: { initial, finalState, upperGuid }, canvas: { desktop: initialMetrics, desktopSurface: initialCapture.surface, ...(mobile ? { mobile: mobile.capture.metrics, mobileSurface: mobile.capture.surface } : {}) },
    interactions: { adjustedFlags, exclusionTrace, missingTerrainTrace, bakedInterior, bakedEdge, clearedBakedTrace },
    layout: { desktop: desktopLayout, ...(mobile ? { mobile: mobile.layout } : {}) }, rendererErrors: { desktop: initial.rendererErrors, ...(mobile ? { mobile: mobile.rendererErrors } : {}) }, pageErrors,
  };
  await writeFile(resolve(outputDir, 'body-query-visual-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
  await context.close();
} finally {
  await browser.close();
}
