import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { assertScenePixels, captureCanvas, pixelDifferenceInCircle, projectWorldPoint } from '../../visual-smoke-helpers.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173';
const outputDir = resolve(process.argv[3] ?? 'visual-evidence');
const desktopOnly = !process.argv.includes('--include-mobile');
await mkdir(outputDir, { recursive: true });
const pageErrors = [];
const consoleErrors = [];

function pixelDifference(leftBuffer, rightBuffer) {
  const left = PNG.sync.read(leftBuffer), right = PNG.sync.read(rightBuffer);
  assert.equal(left.width, right.width);
  assert.equal(left.height, right.height);
  let changed = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    if ([0, 1, 2].some((channel) => Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 4)) changed++;
  }
  return { changedPixels: changed, changedRatio: changed / (left.width * left.height) };
}

async function assertLayout(page, name) {
  const result = await page.evaluate(() => {
    const width = innerWidth;
    const nodes = [...document.querySelectorAll('.panel h1,.panel h2,.panel p,.panel code,.panel button,.panel label,.panel strong,.panel span,.panel output')]
      .filter((node) => node.textContent.trim() && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
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
  await page.waitForFunction(() => Number(document.querySelector('#frame-count')?.textContent ?? 0) >= 8 || (window.__waterWavesDemo?.rendererErrors.length ?? 0) > 0 || /启动失败/.test(document.querySelector('#render-state')?.textContent ?? ''), undefined, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const desktopLayout = await assertLayout(page, 'waves desktop');
  const initialCapture = await captureCanvas(page, { name: 'waves desktop', path: resolve(outputDir, 'waves-desktop-canvas.png'), assertScene: false });
  const initialCanvas = initialCapture.bytes;
  await page.screenshot({ path: resolve(outputDir, 'waves-desktop.png') });
  const firstTime = await page.locator('#time-readout').innerText();
  const engineState = await page.evaluate(() => ({ elapsed: window.__waterWavesDemo?.world.getResource('Time').elapsed ?? null, frames: Number(document.querySelector('#frame-count').textContent), renderer: document.querySelector('#render-state').textContent, gpu: document.querySelector('#gpu-state').textContent, status: document.querySelector('#status').textContent, trace: document.querySelector('#trace').textContent, rendererErrors: window.__waterWavesDemo?.rendererErrors ?? [], startupError: window.__waterWavesStartupError ?? null, probeWorldPoint: window.__waterWavesDemo?.probeWorldPoint ?? null, motionWorldPoint: window.__waterWavesDemo?.motionWorldPoint ?? null, cameraView: window.__waterWavesDemo?.cameraView ?? null }));
  const initialMetrics = initialCapture.metrics;
  await writeFile(resolve(outputDir, 'waves-boot-diagnostic.json'), `${JSON.stringify({ app: 'waves', url: baseUrl, chromiumSandbox: true, engine: engineState, canvas: initialMetrics, canvasSurface: initialCapture.surface, layout: desktopLayout, pageErrors }, null, 2)}\n`);
  if (engineState.frames < 8 || engineState.rendererErrors.length > 0 || engineState.startupError) {
    if (!desktopOnly) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      const mobileLayout = await assertLayout(page, 'waves mobile startup failure');
      await page.screenshot({ path: resolve(outputDir, 'waves-mobile.png') });
      const mobileCapture = await captureCanvas(page, { name: 'waves mobile startup failure', path: resolve(outputDir, 'waves-mobile-canvas.png'), assertScene: false });
      const mobileRendererErrors = await page.evaluate(() => window.__waterWavesDemo?.rendererErrors ?? []);
      await writeFile(resolve(outputDir, 'waves-boot-diagnostic.json'), `${JSON.stringify({ app: 'waves', url: baseUrl, chromiumSandbox: true, engine: engineState, canvas: { desktop: initialMetrics, desktopSurface: initialCapture.surface, mobile: mobileCapture.metrics, mobileSurface: mobileCapture.surface }, rendererErrors: { desktop: engineState.rendererErrors, mobile: mobileRendererErrors }, layout: { desktop: desktopLayout, mobile: mobileLayout }, pageErrors }, null, 2)}\n`);
    }
    throw new Error(`Engine startup/render blocked: ${JSON.stringify({ frames: engineState.frames, rendererErrors: engineState.rendererErrors, startupError: engineState.startupError, status: engineState.status })}`);
  }
  assert(engineState.frames >= 8, `Engine submitted only ${engineState.frames} frames`);
  assert.deepEqual(engineState.rendererErrors, [], `Renderer errors: ${JSON.stringify(engineState.rendererErrors)}`);
  assert(engineState.elapsed > 0.1, `Engine Time did not advance: ${engineState.elapsed}`);
  assert.match(engineState.gpu, /位移 \/ 法线 \/ 速度/);
  assert.doesNotMatch(engineState.renderer, /错误|失败/);
  assert.match(engineState.trace, /LWC 瓦片边界/);
  assertScenePixels(initialMetrics, 'waves desktop');

  await page.waitForTimeout(900);
  const laterCapture = await captureCanvas(page, { name: 'waves desktop later', path: resolve(outputDir, 'waves-desktop-later-canvas.png'), assertScene: false });
  const laterCanvas = laterCapture.bytes;
  const laterRendererErrors = await page.evaluate(() => window.__waterWavesDemo?.rendererErrors ?? []);
  assert.deepEqual(laterRendererErrors, [], `Renderer errors after later desktop frame: ${JSON.stringify(laterRendererErrors)}`);
  assertScenePixels(laterCapture.metrics, 'waves desktop later');
  await page.screenshot({ path: resolve(outputDir, 'waves-desktop-later.png') });
  const motion = pixelDifference(initialCanvas, laterCanvas);
  const surfaceCenter = projectWorldPoint(engineState.motionWorldPoint, engineState.cameraView, initialCapture.surface.canvas.cssWidth, initialCapture.surface.canvas.cssHeight);
  const probeCenter = projectWorldPoint(engineState.probeWorldPoint, engineState.cameraView, initialCapture.surface.canvas.cssWidth, initialCapture.surface.canvas.cssHeight);
  const surfaceRoi = pixelDifferenceInCircle(initialCanvas, laterCanvas, surfaceCenter, 42);
  assert(Math.hypot(surfaceCenter.x - probeCenter.x, surfaceCenter.y - probeCenter.y) > surfaceRoi.radius * 2,
    `Water motion ROI overlaps the CPU-driven probe: ${JSON.stringify({ surfaceCenter, probeCenter, radius: surfaceRoi.radius })}`);
  assert(surfaceRoi.comparedPixels > 0 && surfaceRoi.changedPixels > 0,
    `Water surface ROI did not change across Engine frames: ${JSON.stringify(surfaceRoi)}`);
  const laterTime = await page.locator('#time-readout').innerText();
  assert.notEqual(laterTime, firstTime, 'Engine Time readout did not advance with submitted frames');

  await page.locator('[data-mode="simple"]').click();
  await page.waitForFunction(() => document.querySelector('#trace')?.textContent?.includes('标志 0x6b'));
  const simpleSurface = await page.locator('#surface').innerText();
  await page.screenshot({ path: resolve(outputDir, 'waves-desktop-simple.png') });
  await page.locator('[data-mode="full"]').click();
  await page.waitForFunction(() => document.querySelector('#trace')?.textContent?.includes('标志 0x2b'));
  const shallowAttenuation = await page.locator('#attenuation').innerText();
  await page.locator('#depth').evaluate((input) => { input.value = '12'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#depth-value')?.textContent === '12.0 m');
  const deepAttenuation = await page.locator('#attenuation').innerText();
  assert.notEqual(shallowAttenuation, deepAttenuation, `depth attenuation did not vary: ${shallowAttenuation}`);
  await page.screenshot({ path: resolve(outputDir, 'waves-desktop-depth.png') });
  const waveDigestBefore = await page.evaluate(() => { const demo = window.__waterWavesDemo; return demo.app.assets.read(demo.waveSetHandle).unwrap().inputDigest; });
  await page.locator('#strength').evaluate((input) => { input.value = '1.8'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction((before) => { const demo = window.__waterWavesDemo; return demo.app.assets.read(demo.waveSetHandle).unwrap().inputDigest !== before; }, waveDigestBefore);
  const waveDigestAfter = await page.evaluate(() => { const demo = window.__waterWavesDemo; return demo.app.assets.read(demo.waveSetHandle).unwrap().inputDigest; });
  await page.screenshot({ path: resolve(outputDir, 'waves-desktop-strong.png') });

  let mobile;
  if (!desktopOnly) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const layout = await assertLayout(page, 'waves mobile');
    await page.screenshot({ path: resolve(outputDir, 'waves-mobile.png') });
    const capture = await captureCanvas(page, { name: 'waves mobile', path: resolve(outputDir, 'waves-mobile-canvas.png'), assertScene: false });
    const rendererErrors = await page.evaluate(() => window.__waterWavesDemo?.rendererErrors ?? []);
    assert.deepEqual(rendererErrors, [], `Renderer errors on mobile: ${JSON.stringify(rendererErrors)}`);
    assertScenePixels(capture.metrics, 'waves mobile');
    mobile = { layout, capture, rendererErrors };
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  const report = {
    app: 'waves', url: baseUrl, browser: 'Chromium', chromiumSandbox: true,
    screenshots: ['waves-desktop.png', 'waves-desktop-canvas.png', 'waves-desktop-later.png', 'waves-desktop-later-canvas.png', 'waves-desktop-simple.png', 'waves-desktop-depth.png', 'waves-desktop-strong.png', ...(mobile ? ['waves-mobile.png', 'waves-mobile-canvas.png'] : [])],
    engine: { ...engineState, firstTime, laterTime },
    canvas: { desktop: initialMetrics, desktopSurface: initialCapture.surface, wholeCanvasMotion: motion, waterSurfaceMotion: surfaceRoi, ...(mobile ? { mobile: mobile.capture.metrics, mobileSurface: mobile.capture.surface } : {}) },
    interactions: { simpleSurface, shallowAttenuation, deepAttenuation, waveDigestBefore, waveDigestAfter, lwcEdge: true, waterSurfaceMotionRoi: { worldPoint: engineState.motionWorldPoint, probeWorldPoint: engineState.probeWorldPoint } },
    layout: { desktop: desktopLayout, ...(mobile ? { mobile: mobile.layout } : {}) }, rendererErrors: { desktop: engineState.rendererErrors, ...(mobile ? { mobile: mobile.rendererErrors } : {}) }, pageErrors,
  };
  await writeFile(resolve(outputDir, 'waves-visual-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
  await context.close();
} finally {
  await browser.close();
}
