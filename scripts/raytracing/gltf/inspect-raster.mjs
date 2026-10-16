import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import { writeReferencePng } from '../../../apps/shared/png-codec.mjs';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { inspectRasterStages } from './raster-stages.mjs';
import { rasterInitialization } from './raster-tape.mjs';

const directory = resolve(process.argv[2] ?? 'artifacts/sponza-raster');
const name = process.argv[3] ?? 'baseline';
const bytes = await readFile(resolve(directory, `${name}.rhitape`));
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
const initialization = rasterInitialization(model);
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
const adapter = (await gpu.rhi.requestAdapter()).unwrap();
const device = (
  await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
).unwrap();
const errors = [];
gpu
  ._internal_getRawDevice(device)
  .addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const replay = (
  await openReplay(tape, { device, createShaderModule: gpu.createShaderModule })
).unwrap();
const outputs = new Map();
try {
  const stages = await inspectRasterStages(model, replay, async (label, data) => {
    outputs.set(label, data);
    await writeFile(resolve(directory, `${name}-dawn-${label}`), data);
    console.log(`Read ${label}`);
  });
  for (const [label, data] of outputs)
    if (label.endsWith('.rgba'))
      await writeFile(
        resolve(directory, `${name}-dawn-${label.replace('.rgba', '.png')}`),
        writeReferencePng(data, stages.width, stages.height),
      );
  const report = {
    ...stages,
    digest: tapeDigest(bytes),
    initialization,
    backend: 'Dawn software GPU diagnostic',
    errors,
  };
  await writeFile(resolve(directory, `${name}-dawn-stages.json`), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ covered: stages.covered, directEnergy: stages.directEnergy, errors }),
  );
} finally {
  (await replay.dispose()).unwrap();
  gpu._internal_getRawDevice(device).destroy();
}
