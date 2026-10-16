import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import UPNG from 'upng-js';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { inspectDiffuseReconstruction } from './diffuse-stages.mjs';

assert(process.argv[2] && process.argv[3], 'Usage: inspect-reconstruction.mjs <tape> <output>');
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
Object.assign(globalThis, globals);
const backend = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: backend }, configurable: true });
const bytes = new Uint8Array(await readFile(resolve(process.argv[2])));
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const adapter = (await gpu.rhi.requestAdapter()).unwrap();
const device = (
  await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
).unwrap();
const errors = [];
const native = gpu._internal_getRawDevice(device);
native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const replay = (
  await openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
).unwrap();
try {
  const images = new Map();
  const result = await inspectDiffuseReconstruction(model, replay, async (name, value) => {
    await writeFile(resolve(output, name), value);
    if (name.endsWith('.rgba')) images.set(name, value);
  });
  for (const [name, value] of images) {
    await writeFile(
      resolve(output, name.replace('.rgba', '.png')),
      Buffer.from(UPNG.encode([value.buffer], result.width, result.height, 0)),
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'inspection.json'),
    JSON.stringify(
      { digest: tapeDigest(bytes), ...result, unseeded: model.unseededResources, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result.statistics));
} finally {
  (await replay.dispose()).unwrap();
  native.destroy();
  delete globalThis.navigator;
}
