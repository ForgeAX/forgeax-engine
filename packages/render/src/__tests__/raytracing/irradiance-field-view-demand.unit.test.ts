import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createIrradianceFieldViewKernels } from '../../raytracing/irradiance-field';

it('prepares no upsample or feedback pipeline for a full direct-only live field', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const layouts = vi.spyOn(device, 'createPipelineLayout');
  const result = (
    await createIrradianceFieldViewKernels(device, module, 'live', {
      resolution: 'full',
      radiosity: false,
      gatherView: true,
    })
  ).unwrap();
  expect(pipelines.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'lightCards',
    'gatherField',
    'copyDirectCards',
  ]);
  expect(result.kernels.upsampleField).toBeUndefined();
  expect(layouts.mock.calls[2]?.[0].bindGroupLayouts).toHaveLength(1);
  expect([...(layouts.mock.calls[1]?.[0].bindGroupLayouts ?? [])][1]).toBe(result.sampleLayout);
  expect(pipelines.mock.calls.every(([d]) => d.compute.module === module)).toBe(true);
});

it('retains the exact feedback and shared layout path for a half-resolution live field', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const layouts = vi.spyOn(device, 'createPipelineLayout');
  const result = (
    await createIrradianceFieldViewKernels(device, module, 'live', {
      resolution: 'half',
      radiosity: true,
      gatherView: true,
    })
  ).unwrap();
  expect(pipelines.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'lightCards',
    'gatherField',
    'radiateCards',
    'upsampleField',
  ]);
  for (const index of [1, 2, 3])
    expect([...(layouts.mock.calls[index]?.[0].bindGroupLayouts ?? [])][1]).toBe(
      result.sampleLayout,
    );
  expect(result.kernels.upsampleField).toBeDefined();
});

it('retains baked sampler layout and suppresses the unused full-resolution upsample', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const result = (
    await createIrradianceFieldViewKernels(device, module, 'baked', {
      resolution: 'full',
      radiosity: false,
      gatherView: true,
    })
  ).unwrap();
  expect(pipelines.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'lightCards',
    'gatherBakedField',
    'copyDirectCards',
  ]);
  expect(result.kernels.upsampleField).toBeUndefined();
});

it('keeps the half-resolution direct-only path and reflection sample layout independent', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const layouts = vi.spyOn(device, 'createPipelineLayout');
  const result = (
    await createIrradianceFieldViewKernels(device, module, 'live', {
      resolution: 'half',
      radiosity: false,
      gatherView: true,
    })
  ).unwrap();
  expect(pipelines.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'lightCards',
    'gatherField',
    'copyDirectCards',
    'upsampleField',
  ]);
  (await result.reflectionKernels(module)).unwrap();
  expect([...(layouts.mock.calls[4]?.[0].bindGroupLayouts ?? [])][1]).toBe(result.sampleLayout);
});

it('retains the baked half-resolution upsample entry', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const result = (
    await createIrradianceFieldViewKernels(device, module, 'baked', {
      resolution: 'half',
      radiosity: false,
      gatherView: true,
    })
  ).unwrap();
  expect(pipelines.mock.calls.at(-1)?.[0].compute.entryPoint).toBe('upsampleBakedField');
  expect(result.kernels.upsampleField).toBeDefined();
});

it('does not initialize unused gather pipelines for a Screen Probe field', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const original = device.createComputePipeline.bind(device);
  const pipelines = vi.spyOn(device, 'createComputePipeline').mockImplementation((descriptor) => {
    if (descriptor.compute.entryPoint === 'gatherField') throw new Error('unused gather reached');
    return original(descriptor);
  });
  try {
    const view = (
      await createIrradianceFieldViewKernels(device, module, 'live', {
        resolution: 'half',
        radiosity: true,
        gatherView: false,
      })
    ).unwrap();
    expect(pipelines.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
      'lightCards',
      'radiateCards',
    ]);
    expect(view.kernels.gatherField).toBeUndefined();
    expect(view.kernels.upsampleField).toBeUndefined();
    (await view.reflectionKernels(module)).unwrap();
    expect(pipelines.mock.calls.slice(2).map(([d]) => d.compute.entryPoint)).toEqual([
      'generateFieldReflections',
      'accumulateFieldReflections',
      'filterFieldReflections',
    ]);
  } finally {
    pipelines.mockRestore();
  }
});

it('publishes no partial gather pair and retains its failure without frame retries', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const view = (
    await createIrradianceFieldViewKernels(device, module, 'live', {
      resolution: 'half',
      radiosity: true,
      gatherView: false,
    })
  ).unwrap();
  const original = device.createComputePipeline.bind(device);
  const pipelines = vi.spyOn(device, 'createComputePipeline').mockImplementation((descriptor) => {
    if (descriptor.compute.entryPoint === 'upsampleField') throw new Error('upsample unavailable');
    return original(descriptor);
  });
  try {
    (await view.prepareGather(false)).unwrap();
    expect(pipelines).not.toHaveBeenCalled();
    const failed = view.prepareGather(true);
    await expect(failed).rejects.toThrow('upsample unavailable');
    expect(view.kernels.gatherField).toBeUndefined();
    expect(view.kernels.upsampleField).toBeUndefined();
    pipelines.mockImplementation(original);
    pipelines.mockClear();
    (await view.prepareGather(false)).unwrap();
    expect(view.prepareGather(true)).toBe(failed);
    await expect(view.prepareGather(true)).rejects.toThrow('upsample unavailable');
    expect(pipelines).not.toHaveBeenCalled();
  } finally {
    pipelines.mockRestore();
  }
});
