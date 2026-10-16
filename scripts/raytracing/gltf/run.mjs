import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import UPNG from 'upng-js';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { renderGltf } from './render.mjs';

Object.assign(globalThis, globals);
const native = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: native }, configurable: true });
const out = resolve(process.argv[2] ?? 'artifacts/ray-sponza'),
  options = JSON.parse(process.argv[3] ?? '{}');
const prepared = JSON.parse(await readFile(resolve(out, 'prepared.json'), 'utf8'));
const recorder = attachRecorder(gpu).unwrap();
const device = (
  await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
).unwrap();
const rawDevice = gpu._internal_getRawDevice(device._realDevice),
  errors = [];
rawDevice.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
try {
  const result = await renderGltf(
    device,
    recorder.backend.createShaderModule,
    prepared,
    async (name) => new Uint8Array(await readFile(resolve(out, name))),
    options,
    recorder,
    console.log,
  );
  for (let i = 0; i < 2; i++) {
    await writeFile(
      resolve(out, `${i ? 'indirect-reference' : 'direct-reference'}.png`),
      Buffer.from(
        UPNG.encode(
          [result.images[i].buffer],
          result.report.resolution,
          result.report.resolution,
          0,
        ),
      ),
    );
    await writeFile(
      resolve(out, `${i ? 'indirect-reference' : 'direct-reference'}.bin`),
      result.raw[i],
    );
  }
  await writeFile(resolve(out, 'sponza.rhitape'), result.tape.bytes);
  const tape = decodeTape(result.tape.bytes).unwrap(),
    model = buildFrameModel(tape);
  result.report.tape = {
    digest: result.tape.digest,
    works: model.works.length,
    unseededResources: model.unseededResources,
  };
  result.report.readbackInitialization = model.unseededResources.map(({ resourceId }) => {
    const command = model.commands.find(
      (c) =>
        (c.kind === 'copyBufferToBuffer' && c.params.destinationHandleId === resourceId) ||
        (c.kind === 'copyTextureToBuffer' && c.params.destination.bufferHandleId === resourceId),
    );
    assert(command, `Readback has no captured initializing copy: ${resourceId}`);
    assert(!model.works.some((w) => w.bindings.some((b) => b.resourceId === resourceId)));
    return {
      resourceId,
      initializingCopyEvent: command.eventIndex,
      operation: command.kind,
      sourceResourceId: command.params.sourceHandleId ?? command.params.source.textureHandleId,
    };
  });
  result.report.errors = errors;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(result.report, null, 2));
  // Retire producer before recreating resources on a fresh device.
  (await recorder.dispose()).unwrap();
  rawDevice.destroy();
  const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
  ).unwrap();
  const checks = [];
  try {
    for (const [i, work] of model.works.slice(-2).entries()) {
      const pixels = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap().attachment;
      assert.deepEqual(pixels.bytes, result.images[i]);
      checks.push({ workIndex: work.workIndex, byteEquality: true });
    }
  } finally {
    (await replay.dispose()).unwrap();
    gpu._internal_getRawDevice(fresh).destroy();
  }
  await writeFile(resolve(out, 'replay.json'), JSON.stringify(checks, null, 2));
  assert.equal(errors.length, 0);
  assert(result.report.counts.every((c) => c.invalid === 0 && c.incomplete === 0));
  console.log(JSON.stringify(result.report, null, 2));
} finally {
  (await recorder.dispose()).unwrap();
  rawDevice.destroy();
  delete globalThis.navigator;
}
