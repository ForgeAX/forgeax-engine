import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve(process.argv[2]);
assert(process.env.FORGEAX_RASTER_CDP, 'A dedicated qualified browser is required');
await mkdir(output, { recursive: true });
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2));
const browser = await chromium.connectOverCDP(process.env.FORGEAX_RASTER_CDP);
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(240000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (event) => {
  if (event.type() === 'error') errors.push(event.text());
});
const batches = [];
let copyMarkerGaps;
try {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(
    process.env.FORGEAX_RASTER_URL ??
      'http://127.0.0.1:8759/raster.html?resolution=384&surfaces=1&timings=1',
  );
  await page.waitForFunction(() => window.__sponzaRaster || window.__sponzaRasterFailure);
  assert.equal(await page.evaluate(() => window.__sponzaRasterFailure), undefined);
  await page.evaluate(() => window.__sponzaRaster.warm());
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return {
      userAgent: navigator.userAgent,
      vendor: adapter?.info.vendor,
      architecture: adapter?.info.architecture,
      timestampQuery: adapter?.features.has('timestamp-query'),
      scene: window.__sponzaRaster.inspect(),
    };
  });
  await save('environment.json', environment);
  assert.equal(environment.timestampQuery, true);
  assert.equal(environment.scene.width, 384);
  assert.equal(environment.scene.height, 384);
  assert.equal(environment.scene.recorderEnabled, false, 'Measure with the recorder disabled');
  // Reverse order in the second pair to expose drift. No buffer reads or
  // screenshots occur inside the measured App submission/completion interval.
  for (const mode of ['raw', 'combined', 'combined', 'raw']) {
    console.log(`Measure ${mode} batch ${batches.length + 1}`);
    const result = await page.evaluate(async (mode) => {
      const host = window.__sponzaRaster;
      await host.setDiffuseGi({
        gather: 'exact',
        maxBounces: 1,
        maxDistance: 100,
        seed: 47,
        environment: [0.25, 0.3, 0.4],
        ...(mode === 'raw' ? {} : { reconstruction: mode }),
      });
      return host.benchmark({ warmup: 2, samples: 20 });
    }, mode);
    batches.push({ mode, ...result });
    await save('batches.json', batches);
    assert(['complete', 'partial'].includes(result.status));
    for (const frame of result.frames) {
      assert.equal(frame.timing.droppedPassCount, 0);
      const missing = frame.timing.passes.filter((pass) => pass.status !== 'measured');
      for (const pass of missing) {
        assert.equal(pass.passKind, 'copy');
        assert.equal(pass.reason.code, 'timestamp-write-unavailable');
      }
      const gaps = missing.map((pass) => pass.passName).sort();
      copyMarkerGaps ??= gaps;
      assert.deepEqual(gaps, copyMarkerGaps, 'Every mode must have the same copy-only gaps');
      assert.equal(frame.timing.executedPassCount, frame.timing.measuredPassCount + missing.length);
      const reconstruction = frame.timing.passes.filter((pass) =>
        ['ray-diffuse.temporal', 'ray-diffuse.spatial'].includes(pass.passName),
      );
      assert.equal(reconstruction.length, mode === 'raw' ? 0 : 2);
      for (const pass of reconstruction) assert.equal(pass.status, 'measured');
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b),
      middle = sorted.length / 2;
    return sorted.length % 2
      ? sorted[Math.floor(middle)]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summary = Object.fromEntries(
    ['raw', 'combined'].map((mode) => {
      const frames = batches
        .filter((batch) => batch.mode === mode)
        .flatMap((batch) => batch.frames);
      const reconstructionMs = frames.map((frame) =>
        frame.timing.passes.reduce(
          (sum, pass) =>
            sum +
            (['ray-diffuse.temporal', 'ray-diffuse.spatial'].includes(pass.passName)
              ? pass.durationNanoseconds / 1e6
              : 0),
          0,
        ),
      );
      return [
        mode,
        {
          frames: frames.length,
          medianStepMs: median(frames.map((frame) => frame.stepToCompletionMs)),
          medianMeasuredGpuPassSumMs: median(
            frames.map((frame) => frame.timing.measuredPassNanoseconds / 1e6),
          ),
          medianReconstructionMs: median(reconstructionMs),
          maxReconstructionMs: Math.max(...reconstructionMs),
        },
      ];
    }),
  );
  const overhead = summary.combined.medianStepMs / summary.raw.medianStepMs - 1;
  const bytes = batches.find((batch) => batch.mode === 'combined').report.diffuseGi.reconstruction
    .allocatedBytes;
  const passed =
    overhead <= 0.15 && summary.combined.maxReconstructionMs <= 5 && bytes <= 384 * 384 * 256 + 48;
  const result = {
    status: passed ? 'pass' : 'fail',
    summary,
    medianStepOverhead: overhead,
    allocatedBytes: bytes,
    coverage: {
      reconstruction: 'complete',
      frameGpu: copyMarkerGaps.length === 0 ? 'complete' : 'partial',
      unmeasuredCopyPasses: copyMarkerGaps,
      completeFrameGpuCostQualified: copyMarkerGaps.length === 0,
    },
    scope:
      'serial whole-App step-to-completion and complete reconstruction pass cost; partial frame GPU sums exclude the listed copy markers and are not total GPU cost or display FPS',
  };
  await save('cost.json', result);
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  assert(passed, 'Predeclared cost target failed; preserve cost.json');
} finally {
  await save('errors.json', errors);
  await page.evaluate(() => window.__sponzaRaster?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
