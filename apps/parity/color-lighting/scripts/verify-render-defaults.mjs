import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const url = process.argv[2] ?? 'http://127.0.0.1:4276/render-defaults.html';
const output = resolve('artifacts/render-defaults');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...launch, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__renderDefaultsComparison || globalThis.__renderDefaultsComparisonError, undefined, { timeout: 120000 });
  const result = await page.evaluate(() => ({ report: globalThis.__renderDefaultsComparison, error: globalThis.__renderDefaultsComparisonError }));
  await page.screenshot({ path: resolve(output, 'comparison.png'), fullPage: true });
  await writeFile(resolve(output, 'comparison.json'), `${JSON.stringify({ url, ...result, errors }, null, 2)}\n`);
  if (result.error || errors.length) throw new Error(JSON.stringify({ ...result, errors }));
  console.log(JSON.stringify(result.report));
} finally { await browser.close(); }
