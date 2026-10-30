import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

export async function verifyManagedTextureRange(mips: 'none' | 'generate') {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = _internal_getRawDevice(device);
  assert(raw);
  const submits = vi.spyOn(device.queue, 'submit');
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry(),
    store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    (_device, descriptor) => rhi.createShaderModule(device, descriptor),
    device.caps,
  );
  if (mips === 'generate') (await store.prewarmMipmapPipeline(device, ['rgba8unorm'])).unwrap();
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: mips },
      data: new Uint8Array(256),
    })
    .unwrap();
  const current = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  const initial = store.ensureResident(handle, current()).unwrap();
  expect(submits).not.toHaveBeenCalled();
  const fixed = store.retainTextureResidency(handle);
  assert(fixed);
  const observer = assets.observe().unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const shader = (
    await rhi.createShaderModule(device, {
      code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn sample() {
  output[0] = textureLoad(source, vec2i(2, 3), 0);
  output[1] = textureLoad(source, vec2i(7, 7), 0);
  output[2] = textureLoad(source, vec2i(0), i32(textureNumLevels(source)) - 1);
}`,
    })
  ).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module: shader, entryPoint: 'sample' },
    })
    .unwrap();
  const output = device.createBuffer({ size: 48, usage: 132 }).unwrap();
  const readback = device.createBuffer({ size: 48, usage: 9 }).unwrap();
  const sample = async (entry: typeof initial) => {
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: entry.view } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap(),
      pass = encoder.beginComputePass({});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 48);
    const mipWork = store.prepareTextureMips().unwrap();
    const recorded = encoder.finish().unwrap();
    device.queue
      .submit(mipWork?.buffer === undefined ? [recorded] : [mipWork.buffer, recorded])
      .unwrap();
    mipWork?.complete(true);
    fixed.track(device.queue.onSubmittedWorkDone());
    const mapping = (await readback.mapAsync(1)).unwrap();
    const values = new Float32Array(mapping.getMappedRange().unwrap().slice(0));
    mapping.unmap();
    return [...values];
  };
  const edit = (green: boolean) => {
    const priorSubmits = submits.mock.calls.length;
    const pixels = green ? [0, 255, 0, 255] : [255, 0, 0, 255];
    const size = mips === 'generate' ? 8 : 2;
    assets
      .writeRange(handle, {
        origin: mips === 'generate' ? { x: 0, y: 0 } : { x: 2, y: 3 },
        size: { width: size, height: size },
        data: Uint8Array.from(Array.from({ length: size * size }, () => pixels).flat()),
      })
      .unwrap();
    const batch = observer.read().unwrap(),
      change = batch.changes[0];
    assert(change);
    store.adoptTextureChange(change, current()).unwrap();
    batch.accept();
    const resident = store.ensureResident(handle, current()).unwrap();
    expect(submits.mock.calls.length).toBe(priorSubmits);
    return resident;
  };
  try {
    const red = edit(false);
    expect(Object.is(red.texture, initial.texture)).toBe(false);
    const redPixels = await sample(red);
    expect(redPixels.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(redPixels.slice(4, 8)).toEqual(mips === 'generate' ? [1, 0, 0, 1] : [0, 0, 0, 0]);
    expect(redPixels.slice(8)).toEqual(mips === 'generate' ? [1, 0, 0, 1] : [0, 0, 0, 0]);
    expect(await sample(initial)).toEqual(new Array(12).fill(0));
    const green = edit(true);
    expect(green.texture).toBe(red.texture);
    expect((await sample(green)).slice(0, 4)).toEqual([0, 1, 0, 1]);
    if (mips === 'generate') expect((await sample(green)).slice(8)).toEqual([0, 1, 0, 1]);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    submits.mockRestore();
    await fixed.release(false);
    observer.dispose();
    store.destroyAll();
    assets.dispose();
    device.destroyBuffer(output);
    device.destroyBuffer(readback);
    await device.queue.onSubmittedWorkDone();
  }
}
