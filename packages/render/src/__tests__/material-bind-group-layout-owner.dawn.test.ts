import { World } from '@forgeax/engine-ecs';
import type { BindGroupLayoutEntry } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { createSkylightFallback, skylightBindGroupResources } from '../ibl/skylight-bind-group';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import type { MaterialSnapshot } from '../render-system-extract';
import { nativeDeviceFixture } from './native-device-fixture';

it('keeps the selected native material layout through replacement and return to an earlier publication', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  let scopeOpen = true;
  const fallback = createSkylightFallback(device, device.queue);
  const materialBuffer = device.createBuffer({ size: 256, usage: 64 | 8 }).unwrap();
  const sceneBuffer = device.createBuffer({ size: 64, usage: 128 }).unwrap();
  const output = device.createBuffer({ size: 16, usage: 128 | 4 }).unwrap();
  const readback = device.createBuffer({ size: 16, usage: 1 | 8 }).unwrap();
  const bytes = new Uint32Array(64);
  bytes.set([23, 47, 71, 255], 12);
  bytes.set([89, 101, 127, 255], 28);
  device.queue.writeBuffer(materialBuffer, 0, bytes).unwrap();
  const materialLayout = (minBindingSize: number) => {
    const entries: BindGroupLayoutEntry[] = [
      { binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize } },
      { binding: 1, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
      { binding: 2, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 3, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
      { binding: 4, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 5, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
      { binding: 6, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 47, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
    ];
    if (transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage))
      entries.push(
        { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
        { binding: 8, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
      );
    if (device.caps.storageBuffer)
      entries.push({ binding: 46, visibility: 4, buffer: { type: 'read-only-storage' } });
    return device.createBindGroupLayout({ entries }).unwrap();
  };
  const originalLayout = materialLayout(64);
  const replacementLayout = materialLayout(128);
  let selectedLayout = originalLayout;
  const deps = {
    runtime: { device, getParamSchema: () => [], getMaterialBindGroupLayout: () => selectedLayout },
    pipelineState: {
      materialBindGroupLayout: originalLayout,
      materialUniformBuffer: { buffer: materialBuffer },
      meshStorageBuffer: { buffer: sceneBuffer },
      defaultSampler: fallback.sampler,
      defaultWhiteTextureView: fallback.brdfLutView,
    },
    world: new World(),
    store: { materialResourceEpoch: 0 },
    materialSlice: 256,
    videoHighPerfAvailable: false,
    skylightResources: skylightBindGroupResources(fallback),
    materialBgShared: new Map(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
  } as unknown as PerSubmeshMaterialBgDeps;
  const material = { materialHandle: 1, materialShaderId: 'game::replaceable' } as MaterialSnapshot;
  const outputLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const outputGroup = device
    .createBindGroup({
      layout: outputLayout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
    })
    .unwrap();
  const run = async (size: number, expected: number[]) => {
    const module = createShaderModuleImmediate(device, {
      code: `
struct Material { values: array<vec4<u32>, ${size}> }
@group(0) @binding(0) var<uniform> material: Material;
@group(1) @binding(0) var<storage, read_write> output: array<vec4<u32>>;
@compute @workgroup_size(1) fn main() { output[0] = material.values[${size - 1}]; }
`,
    }).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [selectedLayout, outputLayout] })
          .unwrap(),
        compute: { module, entryPoint: 'main' },
      })
      .unwrap();
    const group = buildPerSubmeshMaterialBg(deps, { ...material }, 1);
    expect(buildPerSubmeshMaterialBg(deps, { ...material }, 2)).toBe(group);
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setBindGroup(1, outputGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    const actual = [...new Uint32Array(mapping.getMappedRange().unwrap().slice(0))];
    mapping.unmap();
    expect(actual).toEqual(expected);
    return group;
  };
  try {
    const original = await run(4, [23, 47, 71, 255]);
    selectedLayout = replacementLayout;
    expect(await run(8, [89, 101, 127, 255])).not.toBe(original);
    selectedLayout = originalLayout;
    expect(await run(4, [23, 47, 71, 255])).toBe(original);
    expect(deps.bindGroupCounts.createBindGroup).toBe(2);
    const validation = await native.popErrorScope();
    scopeOpen = false;
    expect(validation).toBeNull();
  } finally {
    if (scopeOpen) await native.popErrorScope();
    for (const buffer of [materialBuffer, sceneBuffer, output, readback, fallback.intensityBuffer])
      device.destroyBuffer(buffer).unwrap();
    for (const texture of [
      fallback.irradianceTexture,
      fallback.prefilterTexture,
      fallback.brdfLutTexture,
    ])
      device.destroyTexture(texture).unwrap();
    native.destroy();
  }
});
