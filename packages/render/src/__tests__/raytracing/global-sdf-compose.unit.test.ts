import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import * as globalSdf from '../../raytracing/global-sdf';
import { queryTestDevice } from './global-sdf-query-device.fixture';

it('borrows exact composition ranges without creating, writing, submitting or releasing buffers', async () => {
  expect(globalSdf.createGlobalSdfCompositionRecorder).toBeTypeOf('function');
  const device = await queryTestDevice();
  const module = (
    await createShaderModule(device, { code: globalSdf.GLOBAL_SDF_COMPOSE_WGSL })
  ).unwrap();
  const input = Object.fromEntries(
    Object.entries({ instances: 288, fields: 256, bounds: 96, settings: 48, voxels: 65 * 16 }).map(
      ([name, size]) => [
        name,
        {
          buffer: device.createBuffer({ size: size + 512, usage: 0xcc }).unwrap(),
          offset: 256,
          size,
        },
      ],
    ),
  ) as unknown as globalSdf.GlobalSdfCompositionInputs;
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  const create = vi.spyOn(device, 'createBuffer');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const submit = vi.spyOn(device.queue, 'submit');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const bind = vi.spyOn(device, 'createBindGroup');
  const dispatch = vi.spyOn(pass, 'dispatchWorkgroups');
  const end = vi.spyOn(pass, 'end');
  const recorder = globalSdf.createGlobalSdfCompositionRecorder(device, module).unwrap();
  for (const count of [0, -1, 1.5, NaN, Infinity, 128 ** 3 + 1])
    expect(recorder.record(pass, input, count).ok).toBe(false);
  for (const name of ['instances', 'fields', 'bounds', 'settings', 'voxels'] as const) {
    for (const offset of [-1, 1, NaN, Infinity, 256.5])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], offset } }, 65).ok).toBe(
        false,
      );
    for (const size of [0, -1, input[name].size - 1, NaN, Infinity])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], size } }, 65).ok).toBe(
        false,
      );
    expect(
      recorder.record(
        pass,
        { ...input, [name]: { ...input[name], offset: device.limits.maxBufferSize } },
        65,
      ).ok,
    ).toBe(false);
  }
  expect(
    recorder.record(pass, { ...input, instances: { ...input.instances, size: 144 } }, 65).ok,
  ).toBe(false);
  expect(
    recorder.record(
      pass,
      {
        ...input,
        instances: { ...input.instances, size: 1025 * 144 },
        bounds: { ...input.bounds, size: 1025 * 48 },
      },
      65,
    ).ok,
  ).toBe(false);
  for (const name of ['instances', 'fields', 'bounds', 'settings'] as const)
    expect(
      recorder.record(
        pass,
        { ...input, voxels: { ...input.voxels, buffer: input[name].buffer } },
        65,
      ).ok,
    ).toBe(false);
  expect(bind).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  recorder.record(pass, input, 65).unwrap();
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(2);
  expect(Array.from(bind.mock.calls[0]?.[0].entries ?? [], (entry) => entry.resource)).toEqual(
    [input.instances, input.fields, input.bounds, input.settings, input.voxels].map((value) => ({
      kind: 'buffer',
      value,
    })),
  );
  expect(create).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  pass.end();
  encoder.finish().unwrap();
  for (const binding of Object.values(input)) device.destroyBuffer(binding.buffer).unwrap();
});

it('rejects unavailable composition limits and preserves the backend binding failure without dispatch', async () => {
  const device = await queryTestDevice();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const limited = (limits: Partial<RhiDevice['limits']>, caps: Partial<RhiDevice['caps']> = {}) => {
    const result: RhiDevice = Object.create(device);
    Object.defineProperty(result, 'limits', { value: { ...device.limits, ...limits } });
    Object.defineProperty(result, 'caps', { value: { ...device.caps, ...caps } });
    return result;
  };
  for (const caps of [{ compute: false }, { storageBuffer: false }])
    expect(globalSdf.createGlobalSdfCompositionRecorder(limited({}, caps), module)).toMatchObject({
      ok: false,
      error: { code: 'rhi-not-available' },
    });
  for (const limits of [
    { maxBindGroups: 0 },
    { maxBindingsPerBindGroup: 4 },
    { maxStorageBuffersPerShaderStage: 3 },
    { maxUniformBuffersPerShaderStage: 0 },
    { maxUniformBufferBindingSize: 47 },
    { maxComputeWorkgroupSizeX: 63 },
    { maxComputeInvocationsPerWorkgroup: 63 },
  ])
    expect(globalSdf.createGlobalSdfCompositionRecorder(limited(limits), module)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  const input = Object.fromEntries(
    Object.entries({ instances: 144, fields: 4, bounds: 48, settings: 48, voxels: 65 * 16 }).map(
      ([name, size]) => [
        name,
        { buffer: device.createBuffer({ size, usage: 0xcc }).unwrap(), size },
      ],
    ),
  ) as unknown as globalSdf.GlobalSdfCompositionInputs;
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  for (const limits of [
    { maxComputeWorkgroupsPerDimension: 1 },
    { maxStorageBufferBindingSize: 1024 },
    { maxBufferSize: 1024 },
  ]) {
    const recorder = globalSdf.createGlobalSdfCompositionRecorder(limited(limits), module).unwrap();
    expect(recorder.record(pass, input, 65)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  }
  const recorder = globalSdf.createGlobalSdfCompositionRecorder(device, module).unwrap();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected backend binding rejection',
    hint: 'repair the supplied range',
  });
  const binding = vi.spyOn(device, 'createBindGroup').mockReturnValueOnce(err(failure));
  expect(recorder.record(pass, input, 65)).toEqual(err(failure));
  expect(device.totalDispatchCount).toBe(0);
  binding.mockRestore();
  pass.end();
  encoder.finish().unwrap();
  for (const value of Object.values(input)) device.destroyBuffer(value.buffer).unwrap();
});

it('keeps reference helper admission and cleanup while its encoder path uses the shared recorder', async () => {
  const device = await queryTestDevice();
  const live = () =>
    device.bookkeeper.allRecords().filter((record) => record.kind === 'Buffer' && !record.destroyed)
      .length;
  const grid = {
    origin: [0, 0, 0] as const,
    dimensions: [1, 1, 1] as const,
    spacing: 1,
    maxDistance: 2,
    coverageDistance: 0.5,
  };
  const shader = vi.fn(createShaderModule);
  const composition = (
    await globalSdf.createGlobalSdfComposition(device, shader, [], grid)
  ).unwrap();
  expect(shader.mock.calls[0]?.[1].code).toBe(globalSdf.GLOBAL_SDF_COMPOSE_WGSL);
  expect(live()).toBe(5);
  const encoder = device.createCommandEncoder({}).unwrap();
  const begin = vi.spyOn(encoder, 'beginComputePass');
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected borrowed composition rejection',
    hint: 'retry the same frozen source',
  });
  vi.spyOn(device, 'createBindGroup').mockReturnValueOnce(err(failure));
  expect(composition.record(encoder)).toEqual(err(failure));
  expect(begin).toHaveBeenCalledOnce();
  composition.record(encoder).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  expect(device.totalDispatchCount).toBe(1);
  composition.dispose();
  expect(live()).toBe(0);
  const unsupported: RhiDevice = Object.create(device);
  Object.defineProperty(unsupported, 'caps', { value: { ...device.caps, compute: false } });
  expect(
    await globalSdf.createGlobalSdfComposition(unsupported, createShaderModule, [], grid),
  ).toMatchObject({ ok: false, error: { code: 'rhi-not-available' } });
  expect(live()).toBe(0);
});
