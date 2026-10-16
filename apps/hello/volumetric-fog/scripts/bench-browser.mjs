import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { qualifyGpuResults, resolveReferenceRunnerClass } from './bench-contract.mjs';

const baseUrl = process.env.FORGEAX_FOG_URL ?? 'http://127.0.0.1:5173/';
const url = new URL(baseUrl);
url.searchParams.set('bench', '1');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FORGEAX_CHROME_EXECUTABLE === undefined
    ? { channel: 'chrome' }
    : { executablePath: process.env.FORGEAX_CHROME_EXECUTABLE }),
  args: [
    '--disable-features=MacAppCodeSignClone',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__forgeaxFogBench !== undefined, { timeout: 10_000 });
  const rawResults = await page.evaluate(() => globalThis.__forgeaxFogBench());
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const qualification = resolveReferenceRunnerClass(process.env.FORGEAX_REFERENCE_RUNNER_CLASS);
  const results = qualifyGpuResults(rawResults, qualification);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const receipt = {
    schemaVersion: '2',
    head,
    runnerClass: 'browser-webgpu',
    referenceRunnerClass: qualification.referenceRunnerClass,
    qualification,
    browser: { name: 'chrome', userAgent },
    source: 'renderer-observe',
    results,
  };
  if (process.env.FORGEAX_FOG_RECEIPT !== undefined) {
    await writeFile(process.env.FORGEAX_FOG_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify(receipt));
  if (qualification.status === 'qualified' && results.some((result) => result.pass !== true)) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
