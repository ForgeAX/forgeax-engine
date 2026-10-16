import { World } from '@forgeax/engine-ecs';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { readBuffer } from './raytracing/path-tracer.fixture';

export async function verifySamplerResidency() {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('no cubemap');
    },
    device.caps,
  );
  const scope = new World();
  const source: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]),
  };
  const textureHandle = scope.allocSharedRef('TextureAsset', source);
  const texture = store.ensureResident(textureHandle, source, scope).unwrap();
  const nearest: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const linear: SamplerAsset = { kind: 'sampler', minFilter: 'linear', magFilter: 'linear' };
  const handle = scope.allocSharedRef('SamplerAsset', nearest);
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 2, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 3, visibility: 4, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const module = (
    await recorder.backend.createShaderModule(device, {
      code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var current: sampler;
@group(0) @binding(2) var previous: sampler;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn sample() {
  output[0] = textureSampleLevel(source, current, vec2f(0.5), 0.0);
  output[1] = textureSampleLevel(source, previous, vec2f(0.5), 0.0);
}`,
    })
  ).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'sample' },
    })
    .unwrap();
  const output = device.createBuffer({ size: 32, usage: 132 }).unwrap();
  const results: Uint8Array[] = [];
  const facts: { filter: string; current: number; previous: number }[] = [];
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    let previous = store.ensureSamplerResident(handle, nearest, scope).unwrap();
    for (const [index, payload] of [nearest, linear, nearest].entries()) {
      // The resource-scope API receives the next accepted publication payload at
      // the same logical handle. World authoring itself does not replace shared refs.
      const current = store.ensureSamplerResident(handle, payload, scope).unwrap();
      if (index !== 0) expect(current).not.toBe(previous);
      const binding = device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: texture.view } },
            { binding: 1, resource: { kind: 'sampler', value: current } },
            { binding: 2, resource: { kind: 'sampler', value: previous } },
            { binding: 3, resource: { kind: 'buffer', value: { buffer: output } } },
          ],
        })
        .unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      const pass = encoder.beginComputePass({ label: `sampler-source-${index}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const bytes = await readBuffer(device, output, 32);
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, 8);
      const expectedCurrent = index === 1 ? 0.5 : 1;
      const expectedPrevious = index === 2 ? 0.5 : 1;
      const expected = [
        expectedCurrent,
        expectedCurrent,
        expectedCurrent,
        1,
        expectedPrevious,
        expectedPrevious,
        expectedPrevious,
        1,
      ];
      // UNORM filtering may round to the source precision. This bound keeps
      // nearest (1) and linear (0.5) decisively distinct on real backends.
      for (const [lane, value] of values.entries())
        expect(Math.abs(value - (expected[lane] ?? NaN))).toBeLessThanOrEqual(1 / 255);
      results.push(bytes);
      facts.push({
        filter: payload.minFilter ?? 'nearest',
        current: values[0] ?? NaN,
        previous: values[4] ?? NaN,
      });
      previous = current;
    }
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await captured).unwrap().bytes;
    store.destroyAll();
    device.destroyBuffer(output).unwrap();
    raw.destroy();
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    expect(model.works).toHaveLength(3);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      for (const [index, work] of model.works.entries()) {
        const resource = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 3,
        )?.resourceId;
        assert(resource);
        expect((await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes).toEqual(
          results[index],
        );
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return { bytes, results, facts };
  } finally {
    store.destroyAll();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
