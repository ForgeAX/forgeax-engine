import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]),
  cardInput = resolve(process.argv[4]);
const resolution = Number(process.argv[5] ?? 64);
assert(Number.isInteger(resolution) && resolution >= 8 && resolution <= 512);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [],
  sizes = new Map();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('SDF:')) console.log(e.text());
});
await page.exposeFunction('saveSdfChunk', async (name, offset, base64) => {
  assert(/^[a-zA-Z0-9_-]+\.(bin|json|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(base64, 'base64');
  if (offset === 0) await writeFile(resolve(output, name), bytes);
  else await appendFile(resolve(output, name), bytes);
  sizes.set(name, offset + bytes.length);
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, input, cardInput, resolution }) => {
      try {
        const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
        const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
        const render = await import(`/@fs/${root}packages/render/dist/internal.mjs`);
        const geometry = await import(`/@fs/${root}packages/geometry/dist/index.mjs`);
        const load = async (name) => {
          const r = await fetch(`/@fs/${input}/${name}`);
          if (!r.ok) throw Error(`input ${name}: ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        };
        const json = async (name) => JSON.parse(new TextDecoder().decode(await load(name)));
        const send = async (name, bytes) => {
          for (let offset = 0; offset < bytes.length; offset += 262144) {
            const chunk = bytes.subarray(offset, offset + 262144);
            let binary = '';
            for (let i = 0; i < chunk.length; i += 8192)
              binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
            await window.saveSdfChunk(name, offset, btoa(binary));
          }
        };
        const { createGltfResources } = await import(
          `/@fs/${root}scripts/raytracing/gltf/resources.mjs`
        );
        const cardLoad = async (name) => {
          const r = await fetch(`/@fs/${cardInput}/${name}`);
          if (!r.ok) throw Error(`card input ${name}: ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        };
        const cardJson = async (name) => JSON.parse(new TextDecoder().decode(await cardLoad(name)));
        const prepared = await cardJson('prepared.json'),
          cardData = await cardJson('cards.json');
        const manifest = await json('composition.json'),
          inputs = [],
          gpuErrors = [],
          fields = new Map();
        for (const row of manifest.cases.filter((r) =>
          ['complete-roster', 'receiver'].includes(r.name),
        )) {
          const sources = [];
          for (const source of row.sources) {
            let field = source.field;
            if (source.fieldFile) {
              if (!fields.has(source.fieldFile)) {
                const bytes = await load(source.fieldFile);
                const digest = Array.from(
                  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                  (b) => b.toString(16).padStart(2, '0'),
                ).join('');
                if (digest !== manifest.fields[source.fieldFile].sha256)
                  throw Error('field digest mismatch');
                fields.set(
                  source.fieldFile,
                  (await geometry.decodeMeshDistanceField(bytes, source.meshDigest)).unwrap(),
                );
              }
              field = fields.get(source.fieldFile);
            }
            sources.push({ ...source, field });
          }
          inputs.push({
            section: row.name,
            sources,
            grid: row.grid,
            rays: row.queryFile ? (await json(row.queryFile)).rays : undefined,
          });
        }
        // The same plans drive capture, readback, replay and unrecorded timing.
        const prepare = async (device, compile) => {
          const plans = [];
          try {
            for (const data of inputs) {
              const composition = (
                await render.createGlobalSdfComposition(device, compile, data.sources, data.grid)
              ).unwrap();
              plans.push({
                name: data.section,
                kind: 'composition',
                plan: composition,
                buffer: composition.buffers.voxels,
                size: composition.voxelCount * 16,
                binding: 4,
              });
              if (data.rays) {
                const query = (
                  await render.createGlobalSdfQuery(device, compile, composition, data.rays)
                ).unwrap();
                plans.push({
                  name: `${data.section}-query`,
                  kind: 'query',
                  plan: query,
                  buffer: query.buffers.hits,
                  size: query.rayCount * render.GLOBAL_SDF_HIT_STRIDE,
                  binding: 3,
                });
                const resources = await createGltfResources(
                  device,
                  compile,
                  prepared,
                  cardLoad,
                  () => {},
                );
                let cards, lookup;
                try {
                  cards = (
                    await render.createSurfaceCapture(
                      device,
                      compile,
                      cardData.sources,
                      { kind: 'cards', resolution },
                      resources.resolveTexture,
                    )
                  ).unwrap();
                  // Seed real raster Card images before this association capture. Their complete
                  // initial bytes enter the tape; timestamps below exclude Card production.
                  const encoder = device.createCommandEncoder({}).unwrap();
                  cards.record(encoder).unwrap();
                  device.queue.submit([encoder.finish().unwrap()]).unwrap();
                  await device.queue.onSubmittedWorkDone();
                  lookup = (
                    await render.createGlobalSdfCardLookup(
                      device,
                      compile,
                      composition,
                      query,
                      cards,
                      cardData.sources,
                    )
                  ).unwrap();
                  plans.push({
                    name: `${data.section}-candidates`,
                    kind: 'candidates',
                    plan: {
                      record: (e) => lookup.record(e),
                      dispose: () => {
                        lookup.dispose();
                        cards.dispose();
                        resources.dispose();
                      },
                    },
                    buffer: lookup.candidateBuffer,
                    size: query.rayCount * render.GLOBAL_CARD_CANDIDATE_STRIDE,
                    binding: 5,
                  });
                  plans.push({
                    name: `${data.section}-samples`,
                    kind: 'samples',
                    plan: undefined,
                    buffer: lookup.buffer,
                    size: query.rayCount * 4 * render.CARD_LOOKUP_STRIDE,
                    binding: 7,
                  });
                } catch (cause) {
                  lookup?.dispose();
                  cards?.dispose();
                  resources.dispose();
                  throw cause;
                }
              }
            }
            return plans;
          } catch (cause) {
            for (const { plan } of plans.toReversed()) plan?.dispose();
            throw cause;
          }
        };
        const read = async (device, buffer, size) => {
          const staging = device.createBuffer({ size, usage: 9 }).unwrap();
          try {
            const encoder = device.createCommandEncoder({}).unwrap();
            encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
            device.queue.submit([encoder.finish().unwrap()]).unwrap();
            const mapped = (await staging.mapAsync(1)).unwrap();
            const bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
            mapped.unmap();
            return bytes;
          } finally {
            device.destroyBuffer(staging);
          }
        };
        const recorder = debug.attachRecorder(gpu).unwrap();
        const device = (
          await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
        ).unwrap();
        const raw = gpu._internal_getRawDevice(device._realDevice);
        if (!raw) throw Error('capture native device unavailable');
        raw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const queries = [],
          live = [];
        let tapeBytes;
        try {
          queries.push(...(await prepare(device, recorder.backend.createShaderModule)));
          const capture = recorder.captureFrame();
          (await recorder.frameBoundary()).unwrap();
          const encoder = device.createCommandEncoder({ label: 'imported-sdf-probes' }).unwrap();
          for (const { plan } of queries) plan?.record(encoder).unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          (await recorder.frameBoundary()).unwrap();
          tapeBytes = (await capture).unwrap().bytes;
          await send('global-cards.rhitape', tapeBytes);
          for (let i = 0; i < queries.length; i++) {
            const bytes = await read(device, queries[i].buffer, queries[i].size);
            live.push(bytes);
            await send(`${queries[i].name}.bin`, bytes);
          }
        } finally {
          for (const { plan } of queries.toReversed()) plan?.dispose();
          (await recorder.dispose()).unwrap();
          raw.destroy();
        }
        const tape = debug.decodeTape(tapeBytes).unwrap(),
          model = debug.buildFrameModel(tape);
        if (model.unseededResources.length || model.works.length !== queries.length)
          throw Error('incomplete captured work closure');
        const cardTextures = model.resources.filter(
          (r) =>
            r.descriptor?.kind === 'createTexture' && r.descriptor.desc.label?.startsWith('cards.'),
        );
        const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
        const freshRaw = gpu._internal_getRawDevice(fresh);
        if (!freshRaw) throw Error('replay native device unavailable');
        freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const replay = (
          await debug.openReplay(tape, {
            device: fresh,
            createShaderModule: gpu.createShaderModule,
          })
        ).unwrap();
        const replayRows = [];
        try {
          const resources = model.works.map(
            (work, i) => work.bindings.find((b) => b.binding === queries[i].binding).resourceId,
          );
          for (const resource of resources)
            if (!(await replay.readResource(resource)).unwrap().bytes.every((v) => v === 0))
              throw Error('no-work output is nonzero');
          for (let i = 0; i < resources.length; i++) {
            const bytes = (await replay.readResourceAtWork(resources[i], i)).unwrap().bytes;
            const differing =
              bytes.length === live[i].length
                ? bytes.reduce((n, b, j) => n + Number(b !== live[i][j]), 0)
                : -1;
            replayRows.push({
              section: queries[i].name,
              kind: queries[i].kind,
              workIndex: i,
              resourceId: resources[i],
              differentBytes: differing,
            });
            if (differing !== 0) throw Error(`replay difference at work ${i}`);
          }
          for (const [i, resource] of cardTextures.entries()) {
            const bytes = (
              await replay.readResourceAtWork(resource.resourceId, model.works.at(-1).workIndex)
            ).unwrap().bytes;
            await send(`card-plane-${i}.bin`, bytes);
          }
        } finally {
          (await replay.dispose()).unwrap();
          freshRaw.destroy();
        }
        console.log(`SDF: exact replay of ${queries.length} composition/query works`);
        // Timestamp controls use an independent device with no recorder.
        const adapter = (await gpu.rhi.requestAdapter()).unwrap();
        if (!adapter.features.has('timestamp-query')) throw Error('timestamp-query unavailable');
        const costDevice = (
          await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
        ).unwrap();
        const costRaw = gpu._internal_getRawDevice(costDevice);
        if (!costRaw) throw Error('cost native device unavailable');
        costRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const costs = [],
          owned = [];
        const timestamps = costDevice
          .createQuerySet({ type: 'timestamp', count: queries.length * 2 })
          .unwrap();
        const size = queries.length * 16;
        const resolved = costDevice
          .createBuffer({ size: Math.ceil(size / 256) * 256, usage: 516 })
          .unwrap();
        const readback = costDevice.createBuffer({ size, usage: 9 }).unwrap();
        try {
          owned.push(...(await prepare(costDevice, gpu.createShaderModule)));
          for (let sample = -3; sample < 24; sample++) {
            const encoder = costDevice.createCommandEncoder({}).unwrap(),
              begin = encoder.beginComputePass.bind(encoder);
            let pass = 0;
            encoder.beginComputePass = (desc) => {
              const i = pass++;
              return begin({
                ...desc,
                timestampWrites: {
                  querySet: timestamps,
                  beginningOfPassWriteIndex: i * 2,
                  endOfPassWriteIndex: i * 2 + 1,
                },
              });
            };
            const start = performance.now();
            for (const { plan } of owned) plan?.record(encoder).unwrap();
            const recordMs = performance.now() - start;
            encoder.resolveQuerySet(timestamps, 0, queries.length * 2, resolved, 0).unwrap();
            encoder.copyBufferToBuffer(resolved, 0, readback, 0, size);
            costDevice.queue.submit([encoder.finish().unwrap()]).unwrap();
            await costDevice.queue.onSubmittedWorkDone();
            const completionMs = performance.now() - start;
            const mapping = (await readback.mapAsync(1)).unwrap(),
              values = new BigUint64Array(mapping.getMappedRange().unwrap());
            const gpuNanoseconds = queries.map((_, i) => Number(values[i * 2 + 1] - values[i * 2]));
            mapping.unmap();
            if (pass !== queries.length || gpuNanoseconds.some((n) => n <= 0))
              throw Error('incomplete timestamp coverage');
            if (sample >= 0) costs.push({ recordMs, completionMs, gpuNanoseconds });
          }
        } finally {
          for (const { plan } of owned.toReversed()) plan?.dispose();
          costDevice.destroyQuerySet(timestamps);
          costDevice.destroyBuffer(resolved);
          costDevice.destroyBuffer(readback);
          costRaw.destroy();
        }
        return {
          browser: navigator.userAgent,
          adapter: (await navigator.gpu.requestAdapter()).info,
          requiredFeatures: ['timestamp-query'],
          adapterIdentity: 'RHI does not expose adapter info; pair with the test-machine record.',
          works: replayRows,
          cardInput,
          resolution,
          cardTextures: cardTextures.map((r, i) => ({
            file: `card-plane-${i}.bin`,
            id: r.resourceId,
            desc: r.descriptor.desc,
          })),
          cardCaptureCostIncluded: false,
          associationScope:
            'Four per-candidate samples; no material resolve, lighting or GI acceptance.',
          cases: inputs.map((d) => ({
            name: d.section,
            grid: d.grid,
            instances: d.sources.length,
            missing: d.sources.filter((s) => s.field.missing).length,
            rays: d.rays?.length ?? 0,
          })),
          unseededResources: model.unseededResources,
          noWorkNonzeroBytes: 0,
          gpuErrors,
          costs,
          warmup: 3,

          recorderEnabledForCost: false,
          cpuTimingLimit:
            'Browser performance.now quantization applies; zero recordMs means below timer resolution, not zero CPU work.',
          scope: manifest.scope,
        };
      } catch (cause) {
        throw Error(
          JSON.stringify({
            message: cause?.message,
            code: cause?.code,
            detail: cause?.detail,
            cause,
            stack: cause?.stack,
          }),
        );
      }
    },
    { root, input, cardInput, resolution },
  );
  await writeFile(resolve(output, 'gpu.json'), JSON.stringify({ ...result, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
  console.log(
    JSON.stringify({
      works: result.works.length,
      samples: result.costs.length,
      gpuErrors: result.gpuErrors,
    }),
  );
} finally {
  await page.close();
  await browser.close();
}
