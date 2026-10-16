import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  createGlobalSdfQuery,
  GlobalSdfQueryStatus as Status,
} from '../../raytracing/global-sdf-query';
import { readBuffer } from './path-tracer.fixture';

/** A shallow sampled ridge isolates the skipped interval without private scene assets. */
export async function verifyGlobalSdfMinimumStep() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const composition = (
    await createGlobalSdfComposition(device, recorder.backend.createShaderModule, [], {
      origin: [-3, -3, -3],
      dimensions: [13, 13, 13],
      spacing: 0.5,
      maxDistance: 2,
      coverageDistance: 0.5,
    })
  ).unwrap();
  const bytes = new Uint8Array(composition.voxelCount * 16),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < composition.voxelCount; i++) {
    view.setFloat32(i * 16, 0.015 + 0.12 * Math.abs(-3 + (i % 13) * 0.5), true);
    view.setFloat32(i * 16 + 4, 1, true);
    view.setUint32(i * 16 + 8, 1, true);
    view.setUint32(i * 16 + 12, 0xffffffff, true);
  }
  device.queue.writeBuffer(composition.buffers.voxels, 0, bytes).unwrap();
  const ray = {
    origin: [-0.2, 0, 0] as const,
    direction: [1, 0, 0] as const,
    tMin: 0,
    tMax: 1,
    mask: 255,
  };
  const rays = [
    ray,
    { ...ray, direction: [2, 0, 0] as const, tMax: 0.5 },
    { ...ray, tMax: 0.08 },
    { ...ray, direction: [-1, 0, 0] as const },
    { ...ray, mask: 0 },
  ];
  const cases = [
    { maxSteps: 256, minStepFactor: 1 },
    { maxSteps: 256, minStepFactor: 0.25 },
    { maxSteps: 3, minStepFactor: 0.25 },
  ];
  const queries = [];
  let tapeBytes: Uint8Array;
  const outputs: Uint8Array[] = [];
  try {
    for (const options of cases)
      queries.push(
        (
          await createGlobalSdfQuery(
            device,
            recorder.backend.createShaderModule,
            composition,
            rays,
            options,
          )
        ).unwrap(),
      );
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const q of queries) q.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await pending).unwrap().bytes;
    for (const q of queries)
      outputs.push(await readBuffer(device, q.buffers.hits, rays.length * 64));
  } finally {
    for (const q of queries) q.dispose();
    composition.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const results = outputs.map((b) => new DataView(b.buffer, b.byteOffset, b.byteLength));
  const status = (c: number, r: number) => results[c]?.getUint32(r * 64, true);
  expect(rays.map((_, i) => status(0, i))).toEqual([
    Status.miss,
    Status.miss,
    Status.miss,
    Status.miss,
    Status.miss,
  ]);
  expect(rays.map((_, i) => status(1, i))).toEqual([
    Status.hit,
    Status.hit,
    Status.miss,
    Status.miss,
    Status.miss,
  ]);
  expect(status(2, 0)).toBe(Status.stepBudget);
  const refined = results[1];
  assert(refined);
  const hitT = refined.getFloat32(16, true);
  expect(hitT).toBeGreaterThan(0.17);
  expect(hitT).toBeLessThan(0.2);
  expect(Math.abs(hitT - 2 * refined.getFloat32(64 + 16, true))).toBeLessThan(1e-6);
  expect(refined.getUint32(8, true)).toBe(4);
  expect(refined.getFloat32(48, true)).toBeLessThan(-0.99);
  // Step density changes; neither expansion nor its first sample is relaxed.
  expect(refined.getFloat32(20, true)).toBeCloseTo(0.0195, 6);
  expect(refined.getFloat32(24, true)).toBeCloseTo(0.039, 6);
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(cases.length);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  assert(raw);
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [i, work] of model.works.entries()) {
      const id = work.bindings.find((b) => b.binding === 3)?.resourceId;
      assert(id);
      expect((await replay.readResourceAtWork(id, work.workIndex)).unwrap().bytes).toEqual(
        outputs[i],
      );
    }
  } finally {
    (await replay.dispose()).unwrap();
    raw.destroy();
  }
  expect(errors).toEqual([]);
  return { hitT, workCount: model.works.length, errors };
}
