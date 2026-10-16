import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = resolve(process.argv[2]);
const browser = await chromium.connectOverCDP(process.env.FORGEAX_RASTER_CDP);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (event) => {
  if (event.type() === 'error') errors.push(event.text());
  else if (event.text().startsWith('Diffuse replay:')) console.log(event.text());
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, directory }) => {
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const { rasterInitialization } = await import(
        `/@fs/${root}scripts/raytracing/gltf/raster-tape.mjs`
      );
      const fetchBytes = async (name) =>
        new Uint8Array(await (await fetch(`/@fs/${directory}/${name}`)).arrayBuffer());
      console.log('Diffuse replay: loading tape');
      const bytes = await fetchBytes('indirect.rhitape');
      const tape = debug.decodeTape(bytes).unwrap();
      const model = debug.buildFrameModel(tape);
      const initialization = rasterInitialization(model);
      const work = (entry) => {
        const found = model.works.find((item) =>
          item.pipeline.shaders.some((shader) => shader.entryPoint === entry),
        );
        if (!found) throw new Error(`Missing ${entry} work`);
        return found;
      };
      const direct = work('fs_standard_deferred');
      const reconstructed = model.works.some((item) =>
        item.pipeline.shaders.some(
          (shader) => shader.entryPoint === 'fs_ray_diffuse_reconstructed',
        ),
      );
      const composite = work(reconstructed ? 'fs_ray_diffuse_reconstructed' : 'fs_ray_diffuse');
      const generate = work('generateRasterRays');
      const accumulation = model.resources.find(
        (resource) => resource.descriptor?.desc?.label === 'ray-path.accumulation',
      );
      if (!accumulation) throw new Error('Missing raw D allocation');
      const adapter = (await gpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(
          debug.replayDeviceRequest(tape, adapter.features, adapter.limits),
        )
      ).unwrap();
      const gpuErrors = [];
      const native = gpu._internal_getRawDevice(device);
      native.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const replay = (
        await debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      const outputs = {};
      const read = async (name, resource, at) => {
        console.log(`Diffuse replay: ${name} at work ${at}`);
        const value = (await replay.readResourceAtWork(resource, at)).unwrap();
        let binary = '';
        for (let offset = 0; offset < value.bytes.length; offset += 8192)
          binary += String.fromCharCode(...value.bytes.subarray(offset, offset + 8192));
        outputs[name] = btoa(binary);
        return value;
      };
      try {
        await read('direct-hdr.bin', direct.attachments.colorViewHandleIds[0], direct.workIndex);
        const d = await read('raw-d.bin', accumulation.resourceId, composite.workIndex);
        const final = await read(
          'composite-hdr.bin',
          composite.attachments.colorViewHandleIds[0],
          composite.workIndex,
        );
        const live = await fetchBytes('indirect-linear-hdr.bin');
        if (
          live.length !== final.bytes.length ||
          live.some((value, index) => value !== final.bytes[index])
        )
          throw new Error('Fresh-device composite differs from the live HDR bytes');
        const data = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength);
        const stats = {
          rows: d.bytes.length / 80,
          sampled: 0,
          errors: 0,
          nonFinite: 0,
          positive: 0,
        };
        for (let offset = 0; offset < d.bytes.length; offset += 80) {
          const count = data.getUint32(offset + 12, true);
          stats.sampled += Number(count === 1);
          stats.errors += Number(data.getUint32(offset + 28, true) !== 0);
          for (const channel of [0, 4, 8]) {
            const value = data.getFloat32(offset + channel, true);
            stats.nonFinite += Number(!Number.isFinite(value));
            stats.positive += Number(value > 0);
          }
        }
        if (stats.errors || stats.nonFinite || !stats.positive)
          throw new Error(JSON.stringify(stats));
        const { inspectDiffuseReconstruction } = await import(
          `/@fs/${root}scripts/raytracing/gltf/diffuse-stages.mjs`
        );
        const reconstruction = await inspectDiffuseReconstruction(
          model,
          replay,
          async (name, bytes) => {
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192)
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            outputs[name] = btoa(binary);
          },
        );
        const inspected = (
          await replay.inspectWork(composite.workIndex, ['pipeline', 'bindings'])
        ).unwrap();
        return {
          digest: debug.tapeDigest(bytes),
          workCount: model.works.length,
          resourceCount: model.resources.length,
          initialization,
          selectedWorks: {
            direct: direct.workIndex,
            generate: generate.workIndex,
            composite: composite.workIndex,
          },
          composite: inspected,
          reconstruction,
          stats,
          width: final.width,
          height: final.height,
          replayExact: true,
          gpuErrors,
          outputs,
        };
      } finally {
        (await replay.dispose()).unwrap();
        native.destroy();
      }
    },
    { root, directory },
  );
  for (const [name, value] of Object.entries(result.outputs))
    await writeFile(resolve(directory, `replay-${name}`), Buffer.from(value, 'base64'));
  delete result.outputs;
  await writeFile(resolve(directory, 'replay.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      works: result.selectedWorks,
      stats: result.stats,
      replayExact: result.replayExact,
    }),
  );
} finally {
  await writeFile(resolve(directory, 'replay-errors.json'), JSON.stringify(errors));
  await page.close();
  await browser.close();
}
