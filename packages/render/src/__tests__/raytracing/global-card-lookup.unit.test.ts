import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import * as globalCards from '../../raytracing/global-card-lookup';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import { createGlobalSdfQuery } from '../../raytracing/global-sdf-query';
import { CARD_TEXTURES, type SurfaceCapture } from '../../raytracing/surface-cards';
import { queryTestDevice } from './global-sdf-query-device.fixture';

async function cardDevice() {
  const device = await queryTestDevice();
  Object.assign(device.limits, { maxSampledTexturesPerShaderStage: 16 });
  return device;
}

function cardInputs(device: RhiDevice, rayCount = 65): globalCards.GlobalSdfCardLookupInputs {
  const input = Object.fromEntries(
    Object.entries({
      hits: rayCount * 64,
      instances: 288,
      fields: 256,
      bounds: 96,
      grid: 48,
      candidates: rayCount * 32,
      cards: 160,
      output: rayCount * 4 * 112,
      settings: 16,
    }).map(([name, size]) => [
      name,
      {
        buffer: device.createBuffer({ size: size + 512, usage: 0xcc }).unwrap(),
        offset: 256,
        size,
      },
    ]),
  );
  const textures = Object.fromEntries(
    CARD_TEXTURES.map((name) => {
      const texture = device
        .createTexture({
          size: [4, 4],
          format: name === 'depth' ? 'depth32float' : 'rgba16float',
          usage: 4,
        })
        .unwrap();
      return [name, device.createTextureView(texture, {}).unwrap()];
    }),
  );
  return { ...input, textures } as unknown as globalCards.GlobalSdfCardLookupInputs;
}

const buffers = [
  'hits',
  'instances',
  'fields',
  'bounds',
  'grid',
  'candidates',
  'cards',
  'output',
  'settings',
] as const;
const stages = ['selectCandidates', 'sampleCards'] as const;

it('records both Card kernels into borrowed passes and exact ranges without owning producer work', async () => {
  expect(globalCards.createGlobalSdfCardLookupRecorder).toBeTypeOf('function');
  const device = await cardDevice();
  const module = (
    await createShaderModule(device, { code: globalCards.GLOBAL_SDF_CARD_LOOKUP_WGSL })
  ).unwrap();
  const input = cardInputs(device);
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  const create = vi.spyOn(device, 'createBuffer');
  const view = vi.spyOn(device, 'createTextureView');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const submit = vi.spyOn(device.queue, 'submit');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const layout = vi.spyOn(device, 'createBindGroupLayout');
  const bind = vi.spyOn(device, 'createBindGroup');
  const dispatch = vi.spyOn(pass, 'dispatchWorkgroups');
  const end = vi.spyOn(pass, 'end');
  const recorder = globalCards.createGlobalSdfCardLookupRecorder(device, module).unwrap();
  // Freeze the existing WGSL binding ABI independently of recorder table order.
  expect(Array.from(layout.mock.calls[0]?.[0].entries ?? [])).toEqual([
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 64 } },
    { binding: 1, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 144 } },
    { binding: 2, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 4 } },
    { binding: 3, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 48 } },
    { binding: 4, visibility: 4, buffer: { type: 'uniform', minBindingSize: 48 } },
    { binding: 5, visibility: 4, buffer: { type: 'storage', minBindingSize: 32 } },
    { binding: 6, visibility: 4, buffer: { type: 'read-only-storage', minBindingSize: 80 } },
    { binding: 7, visibility: 4, buffer: { type: 'storage', minBindingSize: 112 } },
    { binding: 8, visibility: 4, buffer: { type: 'uniform', minBindingSize: 16 } },
    { binding: 9, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
    { binding: 10, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
    { binding: 11, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
    { binding: 12, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
    { binding: 13, visibility: 4, texture: { sampleType: 'depth' } },
  ]);
  for (const stage of stages) recorder.record(pass, input, 65, stage).unwrap();
  expect(dispatch.mock.calls).toEqual([[2], [2]]);
  expect(Array.from(bind.mock.calls[0]?.[0].entries ?? [], (entry) => entry.resource)).toEqual([
    ...buffers.map((name) => ({ kind: 'buffer', value: input[name] })),
    ...CARD_TEXTURES.map((name) => ({ kind: 'textureView', value: input.textures[name] })),
  ]);
  // Reference compositions expose an opaque field-pool buffer without its capacity.
  // Omitted size retains native whole-buffer semantics; RHI validates the real tail.
  recorder
    .record(pass, { ...input, fields: { buffer: input.fields.buffer } }, 65, stages[0])
    .unwrap();
  const entries = Array.from(bind.mock.calls[2]?.[0].entries ?? []);
  expect(entries[2]?.resource).toEqual({ kind: 'buffer', value: { buffer: input.fields.buffer } });
  for (const spy of [create, view, write, submit, destroy, end]) expect(spy).not.toHaveBeenCalled();
  pass.end();
  encoder.finish().unwrap();
});

it('rejects invalid counts, layouts, offsets and output aliases before either Card dispatch', async () => {
  const device = await cardDevice();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const input = cardInputs(device);
  const recorder = globalCards.createGlobalSdfCardLookupRecorder(device, module).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  const bind = vi.spyOn(device, 'createBindGroup');
  const dispatch = vi.spyOn(pass, 'dispatchWorkgroups');
  for (const stage of stages) {
    for (const count of [0, -1, 1.5, NaN, Infinity, 65537])
      expect(recorder.record(pass, input, count, stage).ok).toBe(false);
    for (const name of buffers) {
      for (const offset of [-1, 1, NaN, Infinity, 256.5])
        expect(
          recorder.record(pass, { ...input, [name]: { ...input[name], offset } }, 65, stage).ok,
        ).toBe(false);
      for (const size of [0, -1, (input[name].size ?? 0) - 1, NaN, Infinity])
        expect(
          recorder.record(pass, { ...input, [name]: { ...input[name], size } }, 65, stage).ok,
        ).toBe(false);
      expect(
        recorder.record(
          pass,
          { ...input, [name]: { ...input[name], offset: device.limits.maxBufferSize } },
          65,
          stage,
        ).ok,
      ).toBe(false);
    }
    for (const output of ['candidates', 'output'] as const) {
      for (const name of buffers.filter((name) => name !== output))
        expect(
          recorder.record(
            pass,
            { ...input, [output]: { ...input[output], buffer: input[name].buffer } },
            65,
            stage,
          ).ok,
        ).toBe(false);
      expect(
        recorder.record(
          pass,
          { ...input, fields: { buffer: input[output].buffer, offset: 0 } },
          65,
          stage,
        ).ok,
      ).toBe(false);
    }
    expect(
      recorder.record(pass, { ...input, instances: { ...input.instances, size: 144 } }, 65, stage)
        .ok,
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
        stage,
      ).ok,
    ).toBe(false);
  }
  expect(bind).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  pass.end();
  encoder.finish().unwrap();
});

it('preserves capability, device-limit and backend binding failures without dispatching Card work', async () => {
  const device = await cardDevice();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const limited = (limits: Partial<RhiDevice['limits']>, caps: Partial<RhiDevice['caps']> = {}) => {
    const result: RhiDevice = Object.create(device);
    Object.defineProperty(result, 'limits', { value: { ...device.limits, ...limits } });
    Object.defineProperty(result, 'caps', { value: { ...device.caps, ...caps } });
    return result;
  };
  for (const caps of [{ compute: false }, { storageBuffer: false }])
    expect(globalCards.createGlobalSdfCardLookupRecorder(limited({}, caps), module)).toMatchObject({
      ok: false,
      error: { code: 'rhi-not-available' },
    });
  for (const limits of [
    { maxBindGroups: 0 },
    { maxBindingsPerBindGroup: 13 },
    { maxStorageBuffersPerShaderStage: 6 },
    { maxUniformBuffersPerShaderStage: 1 },
    { maxSampledTexturesPerShaderStage: 4 },
    { maxUniformBufferBindingSize: 47 },
    { maxComputeWorkgroupSizeX: 63 },
    { maxComputeInvocationsPerWorkgroup: 63 },
  ])
    expect(globalCards.createGlobalSdfCardLookupRecorder(limited(limits), module)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  const input = cardInputs(device);
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginComputePass({});
  for (const limits of [
    { maxComputeWorkgroupsPerDimension: 1 },
    { maxStorageBufferBindingSize: 1024 },
    { maxBufferSize: 1024 },
  ]) {
    const recorder = globalCards
      .createGlobalSdfCardLookupRecorder(limited(limits), module)
      .unwrap();
    for (const stage of stages)
      expect(recorder.record(pass, input, 65, stage)).toMatchObject({
        ok: false,
        error: { code: 'limit-exceeded' },
      });
  }
  const recorder = globalCards.createGlobalSdfCardLookupRecorder(device, module).unwrap();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected Card binding rejection',
    hint: 'repair the producer range',
  });
  const binding = vi.spyOn(device, 'createBindGroup');
  for (const stage of stages) {
    binding.mockReturnValueOnce(err(failure));
    expect(recorder.record(pass, input, 65, stage)).toEqual(err(failure));
  }
  expect(device.totalDispatchCount).toBe(0);
  pass.end();
  encoder.finish().unwrap();
});

it('reuses the recorder in the reference helper and closes passes and allocations on failure', async () => {
  const device = await cardDevice();
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed).length;
  const composition = (
    await createGlobalSdfComposition(device, createShaderModule, [], {
      origin: [-2, -2, -2],
      dimensions: [4, 4, 4],
      spacing: 1,
      maxDistance: 2,
      coverageDistance: 0.5,
    })
  ).unwrap();
  const query = (
    await createGlobalSdfQuery(device, createShaderModule, composition, [
      {
        origin: [0, 0, 0],
        direction: [1, 0, 0],
        tMin: 0,
        tMax: 1,
        mask: 255,
      },
    ])
  ).unwrap();
  const textures = Object.fromEntries(
    CARD_TEXTURES.map((name) => [
      name,
      device
        .createTexture({
          size: [4, 4],
          format: name === 'depth' ? 'depth32float' : 'rgba16float',
          usage: 4,
        })
        .unwrap(),
    ]),
  );
  // An empty admitted capture needs only its existing padding projection row.
  const cache = {
    kind: 'cards',
    resolution: 4,
    entries: [],
    textures,
  } as unknown as SurfaceCapture;
  const baseline = live();
  const compile = vi.fn(createShaderModule);
  const lookup = (
    await globalCards.createGlobalSdfCardLookup(device, compile, composition, query, cache, [])
  ).unwrap();
  expect(compile.mock.calls[0]?.[1].code).toBe(globalCards.GLOBAL_SDF_CARD_LOOKUP_WGSL);
  expect(live()).toBe(baseline + 4);
  const encoder = device.createCommandEncoder({}).unwrap();
  const originalBegin = encoder.beginComputePass.bind(encoder);
  const ended: ReturnType<typeof vi.spyOn>[] = [];
  const begin = vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
    const pass = originalBegin(descriptor);
    ended.push(vi.spyOn(pass, 'end'));
    return pass;
  });
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected reference Card binding failure',
    hint: 'repair the borrowed field range',
  });
  const binding = vi.spyOn(device, 'createBindGroup').mockReturnValueOnce(err(failure));
  expect(lookup.record(encoder)).toEqual(err(failure));
  expect(begin).toHaveBeenCalledOnce();
  expect(ended[0]).toHaveBeenCalledOnce();
  expect(device.totalDispatchCount).toBe(0);
  lookup.record(encoder).unwrap();
  expect(begin.mock.calls.slice(1).map(([descriptor]) => descriptor?.label)).toEqual([
    'global-sdf.cards.selectCandidates',
    'global-sdf.cards.sampleCards',
  ]);
  expect(ended.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  expect(device.totalDispatchCount).toBe(2);
  lookup.dispose();
  lookup.dispose();
  expect(live()).toBe(baseline);
  expect(lookup.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  binding.mockRestore();
  const unsupported: RhiDevice = Object.create(device);
  Object.defineProperty(unsupported, 'caps', { value: { ...device.caps, compute: false } });
  expect(
    await globalCards.createGlobalSdfCardLookup(
      unsupported,
      createShaderModule,
      composition,
      query,
      cache,
      [],
    ),
  ).toMatchObject({ ok: false, error: { code: 'rhi-not-available' } });
  expect(live()).toBe(baseline);
  query.dispose();
  composition.dispose();
  expect(live()).toBe(0);
  for (const texture of Object.values(textures)) device.destroyTexture(texture).unwrap();
});
