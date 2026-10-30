import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import { encodedTexture } from './managed-basis-texture-fixture';

it('samples old and new compressed image mip chains in one GPU submission', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({
      requiredFeatures: adapter.features.has('texture-compression-bc')
        ? ['texture-compression-bc']
        : [],
    })
  ).unwrap();
  const raw = _internal_getRawDevice(device);
  assert(raw);
  raw.pushErrorScope('validation');
  const assets = new AssetRegistry(),
    world = new World({ assets }),
    store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const first = await encodedTexture(32),
    second = await encodedTexture(192);
  const handle = assets.create(first).unwrap(),
    observer = assets.observe().unwrap();
  const source = () => runtimeAssets(assets).borrow<TextureAsset>(handle).unwrap();
  const prepare = async () => {
    store.prepareTextureData(handle, source(), worldRenderResources(world));
    await store.waitTextureData(handle, worldRenderResources(world));
    return store.ensureResident(handle, source(), worldRenderResources(world)).unwrap();
  };
  const before = await prepare(),
    fixed = store.retainTextureResidency(handle, worldRenderResources(world));
  assert(fixed);
  assets.replace(handle, second).unwrap();
  const changes = observer.read().unwrap();
  for (const change of changes.changes)
    store.adoptTextureChange(change, source(), worldRenderResources(world)).unwrap();
  changes.accept();
  const after = await prepare();
  expect(Object.is(after.view, before.view)).toBe(false);
  expect(before.texture.isDestroyed).toBe(false);
  expect(after.receipt.mipLevelCount).toBe(5);
  const shader = (
    await rhi.createShaderModule(device, {
      code: `
@group(0) @binding(0) var before: texture_2d<f32>;
@group(0) @binding(1) var after: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(1) fn sample() {
  values[0] = textureLoad(before, vec2i(0), 0);
  values[1] = textureLoad(after, vec2i(0), 0);
  values[2] = textureLoad(before, vec2i(0), 4);
  values[3] = textureLoad(after, vec2i(0), 4);
}`,
    })
  ).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: 4, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module: shader, entryPoint: 'sample' },
    })
    .unwrap();
  const output = device.createBuffer({ size: 64, usage: 132 }).unwrap();
  const readback = device.createBuffer({ size: 64, usage: 9 }).unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: before.view } },
        { binding: 1, resource: { kind: 'textureView', value: after.view } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: output } } },
      ],
    })
    .unwrap();
  const encoder = device.createCommandEncoder().unwrap(),
    pass = encoder.beginComputePass({});
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  fixed.track(device.queue.onSubmittedWorkDone());
  const release = fixed.release(true);
  const mapping = (await readback.mapAsync(1)).unwrap();
  const values = new Float32Array(mapping.getMappedRange().unwrap().slice(0));
  mapping.unmap();
  for (const i of [0, 2])
    for (let c = 0; c < 4; c++) {
      expect(Math.abs((values[i * 4 + c] ?? NaN) - 32 / 255)).toBeLessThan(0.02);
      expect(Math.abs((values[(i + 1) * 4 + c] ?? NaN) - 192 / 255)).toBeLessThan(0.02);
    }
  await release;
  expect(before.texture.isDestroyed).toBe(true);
  expect(await raw.popErrorScope()).toBeNull();
  observer.dispose();
  store.destroyAll();
  assets.dispose();
  device.destroyBuffer(output);
  device.destroyBuffer(readback);
});
