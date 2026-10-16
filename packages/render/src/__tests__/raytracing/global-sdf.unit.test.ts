import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { createGlobalSdfComposition, type GlobalSdfGrid } from '../../raytracing/global-sdf';
import {
  createGlobalSdfQuery,
  createGlobalSdfQueryRecorder,
} from '../../raytracing/global-sdf-query';
import { createSdfQuery, sdfInstanceKey } from '../../raytracing/sdf-query';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

it('freezes local query identity and cardinality before asynchronous compilation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const source = [{ instanceId: 7, geometryId: 9, mask: 255, transform, field }];
  const rays = [
    { origin: [0, 2, 0] as const, direction: [0, -1, 0] as const, tMin: 0, tMax: 4, mask: 255 },
  ];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = createSdfQuery(
    device,
    async (d, desc) => {
      await gate;
      return createShaderModule(d, desc);
    },
    source,
    rays,
  );
  source.length = 0;
  const first = rays[0];
  assert(first);
  rays.push(...Array.from({ length: 64 }, () => first));
  assert(release);
  release();
  const query = (await pending).unwrap();
  try {
    expect(query.sources.map((s) => s.instanceId)).toEqual([7]);
    expect(query.rayCount).toBe(1);
  } finally {
    query.dispose();
  }
});

it('bounds global composition inputs, freezes async preparation and releases every owned buffer', async () => {
  const device = await queryTestDevice();
  assert(device instanceof RhiNullDevice);
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const source = { instanceId: 7, geometryId: 9, mask: 255, transform, field };
  const origin: [number, number, number] = [-2, -2, -2];
  const grid: GlobalSdfGrid = {
    origin,
    dimensions: [9, 9, 9],
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.25,
  };
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed);
  for (const invalid of [
    { ...grid, spacing: 0 },
    { ...grid, spacing: 1e-50 },
    { ...grid, maxDistance: Infinity },
    { ...grid, coverageDistance: 3 },
    { ...grid, coverageDistance: -1 },
    { ...grid, dimensions: [129, 9, 9] as const },
    { ...grid, dimensions: [1, 0, 1] as const },
    { ...grid, origin: [1e20, 0, 0] as const },
    { ...grid, origin: [8388607, 0, 0] as const },
  ])
    expect(
      (await createGlobalSdfComposition(device, createShaderModule, [source], invalid)).ok,
    ).toBe(false);
  const shear = [...transform];
  shear[4] = 0.5;
  expect(
    (
      await createGlobalSdfComposition(
        device,
        createShaderModule,
        [{ ...source, transform: shear }],
        grid,
      )
    ).ok,
  ).toBe(false);
  expect(live()).toHaveLength(0);
  expect(
    (
      await createGlobalSdfComposition(
        device,
        createShaderModule,
        Array.from({ length: 1025 }, (_, instanceId) => ({ ...source, instanceId })),
        grid,
      )
    ).ok,
  ).toBe(false);
  const many = (
    await createGlobalSdfComposition(
      device,
      createShaderModule,
      Array.from({ length: 65 }, (_, instanceId) => ({ ...source, instanceId })),
      grid,
    )
  ).unwrap();
  expect(many.sources).toHaveLength(65);
  many.dispose();
  expect(live()).toHaveLength(0);
  const failure = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected compile failure',
        hint: 'retry compilation',
      }),
    );
  expect((await createGlobalSdfComposition(device, failure, [source], grid)).ok).toBe(false);
  expect(live()).toHaveLength(0);
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const oldKey = sdfInstanceKey(source);
  const pending = createGlobalSdfComposition(
    device,
    async (d, desc) => {
      await gate;
      return createShaderModule(d, desc);
    },
    [source],
    grid,
  );
  transform[12] = 20;
  origin[0] = 99;
  assert(complete);
  complete();
  const built = (await pending).unwrap();
  expect(built.sources[0]?.key).toBe(oldKey);
  expect(built.grid.origin[0]).toBe(-2);
  expect(built.voxelCount).toBe(729);
  expect(live()).toHaveLength(5);
  const encoder = device.createCommandEncoder({}).unwrap();
  expect(built.record(encoder).ok).toBe(true);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  built.dispose();
  built.dispose();
  expect(live()).toHaveLength(0);
  expect(built.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
});

it('keeps global query resource ownership and mask admission at the composed-region boundary', async () => {
  const device = await queryTestDevice();
  assert(device instanceof RhiNullDevice);
  const grid: GlobalSdfGrid = {
    origin: [-3, -3, -3],
    dimensions: [13, 13, 13],
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.5,
  };
  const composition = (
    await createGlobalSdfComposition(device, createShaderModule, [], grid)
  ).unwrap();
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed);
  const ray = {
    origin: [0, 0, 0] as const,
    direction: [0, 1, 0] as const,
    tMin: 0,
    tMax: 2,
    mask: 255,
  };
  const baseline = live().length;
  for (const maxSteps of [0, -1, 1.5, 1025, Infinity])
    expect(
      (await createGlobalSdfQuery(device, createShaderModule, composition, [ray], { maxSteps })).ok,
    ).toBe(false);
  for (const minStepFactor of [0, -1, 1.1, Number.NaN, Infinity, 1e-50])
    expect(
      (
        await createGlobalSdfQuery(device, createShaderModule, composition, [ray], {
          minStepFactor,
        })
      ).ok,
    ).toBe(false);
  expect(
    (await createGlobalSdfQuery(device, createShaderModule, composition, [{ ...ray, mask: 1 }])).ok,
  ).toBe(false);
  for (const invalid of [
    { ...ray, direction: [1e-40, 0, 0] as const },
    { ...ray, direction: [3e38, 3e38, 0] as const },
    { ...ray, direction: [2e38, 0, 0] as const },
    { ...ray, origin: [3e38, 0, 0] as const, direction: [1e38, 0, 0] as const },
  ])
    expect(
      (await createGlobalSdfQuery(device, createShaderModule, composition, [invalid])).ok,
    ).toBe(false);
  const small = (
    await createGlobalSdfComposition(device, createShaderModule, [], {
      ...grid,
      dimensions: [1, 1, 1],
    })
  ).unwrap();
  expect((await createGlobalSdfQuery(device, createShaderModule, small, [ray])).ok).toBe(false);
  small.dispose();
  expect(live()).toHaveLength(baseline);
  const fail = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected compile failure',
        hint: 'retry',
      }),
    );
  expect((await createGlobalSdfQuery(device, fail, composition, [ray])).ok).toBe(false);
  expect(live()).toHaveLength(baseline);
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const mutableRays = [{ ...ray }];
  const pending = createGlobalSdfQuery(
    device,
    async (d, desc) => {
      await gate;
      return createShaderModule(d, desc);
    },
    composition,
    mutableRays,
  );
  assert(mutableRays[0]);
  mutableRays[0].mask = 1;
  mutableRays.push({ ...ray });
  assert(complete);
  complete();
  const query = (await pending).unwrap();
  expect(query.rayCount).toBe(1);
  expect(query.buffers.voxels).toBe(composition.buffers.voxels);
  expect(query.buffers.grid).toBe(composition.buffers.settings);
  expect(live()).toHaveLength(baseline + 3);
  const e = device.createCommandEncoder({}).unwrap();
  composition.record(e).unwrap();
  query.record(e).unwrap();
  device.queue.submit([e.finish().unwrap()]).unwrap();
  query.dispose();
  query.dispose();
  expect(live()).toHaveLength(baseline);
  expect(query.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  const after = device.createCommandEncoder({}).unwrap();
  composition.record(after).unwrap();
  device.queue.submit([after.finish().unwrap()]).unwrap();
  composition.dispose();
  expect(live()).toHaveLength(0);
});

it('records only exact aligned borrowed query ranges without writing, submitting or releasing them', async () => {
  const device = await queryTestDevice();
  const recorder = createGlobalSdfQueryRecorder(
    device,
    (await createShaderModule(device, { code: '' })).unwrap(),
  ).unwrap();
  const range = (size: number) => ({
    buffer: device.createBuffer({ size: size + 512, usage: 0xcc }).unwrap(),
    offset: 256,
    size,
  });
  const input = {
    voxels: range(64 * 16),
    grid: range(48),
    rays: range(65 * 48),
    hits: range(65 * 64),
    settings: range(16),
  };
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const submit = vi.spyOn(device.queue, 'submit');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const bind = vi.spyOn(device, 'createBindGroup');
  const dispatch = vi.spyOn(pass, 'dispatchWorkgroups');
  for (const count of [0, -1, 1.5, NaN, Infinity, 65537])
    expect(recorder.record(pass, input, count).ok).toBe(false);
  for (const name of ['voxels', 'grid', 'rays', 'hits', 'settings'] as const) {
    for (const offset of [-1, 1, NaN, Infinity, 256.5])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], offset } }, 65).ok).toBe(
        false,
      );
    for (const size of [0, input[name].size - 1, NaN, Infinity])
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
  for (const name of ['voxels', 'grid', 'rays', 'settings'] as const)
    expect(
      recorder.record(pass, { ...input, hits: { ...input.hits, buffer: input[name].buffer } }, 65)
        .ok,
    ).toBe(false);
  expect(bind).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  recorder.record(pass, input, 65).unwrap();
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(2);
  expect(Array.from(bind.mock.calls[0]?.[0].entries ?? [], (entry) => entry.resource)).toEqual(
    [input.voxels, input.grid, input.rays, input.hits, input.settings].map((value) => ({
      kind: 'buffer',
      value,
    })),
  );
  expect(write).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  pass.end();
  for (const binding of Object.values(input)) device.destroyBuffer(binding.buffer).unwrap();
});

it('checks query capabilities and limits before dispatch and cleans owned buffers on failure', async () => {
  const device = await queryTestDevice();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const limited = (limits: Partial<RhiDevice['limits']>, caps: Partial<RhiDevice['caps']> = {}) => {
    const result: RhiDevice = Object.create(device);
    Object.defineProperty(result, 'limits', { value: { ...device.limits, ...limits } });
    Object.defineProperty(result, 'caps', { value: { ...device.caps, ...caps } });
    return result;
  };
  for (const caps of [{ compute: false }, { storageBuffer: false }])
    expect(createGlobalSdfQueryRecorder(limited({}, caps), module)).toMatchObject({
      ok: false,
      error: { code: 'rhi-not-available' },
    });
  for (const limits of [
    { maxBindGroups: 0 },
    { maxBindingsPerBindGroup: 4 },
    { maxStorageBuffersPerShaderStage: 2 },
    { maxUniformBuffersPerShaderStage: 1 },
    { maxUniformBufferBindingSize: 47 },
    { maxComputeWorkgroupSizeX: 63 },
    { maxComputeInvocationsPerWorkgroup: 63 },
  ])
    expect(createGlobalSdfQueryRecorder(limited(limits), module)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  const composition = (
    await createGlobalSdfComposition(device, createShaderModule, [], {
      origin: [-3, -3, -3],
      dimensions: [13, 13, 13],
      spacing: 0.5,
      maxDistance: 2,
      coverageDistance: 0.5,
    })
  ).unwrap();
  const live = () =>
    device.bookkeeper.allRecords().filter((record) => record.kind === 'Buffer' && !record.destroyed)
      .length;
  const baseline = live();
  expect(
    (
      await createGlobalSdfQuery(limited({}, { compute: false }), createShaderModule, composition, [
        { origin: [0, 2, 0], direction: [0, -1, 0], tMin: 0, tMax: 2, mask: 255 },
      ])
    ).ok,
  ).toBe(false);
  expect(live()).toBe(baseline);
  const buffer = device.createBuffer({ size: 13 ** 3 * 16, usage: 0xcc }).unwrap();
  const input = {
    voxels: { buffer, size: 13 ** 3 * 16 },
    grid: { buffer, size: 48 },
    rays: { buffer, size: 65 * 48 },
    hits: { buffer, size: 65 * 64 },
    settings: { buffer, size: 16 },
  };
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  for (const limits of [
    { maxComputeWorkgroupsPerDimension: 1 },
    { maxStorageBufferBindingSize: 1024 },
    { maxBufferSize: 1024 },
  ]) {
    const query = createGlobalSdfQueryRecorder(limited(limits), module).unwrap();
    expect(query.record(pass, input, 65)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  }
  expect(device.totalDispatchCount).toBe(0);
  pass.end();
  device.destroyBuffer(buffer).unwrap();
  composition.dispose();
});
