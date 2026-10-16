import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  createGlobalSdfQueryRecorder,
  GLOBAL_SDF_QUERY_WGSL,
  GlobalSdfQueryStatus as Status,
} from '../../raytracing/global-sdf-query';
import { packReferenceRays } from '../../raytracing/scene';
import { readBuffer } from './path-tracer.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

// Independent emitter: no CPU ray upload and no constructor placeholder rays.
// This proves the borrowed query seam, not ordinary Renderer placement integration.
const EMIT_RAYS = `
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
@group(0) @binding(0) var<uniform> shift: vec4f;
@group(0) @binding(1) var<storage,read_write> rays: array<Ray>;
@compute @workgroup_size(64) fn emit(@builtin(global_invocation_id) id:vec3u) {
 if(id.x<arrayLength(&rays)) {
  rays[id.x]=Ray(vec3f(0,2,0)+shift.xyz,0,vec3f(0,-1,0),1.5,vec4u(255,0,0,0));
 }
}`;

/** Exact range, >64-lane dispatch and producer/query omission evidence on a real backend. */
export async function verifyGlobalSdfGpuRays(
  save?: (
    tape: Uint8Array,
    outputs: readonly { rays: Uint8Array; hits: Uint8Array }[],
  ) => Promise<void>,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 16 })
  ).unwrap();
  const composition = (
    await createGlobalSdfComposition(
      device,
      recorder.backend.createShaderModule,
      [
        {
          instanceId: 7,
          geometryId: 9,
          mask: 255,
          field,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ],
      {
        origin: [-3, -3, -3],
        dimensions: [13, 13, 13],
        spacing: 0.5,
        maxDistance: 2,
        coverageDistance: 0.5,
      },
    )
  ).unwrap();
  const owned: Buffer[] = [];
  const count = 65;
  const offset = Math.max(256, device.limits.minStorageBufferOffsetAlignment);
  const buffer = (label: string, bytes: Uint8Array, usage = 128 | 12) => {
    const result = device.createBuffer({ label, size: bytes.byteLength, usage }).unwrap();
    owned.push(result);
    device.queue.writeBuffer(result, 0, bytes).unwrap();
    return result;
  };
  const settingsBytes = new Uint8Array(16);
  const settingsView = new DataView(settingsBytes.buffer);
  settingsView.setUint32(0, 256, true);
  settingsView.setFloat32(4, 1, true);
  const settings = buffer('gpu-rays.query-settings', settingsBytes, 64 | 12);
  const plans = [
    { name: 'emitted', shift: 0, emit: true, query: true, emitWork: 1, queryWork: 2 },
    { name: 'moved-origin', shift: 2, emit: true, query: true, emitWork: 3, queryWork: 4 },
    { name: 'omitted-producer', shift: 0, emit: false, query: true, emitWork: -1, queryWork: 5 },
    { name: 'omitted-query', shift: 0, emit: true, query: false, emitWork: 6, queryWork: -1 },
  ];
  const outputs: { rays: Uint8Array; hits: Uint8Array }[] = [];
  let tapeBytes: Uint8Array;
  try {
    const query = createGlobalSdfQueryRecorder(
      device,
      (await recorder.backend.createShaderModule(device, { code: GLOBAL_SDF_QUERY_WGSL })).unwrap(),
    ).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: {
          module: (await recorder.backend.createShaderModule(device, { code: EMIT_RAYS })).unwrap(),
          entryPoint: 'emit',
        },
      })
      .unwrap();
    const cases = plans.map((plan) => {
      const rays = buffer(`${plan.name}.rays`, new Uint8Array(offset + count * 48 + 256));
      const hits = buffer(
        `${plan.name}.hits`,
        new Uint8Array(offset + count * 64 + 256).fill(0xcd),
      );
      const shift = buffer(
        `${plan.name}.shift`,
        new Uint8Array(new Float32Array([plan.shift, 0, 0, 0]).buffer),
        64 | 12,
      );
      const emitter = device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'buffer', value: { buffer: shift, size: 16 } } },
            {
              binding: 1,
              resource: { kind: 'buffer', value: { buffer: rays, offset, size: count * 48 } },
            },
          ],
        })
        .unwrap();
      return { plan, rays, hits, emitter };
    });
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    composition.record(encoder).unwrap();
    for (const { plan, rays, hits, emitter } of cases) {
      if (plan.emit) {
        const pass = encoder.beginComputePass({ label: `${plan.name}.emit` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, emitter);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
      }
      if (plan.query) {
        const pass = encoder.beginComputePass({ label: `${plan.name}.query` });
        query
          .record(
            pass,
            {
              voxels: { buffer: composition.buffers.voxels, size: composition.voxelCount * 16 },
              grid: { buffer: composition.buffers.settings, size: 48 },
              rays: { buffer: rays, offset, size: count * 48 },
              hits: { buffer: hits, offset, size: count * 64 },
              settings: { buffer: settings, size: 16 },
            },
            count,
          )
          .unwrap();
        pass.end();
      }
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    for (const { rays, hits } of cases)
      outputs.push({
        rays: await readBuffer(device, rays, offset + count * 48 + 256),
        hits: await readBuffer(device, hits, offset + count * 64 + 256),
      });
    await save?.(tapeBytes, outputs);
  } finally {
    for (const handle of owned) device.destroyBuffer(handle).unwrap();
    composition.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const summaries = outputs.map((output, index) => {
    const plan = plans[index];
    assert(plan);
    expect(output.rays.subarray(0, offset).every((value) => value === 0)).toBe(true);
    expect(output.rays.subarray(offset + count * 48).every((value) => value === 0)).toBe(true);
    expect(output.hits.subarray(0, offset).every((value) => value === 0xcd)).toBe(true);
    expect(output.hits.subarray(offset + count * 64).every((value) => value === 0xcd)).toBe(true);
    const expectedRay = {
      origin: [plan.shift, 2, 0] as const,
      direction: [0, -1, 0] as const,
      tMin: 0,
      tMax: 1.5,
      mask: 255,
    };
    expect(output.rays.subarray(offset, offset + count * 48)).toEqual(
      plan.emit
        ? packReferenceRays(Array.from({ length: count }, () => expectedRay)).unwrap()
        : new Uint8Array(count * 48),
    );
    const hits = new DataView(output.hits.buffer, output.hits.byteOffset + offset, count * 64);
    const expectedStatus = !plan.query
      ? 0xcdcdcdcd
      : plan.emit && plan.shift === 0
        ? Status.hit
        : Status.miss;
    for (let i = 0; i < count; i++) {
      expect(hits.getUint32(i * 64, true)).toBe(expectedStatus);
      if (plan.query && plan.emit) {
        expect(hits.getUint32(i * 64 + 8, true)).toBeGreaterThan(0);
        if (plan.shift === 0) {
          // The independently authored cube top is y=1: the exact triangle hit t is 1.
          // Global SDF's conservative expansion admits an earlier approximate hit.
          expect(hits.getFloat32(i * 64 + 16, true)).toBeGreaterThan(0.5);
          expect(hits.getFloat32(i * 64 + 16, true)).toBeLessThan(1.25);
          expect(hits.getFloat32(i * 64 + 52, true)).toBeGreaterThan(0.99);
        }
      }
    }
    return {
      name: plan.name,
      status: expectedStatus,
      count,
      emitted: plan.emit,
      queried: plan.query,
      t: plan.query ? hits.getFloat32(16, true) : null,
      steps: plan.query ? hits.getUint32(8, true) : null,
    };
  });
  expect(outputs[0]?.rays).not.toEqual(outputs[2]?.rays);
  expect(outputs[0]?.hits).not.toEqual(outputs[2]?.hits);
  expect(outputs[0]?.hits).not.toEqual(outputs[3]?.hits);
  const tape = decodeTape(tapeBytes).unwrap();
  const model = buildFrameModel(tape);
  expect(model.works).toHaveLength(7);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  assert(raw);
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    // Every replay ray buffer starts zero; nonzero origins must come from the recorded emitter.
    for (const plan of plans) {
      const consumer = model.works[plan.queryWork];
      const producer = model.works[plan.emitWork];
      const binding =
        consumer?.bindings.find((entry) => entry.binding === 2) ??
        producer?.bindings.find((entry) => entry.binding === 1);
      assert(binding?.resourceId);
      expect(
        (await replay.readResource(binding.resourceId))
          .unwrap()
          .bytes.every((value) => value === 0),
      ).toBe(true);
      const hit = consumer?.bindings.find((entry) => entry.binding === 3);
      if (hit?.resourceId)
        expect(
          (await replay.readResource(hit.resourceId))
            .unwrap()
            .bytes.every((value) => value === 0xcd),
        ).toBe(true);
    }
    for (const [index, plan] of plans.entries()) {
      const output = outputs[index];
      assert(output);
      const consumer = model.works[plan.queryWork];
      const producer = model.works[plan.emitWork];
      const rayBinding =
        consumer?.bindings.find((binding) => binding.binding === 2) ??
        producer?.bindings.find((binding) => binding.binding === 1);
      assert(rayBinding?.resourceId);
      expect(rayBinding.bufferOffset).toBe(offset);
      expect(rayBinding.bufferSize).toBe(count * 48);
      if (producer && consumer) {
        expect(producer.workIndex).toBeLessThan(consumer.workIndex);
        expect(producer.bindings.find((binding) => binding.binding === 1)?.resourceId).toBe(
          rayBinding.resourceId,
        );
      }
      expect(
        (
          await replay.readResourceAtWork(
            rayBinding.resourceId,
            consumer?.workIndex ?? plan.emitWork,
          )
        ).unwrap().bytes,
      ).toEqual(output.rays);
      if (consumer) {
        const hitBinding = consumer.bindings.find((binding) => binding.binding === 3);
        assert(hitBinding?.resourceId);
        expect(hitBinding.bufferOffset).toBe(offset);
        expect(hitBinding.bufferSize).toBe(count * 64);
        expect(
          (await replay.readResourceAtWork(hitBinding.resourceId, consumer.workIndex)).unwrap()
            .bytes,
        ).toEqual(output.hits);
      }
    }
  } finally {
    (await replay.dispose()).unwrap();
    raw.destroy();
  }
  expect(errors).toEqual([]);
  return { cases: summaries, works: model.works.length, offset, rayCount: count, errors };
}
