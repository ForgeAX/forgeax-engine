import { webkit } from 'playwright';

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  console.log(JSON.stringify({ browser: 'webkit', status: 'ready', userAgent }));
} catch (error) {
  console.error(
    `[webkit capability] launch failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
