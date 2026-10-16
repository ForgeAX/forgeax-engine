import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
const output = resolve(process.env.FORGEAX_AUDIO_EVIDENCE ?? 'artifacts/audio-controls');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...browserLaunch, headless: true, chromiumSandbox: true});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [],
  networkFailures = [],
  rows = [];
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.responseReceived', (event) => {
  if (event.response.status >= 400)
    networkFailures.push({ url: event.response.url, status: event.response.status });
});
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (
    (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) ||
    /WebGPU.*validation|Invalid (?:RenderPipeline|CommandBuffer|BindGroup)/i.test(message.text())
  )
    errors.push(message.text());
});
try {
  await page.goto(process.env.FORGEAX_AUDIO_URL ?? 'http://localhost:5395');
  await page.waitForFunction(() => globalThis.__forgeaxAudioControls?.snapshot().frames >= 60, {
    timeout: 120000,
  });
  await page.click('#controls-play');
  await page.waitForFunction(() => globalThis.__forgeaxAudioControls.snapshot().position > 0.1);
  for (const phase of ['dry', 'lowpass', 'paused', 'resumed']) {
    await page.evaluate(() => globalThis.__forgeaxAudioControls.freeze(false));
    if (phase === 'lowpass') await page.selectOption('#controls-filter', 'lowpass');
    if (phase === 'paused') await page.click('#controls-pause');
    if (phase === 'resumed') {
      await page.focus('#controls-rate');
      for (let i = 0; i < 4; i++) await page.press('#controls-rate', 'ArrowRight');
      await page.click('#controls-resume');
    }
    await page.waitForTimeout(500);
    await page.evaluate(() => globalThis.__forgeaxAudioControls.freeze(true));
    const snapshot = await page.evaluate(() => globalThis.__forgeaxAudioControls.snapshot());
    if (phase === 'paused') {
      await page.waitForTimeout(100);
      const current = await page.evaluate(() => globalThis.__forgeaxAudioControls.snapshot());
      if (current.position !== snapshot.position || current.active !== 0)
        throw new Error('pause failed to freeze position');
    }
    const downloadPromise = page.waitForEvent('download');
    const capture = await page.evaluate(async () => {
      const captured = await globalThis.__forgeaxAudioControls.capture();
      if (!captured?.ok) throw new Error(JSON.stringify(captured?.error ?? 'capture-unavailable'));
      const url = URL.createObjectURL(new Blob([captured.value.bytes]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'frame.rhitape';
      a.click();
      return { digest: captured.value.digest, url, bytes: captured.value.bytes.length };
    });
    const tapePath = resolve(output, `${phase}.rhitape`);
    await (await downloadPromise).saveAs(tapePath);
    await page.evaluate((url) => URL.revokeObjectURL(url), capture.url);
    await page.screenshot({ path: resolve(output, `${phase}.png`) });
    const bitmapDownload = page.waitForEvent('download');
    const bitmapUrl = await page.evaluate(async () => {
      const blob = await new Promise((resolve) => document.querySelector('#app').toBlob(resolve));
      if (!blob) throw new Error('canvas bitmap unavailable');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'canvas.png';
      a.click();
      return url;
    });
    await (await bitmapDownload).saveAs(resolve(output, `${phase}-canvas.png`));
    await page.evaluate((url) => URL.revokeObjectURL(url), bitmapUrl);
    rows.push({ phase, snapshot, digest: capture.digest, bytes: capture.bytes, tapePath });
    console.log(JSON.stringify(rows.at(-1)));
  }
  await page.click('#controls-stop');
  await page.waitForFunction(
    () => globalThis.__forgeaxAudioControls.snapshot().position === undefined,
  );
  if (errors.length || networkFailures.length)
    throw new Error(JSON.stringify({ errors, networkFailures }));
  await writeFile(
    resolve(output, 'capture.json'),
    `${JSON.stringify({ status: 'pass', errors, networkFailures, rows }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
