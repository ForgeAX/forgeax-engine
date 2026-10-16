import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import UPNG from 'upng-js';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '../../packages/rhi-debug/dist/index.mjs';
import * as backend from '../../packages/rhi-webgpu/dist/index.mjs';

const [input, destination] = process.argv.slice(2);
assert(
  input && destination,
  'usage: node scripts/raytracing/inspect-material-cards.mjs <tape> <output-directory>',
);
const directory = resolve(destination);
await mkdir(directory, { recursive: true });
Object.assign(globalThis, globals);
const nativeGpu = create(['backend=vulkan']);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: nativeGpu }, configurable: true });
const bytes = new Uint8Array(await readFile(input));
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
const seed = model.works.find((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'seed'));
assert(seed, 'tape must contain surface-lighting seed work');
const adapter = (await backend.rhi.requestAdapter()).unwrap();
const device = (
  await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
).unwrap();
const raw = backend._internal_getRawDevice(device),
  errors = [];
raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const replay = (
  await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
).unwrap();
const half = (data, offset) => {
  const bits = data.getUint16(offset, true),
    exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  return (
    (bits & 32768 ? -1 : 1) *
    (exponent === 0
      ? mantissa * 2 ** -24
      : exponent === 31
        ? mantissa
          ? NaN
          : Infinity
        : (1 + mantissa / 1024) * 2 ** (exponent - 15))
  );
};
try {
  const outputs = {};
  for (const [name, binding] of [
    ['projections', 2],
    ['surface', 5],
    ['albedo', 9],
    ['normal', 10],
    ['emission', 11],
    ['validity', 12],
    ['depth', 17],
  ]) {
    const resource = seed.bindings.find((b) => b.binding === binding)?.resourceId;
    assert(resource, `${name} binding`);
    const read = (await replay.readResourceAtWork(resource, seed.workIndex)).unwrap();
    outputs[name] = read;
    await writeFile(join(directory, `${name}.bin`), read.bytes);
  }
  const desc = model.resources.find(
    (r) => r.resourceId === seed.bindings.find((b) => b.binding === 12).resourceId,
  )?.descriptor;
  const textureId = desc?.sourceHandleId;
  const extent = model.resources.find((r) => r.resourceId === textureId)?.descriptor?.desc?.size;
  assert(extent?.width && extent.height, 'captured atlas extent');
  const settingsResource = seed.bindings.find((b) => b.binding === 8)?.resourceId;
  const settings = (await replay.readResourceAtWork(settingsResource, seed.workIndex)).unwrap();
  const config = new DataView(
    settings.bytes.buffer,
    settings.bytes.byteOffset,
    settings.bytes.byteLength,
  );
  const cardCount = config.getUint32(52, true),
    resolution = config.getUint32(56, true);
  const width = extent.width,
    height = extent.height,
    columns = width / resolution;
  const view = (name) =>
    new DataView(
      outputs[name].bytes.buffer,
      outputs[name].bytes.byteOffset,
      outputs[name].bytes.byteLength,
    );
  const validity = view('validity'),
    depth = view('depth'),
    surface = view('surface'),
    projections = view('projections');
  const rgba = new Uint8Array(width * height * 4),
    albedoImage = rgba.slice(),
    tiles = [];
  for (let card = 0; card < cardCount; card++) {
    const counts = { valid: 0, empty: 0, complete: 0, incomplete: 0, invalid: 0 },
      z = [];
    for (let y = 0; y < resolution; y++)
      for (let x = 0; x < resolution; x++) {
        const pixel =
          (Math.floor(card / columns) * resolution + y) * width + (card % columns) * resolution + x;
        const valid = half(validity, pixel * 8 + 6) === 1;
        const state = surface.getUint32(pixel * 64 + 48, true);
        counts[valid ? 'valid' : 'empty']++;
        if (state === 1) counts.complete++;
        else if (state === 2) counts.incomplete++;
        else if (state !== 0) counts.invalid++;
        if (valid) z.push(depth.getFloat32(pixel * 4, true));
        rgba.set([...(valid ? [40, 190, 70] : [190, 0, 170]), 255], pixel * 4);
        const color = [0, 1, 2].map((c) =>
          Math.round(255 * Math.min(1, Math.max(0, half(view('albedo'), pixel * 8 + c * 2)))),
        );
        albedoImage.set([...(valid ? color : [190, 0, 170]), 255], pixel * 4);
      }
    tiles.push({
      card,
      instanceId: projections.getUint32(card * 80 + 64, true),
      normal: [0, 1, 2].map((c) => projections.getFloat32(card * 80 + 48 + c * 4, true)),
      ...counts,
      depthRange: z.length ? [Math.min(...z), Math.max(...z)] : null,
    });
  }
  for (const [name, data] of [
    ['validity', rgba],
    ['albedo', albedoImage],
  ])
    await writeFile(
      join(directory, `${name}.png`),
      new Uint8Array(UPNG.encode([data.buffer], width, height, 0)),
    );
  const report = {
    tapeDigest: await tapeDigest(bytes),
    workIndex: seed.workIndex,
    atlas: { width, height, resolution, cardCount },
    tiles,
    errors,
  };
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'inspection.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      workIndex: seed.workIndex,
      atlas: report.atlas,
      emptyCards: tiles.filter((t) => !t.valid),
      incomplete: tiles.filter((t) => t.incomplete),
    }),
  );
} finally {
  (await replay.dispose()).unwrap();
  raw.destroy();
  delete globalThis.navigator;
}
