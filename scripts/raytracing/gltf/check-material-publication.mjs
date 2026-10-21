import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const out =
  process.env.FORGEAX_MATERIAL_EVIDENCE ??
  'artifacts/raytracing/iteration-02/sponza-publication-cooked';
const base = process.env.FORGEAX_RASTER_URL ?? 'http://127.0.0.1:8739';
const runtimeModule = `/@fs${process.cwd()}/packages/assets-runtime/dist/index.mjs`;
const runtimeInternalModule = `/@fs${process.cwd()}/packages/assets-runtime/dist/internal.mjs`;
await mkdir(out, { recursive: true });
const metaPath = 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json';
const meta = JSON.parse(await readFile(metaPath, 'utf8'));
const expected = meta.subAssets.filter((entry) => entry.kind === 'material');
assert.equal(expected.length, 25);
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9737',
);
const page = await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1000, height: 1050 });
const errors = [];
const recordError = (message) => {
  errors.push(message);
  void page
    .evaluate((message) => {
      window.__materialPublicationFailure = message;
    }, message)
    .catch(() => {});
};
page.on('pageerror', (error) => recordError(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') recordError(message.text());
});
page.setDefaultTimeout(600000);
let report;
try {
  await page.goto(`${base}/raster.html?resolution=384&surfaces=1`);
  await page.waitForFunction(
    () =>
      window.__sponzaRaster || window.__sponzaRasterFailure || window.__materialPublicationFailure,
  );
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.__sponzaRasterFailure), undefined);
  await page.waitForFunction(() =>
    window.__sponzaRaster.inspect().passes.some((p) => p.includes('deferred')),
  );
  await page.evaluate(() => window.__sponzaRaster.warm());
  report = await page.evaluate(
    async ({ expected, runtimeModule, runtimeInternalModule }) => {
      const { app } = window.__sponzaRaster;
      const [{ selectMaterialPassProgram }, { runtimeAssetReference, runtimeAssets }] =
        await Promise.all([import(runtimeModule), import(runtimeInternalModule)]);
      const records = runtimeAssets(app.assets);
      const observed = expected.map(({ guid, sourceKey }) => {
        const handle = runtimeAssetReference(app.assets, guid);
        const read = handle === undefined ? undefined : records.borrow(handle);
        const payload = read?.ok ? read.value : undefined;
        const source = handle === undefined ? undefined : app.assets.sourceOf(handle);
        const projection =
          payload?.kind === 'material'
            ? app.assets.getMaterialProjectionForPayload(payload)
            : undefined;
        return {
          guid,
          sourceKey,
          handle,
          payload,
          source,
          projection,
          error: read?.ok === false ? read.error : undefined,
          status:
            handle === undefined
              ? 'missing'
              : payload?.kind === 'material' &&
                  source?.guid === guid.toLowerCase() &&
                  source.publication !== undefined &&
                  projection !== undefined
                ? 'Ready'
                : 'Error',
        };
      });
      const materials = observed.map(
        ({ guid, sourceKey, handle, payload, source, projection, error, status }) => {
          if (status !== 'Ready') {
            return {
              guid,
              sourceKey,
              handle,
              status,
              source,
              error,
              payload: {
                kind: payload?.kind,
                parent: payload?.parent,
                passes: payload?.passes?.map((p) => ({ name: p.name, program: p.program })),
                cooked: payload?.cooked !== undefined,
              },
              projection,
              expectedReadiness: observed.map(({ guid: expectedGuid, status: expectedStatus }) => ({
                guid: expectedGuid,
                status: expectedStatus,
              })),
            };
          }
          const forward = projection.passes.find((pass) => pass.name.toLowerCase() === 'forward');
          if (!forward) throw new Error(`Missing authored Forward pass for ${guid}`);
          const selected = selectMaterialPassProgram(projection, forward.name, {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'ray',
            geometry: 'mesh',
            pass: 'ray-hit',
            profile: 'forgeax-material-ray-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          });
          const artifact = app.assets.getMaterialArtifact(selected.specializationKey);
          if (artifact === undefined) throw new Error(`Missing published ray artifact for ${guid}`);
          return {
            guid,
            sourceKey,
            handle,
            status,
            generation: projection.publicationGeneration,
            publication: source.publication,
            modified: source.modified,
            programs: projection.passes.flatMap((pass) =>
              pass.programs.map((program) => ({ pass: pass.name, ...program })),
            ),
            selected,
            sourceBytes: artifact.bytes.byteLength,
            shader: new TextDecoder().decode(artifact.bytes),
            rasterContexts: projection.passes.flatMap((pass) =>
              pass.programs
                .filter((program) => program.context.pipeline !== 'ray')
                .map((program) => ({
                  pass: pass.name,
                  context: program.context,
                  entry: program.entry,
                  address: program.address,
                })),
            ),
          };
        },
      );
      const adapter = await navigator.gpu.requestAdapter();
      return {
        scope: 'Ordinary App/Pack HTTP publication and exact ray-context selection; GI is off.',
        browser: navigator.userAgent,
        adapter: { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture },
        render: window.__sponzaRaster.inspect(),
        materials,
      };
    },
    { expected, runtimeModule, runtimeInternalModule },
  );
  await writeFile(`${out}/publication.json`, JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(report.materials.length, 25);
  for (const material of report.materials) {
    assert.equal(material.status, 'Ready');
    assert.equal(material.selected.entry, 'cs_surface');
    assert.ok(material.rasterContexts.some((program) => program.context.pipeline === 'deferred'));
    assert.ok(material.shader.includes('fn cs_surface('));
    material.sourceSha256 = createHash('sha256').update(material.shader).digest('hex');
    assert.equal(`sha256:${material.sourceSha256}`, material.selected.artifactHash);
    delete material.shader;
  }
  report.sourceState = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      'packages',
      'scripts',
      'config',
      'package.json',
      'pnpm-lock.yaml',
    ],
    {
      encoding: 'utf8',
    },
  ).trim()
    ? 'working-tree'
    : 'committed';
  report.engineHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.assetHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: 'forgeax-engine-assets',
    encoding: 'utf8',
  }).trim();
  const timing = await page.evaluate(() => window.__sponzaRaster.benchmark());
  await writeFile(`${out}/timing.json`, JSON.stringify(timing, null, 2));
  const samples = timing.frames.map((frame) => frame.stepToCompletionMs).sort((a, b) => a - b);
  report.timing = {
    scope: 'Serial App step to GPU completion; not frame throughput or isolated GPU time.',
    warmup: timing.warmup,
    samples: samples.length,
    medianMs:
      (samples[Math.floor((samples.length - 1) / 2)] + samples[Math.floor(samples.length / 2)]) / 2,
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  };
  await page.screenshot({ path: `${out}/sponza.png`, fullPage: true });
  await page.locator('canvas#app').screenshot({ path: `${out}/sponza-canvas.png` });
  await writeFile(`${out}/publication.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        engine: report.engineHead,
        materials: report.materials.length,
        uniqueRayPrograms: new Set(
          report.materials.map((material) => material.selected.specializationKey),
        ).size,
        errors,
        timing: report.timing,
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(`${out}/errors.json`, JSON.stringify(errors));
  await page
    .screenshot({ path: `${out}/last-page.png`, fullPage: true, timeout: 5000 })
    .catch(() => {});
  await page.evaluate(() => window.__sponzaRaster?.dispose()).catch(() => {});
  await page.close();
  await browser.close();
}
