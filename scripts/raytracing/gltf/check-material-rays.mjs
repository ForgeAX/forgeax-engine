import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const [preparedPath, cohortPath, outputPath] = process.argv.slice(2).map((p) => resolve(p));
assert(
  preparedPath && cohortPath && outputPath,
  'check-material-rays <prepared-dir> <cohorts.json> <output>',
);
await mkdir(outputPath, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [],
  sizes = new Map();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('Material:')) console.log(e.text());
});
await page.exposeFunction('saveMaterialChunk', async (name, offset, encoded) => {
  assert(/^[a-zA-Z0-9_-]+\.(bin|json|rhitape)$/.test(name));
  assert.equal(offset, sizes.get(name) ?? 0);
  const bytes = Buffer.from(encoded, 'base64');
  if (offset === 0) await writeFile(resolve(outputPath, name), bytes);
  else await appendFile(resolve(outputPath, name), bytes);
  sizes.set(name, offset + bytes.length);
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, preparedPath, cohortPath }) => {
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const render = await import(`/@fs/${root}packages/render/dist/internal.mjs`);
      const { createGltfResources } = await import(
        `/@fs/${root}scripts/raytracing/gltf/resources.mjs`
      );
      const load = async (name) => {
        const response = await fetch(`/@fs/${preparedPath}/${name}`);
        if (!response.ok) throw Error(`prepared input ${name}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const prepared = JSON.parse(new TextDecoder().decode(await load('prepared.json')));
      const response = await fetch(`/@fs/${cohortPath}`);
      if (!response.ok) throw Error('cohort file unavailable');
      const cohorts = await response.json(),
        gpuErrors = [];
      const send = async (name, bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 262144) {
          const chunk = bytes.subarray(offset, offset + 262144);
          let binary = '';
          for (let i = 0; i < chunk.length; i += 8192)
            binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
          await window.saveMaterialChunk(name, offset, btoa(binary));
        }
      };
      const read = async (device, buffer, size) => {
        const staging = device.createBuffer({ size, usage: 9 }).unwrap();
        try {
          const encoder = device.createCommandEncoder({}).unwrap();
          encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          const mapping = (await staging.mapAsync(1)).unwrap();
          const bytes = new Uint8Array(mapping.getMappedRange().unwrap()).slice();
          mapping.unmap();
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
      const resources = await createGltfResources(
        device,
        recorder.backend.createShaderModule,
        prepared,
        load,
      );
      const tracers = [],
        outputs = [];
      let tapeBytes;
      try {
        for (const cohort of cohorts) {
          if (!/^[a-z0-9-]+$/.test(cohort.name) || !cohort.rays.length)
            throw Error('invalid cohort');
          // The existing custom-ray transport starts at zero and uses one f32 far distance.
          // Refuse any cohort that would silently change that interval or mask contract.
          const maxDistance = Math.fround(cohort.rays[0].tMax);
          if (
            cohort.rays.some(
              (r) =>
                r.tMin !== 0 || Math.fround(r.tMax) !== maxDistance || ![0, 255].includes(r.mask),
            )
          )
            throw Error('cohort intervals/masks require another transport');
          const rays = cohort.rays.map((r) => ({
            origin: r.origin,
            direction: r.direction,
            active: r.mask !== 0,
            coneWidth: r.coneWidth ?? 0,
            coneSpread: r.coneSpread ?? 0,
          }));
          const tracer = (
            await render.createRayPathTracer(device, recorder.backend.createShaderModule, {
              kernel: prepared.kernel,
              scene: resources.scene,
              materials: prepared.materials,
              resolveTexture: resources.resolveTexture,
              lights: [],
              settings: {
                width: rays.length,
                height: 1,
                rays,
                maxBounces: 1,
                seed: 47,
                environment: [0, 0, 0],
                maxDistance,
              },
            })
          ).unwrap();
          tracers.push(tracer);
        }
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        for (const [i, tracer] of tracers.entries()) {
          console.log(`Material: trace original ${cohorts[i].name} (${tracer.pixelCount} rays)`);
          const encoder = device.createCommandEncoder({}).unwrap();
          tracer.recordSample(encoder).unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          await device.queue.onSubmittedWorkDone();
        }
        (await recorder.frameBoundary()).unwrap();
        tapeBytes = (await pending).unwrap().bytes;
        await send('material-rays.rhitape', tapeBytes);
        for (const [i, tracer] of tracers.entries()) {
          const row = { name: cohorts[i].name, rays: tracer.pixelCount, data: {} };
          for (const [key, stride] of [
            ['inputs', 224],
            ['surfaces', 96],
            ['accumulation', 80],
          ]) {
            row.data[key] = await read(device, tracer.buffers[key], tracer.pixelCount * stride);
            await send(`${row.name}-${key}.bin`, row.data[key]);
          }
          outputs.push(row);
        }
      } finally {
        for (const t of tracers.toReversed()) t.dispose();
        resources.dispose();
        (await recorder.dispose()).unwrap();
        raw.destroy();
      }
      const tape = debug.decodeTape(tapeBytes).unwrap(),
        model = debug.buildFrameModel(tape);
      if (model.unseededResources.length) throw Error('material tape lacks initial seeds');
      const works = model.works.filter((w) =>
        w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
      );
      if (works.length !== outputs.length) throw Error('cohort accumulation work missing');
      const seedBytes = (work, binding) => {
        const id = work.bindings.find(
          (b) => b.groupIndex === 0 && b.binding === binding,
        ).resourceId;
        const seed = tape.bootstrap.find((r) => r.handleId === id);
        if (seed?.initialData.length !== 1) throw Error('reference seed unavailable');
        return tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes;
      };
      const seeds = model.works.filter((w) =>
        w.pipeline.shaders.some((s) => s.entryPoint === 'generateInitialRays'),
      );
      if (seeds.length !== cohorts.length) throw Error('initial ray work missing');
      const sourceChecks = [];
      const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (const [i, cohort] of cohorts.entries()) {
        const expected = new Uint8Array(cohort.rays.length * 80),
          floats = new Float32Array(expected.buffer),
          words = new Uint32Array(expected.buffer);
        cohort.rays.forEach((ray, j) => {
          floats.set(
            [...ray.origin, ray.coneWidth ?? 0, ...ray.direction, ray.coneSpread ?? 0, 1, 1, 1, 0],
            j * 20,
          );
          words.set([Number(ray.mask !== 0), 0, 47, 0], j * 20 + 16);
        });
        const actual = seedBytes(seeds[i], 0);
        if (actual.length !== expected.length || actual.some((v, j) => v !== expected[j]))
          throw Error('initial ray seed differs from the requested cohort');
        const settings = view(seedBytes(works[i], 8)),
          triangles = view(seedBytes(works[i], 0));
        if (
          settings.getFloat32(76, true) !== Math.fround(cohort.rays[0].tMax) ||
          settings.getUint32(80, true) !== cohort.rays.length ||
          settings.getUint32(84, true) !== 1 ||
          settings.getUint32(88, true) !== 1
        )
          throw Error('reference settings changed');
        const input = view(outputs[i].data.inputs),
          accum = view(outputs[i].data.accumulation),
          surface = view(outputs[i].data.surfaces);
        let hits = 0,
          maximumRayPositionDelta = 0;
        for (let j = 0; j < cohort.rays.length; j++) {
          if (accum.getUint32(j * 80 + 12, true) !== 1 || accum.getUint32(j * 80 + 28, true) !== 0)
            throw Error('incomplete material reference');
          if (accum.getUint32(j * 80 + 64, true) === 0xffffffff) continue;
          hits++;
          if (surface.getUint32(j * 96 + 64, true) !== 1)
            throw Error('first-hit material is unavailable');
          const primitive = input.getUint32(j * 224 + 220, true),
            at = primitive * 80;
          // Input identity is material/valid/bounce/ordered-triangle; the
          // complete instance/geometry/primitive/material identity lives in accumulation.
          for (let a = 0; a < 4; a++)
            if (
              triangles.getUint32(at + 48 + a * 4, true) !==
              accum.getUint32(j * 80 + 64 + a * 4, true)
            )
              throw Error('first-hit identity differs from captured geometry');
          if (
            input.getUint32(j * 224 + 208, true) !== triangles.getUint32(at + 60, true) ||
            input.getUint32(j * 224 + 212, true) !== 1 ||
            input.getUint32(j * 224 + 216, true) !== 0
          )
            throw Error('first-hit material input identity is invalid');
          const t = input.getFloat32(j * 224 + 28, true),
            ray = cohort.rays[j];
          if (t < 0 || t > Math.fround(ray.tMax))
            throw Error('first hit escaped the original interval');
          for (let a = 0; a < 3; a++)
            maximumRayPositionDelta = Math.max(
              maximumRayPositionDelta,
              Math.abs(
                input.getFloat32(j * 224 + 16 + a * 4, true) -
                  (Math.fround(ray.origin[a]) + Math.fround(ray.direction[a]) * t),
              ),
            );
        }
        if (maximumRayPositionDelta > 1e-4)
          throw Error('first-hit position is not on its source ray');
        sourceChecks.push({
          name: cohort.name,
          rays: cohort.rays.length,
          hits,
          initialSeedsByteExact: true,
          identityMatchesCapturedGeometry: true,
          maximumRayPositionDelta,
        });
      }
      const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const freshRaw = gpu._internal_getRawDevice(fresh);
      if (!freshRaw) throw Error('replay native device unavailable');
      freshRaw.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
          await debug.openReplay(tape, {
            device: fresh,
            createShaderModule: gpu.createShaderModule,
          })
        ).unwrap(),
        checks = [];
      try {
        for (const [i, work] of works.entries()) {
          for (const [key, binding] of [
            ['inputs', 4],
            ['surfaces', 5],
            ['accumulation', 6],
          ]) {
            const resource = work.bindings.find(
              (b) => b.groupIndex === 0 && b.binding === binding,
            ).resourceId;
            const bytes = (await replay.readResourceAtWork(resource, work.workIndex)).unwrap()
                .bytes,
              original = outputs[i].data[key];
            const differentBytes =
              bytes.length === original.length
                ? bytes.reduce((n, v, j) => n + Number(v !== original[j]), 0)
                : -1;
            checks.push({
              name: outputs[i].name,
              key,
              resource,
              workIndex: work.workIndex,
              differentBytes,
            });
            if (differentBytes !== 0)
              throw Error(`material replay differs ${outputs[i].name}/${key}`);
          }
        }
      } finally {
        (await replay.dispose()).unwrap();
        freshRaw.destroy();
      }
      return {
        scope:
          'Shared-material first-hit reference on unchanged rays; zero cone footprint unless explicitly carried. Real MASK and sidedness, no lighting comparison or GI acceptance.',
        browser: navigator.userAgent,
        cohorts: outputs.map(({ data, ...r }) => r),
        checks,
        sourceChecks,
        gpuErrors,
        unseededResources: model.unseededResources,
        works: model.works.length,
      };
    },
    { root, preparedPath, cohortPath },
  );
  await writeFile(resolve(outputPath, 'cohorts.json'), await readFile(cohortPath));
  const artifacts = {};
  for (const name of [...sizes.keys(), 'cohorts.json']) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(outputPath, name))) hash.update(bytes);
    artifacts[name] = hash.digest('hex');
  }
  await writeFile(
    resolve(outputPath, 'gpu.json'),
    JSON.stringify({ ...result, errors, artifacts }, null, 2),
  );
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await page.close();
  await browser.close();
}
