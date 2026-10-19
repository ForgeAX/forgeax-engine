import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const url = process.argv[2] ?? 'http://127.0.0.1:4277/environment-response.html';
const directory = process.argv[3] ?? 'artifacts/skylight-response/browser';
const recordOnly = process.argv.includes('--record');
const capture = process.argv.includes('--capture');
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({
  ...launch,
  args: [...launch.args, '--use-angle=swiftshader'],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.environmentResponse?.initial, undefined, {
    timeout: 120_000,
  });
  const reports = [];
  for (const source of ['solid', 'panorama', 'studio'])
    for (const rotation of source === 'studio' ? [0, Math.PI / 2] : [0])
    for (const path of ['forward', 'deferred']) {
      const report = await page.evaluate(
        ({ path, source, rotation }) => globalThis.environmentResponse.run(path, source, rotation),
        { path, source, rotation },
      );
      reports.push(report);
      await page.screenshot({ path: `${directory}/${source}-${path}-${rotation === 0 ? 0 : 90}.png` });
    }
  if (capture) {
    const download = page.waitForEvent('download');
    const report = await page.evaluate(() => globalThis.environmentResponse.capture('forward', 'studio', 0));
    await (await download).saveAs(`${directory}/studio-forward.rhitape`);
    writeFileSync(`${directory}/capture.json`, JSON.stringify(report, null, 2));
  }
  writeFileSync(`${directory}/comparison.json`, JSON.stringify({ url, reports, errors }, null, 2));
  assert.deepEqual(errors, [], 'browser errors');
  if (!recordOnly)
    for (const report of reports) {
      assert.ok(
        report.maxRegionError < (report.source === 'solid' ? 0.01 : report.source === 'studio' ? 0.05 : 0.025),
        `${report.path}: max ROI mean RGB error ${report.maxRegionError}`,
      );
      if (report.source === 'studio')
        for (const material of report.pixelErrors)
          assert.ok(material.relativeError < 0.25, `${report.path}: ${material.name} roughness=${material.roughness} spatial error ${material.relativeError}`);
    }
  console.log(
    JSON.stringify(
      reports.map(({ path, source, rotation, maxRegionError, pixelErrors }) => ({ path, source, rotation, maxRegionError, pixelErrors })),
    ),
  );
} finally {
  await browser.close();
}
