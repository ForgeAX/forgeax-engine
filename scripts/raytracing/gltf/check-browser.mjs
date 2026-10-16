import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import browserLaunch from '../../ci/browser-launch.json' with { type: 'json' };

const out = resolve(process.argv[2] ?? 'artifacts/ray-sponza-browser');
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
page.setDefaultTimeout(600000);
try {
  await page.goto('http://127.0.0.1:5197/?resolution=128&samples=2');
  await page.waitForFunction(() => window.__gltfScene?.result);
  await page.screenshot({ path: resolve(out, 'scene.png'), fullPage: true });
  const inspect = () =>
    page.evaluate(() => {
      const r = window.__gltfScene.result;
      return {
        report: r.report,
        sums: r.raw.map((bytes) => {
          const f = new Float32Array(bytes.buffer);
          let sum = 0;
          for (let i = 0; i < f.length; i += 20) sum += f[i] + f[i + 1] + f[i + 2];
          return sum;
        }),
      };
    });
  const baseline = await inspect();
  await writeFile(resolve(out, 'baseline.json'), JSON.stringify(baseline, null, 2));
  assert(baseline.report.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  assert(baseline.sums[0] > 0 && baseline.sums[1] > baseline.sums[0]);
  console.log('Full Sponza baseline passed; replaying both displays');
  const replay = await page.evaluate(() => window.__gltfScene.replay());
  // Four readback staging buffers are initialized by captured GPU copies.
  assert.equal(replay.unseededResources.length, 4);
  await page.selectOption('#light', '0');
  await page.selectOption('#samples', '1');
  await page.selectOption('#resolution', '64');
  await page.locator('#render').click();
  await page.waitForFunction(() => window.__gltfScene.result?.report.light === 0);
  const off = await inspect();
  assert.deepEqual(off.sums, [0, 0]);
  assert(off.report.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  await page.screenshot({ path: resolve(out, 'light-off.png') });
  await page.selectOption('#light', '1');
  await page.selectOption('#camera', '4');
  await page.locator('#render').click();
  await page.waitForFunction(() => window.__gltfScene.result?.report.camera.origin[2] === 4);
  const moved = await inspect();
  await writeFile(resolve(out, 'moved.json'), JSON.stringify(moved, null, 2));
  await page.screenshot({ path: resolve(out, 'camera-side.png') });
  assert(moved.sums[0] > 0);
  assert(moved.report.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  await page.screenshot({ path: resolve(out, 'camera-side.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__gltfScene.errors), []);
  await writeFile(
    resolve(out, 'checks.json'),
    JSON.stringify({ baseline, replay, off, moved, errors }, null, 2),
  );
  console.log(`Sponza browser, controls and fresh replay passed: ${out}`);
} finally {
  try {
    await page.evaluate(() => window.__gltfScene?.dispose());
  } finally {
    await browser.close();
  }
}
