import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import UPNG from 'upng-js';
import launch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const root = resolve(process.env.FORGEAX_PATH_EVIDENCE ?? 'artifacts/path-follow');
const directory = resolve(root, 'normal-production');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ ...launch, headless: true, chromiumSandbox: true});
const errors = [],
  snapshots = [];
const page = await browser.newPage({
  viewport: { width: 1040, height: 760 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
async function image(name) {
  const bytes = await readFile(name);
  const decoded = UPNG.decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return {
    width: decoded.width,
    height: decoded.height,
    rgba: new Uint8Array(UPNG.toRGBA8(decoded)[0]),
  };
}
async function difference(a, b) {
  const first = await image(a),
    second = await image(b);
  if (first.width !== second.width || first.height !== second.height)
    throw new Error('Production bitmap extent changed');
  const histogram = new Uint32Array(256);
  let sum = 0,
    changedPixels = 0;
  for (let i = 0; i < first.rgba.length; i += 4) {
    let max = 0;
    for (let j = 0; j < 3; j++) {
      const delta = Math.abs(first.rgba[i + j] - second.rgba[i + j]);
      sum += delta;
      histogram[delta]++;
      max = Math.max(max, delta);
    }
    if (max > 12) changedPixels++;
  }
  const count = first.width * first.height * 3;
  let seen = 0,
    p99 = 1;
  for (let i = 0; i < 256; i++) {
    seen += histogram[i];
    if (seen >= count * 0.99) {
      p99 = i / 255;
      break;
    }
  }
  return { changedPixels, mean: sum / count / 255, p99 };
}
try {
  await page.goto(process.env.FORGEAX_PATH_NORMAL_URL ?? 'http://127.0.0.1:5418');
  await page.waitForFunction(() => Boolean(globalThis.__pathDemo), undefined, { timeout: 120000 });
  if (await page.evaluate(() => globalThis.__pathDemo.app.rhiCapture !== undefined))
    throw new Error('Normal production retained the main recorder');
  const initial = await page.evaluate(() => globalThis.__pathDemo.step(0));
  if (initial.tick > 60) throw new Error('Production startup passed fixed tick 60');
  for (const [phase, frames] of [
    ['tick60', 60 - initial.tick],
    ['advanced', 60],
    ['paused', 60],
  ]) {
    if (phase === 'paused') await page.click('#pause');
    const snapshot = await page.evaluate((frames) => globalThis.__pathDemo.step(frames), frames);
    if (snapshot.followers.length !== 10) throw new Error('Production follower roster changed');
    const platform = snapshot.followers.find((row) => row.name === 'platform');
    const motorError = Math.hypot(
      ...snapshot.platformDesired.map((value, i) => value - platform.matrix[12 + i]),
    );
    if (motorError > 1e-4) throw new Error('Production physical motor mismatch');
    snapshots.push({ phase, snapshot, motorError });
    const bitmap = await page.evaluate(() => document.querySelector('#app').toDataURL('image/png'));
    await writeFile(
      resolve(directory, `${phase}.png`),
      Buffer.from(bitmap.split(',')[1], 'base64'),
    );
  }
  const movement = await difference(
    resolve(directory, 'tick60.png'),
    resolve(directory, 'advanced.png'),
  );
  const pause = await difference(
    resolve(directory, 'advanced.png'),
    resolve(directory, 'paused.png'),
  );
  const diagnosticParity = await difference(
    resolve(directory, 'tick60.png'),
    resolve(root, 'public-only/tick60-canvas.png'),
  );
  if (
    movement.changedPixels < 100 ||
    pause.changedPixels > movement.changedPixels / 10 ||
    diagnosticParity.mean > 0.05 ||
    diagnosticParity.p99 > 0.05 ||
    errors.length
  )
    throw new Error(JSON.stringify({ movement, pause, diagnosticParity, errors }));
  await writeFile(
    resolve(directory, 'report.json'),
    `${JSON.stringify({ status: 'pass', snapshots, movement, pause, diagnosticParity, errors, mainRecorderPresent: false }, null, 2)}\n`,
  );
} catch (error) {
  await writeFile(
    resolve(directory, 'failure.json'),
    `${JSON.stringify({ status: 'failed', error: String(error), errors, snapshots }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser.close();
}
