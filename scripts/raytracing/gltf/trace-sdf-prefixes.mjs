import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// This tool changes only the existing step budget, never shader source or ray inputs.
assert(
  process.argv.length >= 6 && process.argv.length <= 8,
  'usage: trace-sdf-prefixes.mjs <probe-row.json> <frozen-hits.bin> <new-output> <ray-indices> [max-steps=512] [visibility-expansion=clearance]',
);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = resolve(process.argv[2]),
  frozen = resolve(process.argv[3]);
const output = resolve(process.argv[4]);
assert(/^\d+(,\d+){0,7}$/.test(process.argv[5]), 'ray indices must be comma-separated integers');
const visibilityExpansion = process.argv[7] ?? 'clearance';
assert(['clearance', 'ray-distance'].includes(visibilityExpansion));
const indices = process.argv[5].split(',').map(Number),
  maxSteps = Number(process.argv[6] ?? 512);
assert(indices.length >= 1 && indices.length <= 8 && new Set(indices).size === indices.length);
assert(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1024);
const probe = JSON.parse(await readFile(input, 'utf8')),
  expected = await readFile(frozen);
assert(indices.every((i) => Number.isInteger(i) && i >= 0 && i < probe.rays.length));
assert.equal(expected.length, probe.rays.length * 64);
assert.equal(basename(probe.fieldFile), probe.fieldFile);
const fieldPath = resolve(dirname(input), probe.fieldFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenance = {
  probeSha256: digest(await readFile(input)),
  fieldSha256: digest(await readFile(fieldPath)),
  frozenHitsSha256: digest(expected),
};
// A failed run must remain evidence; refuse to overwrite its output directory.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [],
  sizes = new Map();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
});
await page.exposeFunction('saveSdfPrefix', async (name, offset, data) => {
  assert(/^ray-\d+(?:-prefixes)?\.(bin|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(data, 'base64');
  if (offset === 0) await writeFile(resolve(output, name), bytes);
  else await appendFile(resolve(output, name), bytes);
  sizes.set(name, offset + bytes.length);
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const rows = await page.evaluate(
    async ({
      root,
      input,
      frozen,
      fieldPath,
      indices,
      maxSteps,
      visibilityExpansion,
      provenance,
    }) => {
      const load = async (path) => {
        const response = await fetch(`/@fs/${path}`);
        if (!response.ok) throw Error(`input response ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const sha = async (bytes) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
      const [probeBytes, fieldBytes, frozenBytes] = await Promise.all([
        load(input),
        load(fieldPath),
        load(frozen),
      ]);
      if (
        (await sha(probeBytes)) !== provenance.probeSha256 ||
        (await sha(fieldBytes)) !== provenance.fieldSha256 ||
        (await sha(frozenBytes)) !== provenance.frozenHitsSha256
      )
        throw Error('input changed during transport');
      const probe = JSON.parse(new TextDecoder().decode(probeBytes));
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const geometry = await import(`/@fs/${root}packages/geometry/dist/index.mjs`);
      const { createSdfQuery } = await import(`/@fs/${root}packages/render/dist/internal.mjs`);
      const field = (await geometry.decodeMeshDistanceField(fieldBytes, probe.meshDigest)).unwrap();
      const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const save = async (name, bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 262144) {
          const chunk = bytes.subarray(offset, offset + 262144);
          let binary = '';
          for (let i = 0; i < chunk.length; i += 8192)
            binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
          await window.saveSdfPrefix(name, offset, btoa(binary));
        }
      };
      const rows = [];
      for (const ray of indices) {
        const recorder = debug.attachRecorder(gpu).unwrap();
        const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
        const device = (await adapter.requestDevice()).unwrap();
        const native = gpu._internal_getRawDevice(
          recorder.backend.unwrapDeviceForSurface(device).unwrap(),
        );
        if (!native) throw Error('capture native device unavailable');
        const gpuErrors = [];
        native.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        let query;
        try {
          query = (
            await createSdfQuery(
              device,
              recorder.backend.createShaderModule,
              [{ ...probe.instance, field }],
              [probe.rays[ray]],
              { maxSteps, visibilityExpansion },
            )
          ).unwrap();
          const dispatch = async (budget) => {
            device.queue.writeBuffer(query.buffers.settings, 4, new Uint32Array([budget])).unwrap();
            const staging = device.createBuffer({ size: 64, usage: 9 }).unwrap();
            try {
              const encoder = device.createCommandEncoder({}).unwrap();
              query.record(encoder).unwrap();
              encoder.copyBufferToBuffer(query.buffers.hits, 0, staging, 0, 64);
              device.queue.submit([encoder.finish().unwrap()]).unwrap();
              const mapped = (await staging.mapAsync(1)).unwrap();
              const bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
              mapped.unmap();
              return bytes;
            } finally {
              device.destroyBuffer(staging);
            }
          };
          const initial = await dispatch(maxSteps),
            expected = frozenBytes.subarray(ray * 64, (ray + 1) * 64);
          if (!equal(initial, expected)) throw Error(`ray ${ray}: frozen output differs`);
          const steps = new DataView(initial.buffer).getFloat32(24, true);
          if (!Number.isInteger(steps) || steps < 1 || steps > maxSteps)
            throw Error(`ray ${ray}: no query steps to inspect`);
          const pending = recorder.captureFrame();
          (await recorder.frameBoundary()).unwrap();
          const outputs = [];
          for (let budget = 1; budget <= steps; budget++) outputs.push(await dispatch(budget));
          outputs.push(await dispatch(maxSteps));
          (await recorder.frameBoundary()).unwrap();
          const capture = (await pending).unwrap();
          await save(`ray-${ray}.rhitape`, capture.bytes);
          const joined = new Uint8Array(outputs.length * 64);
          outputs.forEach((bytes, i) => {
            joined.set(bytes, i * 64);
          });
          await save(`ray-${ray}-prefixes.bin`, joined);
          const tape = debug.decodeTape(capture.bytes).unwrap(),
            model = debug.buildFrameModel(tape);
          const works = model.works.filter((work) =>
            work.bindings.some((b) => b.groupIndex === 0 && b.binding === 4),
          );
          if (works.length !== outputs.length) throw Error('incomplete captured query closure');
          const unseededReadbacks = model.unseededResources.map((resource) => {
            const create = tape.bootstrap.find(
              (row) => row.handleId === resource.resourceId,
            )?.create;
            const eventIndex = tape.events.findIndex(
              (event) =>
                event.kind === 'copyBufferToBuffer' &&
                event.destinationHandleId === resource.resourceId &&
                event.destinationOffset === 0 &&
                event.sourceOffset === 0 &&
                event.size === 64 &&
                works.some((work) =>
                  work.bindings.some(
                    (binding) =>
                      binding.groupIndex === 0 &&
                      binding.binding === 3 &&
                      binding.resourceId === event.sourceHandleId,
                  ),
                ),
            );
            if (
              create?.kind !== 'createBuffer' ||
              create.desc.size !== 64 ||
              create.desc.usage !== 9 ||
              eventIndex < 0 ||
              works.some((work) =>
                work.bindings.some((binding) => binding.resourceId === resource.resourceId),
              ) ||
              tape.events.some(
                (event) =>
                  event.kind === 'copyBufferToBuffer' &&
                  event.sourceHandleId === resource.resourceId,
              )
            )
              throw Error('uninitialized query resource');
            return {
              resourceId: resource.resourceId,
              initializationEventIndex: eventIndex,
              role: 'capture-readback-only',
            };
          });
          const freshAdapter = (await gpu.rhi.requestAdapter()).unwrap();
          const fresh = (
            await freshAdapter.requestDevice(
              debug.replayDeviceRequest(tape, freshAdapter.features, freshAdapter.limits),
            )
          ).unwrap();
          const raw = gpu._internal_getRawDevice(fresh);
          if (!raw) throw Error('replay native device unavailable');
          raw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
          let replay,
            replayEqual = true;
          try {
            replay = (
              await debug.openReplay(tape, {
                device: fresh,
                createShaderModule: gpu.createShaderModule,
              })
            ).unwrap();
            for (let i = 0; i < works.length; i++) {
              const work = works[i],
                binding = work.bindings.find((b) => b.groupIndex === 0 && b.binding === 3);
              if (!binding) throw Error('query output binding absent');
              const bytes = (
                await replay.readResourceAtWork(binding.resourceId, work.workIndex)
              ).unwrap().bytes;
              replayEqual = equal(bytes, outputs[i]) && replayEqual;
            }
          } finally {
            if (replay) (await replay.dispose()).unwrap();
            raw.destroy();
          }
          rows.push({
            ray,
            steps,
            prefixBudgets: [...Array.from({ length: steps }, (_, i) => i + 1), maxSteps],
            workIndices: works.map((w) => w.workIndex),
            frozenHitEqual: true,
            finalBudgetHitEqual:
              equal(outputs[steps - 1], initial) && equal(outputs[steps], initial),
            replayEqual,
            tapeDigest: capture.digest,
            unseededReadbacks,
            gpuErrors,
          });
        } finally {
          query?.dispose();
          (await recorder.dispose()).unwrap();
          native.destroy();
        }
      }
      return rows;
    },
    { root, input, frozen, fieldPath, indices, maxSteps, visibilityExpansion, provenance },
  );
  const report = {
    scope:
      'Unmodified production SDF query; only maxSteps varies. Non-final budget positions are next-step locations; hit positions include pullback. No performance or geometric correctness claim.',
    provenance,
    visibilityExpansion,
    rows,
    errors,
  };
  await writeFile(resolve(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(errors, []);
  assert(
    rows.every(
      (row) =>
        row.frozenHitEqual &&
        row.finalBudgetHitEqual &&
        row.replayEqual &&
        row.gpuErrors.length === 0,
    ),
  );
  console.log(
    JSON.stringify({
      rays: rows.length,
      prefixes: rows.reduce((n, r) => n + r.prefixBudgets.length, 0),
      frozenAndReplayEqual: true,
    }),
  );
} catch (error) {
  await writeFile(
    resolve(output, 'failure.json'),
    `${JSON.stringify({ message: String(error), provenance, errors }, null, 2)}\n`,
  );
  throw error;
} finally {
  await page.close();
  await browser.close();
}
