import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create, globals } from '@forgeax/engine-dawn-node';
import UPNG from 'upng-js';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  tapeDigest,
} from '../../../packages/rhi-debug/dist/index.mjs';
import * as gpu from '../../../packages/rhi-webgpu/dist/index.mjs';
import { renderScene } from './render.mjs';

Object.assign(globalThis, globals);
const native = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu: native }, configurable: true });
const out = resolve(process.argv[2] ?? 'artifacts/ray-gi-scene');
await mkdir(out, { recursive: true });
const prepared = JSON.parse(await readFile(resolve(out, 'prepared.json'), 'utf8'));
const options = JSON.parse(process.argv[3] ?? '{}');
const recorder = attachRecorder(gpu).unwrap();
const device = (
  await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
).unwrap();
const raw = gpu._internal_getRawDevice(device._realDevice),
  errors = [];
raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
try {
  const result = await renderScene(
    device,
    recorder.backend.createShaderModule,
    prepared,
    options,
    recorder,
    console.log,
  );
  for (const [name, bytes] of Object.entries(result.images))
    await writeFile(
      resolve(out, `${name}.png`),
      Buffer.from(
        UPNG.encode(
          [bytes.buffer],
          result.report.options.resolution,
          result.report.options.resolution,
          0,
        ),
      ),
    );
  for (const [name, bytes] of Object.entries(result.raw))
    await writeFile(resolve(out, `${name}.bin`), bytes);
  await writeFile(resolve(out, 'scene.rhitape'), result.tape);
  const tape = decodeTape(result.tape).unwrap(),
    model = buildFrameModel(tape);
  const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
  ).unwrap();
  const replayChecks = [];
  try {
    for (const work of model.works.slice(-5)) {
      const inspected = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
      const mode = ['direct', 'gi', 'indirect', 'coverage', 'path'][replayChecks.length];
      assert.deepEqual(inspected.attachment.bytes, result.images[mode]);
      replayChecks.push({
        mode,
        workIndex: work.workIndex,
        byteEquality: true,
        bytes: inspected.attachment.bytes.length,
      });
    }
  } finally {
    (await replay.dispose()).unwrap();
    gpu._internal_getRawDevice(fresh).destroy();
  }
  result.report.errors = errors;
  result.report.tape = {
    digest: await tapeDigest(result.tape),
    works: model.works.length,
    unseededResources: model.unseededResources,
  };
  await writeFile(resolve(out, 'report.json'), JSON.stringify(result.report, null, 2));
  await writeFile(resolve(out, 'replay.json'), JSON.stringify(replayChecks, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result.report, null, 2));
} finally {
  (await recorder.dispose()).unwrap();
  raw.destroy();
  delete globalThis.navigator;
}
