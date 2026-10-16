import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition, type GlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  createGlobalSdfQuery,
  GLOBAL_SDF_HIT_STRIDE,
  type GlobalSdfQuery,
  GlobalSdfQueryStatus as Status,
} from '../../raytracing/global-sdf-query';
import type { ReferenceRay } from '../../raytracing/scene';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

export async function verifyGlobalSdfQuery(
  fixture: SdfCardsFixture,
  save?: (tape: Uint8Array, outputs: readonly Uint8Array[]) => Promise<void>,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const real = (device as typeof device & { readonly _realDevice: typeof device })._realDevice;
  const native = webgpu._internal_getRawDevice(real);
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const grid = {
    origin: [-3, -3, -3] as const,
    dimensions: [13, 13, 13] as const,
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.5,
  };
  const source = {
    ...sdfCubeInstance,
    field: {
      ...fixture.field,
      bricks: Uint32Array.from(fixture.field.bricks),
      values: Float32Array.from(fixture.field.values),
    },
  };
  const compositions: GlobalSdfComposition[] = [];
  const ray = (
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    tMax: number,
    mask = 255,
  ): ReferenceRay => ({ origin, direction, tMin: 0, mask, tMax });
  const rays = [
    ray([0, 2, 0], [0, -1, 0], 4),
    ray([0, 2, 0], [0, -2, 0], 2),
    ray([2, 2, 2], [0, 0, 1], 0.25),
    ray([2, 2, 2], [0, 0, 1], 4),
    ray([0, 4, 0], [0, -1, 0], 8),
    ray([0, 0, 0], [0, 1, 0], 2),
    ray([0, 4, 0], [0, -1, 0], 8, 0),
    ray([0, 2, 0], [0, -1, 0], 0.25),
    { ...ray([0, 4, 0], [0, -1, 0], 5), tMin: 2 },
    ray([2.5, 2, 2], [1, 0, 0], 1),
    ray([2, 2, 2], [1, 0, 0], 0.5),
    ray([0, 2, 0], [0, -0.5, 0], 8),
  ];
  const plans = [
    { name: 'unwritten', composition: 0, maxSteps: 256, workIndex: 0, rays },
    { name: 'complete', composition: 0, maxSteps: 256, workIndex: 2, rays },
    { name: 'budget', composition: 0, maxSteps: 1, workIndex: 3, rays },
    { name: 'missing', composition: 1, maxSteps: 256, workIndex: 5, rays },
    { name: 'empty', composition: 2, maxSteps: 256, workIndex: 7, rays },
    {
      name: 'sampling',
      composition: 3,
      maxSteps: 256,
      workIndex: 8,
      rays: [
        ray([0, 2, 0], [0, -1, 0], 4),
        ray([0, 0, 0], [0, 1, 0], 0.1),
        ray([0.25, 0, 0], [0, -1, 0], 0.1),
      ],
    },
  ];
  const queries: GlobalSdfQuery[] = [];
  let tapeBytes: Uint8Array;
  const outputs: Uint8Array[] = [];
  try {
    for (const sources of [
      [source],
      [{ ...source, field: { missing: true as const, bounds: fixture.field.bounds } }],
      [],
      [],
    ])
      compositions.push(
        (
          await createGlobalSdfComposition(
            device,
            recorder.backend.createShaderModule,
            sources,
            grid,
          )
        ).unwrap(),
      );
    const [complete, missing, empty, sampling] = compositions;
    assert(complete && missing && empty && sampling);
    // A controlled linear field isolates interpolation and normal dependencies.
    // The missing x-neighbor has zero weight on x=0 rays, but contributes to
    // their normal gradient. No missing-field sample may impersonate a hit.
    const seeded = new Uint8Array(sampling.voxelCount * 16);
    const seed = new DataView(seeded.buffer);
    for (let z = 0; z < 13; z++)
      for (let y = 0; y < 13; y++)
        for (let x = 0; x < 13; x++) {
          const offset = ((z * 13 + y) * 13 + x) * 16;
          seed.setFloat32(offset, -3 + y * 0.5, true);
          seed.setFloat32(offset + 4, 1, true);
          seed.setUint32(offset + 8, x === 7 && y === 6 && z === 6 ? 2 : 1, true);
          seed.setUint32(offset + 12, 0xffffffff, true);
        }
    device.queue.writeBuffer(sampling.buffers.voxels, 0, seeded).unwrap();
    for (const plan of plans) {
      const composition = compositions[plan.composition];
      assert(composition);
      queries.push(
        (
          await createGlobalSdfQuery(
            device,
            recorder.backend.createShaderModule,
            composition,
            plan.rays,
            { maxSteps: plan.maxSteps },
          )
        ).unwrap(),
      );
    }
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    queries[0]?.record(encoder).unwrap();
    complete.record(encoder).unwrap();
    queries[1]?.record(encoder).unwrap();
    queries[2]?.record(encoder).unwrap();
    missing.record(encoder).unwrap();
    queries[3]?.record(encoder).unwrap();
    empty.record(encoder).unwrap();
    queries[4]?.record(encoder).unwrap();
    queries[5]?.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await pending).unwrap().bytes;
    for (const q of queries)
      outputs.push(await readBuffer(device, q.buffers.hits, q.rayCount * GLOBAL_SDF_HIT_STRIDE));
    await save?.(tapeBytes, outputs);
  } finally {
    for (const q of queries) q.dispose();
    for (const c of compositions) c.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const views = outputs.map((b) => new DataView(b.buffer, b.byteOffset, b.byteLength));
  const status = (caseIndex: number, rayIndex: number) =>
    views[caseIndex]?.getUint32(rayIndex * GLOBAL_SDF_HIT_STRIDE, true);
  expect(Array.from({ length: rays.length }, (_, i) => status(1, i))).toEqual([
    Status.hit,
    Status.hit,
    Status.miss,
    Status.outsideRegion,
    Status.outsideRegion,
    Status.negativeStart,
    Status.miss,
    Status.miss,
    Status.hit,
    Status.outsideRegion,
    Status.miss,
    Status.hit,
  ]);
  expect(status(0, 0)).toBe(Status.missingField);
  expect(views[0]?.getUint32(4, true)).toBe(0);
  expect(status(2, 0)).toBe(Status.stepBudget);
  expect(views[2]?.getUint32(8, true)).toBe(1);
  expect(status(3, 0)).toBe(Status.missingField);
  expect(views[3]?.getUint32(4, true)).toBe(2);
  expect(status(4, 0)).toBe(Status.miss);
  expect([status(5, 0), status(5, 1), status(5, 2)]).toEqual([
    Status.missingField,
    Status.miss,
    Status.missingField,
  ]);
  expect(views[5]?.getUint32(4, true)).toBe(2);
  expect(views[5]?.getUint32(8, true)).toBeGreaterThan(1); // gradient, not first sample
  expect(views[5]?.getUint32(2 * 64 + 8, true)).toBe(1); // contributing interpolation neighbor
  const normal = views[1];
  assert(normal);
  const hitT = normal.getFloat32(16, true),
    doubledT = normal.getFloat32(64 + 16, true);
  expect(hitT).toBeGreaterThan(0.5);
  expect(hitT).toBeLessThan(1.25);
  expect(Math.abs(hitT - 2 * doubledT)).toBeLessThan(1e-5);
  expect(Math.abs(normal.getFloat32(8 * 64 + 16, true) - (2 + hitT))).toBeLessThan(1e-5);
  expect(Math.abs(normal.getFloat32(11 * 64 + 16, true) - 2 * hitT)).toBeLessThan(1e-5);
  expect(normal.getFloat32(52, true)).toBeGreaterThan(0.99);
  expect(normal.getFloat32(5 * 64 + 24, true)).toBeLessThan(0);
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(9);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  assert(raw);
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const plan of plans) {
      const id = model.works[plan.workIndex]?.bindings.find((b) => b.binding === 3)?.resourceId;
      assert(id);
      expect((await replay.readResource(id)).unwrap().bytes.every((b) => b === 0)).toBe(true);
    }
    for (const [i, plan] of plans.entries()) {
      const work = model.works[plan.workIndex];
      assert(work);
      const id = work.bindings.find((b) => b.binding === 3)?.resourceId;
      assert(id);
      const actual = (await replay.readResourceAtWork(id, plan.workIndex)).unwrap().bytes;
      expect(actual).toEqual(outputs[i]);
    }
  } finally {
    (await replay.dispose()).unwrap();
    raw.destroy();
  }
  expect(errors).toEqual([]);
  return {
    works: model.works.length,
    rayCounts: plans.map((p) => p.rays.length),
    cases: plans.map((p) => p.name),
    hitT,
    doubledT,
    errors,
  };
}
