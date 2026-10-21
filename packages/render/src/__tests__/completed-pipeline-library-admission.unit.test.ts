import { describe, expect, it, vi } from 'vitest';
import { createMockGpu } from '../../../rhi-webgpu/src/__tests__/__mocks__/gpu-device';
import { makeRhiDevice } from '../../../rhi-webgpu/src/device';
import { createShaderModuleImmediate } from '../../../rhi-webgpu/src/index';
import * as materialPrograms from '../../../shader/src/material/program';
import { ShaderRegistry } from '../../../shader/src/ShaderRegistry';
import { PreparedRenderPipelineOwner } from '../assembly/material/prepared-pipeline-owner';
import { prepareDevicePipelineLibrary } from '../assembly/webgpu-ready';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';

async function fixture() {
  const raw = (await (
    await createMockGpu().requestAdapter()
  )?.requestDevice()) as unknown as GPUDevice;
  const render = vi.fn(async () => ({}) as GPURenderPipeline);
  const compute = vi.fn(async () => ({}) as GPUComputePipeline);
  Object.assign(raw, { createRenderPipelineAsync: render, createComputePipelineAsync: compute });
  const device = makeRhiDevice(raw).device;
  const syncRender = vi.spyOn(raw, 'createRenderPipeline');
  const syncCompute = vi.spyOn(raw, 'createComputePipeline');
  return { raw, device, render, compute, syncRender, syncCompute };
}

describe('physical-device completion is consumed in the first preparation frame', () => {
  it('prepares material source facts for the captured graphics roster before the first draw', async () => {
    const source = await fixture();
    const codes = [
      '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }',
      '@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }',
      '@compute @workgroup_size(1) fn cs() {}',
    ] as const;
    const modules = codes.map((code) =>
      createShaderModuleImmediate(source.device, { code }).unwrap(),
    );
    const [vertexModule, fragmentModule, computeModule] = modules;
    if (vertexModule === undefined || fragmentModule === undefined || computeModule === undefined)
      throw new Error('fixture shader modules are required');
    for (const label of ['first', 'same source alias'])
      (
        await source.device.createRenderPipelineAsync?.({
          label,
          layout: 'auto',
          vertex: { module: vertexModule, entryPoint: 'vs', buffers: [] },
          fragment: {
            module: fragmentModule,
            entryPoint: 'fs',
            targets: [{ format: 'rgba8unorm' }],
          },
        })
      )?.unwrap();
    (
      await source.device.createComputePipelineAsync?.({
        layout: 'auto',
        compute: { module: computeModule, entryPoint: 'cs' },
      })
    )?.unwrap();
    const manifest = source.device.pipelineLibrary?.export().unwrap();
    if (manifest === undefined || manifest.renderPipelines[0] === undefined)
      throw new Error('fixture graphics library is required');
    const target = await fixture();
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const analyze = vi.spyOn(materialPrograms, 'createMaterialShaderProgram');
    try {
      await prepareDevicePipelineLibrary(target.device, manifest, registry);
      expect(analyze).toHaveBeenCalledTimes(2);
      const vertex = registry.materialProgram(codes[0]);
      const fragment = registry.materialProgram(codes[1]);
      expect(analyze).toHaveBeenCalledTimes(2);
      const recovered = registry.forkForDevice({
        createShaderModule: (descriptor) => createShaderModuleImmediate(target.device, descriptor),
      });
      await prepareDevicePipelineLibrary(target.device, manifest, recovered);
      expect(recovered.materialProgram(codes[0])).toBe(vertex);
      expect(recovered.materialProgram(codes[1])).toBe(fragment);
      expect(analyze).toHaveBeenCalledTimes(2);
      // Compute-only sources have no material contract and remain with their owner.
      registry.materialProgram(codes[2]);
      expect(analyze).toHaveBeenCalledTimes(3);
      const invalid = {
        ...manifest,
        renderPipelines: [{ ...manifest.renderPipelines[0], vertex: { module: 999 } }],
      };
      await expect(
        prepareDevicePipelineLibrary(target.device, invalid, registry),
      ).rejects.toThrow();
      expect(analyze).toHaveBeenCalledTimes(3);
    } finally {
      analyze.mockRestore();
    }
  });

  it('admits three separately named prewarmed compute recipes without an extra pending turn', async () => {
    const f = await fixture();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => f.device,
      getShaderModuleFactory: () => ({
        createShaderModule: (desc) => createShaderModuleImmediate(f.device, desc),
      }),
    });
    try {
      const layout = f.device
        .createPipelineLayout({
          bindGroupLayouts: [f.device.createBindGroupLayout({ entries: [] }).unwrap()],
        })
        .unwrap();
      const descriptors = Array.from({ length: 3 }, (_, i) => ({
        wgsl: `@compute @workgroup_size(1) fn main() {} // recipe ${i}`,
        entryPoints: ['main'],
        bindings: [{ entries: [] }],
      }));
      for (const descriptor of descriptors) {
        const module = createShaderModuleImmediate(f.device, { code: descriptor.wgsl }).unwrap();
        (
          await f.device.createComputePipelineAsync?.({
            label: 'loading alias',
            layout,
            compute: { module, entryPoint: 'main' },
          })
        )?.unwrap();
      }
      expect(f.device.pipelineLibrary?.inspect().compilationCompleted).toBe(3);
      const session = owner.beginFeature('newly-born-player', 0);
      const results = descriptors.map((descriptor, i) =>
        session.prepareProgram(`new-program-${i}`, descriptor, true),
      );
      expect(f.compute).toHaveBeenCalledTimes(3);
      expect(results.map((result) => result.ok)).toEqual([true, true, true]);
      session.commitFrame();
      expect(f.syncCompute).not.toHaveBeenCalled();
    } finally {
      owner.dispose().unwrap();
    }
  });

  it('admits two fresh graphics owners from completed recipes without compilation or pending', async () => {
    const f = await fixture();
    const descriptors = ['billboard', 'mesh'].map((kind) => ({
      layout: 'auto' as const,
      vertex: {
        module: createShaderModuleImmediate(f.device, { code: kind }).unwrap(),
        entryPoint: 'vs',
        buffers: [],
      },
    }));
    for (const descriptor of descriptors)
      (await f.device.createRenderPipelineAsync?.(descriptor))?.unwrap();
    const owner = new PreparedRenderPipelineOwner(f.device, () => true);
    const results = descriptors.map((descriptor, i) =>
      owner.request(`new-graphics-${i}`, `${i}`, descriptor),
    );
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(f.syncRender).not.toHaveBeenCalled();
  });
});

it('holds a mixed ready/pending compute program until every entry actually completes', async () => {
  const f = await fixture();
  const descriptor = {
    wgsl: '@compute @workgroup_size(1) fn warm() {} @compute @workgroup_size(1) fn cold() {}',
    entryPoints: ['warm', 'cold'],
    bindings: [{ entries: [] }],
  };
  const module = createShaderModuleImmediate(f.device, { code: descriptor.wgsl }).unwrap();
  const layout = f.device
    .createPipelineLayout({
      bindGroupLayouts: [f.device.createBindGroupLayout({ entries: [] }).unwrap()],
    })
    .unwrap();
  (
    await f.device.createComputePipelineAsync?.({ layout, compute: { module, entryPoint: 'warm' } })
  )?.unwrap();
  let finish!: (pipeline: GPUComputePipeline) => void;
  f.compute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => f.device,
    getShaderModuleFactory: () => ({
      createShaderModule: () => createShaderModuleImmediate(f.device, { code: descriptor.wgsl }),
    }),
  });
  try {
    const first = owner.beginFeature('mixed', 0);
    expect(first.prepareProgram('two-entries', descriptor, true).ok).toBe(false);
    first.abortFrame().unwrap();
    await Promise.resolve();
    expect(f.compute).toHaveBeenCalledTimes(2);
    const next = owner.beginFeature('mixed', 0);
    expect(next.prepareProgram('two-entries', descriptor, true).ok).toBe(false);
    next.abortFrame().unwrap();
    const completed = f.device.createComputePipelineAsync?.({
      layout,
      compute: { module, entryPoint: 'cold' },
    });
    finish({} as GPUComputePipeline);
    await completed;
    await Promise.resolve();
    const ready = owner.beginFeature('mixed', 0);
    expect(ready.prepareProgram('two-entries', descriptor, true).ok).toBe(true);
    ready.abortFrame().unwrap();
    expect(f.syncCompute).not.toHaveBeenCalled();
  } finally {
    owner.dispose().unwrap();
  }
});
