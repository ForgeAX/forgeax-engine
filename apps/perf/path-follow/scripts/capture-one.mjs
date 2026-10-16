import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import UPNG from 'upng-js';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const output = resolve(process.env.FORGEAX_PATH_EVIDENCE ?? 'artifacts/path-follow');
const base = process.env.FORGEAX_PATH_URL ?? 'http://127.0.0.1:5416';
const reimport = process.env.FORGEAX_PATH_REIMPORT !== '0';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...browserLaunch, headless: true, chromiumSandbox: true});
const page = await browser.newPage({
  viewport: { width: 1040, height: 760 },
  deviceScaleFactor: 1,
  recordVideo: { dir: resolve(output, 'video'), size: { width: 1040, height: 760 } },
});
const errors = [],
  expectedConsoleErrors = [],
  rows = [],
  requests = [],
  imports = [];
let missingAsset, workerLifecycle;
const sourcePath = resolve('apps/perf/path-follow/assets/path.pack.json');
const sourceBytes = await readFile(sourcePath);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let sourceDigest = digest(sourceBytes),
  changed = false;
page.on('pageerror', (e) => {
  errors.push(String(e));
  process.stderr.write(`${String(e)}\n`);
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const location = m.location();
  const missingUrl = new URL(
    '/__pack/scopes/path-follow/1/import/01a10a05-1600-7000-8000-ffffffffffff',
    base,
  ).href;
  if (location.url === missingUrl && m.text().includes('404 (Not Found)'))
    expectedConsoleErrors.push({ text: m.text(), location });
  else errors.push(m.text());
});
page.on('response', (r) => {
  if (r.url().includes('/__pack/')) requests.push({ url: r.url(), status: r.status() });
});
async function loaded(worker = false) {
  const key = worker ? '__pathWorker' : '__pathDemo';
  await page.waitForFunction((key) => Boolean(globalThis[key]), key, { timeout: 120000 });
  if (worker) {
    await page.waitForFunction(async (key) => (await globalThis[key].snapshot()).tick >= 60, key, {
      timeout: 120000,
    });
    await page.evaluate((key) => globalThis[key].app.pause().unwrap(), key);
  } else {
    // Pause as soon as the ordinary App is ready, then select an exact World
    // tick through its existing frame stepping seam; wall delays supply no dt.
    const snapshot = await page.evaluate(() => globalThis.__pathDemo.step(0));
    if (snapshot.tick > 60)
      throw new Error(`Initial App tick passed fixed capture target: ${snapshot.tick}`);
    const ready = await page.evaluate(
      (frames) => globalThis.__pathDemo.step(frames),
      60 - snapshot.tick,
    );
    if (ready.tick !== 60) throw new Error(`App stepping missed fixed tick 60: ${ready.tick}`);
  }
}
async function capture(phase, frames, worker = false) {
  const key = worker ? '__pathWorker' : '__pathDemo';
  const snapshot = await page.evaluate(({ key, frames }) => globalThis[key].step(frames), {
    key,
    frames,
  });
  if (
    snapshot.followers.length !== 10 ||
    snapshot.followers.some((f) => f.matrix.some((x) => !Number.isFinite(x)))
  )
    throw new Error('Follower roster or finite pose invariant failed');
  await page.screenshot({ path: resolve(output, `${phase}.png`) });
  const download = page.waitForEvent('download');
  const tape = await page.evaluate(
    async ({ key, worker }) => {
      const app = globalThis[key];
      const result = worker ? await app.capture() : await app.app.rhiCapture.captureFrame();
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const bytes = new Uint8Array(result.value.bytes);
      const url = URL.createObjectURL(new Blob([bytes]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'frame.rhitape';
      a.click();
      return {
        url,
        digest: result.value.digest,
        bytes: bytes.length,
        snapshot: result.snapshot,
        tickRange: result.tickRange,
      };
    },
    { key, worker },
  );
  await (await download).saveAs(resolve(output, `${phase}.rhitape`));
  await page.evaluate((url) => URL.revokeObjectURL(url), tape.url);
  const bitmapDownload = page.waitForEvent('download');
  const bitmapUrl = await page.evaluate(async () => {
    const blob = await new Promise((resolve) => document.querySelector('#app').toBlob(resolve));
    if (!blob) throw new Error('Canvas bitmap unavailable');
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'canvas.png';
    a.click();
    return url;
  });
  await (await bitmapDownload).saveAs(resolve(output, `${phase}-canvas.png`));
  await page.evaluate((url) => URL.revokeObjectURL(url), bitmapUrl);
  const execution = await page.evaluate((key) => globalThis[key].app.execution.report(), key);
  const actual = tape.snapshot ?? snapshot;
  const platform = actual.followers.find((row) => row.name === 'platform');
  const motor = actual.platformDesired
    ? {
        desired: actual.platformDesired,
        actual: platform.matrix.slice(12, 15),
        positionError: Math.hypot(
          ...actual.platformDesired.map((value, i) => value - platform.matrix[12 + i]),
        ),
        ceiling: 1e-4,
      }
    : null;
  if (motor && motor.positionError > motor.ceiling)
    throw new Error(
      JSON.stringify({ message: 'Physics motor desired/actual mismatch', phase, motor }),
    );
  const catalogue = await catalog();
  const entries = reimport
    ? Array.isArray(catalogue) ? catalogue : catalogue.entries
    : decodeCatalogWire(catalogue).unwrap();
  const assetVersion = entries.find((row) => row.guid === actual.sceneGuid)?.publication;
  if (!assetVersion?.sourceRevision)
    throw new Error(
      JSON.stringify({
        message: 'Path publication version absent',
        phase,
        sceneGuid: actual.sceneGuid,
      }),
    );
  const row = {
    phase,
    snapshot: actual,
    motor,
    assetVersion,
    tickRange: tape.tickRange ?? [snapshot.tick, snapshot.tick],
    execution,
    sourceDigest,
    digest: tape.digest,
    bytes: tape.bytes,
  };
  rows.push(row);
  return snapshot;
}
async function bitmapDifference(first, second) {
  const decode = async (phase) => {
    const bytes = await readFile(resolve(output, `${phase}-canvas.png`));
    const png = UPNG.decode(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    return { width: png.width, height: png.height, rgba: new Uint8Array(UPNG.toRGBA8(png)[0]) };
  };
  const a = await decode(first),
    b = await decode(second);
  if (a.width !== b.width || a.height !== b.height) throw new Error('Bitmap extent changed');
  let sum = 0,
    changedPixels = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    let max = 0;
    for (let j = 0; j < 3; j++) {
      const d = Math.abs(a.rgba[i + j] - b.rgba[i + j]);
      sum += d;
      max = Math.max(max, d);
    }
    if (max > 12) changedPixels++;
  }
  return { first, second, changedPixels, meanRGB: sum / (a.width * a.height * 3 * 255) };
}
async function catalog() {
  const response = await page.request.get(
    new URL(reimport ? '/__pack/scopes/path-follow/1/catalog.json' : '/pack-index.json', base).href,
  );
  if (!response.ok()) throw new Error('Ordinary dev Catalog request failed');
  return response.json();
}
try {
  await page.goto(base);
  await loaded();
  missingAsset = await page.evaluate(() => globalThis.__pathDemo.missingAsset());
  if (missingAsset.ok || !missingAsset.error?.code)
    throw new Error('Missing GUID did not return a structured asset error');
  if (reimport) imports.push({ phase: 'original', catalog: await catalog() });
  const initial = await capture('tick60', 0);
  const advanced = await capture('advanced', 60);
  if (advanced.followers.every((f, i) => f.distance === initial.followers[i].distance))
    throw new Error('Movement falsifier failed');
  await page.click('#pause');
  const paused = await capture('paused', 60);
  if (paused.followers.some((f, i) => f.distance !== advanced.followers[i].distance))
    throw new Error('Pause falsifier failed');
  await page.click('#pause');
  await capture('resumed', 60);
  await page.click('#camera');
  // App.stepFrame remains the World update/draw path; this wait only makes the
  // diagnostic video visible at normal playback speed. It supplies no game time.
  for (let i = 0; i < 120; i++) {
    await page.evaluate(() => globalThis.__pathDemo.step(1));
    await page.waitForTimeout(16);
  }
  await capture('camera', 0);
  await page.click('#pause');
  await page.click('#camera');
  await page.evaluate(() => globalThis.__pathDemo.closeup());
  await capture('closeup', 0);
  const imageMovement = await bitmapDifference('tick60', 'advanced');
  const imagePause = await bitmapDifference('advanced', 'paused');
  if (
    imageMovement.changedPixels < 100 ||
    imagePause.changedPixels > imageMovement.changedPixels / 10
  )
    throw new Error(
      JSON.stringify({ message: 'Image motion/pause falsifier failed', imageMovement, imagePause }),
    );
  await page.goto(new URL('worker.html', base.endsWith('/') ? base : `${base}/`).href);
  await loaded(true);
  const worker = await capture('worker', 60, true);
  const oldWorkers = page.workers();
  if (oldWorkers.length !== 1) throw new Error('Expected one live Engine Worker');
  const oldWorker = oldWorkers[0];
  workerLifecycle = {
    before: { url: oldWorker.url(), worldIdentity: worker.worldIdentity },
    oldWorkerClosed: false,
    after: null,
  };
  oldWorker.once('close', () => {
    workerLifecycle.oldWorkerClosed = true;
  });
  await page.reload();
  await loaded(true);
  const replacement = await capture('worker-recreated', 60, true);
  const newWorkers = page.workers();
  if (newWorkers.length !== 1 || newWorkers[0] === oldWorker || !workerLifecycle.oldWorkerClosed)
    throw new Error('Worker reload failed to close the old realm and create a fresh realm');
  // World identities are realm-local counters. A new Worker legitimately
  // starts again at world-1; observe native Worker lifetime, not a fake UUID.
  workerLifecycle.after = { url: newWorkers[0].url(), worldIdentity: replacement.worldIdentity };
  if (reimport) {
    await page.goto(base);
    await loaded();
    const before = await capture('before-reimport', 0);
    const authored = JSON.parse(sourceBytes);
    authored.assets['scene/path'].payload.entities.rail.components.Path.points[1] += 1;
    const next = Buffer.from(`${JSON.stringify(authored, null, 2)}\n`);
    changed = true;
    sourceDigest = digest(next);
    const reloaded = page.waitForEvent('load', { timeout: 120000 });
    await writeFile(sourcePath, next);
    await reloaded;
    await loaded();
    const after = await capture('reimported', 0);
    imports.push({ phase: 'reimported', catalog: await catalog() });
    if (
      rows.at(-1).assetVersion.sourceRevision ===
      rows.find((row) => row.phase === 'before-reimport').assetVersion.sourceRevision
    )
      throw new Error('Producer reimport retained old source revision');
    if (after.sceneGuid !== before.sceneGuid || after.path[1] !== before.path[1] + 1)
      throw new Error('Reimport GUID identity or current authored controls failed');
    if (
      after.followers.every((row, index) =>
        row.matrix.every((value, j) => value === before.followers[index].matrix[j]),
      )
    )
      throw new Error('Reimport retained stale path projection');
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
  const metadata = {
    userAgent: await page.evaluate(() => navigator.userAgent),
    url: base,
    node: process.version,
    platform: process.platform,
  };
  await writeFile(
    resolve(output, 'capture.json'),
    `${JSON.stringify(
      {
        status: 'pass',
        metadata,
        missingAsset,
        workerLifecycle,
        expectedConsoleErrors,
        errors,
        requests,
        imports,
        imageMovement,
        imagePause,
        rows,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  await writeFile(
    resolve(output, 'capture-failure.json'),
    `${JSON.stringify(
      {
        status: 'failed',
        error: String(error),
        missingAsset,
        workerLifecycle,
        errors,
        expectedConsoleErrors,
        requests,
        imports,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (changed) await writeFile(sourcePath, sourceBytes);
  const video = page.video();
  try {
    await page.context().close();
    if (video) await video.saveAs(resolve(output, 'effect.webm'));
  } finally {
    await browser.close();
  }
}
