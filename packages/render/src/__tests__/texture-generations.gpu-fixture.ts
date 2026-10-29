import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

export async function verifyTextureGenerations() {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scope = worldRenderResources(world);
  const source = (index: number): TextureAsset => ({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array([index * 25, 255 - index * 20, index * 10, 255]),
  });
  let payload = source(0),
    handle = assets.create(payload).unwrap();
  let previous = store.ensureResident(handle, payload, scope).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: 4, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const module = (
    await recorder.backend.createShaderModule(device, {
      code: `
@group(0) @binding(0) var current: texture_2d<f32>;
@group(0) @binding(1) var previous: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4u>;
@compute @workgroup_size(1) fn sample() {
  output[0] = vec4u(round(textureLoad(current, vec2i(0), 0) * 255.0));
  output[1] = vec4u(round(textureLoad(previous, vec2i(0), 0) * 255.0));
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
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const facts: { handle: number; rgba: number[]; previous: number[] }[] = [];
  const results: Uint8Array[] = [];
  try {
    for (let index = 1; index <= 8; index++) {
      const oldHandle = handle,
        oldPayload = payload;
      const oldLease = store.retainTextureResidency(oldHandle, scope);
      assert(oldLease);
      assets.release(oldHandle).unwrap();
      payload = source(index);
      handle = assets.create(payload).unwrap();
      expect(assets.validate(oldHandle)).toMatchObject({ ok: false });
      expect(handle).not.toBe(oldHandle);
      const current = store.ensureResident(handle, payload, scope).unwrap();
      const binding = device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: current.view } },
            { binding: 1, resource: { kind: 'textureView', value: previous.view } },
            { binding: 2, resource: { kind: 'buffer', value: { buffer: output } } },
          ],
        })
        .unwrap();
      const staging = device.createBuffer({ size: 32, usage: 9 }).unwrap();
      const encoder = device.createCommandEncoder({ label: 'texture-generations' }).unwrap();
      const pass = encoder.beginComputePass({ label: 'sample-generations' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, 32);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const completed = device.queue.onSubmittedWorkDone();
      oldLease.track(completed);
      store.invalidateTexture(oldHandle, scope);
      expect(previous.texture.isDestroyed).toBe(false);
      const released = oldLease.release(true);
      await completed;
      await released;
      const mapped = (await staging.mapAsync(1)).unwrap(),
        bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
      mapped.unmap();
      device.destroyBuffer(staging).unwrap();
      const values = [...new Uint32Array(bytes.buffer)];
      assert(payload.data && oldPayload.data);
      expect(values).toEqual([...payload.data, ...oldPayload.data]);
      expect(store.getTextureGpuView(handle, scope)).toBe(current.view);
      expect(previous.texture.isDestroyed).toBe(true);
      expect(current.texture.isDestroyed).toBe(false);
      facts.push({ handle: Number(handle), rgba: values.slice(0, 4), previous: values.slice(4) });
      results.push(bytes);
      previous = current;
    }
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await captured).unwrap().bytes,
      tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    expect(model.works).toHaveLength(8);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      const requests = model.works.map((work) => {
        const resource = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 2,
        )?.resourceId;
        assert(resource);
        return { resourceId: resource, workIndex: work.workIndex };
      });
      const reads = (await replay.readAtWorks(requests)).unwrap();
      for (const [index, read] of reads.entries())
        expect(read.unwrap().bytes).toEqual(results[index]);
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return { bytes, facts };
  } finally {
    assets.release(handle).unwrap();
    store.destroyAll();
    assets.dispose();
    device.destroyBuffer(output).unwrap();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
