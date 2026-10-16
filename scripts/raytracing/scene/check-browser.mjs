import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import browserLaunch from '../../ci/browser-launch.json' with { type: 'json' };

const out = resolve(process.argv[2] ?? 'artifacts/ray-gi-scene-browser');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  ...browserLaunch,
  headless: true,
  args: [...browserLaunch.args, '--use-angle=swiftshader'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 1320, height: 960 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(`${e.location().url}: ${e.text()}`);
});
page.setDefaultTimeout(180000);
try {
  await page.goto('http://127.0.0.1:5196/?resolution=256&samples=64');
  await page.waitForFunction(() => window.__giScene?.result);
  await page.screenshot({ path: resolve(out, 'scene.png'), fullPage: true });
  const baseline = await page.evaluate(() => {
    const r = window.__giScene.result,
      f = new Float32Array(r.raw.field.buffer),
      p = new Float32Array(r.raw.path.buffer),
      u = new Uint32Array(r.raw.path.buffer);
    let illuminatedShadow = 0,
      invalid = 0;
    const n = r.report.options.resolution ** 2;
    for (let i = 0; i < n; i++) {
      if (
        f[i * 20] + f[i * 20 + 1] + f[i * 20 + 2] < 0.001 &&
        f[i * 20 + 12] + f[i * 20 + 13] + f[i * 20 + 14] > 0.03
      )
        illuminatedShadow++;
      if (u[i * 20 + 7] !== 0 || u[i * 20 + 3] !== 64) invalid++;
    }
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    return {
      report: r.report,
      illuminatedShadow,
      invalid,
      meanPath: sum(p.filter((_v, i) => i % 20 < 3)) / (n * 3),
    };
  });
  assert(baseline.illuminatedShadow > 500);
  assert.equal(baseline.invalid, 0);
  console.log('Baseline scene passed; replaying on a fresh device');
  const replay = await page.evaluate(() => window.__giScene.replay());
  assert.equal(replay.unseededResources.length, 0);
  const download = page.waitForEvent('download');
  await page.locator('#capture').click();
  await (await download).saveAs(resolve(out, 'scene.rhitape'));
  // Drive the actual controls, then check linear lighting so tone mapping cannot mask stale data.
  console.log('Fresh replay passed; testing light and material controls');
  await page.selectOption('#light', '0');
  await page.selectOption('#samples', '32');
  await page.locator('#render').click();
  await page.waitForFunction(() => window.__giScene.result.report.options.light === 0);
  const off = await page.evaluate(() =>
    Object.fromEntries(
      ['field', 'path'].map((key) => {
        const r = window.__giScene.result,
          a = new Float32Array(r.raw[key].buffer);
        let max = 0;
        for (let i = 0; i < a.length / 20; i++)
          for (let c = 0; c < 3; c++)
            max = Math.max(max, Math.abs(a[i * 20 + (key === 'field' ? 12 : 0) + c]));
        return [key, max];
      }),
    ),
  );
  assert.deepEqual(off, { field: 0, path: 0 });
  await page.screenshot({ path: resolve(out, 'light-off.png') });
  await page.selectOption('#light', '1');
  await page.selectOption('#wall', 'white');
  await page.locator('#render').click();
  await page.waitForFunction(() => window.__giScene.result.report.options.wall === 'white');
  const white = await page.evaluate(() => window.__giScene.result.report);
  const b = baseline.report.radiometry.boxIndirectMean,
    w = white.radiometry.boxIndirectMean;
  assert(b[0] / b[1] > 1.5);
  assert(w[0] / w[1] < (b[0] / b[1]) * 0.8);
  console.log('Light-off and material color bounce updates passed');
  await page.screenshot({ path: resolve(out, 'white-wall.png') });
  await page.selectOption('#camera', '1.5');
  await page.locator('#render').click();
  await page.waitForFunction(() => window.__giScene.result.report.options.cameraX === 1.5);
  const moved = await page.evaluate(() => window.__giScene.result.report);
  await page.screenshot({ path: resolve(out, 'camera-right.png') });
  await writeFile(
    resolve(out, 'checks.json'),
    JSON.stringify({ baseline, replay, off, white, moved, errors }, null, 2),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__giScene.errors), []);
  console.log(`Browser scene, controls and fresh replay passed: ${out}`);
} finally {
  try {
    await page.evaluate(() => window.__giScene?.dispose());
  } finally {
    await browser.close();
  }
}
