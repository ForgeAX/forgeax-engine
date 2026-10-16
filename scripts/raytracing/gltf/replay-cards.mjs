import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// A new page/device consumes the saved artifact after live resources were released.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = resolve(process.argv[2]);
const capture = JSON.parse(await readFile(resolve(directory, 'capture.json'), 'utf8'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(resolve(directory, 'cards.rhitape'))) hash.update(chunk);
assert.equal(`sha256:${hash.digest('hex')}`, capture.tapeDigest);
const browser = await chromium.connectOverCDP(
  process.env.FORGEAX_RASTER_CDP ?? 'http://127.0.0.1:9789',
);
const page = await browser.contexts()[0].newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') errors.push(e.text());
  else if (e.text().startsWith('Replay:')) console.log(e.text());
});
try {
  await page.goto(
    process.env.FORGEAX_RASTER_REPLAY_URL ?? 'http://127.0.0.1:8759/raster-replay.html',
  );
  const result = await page.evaluate(
    async ({ root, directory, capture }) => {
      const debug = await import(`/@fs/${root}packages/rhi-debug/dist/index.mjs`);
      const gpu = await import(`/@fs/${root}packages/rhi-webgpu/dist/index.mjs`);
      const load = async (name) =>
        new Uint8Array(await (await fetch(`/@fs/${directory}/${name}`)).arrayBuffer());
      const bytes = await load('cards.rhitape');
      console.log(`Replay: loaded ${bytes.length} bytes`);
      const tape = debug.decodeTape(bytes).unwrap();
      const model = debug.buildFrameModel(tape);
      if (model.works.length !== capture.works.length) throw Error('Work count mismatch');
      const adapter = (await gpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(
          debug.replayDeviceRequest(tape, adapter.features, adapter.limits),
        )
      ).unwrap();
      const native = gpu._internal_getRawDevice(device),
        gpuErrors = [];
      native.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const replay = (
        await debug.openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
      ).unwrap();
      const validCount = (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let valid = 0;
        for (let i = 6; i < bytes.length; i += 8)
          valid += Number(view.getUint16(i, true) === 0x3c00);
        return valid;
      };
      try {
        const empty = (await replay.readResource(capture.resources.f0Validity)).unwrap();
        const withoutCapture = { valid: validCount(empty.bytes), bytes: empty.bytes.length };
        console.log('Replay: bootstrap read; executing complete tape');
        const checks = {};
        for (const [name, id] of Object.entries(capture.resources)) {
          const value = (await replay.readResourceAtWork(id, capture.workIndex)).unwrap();
          const live = await load(`${name}.bin`);
          if (value.bytes.length !== live.length) throw Error(`${name}: readback size mismatch`);
          let different = 0;
          for (let i = 0; i < live.length; i++) different += Number(live[i] !== value.bytes[i]);
          checks[name] = {
            bytes: live.length,
            different,
            format: value.format,
            digest: debug.tapeDigest(value.bytes),
          };
          console.log(`Replay: ${name}, ${different} differing bytes`);
        }
        const prefix = (await replay.readResourceAtWork(capture.resources.f0Validity, 0)).unwrap();
        const prefixView = new DataView(
          prefix.bytes.buffer,
          prefix.bytes.byteOffset,
          prefix.bytes.byteLength,
        );
        let laterTilesValid = 0;
        for (let y = 0; y < capture.height; y++)
          for (let x = 0; x < capture.width; x++)
            if (x >= capture.resolution || y >= capture.resolution)
              laterTilesValid += Number(
                prefixView.getUint16((y * capture.width + x) * 8 + 6, true) === 0x3c00,
              );
        await device.queue.onSubmittedWorkDone();
        return {
          tapeDigest: debug.tapeDigest(bytes),
          works: model.works.length,
          workIndex: capture.workIndex,
          checks,
          withoutCapture,
          prefix: { workIndex: 0, valid: validCount(prefix.bytes), laterTilesValid },
          unseededResources: model.unseededResources,
          gpuErrors,
          browser: navigator.userAgent,
        };
      } finally {
        (await replay.dispose()).unwrap();
        native.destroy();
      }
    },
    { root, directory, capture },
  );
  await writeFile(
    resolve(directory, 'replay.json'),
    `${JSON.stringify({ ...result, errors }, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.gpuErrors, []);
  assert.equal(result.tapeDigest, capture.tapeDigest);
  assert(
    Object.values(result.checks).every((c) => c.different === 0),
    'Fresh-device material/depth replay must match live bytes',
  );
  assert.equal(result.withoutCapture.valid, 0, 'No capture work must leave all texels invalid');
  assert.equal(result.prefix.laterTilesValid, 0, 'Later cards must be empty before their work');
  assert(
    result.prefix.valid > 0 && result.prefix.valid < capture.valid,
    'Prefix must render only the first populated card',
  );
} finally {
  await page.close();
  await browser.close();
}
