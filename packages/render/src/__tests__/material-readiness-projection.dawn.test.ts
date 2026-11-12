import { World } from '@forgeax/engine-ecs';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { projectMeshMaterialBindingObservation } from '../mesh-material-bindings';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import { observeMaterialResidency } from '../render-system-residency';
import { testAssets } from './helpers/runtime-assets';
import { nativeDeviceFixture } from './native-device-fixture';

it('keeps actual native texture/sampler residency and mip output through validation, mutation and reset', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const store = new GpuResidencyCache();
  const world = new World();
  const assets = testAssets(world);
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const configure = () => store.configureGpuDevice(device, undefined, device.caps);
  configure();
  const mips = { kind: 'packed' as const, levelCount: 3 };
  const data = new Uint8Array(84);
  for (let offset = 0; offset < data.length; offset += 4) data.set([0, 255, 0, 255], offset);
  const source: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips,
    data,
  };
  const textureHandle = assets.create(source).unwrap();
  const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const samplerHandle = assets.create(sampler).unwrap();
  const material: MaterialSnapshot = {
    ...defaultMaterialSnapshot(),
    textureHandles: new Map([['source', textureHandle]]),
    samplerHandles: new Map([['source', samplerHandle]]),
  };
  const internals = { gpuStore: store } as unknown as RenderSystemInternals;
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
      ],
    })
    .unwrap();
  const module = createShaderModuleImmediate(device, {
    code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<u32>>;
@compute @workgroup_size(1) fn main() {
  output[0] = vec4<u32>(textureLoad(source, vec2<i32>(0), 2) * 255.0);
}`,
  }).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'main' },
    })
    .unwrap();
  const output = device.createBuffer({ size: 16, usage: 132 }).unwrap();
  const readback = device.createBuffer({ size: 16, usage: 9 }).unwrap();
  const compare = () => {
    const full = observeMaterialResidency(worldRenderResources(world), material, internals);
    const status = observeMaterialResidency(
      worldRenderResources(world),
      material,
      internals,
      false,
    );
    expect(status.readiness).toBe(full.readiness);
    expect(status.preparationFailure).toEqual(full.preparationFailure);
    expect(status.textures).toEqual([]);
    expect(status.samplers).toEqual([]);
    const observation = projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey: 1,
      bindings: [{ handle: 0, source: 'engine-default' }],
      diagnostics: [],
      residency: [full],
    });
    expect(observation.residency[0]).toEqual(full);
    // Producer-owned diagnostics are already detached; projection borrows them.
    expect(observation.residency[0]).toBe(full);
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.isFrozen(observation.residency[0]?.samplers)).toBe(true);
    expect(Object.isFrozen(observation.residency[0]?.textures)).toBe(true);
    return full;
  };
  const read = async () => {
    const view = store.getTextureGpuView(textureHandle, worldRenderResources(world));
    if (view === undefined) throw new Error('Missing actual resident texture');
    const bindings = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: view } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    const values = [...new Uint32Array(mapping.getMappedRange().unwrap().slice(0))];
    mapping.unmap();
    expect(values).toEqual([0, 255, 0, 255]);
    return view;
  };
  try {
    const originalPublication = compare();
    const originalSnapshot = structuredClone(originalPublication);
    expect(originalPublication.readiness).toBe('ready');
    const originalView = await read();
    mips.levelCount = 0;
    expect(compare().readiness).toBe('ready');
    const rejected = assets.update(textureHandle, { mips: { kind: 'packed', levelCount: 0 } });
    expect(rejected.ok).toBe(false);
    expect(compare().readiness).toBe('ready');
    expect(originalPublication).toEqual(originalSnapshot);
    mips.levelCount = 3;
    expect(compare().textures[0]?.mipLevelCount).toBe(3);
    expect(await read()).toBe(originalView);
    store.destroyAll();
    configure();
    expect(compare().readiness).toBe('ready');
    expect(Object.is(await read(), originalView)).toBe(false);
    expect(originalPublication).toEqual(originalSnapshot);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    store.destroyAll();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
});
