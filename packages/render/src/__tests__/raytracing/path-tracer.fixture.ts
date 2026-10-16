import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  inspectBufferRecords,
  openReplay,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene, type RaySurfaceInstance } from '../../raytracing/attributes';
import { createRayPathTracer, type RayPathSettings } from '../../raytracing/path-tracer';
import type { RayPathFixture } from './path-tracer.commands';

export const settings = {
  width: 8,
  height: 8,
  camera: { origin: [0, 0, 2], target: [0, 0, 0], up: [0, 1, 0], verticalFov: 0.15 },
  maxBounces: 2,
  seed: 17,
  environment: [1, 1, 1],
  maxDistance: 100,
} satisfies RayPathSettings;
export function plane(materialId = 0): RaySurfaceInstance {
  return {
    instanceId: 7,
    geometryId: 9,
    materialId,
    mask: 255,
    positions: [-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0],
    indices: [0, 1, 2, 0, 2, 3],
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    uvSets: [
      [0, 0, 1, 0, 1, 1, 0, 1],
      [0, 1, 1, 1, 1, 0, 0, 0],
    ],
  };
}
export async function readBuffer(device: RhiDevice, buffer: Buffer, size: number) {
  const staging = device.createBuffer({ size, usage: 9 }).unwrap();
  try {
    const e = device.createCommandEncoder({}).unwrap();
    e.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([e.finish().unwrap()]).unwrap();
    const m = (await staging.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(m.getMappedRange().unwrap()).slice();
    m.unmap();
    return bytes;
  } finally {
    device.destroyBuffer(staging).unwrap();
  }
}
export async function verifyRayPath(fixture: RayPathFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const material = fixture.materials.find((m) => m.name === 'matte');
  assert(material);
  const scene = buildRaySurfaceScene([plane()]).unwrap();
  const tracer = (
    await createRayPathTracer(device, recorder.backend.createShaderModule, {
      kernel: fixture.kernel,
      scene,
      materials: [{ id: 0, ...material }],
      lights: [],
      settings,
    })
  ).unwrap();
  const submit = (count: number, reset = false) => {
    const e = device.createCommandEncoder({}).unwrap();
    if (reset) tracer.reset(e).unwrap();
    for (let i = 0; i < count; i++) tracer.recordSample(e).unwrap();
    device.queue.submit([e.finish().unwrap()]).unwrap();
  };
  // Capture a warm accumulator, then overwrite it. Selected-work replay must
  // recover the first sample even after the original resources are destroyed.
  const samples: Float32Array[] = [];
  for (let i = 0; i < 3; i++) {
    submit(1);
    samples.push(
      new Float32Array((await readBuffer(device, tracer.buffers.paths, 64 * 80)).buffer),
    );
  }
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  submit(1);
  const live = await readBuffer(device, tracer.buffers.accumulation, 64 * 80);
  submit(1, true);
  const reset = await readBuffer(device, tracer.buffers.accumulation, 64 * 80);
  (await recorder.frameBoundary()).unwrap();
  const bytes = (await captured).unwrap().bytes;
  tracer.dispose();
  expect(tracer.reset(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  (await recorder.dispose()).unwrap();
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  const firstAccumulate = 7,
    lastAccumulate = 15;
  expect(model.works).toHaveLength(16);
  try {
    const work = model.works[firstAccumulate];
    assert(work);
    const accumulationId = work.bindings.find((b) => b.binding === 6)?.resourceId;
    assert(accumulationId);
    expect(
      Array.from((await replay.readResourceAtWork(accumulationId, firstAccumulate)).unwrap().bytes),
    ).toEqual(Array.from(live));
    expect(
      Array.from((await replay.readResourceAtWork(accumulationId, lastAccumulate)).unwrap().bytes),
    ).toEqual(Array.from(reset));
    const layout = {
      stride: 80,
      fields: [
        { name: 'mean', offset: 0, type: 'f32' as const, components: 3 as const },
        { name: 'count', offset: 12, type: 'u32' as const, components: 1 as const },
        { name: 'm2', offset: 16, type: 'f32' as const, components: 3 as const },
        { name: 'error', offset: 28, type: 'u32' as const, components: 1 as const },
      ],
    };
    const records = (
      await inspectBufferRecords(replay, accumulationId, firstAccumulate, layout, {
        first: 0,
        count: 64,
      })
    ).unwrap();
    const pathId = work.bindings.find((b) => b.binding === 3)?.resourceId;
    assert(pathId);
    samples.push(
      new Float32Array(
        (await replay.readResourceAtWork(pathId, firstAccumulate)).unwrap().bytes.slice().buffer,
      ),
    );
    for (const row of records.records) {
      expect(row.fields).toMatchObject({ count: [4], error: [0] });
      for (let c = 0; c < 3; c++) {
        const values = samples.map((sample) => sample[row.index * 20 + 12 + c] ?? 0);
        const mean = values.reduce((a, b) => a + b) / 4;
        const m2 = values.reduce((a, b) => a + (b - mean) ** 2, 0);
        expect(row.fields.mean?.[c]).toBeCloseTo(mean, 5);
        expect(row.fields.m2?.[c]).toBeCloseTo(m2, 5);
      }
    }
    const inputId = work.bindings.find((b) => b.binding === 4)?.resourceId;
    assert(inputId);
    const primary = (
      await inspectBufferRecords(
        replay,
        inputId,
        1,
        {
          stride: 224,
          fields: [
            { name: 'normal', offset: 32, type: 'f32', components: 4 },
            { name: 'uv', offset: 80, type: 'f32', components: 4 },
            { name: 'identity', offset: 208, type: 'u32', components: 4 },
          ],
        },
        { first: 0, count: 1 },
      )
    ).unwrap();
    expect(primary.records[0]?.fields.normal).toEqual([0, 0, 1, 1]);
    expect(primary.records[0]?.fields.identity?.slice(0, 3)).toEqual([0, 1, 0]);
  } finally {
    (await replay.dispose()).unwrap();
  }
  // F0=0 derives F90=0, so the Standard lobe is purely diffuse.
  // Check two independent seeds and both terminal-bounce MIS policies.
  const gpu = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const results = [];
  for (const [maxBounces, seed] of [
    [1, 17],
    [2, 17],
    [1, 89],
    [2, 89],
  ] as const) {
    const batch = (
      await createRayPathTracer(gpu, webgpu.createShaderModule, {
        kernel: fixture.kernel,
        scene,
        materials: [{ id: 0, ...material }],
        lights: [],
        settings: { ...settings, maxBounces, seed },
      })
    ).unwrap();
    for (let chunk = 0; chunk < 8; chunk++) {
      const e = gpu.createCommandEncoder({}).unwrap();
      for (let i = 0; i < 16; i++) batch.recordSample(e).unwrap();
      gpu.queue.submit([e.finish().unwrap()]).unwrap();
      await gpu.queue.onSubmittedWorkDone();
    }
    const data = await readBuffer(gpu, batch.buffers.accumulation, 64 * 80);
    const floats = new Float32Array(data.buffer),
      uints = new Uint32Array(data.buffer);
    const mean = [0, 0, 0];
    for (let i = 0; i < 64; i++) {
      expect(uints[i * 20 + 3]).toBe(128);
      expect(uints[i * 20 + 7]).toBe(0);
      for (let c = 0; c < 3; c++) mean[c] = (mean[c] ?? 0) + (floats[i * 20 + c] ?? 0) / 64;
    }
    for (let c = 0; c < 3; c++)
      expect(Math.abs((mean[c] ?? 0) - ([0.8, 0.4, 0.2][c] ?? 0))).toBeLessThan(0.012);
    results.push({ maxBounces, seed, mean });
    batch.dispose();
  }
  webgpu._internal_getRawDevice(gpu)?.destroy();
  return { bytes, live, reset, results, firstAccumulate, lastAccumulate };
}
