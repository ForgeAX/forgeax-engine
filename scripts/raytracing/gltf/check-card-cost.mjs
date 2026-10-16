import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const probes = process.argv[4] ? resolve(process.argv[4]) : null;
const resolutions = (process.argv[5] ?? '32,64').split(',').map(Number);
assert(
  resolutions.length > 0 &&
    resolutions.every((value) => Number.isInteger(value) && value >= 8 && value <= 512),
);
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('Cost:')) console.log(e.text());
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, input, probes, resolutions }) => {
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const render = await import(`/@fs/${root}packages/render/dist/internal.mjs`);
      const { createGltfResources } = await import(
        `/@fs/${root}scripts/raytracing/gltf/resources.mjs`
      );
      const load = async (name) =>
        new Uint8Array(await (await fetch(`/@fs/${input}/${name}`)).arrayBuffer());
      const prepared = JSON.parse(new TextDecoder().decode(await load('prepared.json'))),
        data = JSON.parse(new TextDecoder().decode(await load('cards.json')));
      const adapter = (await gpu.rhi.requestAdapter()).unwrap();
      if (!adapter.features.has('timestamp-query'))
        throw Error('Card GPU cost requires timestamp-query');
      const device = (
        await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
      ).unwrap();
      const native = gpu._internal_getRawDevice(device),
        gpuErrors = [];
      native.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const resources = await createGltfResources(
        device,
        gpu.createShaderModule,
        prepared,
        load,
        () => {},
      );
      const { createSdfCardChains } = await import(
        `/@fs/${root}scripts/raytracing/gltf/sdf-card-chains.mjs`
      );
      const batches = [];
      try {
        for (const resolution of [...resolutions, ...resolutions.toReversed()]) {
          const cards = (
            await render.createSurfaceCapture(
              device,
              gpu.createShaderModule,
              data.sources,
              { kind: 'cards', resolution },
              resources.resolveTexture,
            )
          ).unwrap();
          const chains = await createSdfCardChains(
            device,
            gpu.createShaderModule,
            cards,
            data.sources,
            probes,
          );
          const count = 2 + chains.length * 4;
          const queries = device.createQuerySet({ type: 'timestamp', count }).unwrap();
          const resolved = device
            .createBuffer({ size: Math.ceil((count * 8) / 256) * 256, usage: 516 })
            .unwrap();
          const readback = device.createBuffer({ size: count * 8, usage: 9 }).unwrap();
          const frames = [];
          try {
            for (let sample = -3; sample < 12; sample++) {
              let passes = 0;
              const encoder = device.createCommandEncoder({ label: 'card-cost' }).unwrap();
              const begin = encoder.beginRenderPass.bind(encoder);
              // Controller-only timestamp instrumentation forwards the real production draw stream.
              encoder.beginRenderPass = (desc) => {
                passes++;
                return begin({
                  ...desc,
                  timestampWrites: {
                    querySet: queries,
                    beginningOfPassWriteIndex: 0,
                    endOfPassWriteIndex: 1,
                  },
                });
              };
              let nextQuery = 2;
              const beginCompute = encoder.beginComputePass.bind(encoder);
              encoder.beginComputePass = (desc) => {
                const start = nextQuery;
                nextQuery += 2;
                return beginCompute({
                  ...desc,
                  timestampWrites: {
                    querySet: queries,
                    beginningOfPassWriteIndex: start,
                    endOfPassWriteIndex: start + 1,
                  },
                });
              };
              const start = performance.now();
              cards.record(encoder).unwrap();
              for (const chain of chains) {
                chain.query.record(encoder).unwrap();
                chain.lookup.record(encoder).unwrap();
              }
              const recordMs = performance.now() - start;
              encoder.resolveQuerySet(queries, 0, count, resolved, 0).unwrap();
              encoder.copyBufferToBuffer(resolved, 0, readback, 0, count * 8);
              device.queue.submit([encoder.finish().unwrap()]).unwrap();
              await device.queue.onSubmittedWorkDone();
              const submitToCompletionMs = performance.now() - start;
              const mapping = (await readback.mapAsync(1)).unwrap();
              const values = new BigUint64Array(mapping.getMappedRange().unwrap());
              const gpuNanoseconds = Number(values[1] - values[0]);
              const chainTimes = chains.map((chain, i) => ({
                section: chain.section,
                rayCount: chain.query.rayCount,
                queryGpuNanoseconds: Number(values[3 + 4 * i] - values[2 + 4 * i]),
                lookupGpuNanoseconds: Number(values[5 + 4 * i] - values[4 + 4 * i]),
              }));
              mapping.unmap();
              if (
                passes !== 1 ||
                nextQuery !== count ||
                !(gpuNanoseconds > 0) ||
                chainTimes.some(
                  (t) => !(t.queryGpuNanoseconds > 0) || !(t.lookupGpuNanoseconds > 0),
                )
              )
                throw Error('Missing complete capture-pass timing');
              if (sample >= 0)
                frames.push({ recordMs, submitToCompletionMs, gpuNanoseconds, chainTimes });
            }
            batches.push({
              resolution,
              width: cards.width,
              height: cards.height,
              allocatedBytes: cards.bytes,
              cards: cards.entries.reduce((n, e) => n + e.projections.length, 0),
              frames,
            });
            console.log(`Cost: ${resolution}px batch ${batches.length} complete`);
          } finally {
            for (const chain of chains) {
              chain.lookup.dispose();
              chain.query.dispose();
            }
            cards.dispose();
            device.destroyQuerySet(queries);
            device.destroyBuffer(resolved);
            device.destroyBuffer(readback);
          }
        }
        return {
          batches,
          gpuErrors,
          browser: navigator.userAgent,
          recorderEnabled: false,
          warmup: 3,
          scope:
            'Complete static material-card recapture plus optional frozen SDF/lookup dispatches; excludes source cooking, texture upload and other rendering. Serial CPU submission and GPU pass timestamps are separate; not frame FPS or incremental Surface Cache cost.',
        };
      } finally {
        resources.dispose();
        native.destroy();
      }
    },
    { root, input, probes, resolutions },
  );
  const median = (values) => {
    const v = [...values].sort((a, b) => a - b);
    return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2;
  };
  const summary = Object.fromEntries(
    [...new Set(resolutions)].map((resolution) => {
      const batches = result.batches.filter((b) => b.resolution === resolution),
        frames = batches.flatMap((b) => b.frames);
      return [
        resolution,
        {
          samples: frames.length,
          allocatedBytes: batches[0].allocatedBytes,
          cards: batches[0].cards,
          medianGpuMs: median(frames.map((f) => f.gpuNanoseconds / 1e6)),
          chains: frames[0].chainTimes.map((chain, i) => ({
            section: chain.section,
            rayCount: chain.rayCount,
            medianQueryGpuMs: median(frames.map((f) => f.chainTimes[i].queryGpuNanoseconds / 1e6)),
            medianLookupGpuMs: median(
              frames.map((f) => f.chainTimes[i].lookupGpuNanoseconds / 1e6),
            ),
            maxQueryGpuMs: Math.max(
              ...frames.map((f) => f.chainTimes[i].queryGpuNanoseconds / 1e6),
            ),
            maxLookupGpuMs: Math.max(
              ...frames.map((f) => f.chainTimes[i].lookupGpuNanoseconds / 1e6),
            ),
          })),
          maxGpuMs: Math.max(...frames.map((f) => f.gpuNanoseconds / 1e6)),
          medianRecordMs: median(frames.map((f) => f.recordMs)),
          medianSubmitToCompletionMs: median(frames.map((f) => f.submitToCompletionMs)),
        },
      ];
    }),
  );
  await writeFile(output, `${JSON.stringify({ ...result, summary, errors }, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
} finally {
  await page.close();
  await browser.close();
}
