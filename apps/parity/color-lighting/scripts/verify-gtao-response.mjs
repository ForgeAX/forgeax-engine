import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const url = process.argv[2] ?? 'http://127.0.0.1:4282/gtao-response.html';
const directory = process.argv[3] ?? 'artifacts/rendering-parity/gtao';
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ ...launch, args: [...launch.args, '--use-angle=swiftshader'], chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() => globalThis.gtaoResponse || globalThis.gtaoResponseError, null, { timeout: 180000 });
  const report = await page.evaluate(() => ({ report: globalThis.gtaoResponse, error: globalThis.gtaoResponseError }));
  writeFileSync(`${directory}/report.json`, JSON.stringify({ url, ...report, errors }, null, 2));
  await page.screenshot({ path: `${directory}/comparison.png`, fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(report.error, undefined);
  assert.equal(report.report.zeroIntensityIdentity, true);
  assert.equal(report.report.cases.length, 4);
  console.log(JSON.stringify(report.report));
} finally {
  await browser.close();
}
