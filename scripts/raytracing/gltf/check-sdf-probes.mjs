import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = resolve(process.argv[2]),
  output = resolve(process.argv[3]);
const maxSteps = Number(process.argv[4] ?? 128);
const visibilityExpansion = process.argv[5] ?? 'clearance';
assert(['clearance', 'ray-distance'].includes(visibilityExpansion));
assert(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1024);
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
    async ({ root, input, maxSteps, visibilityExpansion }) => {
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
      const manifest = await json('probes.json'),
        inputs = [],
        gpuErrors = [];
      for (const row of manifest.rows) {
        const data = await json(row.file);
        const fieldBytes = await load(data.fieldFile);
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', fieldBytes)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
        if (digest !== row.artifactSha256) throw Error('probe field digest mismatch');
        const field = (
          await geometry.decodeMeshDistanceField(fieldBytes, data.meshDigest)
        ).unwrap();
        inputs.push({ section: row.section, source: { ...data.instance, field }, rays: data.rays });
      }
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
        for (const data of inputs)
          queries.push(
            (
              await render.createSdfQuery(
                device,
                recorder.backend.createShaderModule,
                [data.source],
                data.rays,
                { maxSteps, visibilityExpansion },
              )
            ).unwrap(),
          );
        const capture = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const encoder = device.createCommandEncoder({ label: 'imported-sdf-probes' }).unwrap();
        for (const query of queries) query.record(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        (await recorder.frameBoundary()).unwrap();
        tapeBytes = (await capture).unwrap().bytes;
        await send('sdf.rhitape', tapeBytes);
        for (let i = 0; i < queries.length; i++) {
          const bytes = await read(device, queries[i].buffers.hits, queries[i].rayCount * 64);
          live.push(bytes);
          await send(`section-${inputs[i].section}-hits.bin`, bytes);
        }
      } finally {
        for (const query of queries) query.dispose();
        (await recorder.dispose()).unwrap();
        raw.destroy();
      }
      const tape = debug.decodeTape(tapeBytes).unwrap(),
        model = debug.buildFrameModel(tape);
      if (model.unseededResources.length || model.works.length !== inputs.length)
        throw Error('incomplete captured work closure');
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const freshRaw = gpu._internal_getRawDevice(fresh);
      if (!freshRaw) throw Error('replay native device unavailable');
      freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
        await debug.openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      const replayRows = [];
      try {
        const resources = model.works.map(
          (work) => work.bindings.find((b) => b.binding === 3).resourceId,
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
            section: inputs[i].section,
            workIndex: i,
            resourceId: resources[i],
            differentBytes: differing,
          });
          if (differing !== 0) throw Error(`replay difference at work ${i}`);
        }
      } finally {
        (await replay.dispose()).unwrap();
        freshRaw.destroy();
      }
      console.log(`SDF: exact replay of ${inputs.length} imported sections`);
      // Timestamp and low-step controls use an independent device with no recorder.
      const adapter = (await gpu.rhi.requestAdapter()).unwrap();
      if (!adapter.features.has('timestamp-query')) throw Error('timestamp-query unavailable');
      const costDevice = (
        await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
      ).unwrap();
      const costRaw = gpu._internal_getRawDevice(costDevice);
      costRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const costs = [],
        owned = [];
      const timestamps = costDevice
        .createQuerySet({ type: 'timestamp', count: inputs.length * 2 })
        .unwrap();
      const size = inputs.length * 16;
      const resolved = costDevice
        .createBuffer({ size: Math.ceil(size / 256) * 256, usage: 516 })
        .unwrap();
      const readback = costDevice.createBuffer({ size, usage: 9 }).unwrap();
      try {
        for (const data of inputs)
          owned.push(
            (
              await render.createSdfQuery(
                costDevice,
                gpu.createShaderModule,
                [data.source],
                data.rays,
                { maxSteps, visibilityExpansion },
              )
            ).unwrap(),
          );
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
          for (const query of owned) query.record(encoder).unwrap();
          const recordMs = performance.now() - start;
          encoder.resolveQuerySet(timestamps, 0, inputs.length * 2, resolved, 0).unwrap();
          encoder.copyBufferToBuffer(resolved, 0, readback, 0, size);
          costDevice.queue.submit([encoder.finish().unwrap()]).unwrap();
          await costDevice.queue.onSubmittedWorkDone();
          const completionMs = performance.now() - start;
          const mapping = (await readback.mapAsync(1)).unwrap(),
            values = new BigUint64Array(mapping.getMappedRange().unwrap());
          const gpuNanoseconds = inputs.map((_, i) => Number(values[i * 2 + 1] - values[i * 2]));
          mapping.unmap();
          if (pass !== inputs.length || gpuNanoseconds.some((n) => n <= 0))
            throw Error('incomplete timestamp coverage');
          if (sample >= 0) costs.push({ recordMs, completionMs, gpuNanoseconds });
        }
        for (const data of inputs) {
          const query = (
            await render.createSdfQuery(
              costDevice,
              gpu.createShaderModule,
              [data.source],
              data.rays,
              { maxSteps: 1, visibilityExpansion },
            )
          ).unwrap();
          try {
            const e = costDevice.createCommandEncoder({}).unwrap();
            query.record(e).unwrap();
            costDevice.queue.submit([e.finish().unwrap()]).unwrap();
            await send(
              `section-${data.section}-budget.bin`,
              await read(costDevice, query.buffers.hits, query.rayCount * 64),
            );
          } finally {
            query.dispose();
          }
        }
      } finally {
        for (const q of owned) q.dispose();
        costDevice.destroyQuerySet(timestamps);
        costDevice.destroyBuffer(resolved);
        costDevice.destroyBuffer(readback);
        costRaw.destroy();
      }
      return {
        browser: navigator.userAgent,
        requiredFeatures: ['timestamp-query'],
        adapterIdentity: 'RHI does not expose adapter info; pair with the test-machine record.',
        works: replayRows,
        unseededResources: model.unseededResources,
        noWorkNonzeroBytes: 0,
        gpuErrors,
        costs,
        warmup: 3,
        maxSteps,
        visibilityExpansion,
        recorderEnabledForCost: false,
        cpuTimingLimit:
          'Browser performance.now quantization applies; zero recordMs means below timer resolution, not zero CPU work.',
        scope: manifest.scope,
      };
    },
    { root, input, maxSteps, visibilityExpansion },
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
