import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import browserLaunch from '../../ci/browser-launch.json' with { type: 'json' };

const out = resolve(process.argv[2] ?? 'artifacts/sponza-raster');
await mkdir(out, { recursive: true });
const remoteCdp = process.env.FORGEAX_RASTER_CDP;
const captureTape = !process.argv.includes('--observe-only');
const browser = remoteCdp
  ? await chromium.connectOverCDP(remoteCdp)
  : await chromium.launch({
      ...browserLaunch,
      headless: true,
      args: [
        ...browserLaunch.args,
        '--use-angle=swiftshader',
        '--js-flags=--max-old-space-size=8192',
      ],
      chromiumSandbox: true,
    });
const page = remoteCdp ? await browser.contexts()[0].newPage() : await browser.newPage();
await page.setViewportSize({ width: 1000, height: 1050 });
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error(e.message);
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Inspector.enable');
cdp.on('Inspector.targetCrashed', (event) =>
  console.error('Inspector.targetCrashed', JSON.stringify(event)),
);
page.on('crash', () => {
  errors.push('Browser page crashed');
  console.error('Browser page crashed');
});
page.on('console', (e) => {
  if (e.type() === 'error') {
    errors.push(e.text());
    console.error(e.text());
  }
});
page.setDefaultTimeout(600000);
const progress = setInterval(() => {
  void page
    .locator('#status')
    .textContent({ timeout: 2000 })
    .then((text) => console.log(text))
    .catch(() => {});
}, 20000);
try {
  await page.goto(
    process.env.FORGEAX_RASTER_URL ??
      `http://127.0.0.1:5198/raster.html?resolution=${process.argv[3] ?? 128}`,
  );
  await page.waitForFunction(() => window.__sponzaRaster || window.__sponzaRasterFailure);
  const failure = await page.evaluate(() => window.__sponzaRasterFailure);
  assert.equal(failure, undefined);
  console.log('Scene loaded; awaiting GPU readiness');
  await page.waitForFunction(() =>
    window.__sponzaRaster.inspect().passes.some((p) => p.includes('deferred')),
  );
  // Shader readiness is asynchronous. The same App owns each warm-up frame.
  await page.evaluate(() => window.__sponzaRaster.warm());
  // Measure before any observation/capture allocates diagnostic readbacks.
  if (process.argv.includes('--benchmark')) {
    const timing = await page.evaluate(() => window.__sponzaRaster.benchmark());
    await writeFile(resolve(out, 'timing.json'), JSON.stringify(timing, null, 2));
  }
  const capture = async (name) => {
    console.log(`Capturing ${name}`);
    const downloaded = remoteCdp || !captureTape ? undefined : page.waitForEvent('download');
    const result = await page.evaluate(
      ({ name, persist, captureTape }) =>
        window.__sponzaRaster.capture(`sponza-raster-${name}-${Date.now()}`, {
          persist,
          captureTape,
        }),
      { name, persist: Boolean(remoteCdp), captureTape },
    );
    if (downloaded) await (await downloaded).saveAs(resolve(out, `${name}.rhitape`));
    else if (result.artifact) await copyFile(result.artifact.path, resolve(out, `${name}.rhitape`));
    await writeFile(resolve(out, `${name}.rgba`), Buffer.from(result.pixels, 'base64'));
    await writeFile(
      resolve(out, `${name}-canvas.rgba`),
      Buffer.from(result.canvasPixels, 'base64'),
    );
    delete result.pixels;
    delete result.canvasPixels;
    for (const observation of result.observations) {
      await writeFile(
        resolve(out, `${name}-live-${observation.domain}.bin`),
        Buffer.from(observation.bytes, 'base64'),
      );
      delete observation.bytes;
      if (observation.records !== undefined) {
        await writeFile(
          resolve(out, `${name}-${observation.domain}-records.u32`),
          Buffer.from(observation.records, 'base64'),
        );
        delete observation.records;
      }
    }
    await writeFile(resolve(out, `${name}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    return result;
  };
  // Restore the exact source light immediately before capture so the frame
  // contains the real shadow-map producer, not only a retained atlas seed.
  await page.evaluate(async () => {
    await window.__sponzaRaster.set({ direction: [0.46, -1, -0.2] });
    await window.__sponzaRaster.warm();
    await window.__sponzaRaster.set();
  });
  await page.screenshot({ path: resolve(out, 'before-capture.png'), fullPage: true });
  const result = await capture('baseline');
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return {
      browser: navigator.userAgent,
      vendor: adapter?.info.vendor,
      architecture: adapter?.info.architecture,
      primitiveIndex: adapter?.features.has('primitive-index'),
    };
  });
  await writeFile(resolve(out, 'environment.json'), JSON.stringify(environment, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.report.errors, []);
  assert.equal(result.report.profile.renderPath, 'deferred');
  assert.equal(result.report.profile.ibl, false);
  assert.equal(result.report.profile.ssao, false);
  if (process.argv.includes('--controls')) {
    for (const [name, options] of [
      ['light-off', { sun: false }],
      ['shadows-off', { shadows: false }],
      ['restored', {}],
      ['side', { side: 4 }],
    ]) {
      await page.evaluate(async (options) => {
        await window.__sponzaRaster.set(options);
        await window.__sponzaRaster.warm();
      }, options);
      const control = await capture(name);
      assert.deepEqual(control.report.errors, []);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      artifact: result.artifact,
      width: result.report.width,
      height: result.report.height,
      passes: result.report.passes,
    }),
  );
} finally {
  clearInterval(progress);
  await page
    .screenshot({ path: resolve(out, 'last-page.png'), fullPage: true, timeout: 5000 })
    .catch(() => {});
  await writeFile(resolve(out, 'errors.json'), JSON.stringify(errors));
  if (!errors.includes('Browser page crashed'))
    await page.evaluate(() => window.__sponzaRaster?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
