import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const toolStarted = performance.now();

const args = process.argv.slice(2);
const captured = args[0] === '--capture';
const [inputArg, frozenArg, sectionArg, outputArg, selectedArg, factorArg] = captured
  ? [null, args[3], args[2], args[4], args[5], undefined]
  : args;
assert(
  (captured
    ? args.length === 6 && /^\d+$/.test(sectionArg)
    : inputArg && /^[a-z0-9-]+$/.test(sectionArg)) &&
    frozenArg &&
    outputArg &&
    /^\d+(,\d+){0,7}$/.test(selectedArg),
  'trace-global-sdf-prefixes <world-input> <frozen-output> <section> <new-output> <ray-indices> [min-step-factor] OR --capture <tape> <query-work> <frozen-resource-prefix> <new-output> <ray-indices>',
);
const minStepFactor = Number(factorArg ?? 1);
assert(Number.isFinite(minStepFactor) && minStepFactor > 0 && minStepFactor <= 1);
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  input = inputArg ? resolve(inputArg) : null,
  frozen = resolve(frozenArg),
  section = captured ? 'captured-query' : sectionArg,
  output = resolve(outputArg),
  selected = selectedArg.split(',').map(Number),
  capture = captured ? { path: resolve(args[1]), workIndex: Number(sectionArg) } : null;
assert(new Set(selected).size === selected.length);
const sha = (b) => createHash('sha256').update(b).digest('hex');
let provenance;
if (capture) {
  provenance = { tape: sha(await readFile(capture.path)) };
  for (const name of ['voxels', 'grid', 'rays', 'hits'])
    provenance[name] = sha(await readFile(`${frozen}-${name}.bin`));
} else {
  const manifestBytes = await readFile(resolve(input, 'composition.json'));
  const manifest = JSON.parse(manifestBytes),
    row = manifest.cases.find((r) => r.name === section);
  assert(row?.queryFile);
  provenance = {
    manifest: sha(manifestBytes),
    cohort: sha(await readFile(resolve(input, row.queryFile))),
    composition: sha(await readFile(resolve(frozen, `${section}.bin`))),
    hits: sha(await readFile(resolve(frozen, `${section}-query.bin`))),
  };
}
provenance.tool = sha(await readFile(fileURLToPath(import.meta.url)));
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
  else if (e.text().startsWith('capture-stage:')) console.log(e.text());
});
await page.exposeFunction('saveGlobalPrefix', async (name, offset, text) => {
  assert(/^[a-z0-9-]+\.(bin|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(text, 'base64');
  if (offset === 0) await writeFile(resolve(output, name), bytes);
  else await appendFile(resolve(output, name), bytes);
  sizes.set(name, offset + bytes.length);
});
const replayUrl =
  process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html';
// Relay only this diagnostic origin when the shared browser runs on another host.
const relaySockets = new Set();
if (process.env.FORGEAX_RASTER_RELAY === '1') {
  await page.routeWebSocket(
    `${new URL(replayUrl).origin.replace('http:', 'ws:').replace('https:', 'wss:')}/**`,
    (socket) => {
      const upstream = new WebSocket(socket.url(), 'vite-hmr'),
        queued = [];
      relaySockets.add(upstream);
      upstream.on('open', () => {
        for (const message of queued) upstream.send(message);
      });
      upstream.on('message', (data, binary) => socket.send(binary ? data : data.toString()));
      upstream.on('error', (error) => errors.push(`relay WebSocket: ${error.message}`));
      socket.onMessage((message) =>
        upstream.readyState === WebSocket.OPEN ? upstream.send(message) : queued.push(message),
      );
      socket.onClose(() => upstream.close());
      upstream.on('close', () => {
        relaySockets.delete(upstream);
        socket.close();
      });
    },
  );
  await page.route(`${new URL(replayUrl).origin}/**`, async (route) => {
    const response = await fetch(route.request().url());
    const headers = Object.fromEntries(response.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({
      status: response.status,
      headers,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
const tapeReader = capture ? await open(capture.path, 'r') : null;
if (tapeReader)
  await page.exposeFunction('readGlobalTapeChunk', async (offset) => {
    const { size } = await tapeReader.stat();
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset < size);
    const bytes = Buffer.alloc(Math.min(1048576, size - offset));
    const { bytesRead } = await tapeReader.read(bytes, 0, bytes.length, offset);
    assert.equal(bytesRead, bytes.length);
    return { size, base64: bytes.toString('base64') };
  });
try {
  await page.goto(replayUrl);
  const result = await page.evaluate(
    async ({ root, input, frozen, section, selected, provenance, minStepFactor, capture }) => {
      const diagnosticStarted = performance.now(),
        timings = {};
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`),
        debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`),
        render = await import(`/@fs/${root}packages/render/dist/internal.mjs`),
        geometry = await import(`/@fs/${root}packages/geometry/dist/index.mjs`);
      const load = async (path) => {
        const r = await fetch(`/@fs/${path}`);
        if (!r.ok) throw Error(`input ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const sha = async (b) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
      const decode = (b) => JSON.parse(new TextDecoder().decode(b));
      const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      let row, cohort, expectedGrid, expectedHits, expectedRays, originalSettings, sourceQuery;
      let originalMaxSteps = 256;
      const source = [];
      if (capture) {
        const sourceStarted = performance.now();
        const frozenBytes = {};
        for (const name of ['voxels', 'grid', 'rays', 'hits']) {
          frozenBytes[name] = await load(`${frozen}-${name}.bin`);
          if ((await sha(frozenBytes[name])) !== provenance[name])
            throw Error(`transport changed ${name}`);
        }
        console.log('capture-stage: loading original tape');
        const first = await window.readGlobalTapeChunk(0),
          tapeBytes = new Uint8Array(first.size);
        for (let offset = 0; offset < first.size; offset += 1048576) {
          const chunk = offset === 0 ? first : await window.readGlobalTapeChunk(offset);
          if (chunk.size !== first.size) throw Error('source tape changed during transport');
          tapeBytes.set(
            Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0)),
            offset,
          );
        }
        if ((await sha(tapeBytes)) !== provenance.tape)
          throw Error('transport changed source tape');
        console.log('capture-stage: decoding original tape');
        const tape = debug.decodeTape(tapeBytes).unwrap(),
          model = debug.buildFrameModel(tape);
        const { rasterInitialization } = await import(
          `/@fs/${root}scripts/raytracing/gltf/raster-tape.mjs`
        );
        const initialization = rasterInitialization(model);
        const work = model.works[capture.workIndex];
        if (
          !work ||
          work.kind !== 'dispatchWorkgroups' ||
          work.pipeline.shaders.length !== 1 ||
          work.pipeline.shaders[0].entryPoint !== 'main' ||
          work.pipeline.shaders[0].source !== render.GLOBAL_SDF_QUERY_WGSL
        )
          throw Error('captured query kernel differs');
        const ranges = ['voxels', 'grid', 'rays', 'hits', 'settings'].map((name, binding) => {
          const b = work.bindings.find((b) => b.groupIndex === 0 && b.binding === binding);
          if (
            !b ||
            b.resourceKind !== 'buffer' ||
            !Number.isSafeInteger(b.bufferSize) ||
            b.bufferSize < 1
          )
            throw Error(`missing captured ${name} range`);
          return {
            name,
            binding,
            resourceId: b.resourceId,
            offset: (b.bufferOffset ?? 0) + (b.dynamicOffset ?? 0),
            size: b.bufferSize,
          };
        });
        if (
          ranges[1].size !== 48 ||
          ranges[4].size !== 16 ||
          ranges[2].size % 48 !== 0 ||
          ranges[3].size !== (ranges[2].size / 48) * 64
        )
          throw Error('captured query ABI differs');
        const adapter = (await gpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(
            debug.replayDeviceRequest(tape, adapter.features, adapter.limits),
          )
        ).unwrap();
        const raw = gpu._internal_getRawDevice(device),
          originalErrors = [];
        raw.addEventListener('uncapturederror', (e) => originalErrors.push(e.error.message));
        let replay;
        const original = {};
        console.log('capture-stage: original fresh-device query readback');
        try {
          replay = (
            await debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
          ).unwrap();
          for (const range of ranges) {
            const bytes = (
              await replay.readResourceAtWork(range.resourceId, work.workIndex, {
                offset: range.offset,
                size: range.size,
              })
            ).unwrap().bytes;
            if (bytes.length !== range.size)
              throw Error(`captured ${range.name} readback truncated`);
            if (range.name !== 'settings' && !equal(bytes, frozenBytes[range.name]))
              throw Error(`captured ${range.name} differs from frozen resource`);
            original[range.name] = bytes;
            range.sha256 = await sha(bytes);
          }
        } finally {
          if (replay) (await replay.dispose()).unwrap();
          raw.destroy();
        }
        if (originalErrors.length) throw Error(originalErrors.join('\n'));
        originalSettings = original.settings;
        const settings = new DataView(originalSettings.buffer, originalSettings.byteOffset, 16);
        originalMaxSteps = settings.getUint32(0, true);
        minStepFactor = settings.getFloat32(4, true);
        if (settings.getUint32(8, true) !== 0 || settings.getUint32(12, true) !== 0)
          throw Error('captured settings reserved words differ');
        const grid = new DataView(original.grid.buffer, original.grid.byteOffset, 48);
        row = {
          grid: {
            origin: [0, 4, 8].map((o) => grid.getFloat32(o, true)),
            spacing: grid.getFloat32(12, true),
            dimensions: [16, 20, 24].map((o) => grid.getUint32(o, true)),
            maxDistance: grid.getFloat32(32, true),
            coverageDistance: grid.getFloat32(36, true),
          },
        };
        const rays = new DataView(
          original.rays.buffer,
          original.rays.byteOffset,
          original.rays.length,
        );
        cohort = {
          rays: Array.from({ length: original.rays.length / 48 }, (_, i) => ({
            origin: [0, 4, 8].map((o) => rays.getFloat32(i * 48 + o, true)),
            tMin: rays.getFloat32(i * 48 + 12, true),
            direction: [16, 20, 24].map((o) => rays.getFloat32(i * 48 + o, true)),
            tMax: rays.getFloat32(i * 48 + 28, true),
            mask: rays.getUint32(i * 48 + 32, true),
          })),
        };
        expectedGrid = original.voxels;
        expectedHits = original.hits;
        expectedRays = original.rays;
        sourceQuery = {
          workIndex: work.workIndex,
          eventIndex: work.eventIndex,
          ranges,
          kernelSha256: await sha(new TextEncoder().encode(work.pipeline.shaders[0].source)),
          initialization,
          sourceReplayByteExact: true,
          settingsWrites: tape.events.flatMap((e, eventIndex) =>
            eventIndex < work.eventIndex &&
            e.kind === 'writeBuffer' &&
            e.handleId === ranges[4].resourceId
              ? [{ eventIndex, ...e }]
              : [],
          ),
        };
        // Keep the admitted grid bytes: the source count is capture data, not an invented default.
        sourceQuery.gridBytes = Array.from(original.grid);
        timings.sourceTransferAndReplayMs = performance.now() - sourceStarted;
      } else {
        const manifestBytes = await load(`${input}/composition.json`),
          manifest = decode(manifestBytes);
        row = manifest.cases.find((r) => r.name === section);
        const cohortBytes = await load(`${input}/${row.queryFile}`);
        cohort = decode(cohortBytes);
        expectedGrid = await load(`${frozen}/${section}.bin`);
        expectedHits = await load(`${frozen}/${section}-query.bin`);
        for (const [key, bytes] of [
          ['manifest', manifestBytes],
          ['cohort', cohortBytes],
          ['composition', expectedGrid],
          ['hits', expectedHits],
        ])
          if ((await sha(bytes)) !== provenance[key]) throw Error(`transport changed ${key}`);
        for (const s of row.sources) {
          if (!s.fieldFile) throw Error('prefix diagnosis requires admitted source fields');
          const bytes = await load(`${input}/${s.fieldFile}`);
          if ((await sha(bytes)) !== manifest.fields[s.fieldFile].sha256)
            throw Error('field changed');
          source.push({
            ...s,
            field: (await geometry.decodeMeshDistanceField(bytes, s.meshDigest)).unwrap(),
          });
        }
      }
      if (
        !selected.every((i) => i < cohort.rays.length) ||
        expectedHits.length !== cohort.rays.length * 64
      )
        throw Error('invalid selected rays');
      const originalSteps = new DataView(expectedHits.buffer);
      const steps = Math.max(...selected.map((i) => originalSteps.getUint32(i * 64 + 8, true)));
      if (steps < 1 || steps > originalMaxSteps)
        throw Error('selected rays have no admitted step history');
      const budgets = [...Array.from({ length: steps }, (_, i) => i + 1), originalMaxSteps];
      const save = async (name, bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 262144) {
          const chunk = bytes.subarray(offset, offset + 262144);
          let text = '';
          for (let i = 0; i < chunk.length; i += 8192)
            text += String.fromCharCode(...chunk.subarray(i, i + 8192));
          await window.saveGlobalPrefix(name, offset, btoa(text));
        }
      };
      const recorder = debug.attachRecorder(gpu).unwrap();
      const device = (
        await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      const raw = gpu._internal_getRawDevice(device._realDevice);
      if (!raw) throw Error('capture native device missing');
      const gpuErrors = [];
      raw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      let composition, query, tapeBytes;
      const outputs = [];
      const read = async (buffer, size) => {
        const staging = device.createBuffer({ size, usage: 9 }).unwrap();
        try {
          const e = device.createCommandEncoder({}).unwrap();
          e.copyBufferToBuffer(buffer, 0, staging, 0, size);
          device.queue.submit([e.finish().unwrap()]).unwrap();
          const m = (await staging.mapAsync(1)).unwrap();
          const bytes = new Uint8Array(m.getMappedRange().unwrap()).slice();
          m.unmap();
          return bytes;
        } finally {
          device.destroyBuffer(staging);
        }
      };
      const reproductionStarted = performance.now();
      try {
        if (capture) {
          const owned = [];
          const make = (bytes, usage) => {
            const buffer = device.createBuffer({ size: bytes.length, usage: usage | 12 }).unwrap();
            owned.push(buffer);
            device.queue.writeBuffer(buffer, 0, bytes).unwrap();
            return buffer;
          };
          composition = {
            grid: row.grid,
            voxelCount: expectedGrid.length / 16,
            buffers: {
              voxels: make(expectedGrid, 128),
              settings: make(new Uint8Array(sourceQuery.gridBytes), 64),
            },
            dispose() {
              for (const buffer of owned) device.destroyBuffer(buffer);
            },
          };
        } else {
          composition = (
            await render.createGlobalSdfComposition(
              device,
              recorder.backend.createShaderModule,
              source,
              row.grid,
            )
          ).unwrap();
        }
        query = (
          await render.createGlobalSdfQuery(
            device,
            recorder.backend.createShaderModule,
            composition,
            cohort.rays,
            { minStepFactor, maxSteps: originalMaxSteps },
          )
        ).unwrap();
        console.log('capture-stage: full-cohort original-budget reproduction');
        const e = device.createCommandEncoder({}).unwrap();
        if (!capture) composition.record(e).unwrap();
        query.record(e).unwrap();
        device.queue.submit([e.finish().unwrap()]).unwrap();
        if (!equal(await read(composition.buffers.voxels, expectedGrid.length), expectedGrid))
          throw Error('original composition differs');
        if (!equal(await read(query.buffers.hits, expectedHits.length), expectedHits))
          throw Error('original full-cohort query differs');
        const createdSettings = await read(query.buffers.settings, 16);
        if (originalSettings && !equal(createdSettings, originalSettings))
          throw Error('captured settings differ from query admission');
        originalSettings = createdSettings;
        if (
          expectedRays &&
          !equal(await read(query.buffers.rays, expectedRays.length), expectedRays)
        )
          throw Error('captured ray ABI changed during query admission');
        timings.fullCohortReproductionMs = performance.now() - reproductionStarted;
        const captureStarted = performance.now();
        // Allocate observation buffers before capture so their initial bytes are explicit.
        // They never feed a query and only retain each dispatch's full-cohort output.
        const copies = budgets.map(() => {
          const copy = device.createBuffer({ size: expectedHits.length, usage: 140 }).unwrap();
          device.queue.writeBuffer(copy, 0, new Uint8Array(expectedHits.length)).unwrap();
          return copy;
        });
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        if (!capture) {
          const produce = device.createCommandEncoder({}).unwrap();
          composition.record(produce).unwrap();
          device.queue.submit([produce.finish().unwrap()]).unwrap();
        }
        for (const [i, budget] of budgets.entries()) {
          device.queue
            .writeBuffer(
              query.buffers.settings,
              0,
              i === budgets.length - 1 ? originalSettings : new Uint32Array([budget]),
            )
            .unwrap();
          const copy = copies[i];
          const enc = device.createCommandEncoder({}).unwrap();
          query.record(enc).unwrap();
          enc.copyBufferToBuffer(query.buffers.hits, 0, copy, 0, expectedHits.length);
          device.queue.submit([enc.finish().unwrap()]).unwrap();
        }
        (await recorder.frameBoundary()).unwrap();
        tapeBytes = (await pending).unwrap().bytes;
        for (const b of copies) {
          outputs.push(await read(b, expectedHits.length));
          device.destroyBuffer(b);
        }
        if (!equal(outputs.at(-1), expectedHits)) throw Error('final full-cohort control differs');
        if (!equal(await read(query.buffers.settings, 16), originalSettings))
          throw Error('final query settings differ');
        for (const i of selected)
          if (
            !equal(
              outputs[steps - 1].subarray(i * 64, (i + 1) * 64),
              expectedHits.subarray(i * 64, (i + 1) * 64),
            )
          )
            throw Error('selected final prefix differs');
        await save('global-prefixes.rhitape', tapeBytes);
        const joined = new Uint8Array(outputs.length * expectedHits.length);
        outputs.forEach((b, i) => {
          joined.set(b, i * expectedHits.length);
        });
        await save('global-prefixes.bin', joined);
        timings.prefixCaptureAndReadbackMs = performance.now() - captureStarted;
      } finally {
        query?.dispose();
        composition?.dispose();
        (await recorder.dispose()).unwrap();
        raw.destroy();
      }
      const tape = debug.decodeTape(tapeBytes).unwrap(),
        model = debug.buildFrameModel(tape);
      if (model.unseededResources.length) throw Error('unseeded prefix resource');
      const works = model.works.filter((w) =>
        w.pipeline.shaders.some((s) => s.source.includes('fn queryGlobal(')),
      );
      if (works.length !== budgets.length) throw Error('prefix work missing');
      const replayStarted = performance.now();
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const freshRaw = gpu._internal_getRawDevice(fresh);
      if (!freshRaw) throw Error('replay native device missing');
      freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
        await debug.openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      const checks = [];
      console.log('capture-stage: fresh-device prefix replay');
      try {
        for (const [i, w] of works.entries()) {
          const id = w.bindings.find((b) => b.binding === 3).resourceId;
          const bytes = (await replay.readResourceAtWork(id, w.workIndex)).unwrap().bytes;
          if (!equal(bytes, outputs[i])) throw Error(`prefix replay differs at ${i}`);
          const settingsId = w.bindings.find((b) => b.binding === 4).resourceId;
          const actualSettings = (await replay.readResourceAtWork(settingsId, w.workIndex)).unwrap()
            .bytes;
          const expectedSettings = originalSettings.slice();
          new DataView(expectedSettings.buffer).setUint32(0, budgets[i], true);
          if (!equal(actualSettings, expectedSettings))
            throw Error(`prefix settings differ at ${i}`);
          checks.push({
            budget: budgets[i],
            workIndex: w.workIndex,
            byteExact: true,
            settingsByteExact: true,
          });
        }
      } finally {
        (await replay.dispose()).unwrap();
        freshRaw.destroy();
      }
      timings.prefixReplayMs = performance.now() - replayStarted;
      timings.totalPageMs = performance.now() - diagnosticStarted;
      if (gpuErrors.length) throw Error(gpuErrors.join('\n'));
      return {
        section,
        timings,
        timingScope:
          'Browser wall-clock diagnostic overhead, including transfer/readback/replay. Not product GPU timing or frame performance.',
        originalMaxSteps,
        originalSettingsSha256: await sha(originalSettings),
        sourceQuery,
        minStepFactor,
        selected,
        cohortRays: cohort.rays.length,
        budgets,
        checks,
        works: model.works.length,
        originalCompositionByteExact: true,
        originalFullCohortByteExact: true,
        finalFullCohortByteExact: true,
        unseededResources: model.unseededResources,
        gpuErrors,
        tapeSha256: await sha(tapeBytes),
      };
    },
    { root, input, frozen, section, selected, provenance, minStepFactor, capture },
  );
  const report = {
    scope:
      'Original Global composition/query, all cohort rays retained; only the existing step budget changes. Prefix positions are the final sampled positions, except terminal hits include pullback.',
    ...result,
    toolWallMs: performance.now() - toolStarted,
    provenance,
    errors,
  };
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify({ message: String(error), errors, provenance }, null, 2),
  );
  throw error;
} finally {
  for (const socket of relaySockets) socket.terminate();
  await tapeReader?.close();
  await page.close();
  await browser.close();
}
