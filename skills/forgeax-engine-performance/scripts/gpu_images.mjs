import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Capture the real mature-framework views, including their image export paths. */
export async function gpuImages(directory, url, { playwrightModule } = {}) {
  const { chromium } = await import(
    playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright'
  );
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1800, height: 1150 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (await page.locator('#viewer').count()) {
      await page.waitForSelector('iframe', { timeout: 60000 });
      // Static interval SVG is the deterministic image; the native UI screenshot is verified separately.
      await page.goto(new URL('gpu-timing.svg', url).href);
      await page.locator('svg').screenshot({ path: join(directory, 'gpu-timing.png') });
      return { images: ['gpu-timing.png'], pageErrors: errors };
    }
    await page.waitForFunction(() => window.gpuViewer?.graphReady, { timeout: 60000 });
    const image = async (name, fn) => {
      const data = await page.evaluate(fn);
      await writeFile(join(directory, name), Buffer.from(data.split(',')[1], 'base64'));
    };
    await image('gpu-resources.png', () => window.gpuViewer.exportResources());
    await page.screenshot({ path: join(directory, 'gpu-overview.png'), fullPage: true });
    await page.locator('#metric').selectOption('count');
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await image('gpu-resource-counts.png', () => window.gpuViewer.exportResources());
    await page.locator('#metric').selectOption('bytes');
    await page.evaluate(() => {
      window.gpuViewer.tab('pipeline');
      const w = window.gpuViewer.report.works[0];
      if (w) window.gpuViewer.graph({ workIndex: w.workIndex });
    });
    await page.waitForFunction(() => window.gpuViewer.graphReady);
    await image('gpu-pipeline.png', () => window.gpuViewer.exportGraph());
    await page.screenshot({ path: join(directory, 'gpu-pipeline-view.png'), fullPage: true });
    await page.evaluate(() => window.gpuViewer.tab('lifetime'));
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await image('gpu-resource-spans.png', () => window.gpuViewer.exportSpans());
    if (errors.length) throw Error('GPU report browser errors: ' + errors.join('; '));
    return {
      images: [
        'gpu-resources.png',
        'gpu-resource-counts.png',
        'gpu-resource-spans.png',
        'gpu-overview.png',
        'gpu-pipeline.png',
        'gpu-pipeline-view.png',
      ],
      pageErrors: errors,
    };
  } finally {
    await browser.close();
  }
}
