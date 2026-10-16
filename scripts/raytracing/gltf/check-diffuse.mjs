import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { halfToFloat } from '../../../packages/rhi-debug/dist/index.mjs';

// The scene installs only the public profile; all GI work belongs to Renderer.
const out = resolve(process.argv[2] ?? 'artifacts/sponza-renderer-diffuse');
const reconstructed = process.argv.includes('--combined');
const cdp = process.env.FORGEAX_RASTER_CDP;
assert(cdp, 'Set FORGEAX_RASTER_CDP to the dedicated test browser');
await mkdir(out, { recursive: true });
const browser = await chromium.connectOverCDP(cdp);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (event) => {
  if (event.type() === 'error') errors.push(event.text());
});
page.setDefaultTimeout(240000);
await page.setViewportSize({ width: 1100, height: 850 });
const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2));
const progress = setInterval(() => {
  void page
    .locator('#status')
    .textContent({ timeout: 1000 })
    .then(console.log)
    .catch(() => {});
}, 20000);
try {
  await page.goto(
    process.env.FORGEAX_RASTER_URL ?? 'http://127.0.0.1:8759/raster.html?resolution=64&surfaces=1',
  );
  await page.waitForFunction(() => window.__sponzaRaster || window.__sponzaRasterFailure);
  assert.equal(await page.evaluate(() => window.__sponzaRasterFailure), undefined);
  await page.evaluate(() => window.__sponzaRaster.warm());
  const capture = async (name, tape = false) => {
    console.log(`Capture ${name}`);
    const result = await page.evaluate(
      ({ name, tape }) =>
        window.__sponzaRaster.capture(name, {
          persist: true,
          captureTape: tape,
        }),
      { name: `renderer-diffuse-${name}-${Date.now()}`, tape },
    );
    if (result.artifact) await copyFile(result.artifact.path, resolve(out, `${name}.rhitape`));
    for (const key of ['pixels', 'canvasPixels']) {
      await writeFile(resolve(out, `${name}-${key}.rgba`), Buffer.from(result[key], 'base64'));
      delete result[key];
    }
    for (const observation of result.observations) {
      await writeFile(
        resolve(out, `${name}-${observation.domain}.bin`),
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
    await save(`${name}.json`, result);
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    await page.locator('#app').screenshot({ path: resolve(out, `${name}-canvas.png`) });
    assert.deepEqual(result.report.errors, []);
    return result;
  };
  const benchmark = async (name) => {
    const result = await page.evaluate(
      (samples) => window.__sponzaRaster.benchmark({ warmup: 2, samples }),
      reconstructed ? 20 : 10,
    );
    await save(`${name}-timing.json`, result);
  };
  await benchmark('direct');
  await capture('direct');
  console.log('Prepare ordinary Renderer GI');
  const settings = {
    gather: 'exact',
    maxBounces: 1,
    maxDistance: 100,
    seed: 47,
    environment: [0.25, 0.3, 0.4],
    ...(reconstructed ? { reconstruction: 'combined' } : {}),
  };
  const ready = await page.evaluate(
    (settings) => window.__sponzaRaster.setDiffuseGi(settings),
    settings,
  );
  assert.equal(ready.diffuseGi?.state, 'ready');
  await save('gi-ready.json', ready);
  await benchmark('indirect');
  await capture('indirect', process.argv.includes('--capture-tape'));
  await page.evaluate(() => window.__sponzaRaster.setDiffuseGi());
  await capture('disabled');
  await page.evaluate(async (settings) => {
    await window.__sponzaRaster.set({ sun: false });
    return window.__sponzaRaster.setDiffuseGi({ ...settings, environment: [0, 0, 0] });
  }, settings);
  await capture('sources-off');
  const hdr = async (name) => {
    const bytes = await readFile(resolve(out, `${name}-linear-hdr.bin`));
    let energy = 0;
    for (let offset = 0; offset < bytes.length; offset += 8)
      for (const channel of [0, 2, 4]) {
        const value = halfToFloat(bytes.readUInt16LE(offset + channel));
        assert(Number.isFinite(value) && value >= 0, 'HDR must be finite and nonnegative');
        energy += value;
      }
    return { bytes, energy };
  };
  const direct = await hdr('direct');
  const indirect = await hdr('indirect');
  const disabled = await hdr('disabled');
  const off = await hdr('sources-off');
  assert.deepEqual(disabled.bytes, direct.bytes, 'Disabling GI restores exact raster HDR');
  assert(indirect.energy > direct.energy, 'Enabled GI contributes indirect energy');
  assert.equal(off.energy, 0, 'Removing all source illumination gives zero HDR');
  await save('pixel-checks.json', {
    directEnergy: direct.energy,
    indirectEnergy: indirect.energy,
    sourceOffEnergy: off.energy,
    disableRestoresExact: true,
  });
  await save(
    'environment.json',
    await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return {
        browser: navigator.userAgent,
        vendor: adapter?.info.vendor,
        architecture: adapter?.info.architecture,
        primitiveIndex: adapter?.features.has('primitive-index'),
      };
    }),
  );
  assert.deepEqual(errors, []);
  console.log('Ordinary Sponza GI controls completed');
} finally {
  clearInterval(progress);
  await save('errors.json', errors);
  await page
    .screenshot({ path: resolve(out, 'last-page.png'), fullPage: true, timeout: 5000 })
    .catch(() => {});
  await page.evaluate(() => window.__sponzaRaster?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
