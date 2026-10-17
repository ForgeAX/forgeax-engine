import { AssetRegistry, HANDLE_CUBE, RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  RhiError,
} from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry, STANDARD_DIRECT_DFG_LUT_BINDING } from '@forgeax/engine-shader';
import {
  err,
  type Handle,
  type MaterialAsset,
  ok,
  type ParamSchemaEntry,
  type Result,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { DeviceScope } from '../../device/device-scope';
import { createPreparedGraphicsStore } from '../../features/prepared-graphics-store';
import type { RenderFeature } from '../../features/types';
import type { SkylightBindGroupResources } from '../../ibl/skylight-bind-group';
import { createSkylightFallback } from '../../ibl/skylight-bind-group';
import { Materials } from '../../materials';
import { createPreparedGraphicsResolver } from '../../prepare/prepared-graphics-resolver';
import { renderPublicationTransfers } from '../../publication/contract';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import {
  type PreparedMaterialBindingsScope,
  preparedMaterialBindings,
} from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';

function scopedMaterialFixture() {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abf';
  let value = 0.25;
  let reads = 0;
  let generation = 1;
  const material: MaterialAsset = {
    kind: 'material',
    values: {
      get roughness() {
        reads++;
        return value;
      },
    },
  };
  assets.catalog(guid, material);
  const schema: ParamSchemaEntry[] = [
    { name: 'roughness', type: 'f32' },
    { name: 'albedo', type: 'texture2d' },
  ];
  const state = {
    defaultSampler: {},
    defaultWhiteTextureView: {},
    meshStorageBuffer: { buffer: {} },
    skylightFallback: {
      irradianceView: {},
      prefilterView: {},
      brdfLutView: {},
      sampler: {},
      intensityBuffer: {},
    },
  };
  const skylight = {
    irradianceView: {},
    irradianceSampler: {},
    prefilterView: {},
    skylightPrefilterView: {},
    prefilterSampler: {},
    brdfLutView: {},
    intensityBuffer: {},
  } as SkylightBindGroupResources;
  const createBuffer = vi.fn((): Result<Buffer, RhiError> => ok({} as Buffer));
  const destroyBuffer = vi.fn((): Result<void, RhiError> => ok(undefined));
  const createBindGroup = vi.fn(
    (_descriptor: {
      layout: BindGroupLayout;
      entries: readonly BindGroupEntry[];
    }): Result<BindGroup, RhiError> => ok({} as BindGroup),
  );
  const writeBuffer = vi.fn(
    (_buffer: Buffer, _offset: number, _bytes: Uint8Array): Result<void, RhiError> => ok(undefined),
  );
  const device = {
    caps: { storageBuffer: true },
    limits: { maxSampledTexturesPerShaderStage: 16 },
    createBuffer,
    destroyBuffer,
    createBindGroup,
    queue: { writeBuffer },
  };
  const source = {
    assets,
    shaderRegistry: assets.shaderRegistry,
    getParamSchema: () => schema,
    getPipelineState: () => state,
    get deviceScope() {
      return { generation };
    },
    device,
  };
  const runtime = source as unknown as RenderSystemInternals;
  const scope: PreparedMaterialBindingsScope = [];
  const layout = {} as BindGroupLayout;
  const acquire = (rows = scope, owner = world, bindingLayout = layout) => {
    const binding = preparedMaterialBindings(
      runtime,
      [owner],
      'shader',
      0,
      guid,
      bindingLayout,
      skylight,
      rows,
    ).unwrap();
    if (!('release' in binding)) throw new Error('expected a scoped material lease');
    return binding;
  };
  return {
    world,
    guid,
    runtime,
    source,
    state,
    skylight,
    scope,
    layout,
    schema,
    acquire,
    createBuffer,
    destroyBuffer,
    createBindGroup,
    writeBuffer,
    setValue: (next: number) => {
      value = next;
    },
    advanceGeneration: () => {
      generation++;
    },
    reads: () => reads,
  };
}

it('shares only live same-resolver material resources and releases the final borrower once', () => {
  const f = scopedMaterialFixture();
  const before = f.reads();
  const first = f.acquire();
  expect(f.reads()).toBeGreaterThan(before);
  const afterFirst = f.reads();
  const second = f.acquire();
  expect(f.reads()).toBeGreaterThan(afterFirst);
  const afterSecond = f.reads();
  const otherScope: PreparedMaterialBindingsScope = [];
  const inFlight = f.acquire(otherScope);
  expect(f.reads()).toBeGreaterThan(afterSecond);
  expect(first.handle).toBe(second.handle);
  expect(inFlight.handle).not.toBe(first.handle);
  expect(f.createBuffer).toHaveBeenCalledTimes(2);
  expect(f.writeBuffer).toHaveBeenCalledTimes(2);
  expect(f.createBindGroup).toHaveBeenCalledTimes(2);
  expect(first.dynamicOffsets).toEqual([0]);
  first.release().unwrap();
  first.release().unwrap();
  expect(f.destroyBuffer).not.toHaveBeenCalled();
  inFlight.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(1);
  expect(otherScope).toHaveLength(0);
  second.release().unwrap();
  second.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(2);
  expect(f.scope).toHaveLength(0);
  const renewed = f.acquire();
  expect(renewed.handle).not.toBe(first.handle);
  expect(f.createBuffer).toHaveBeenCalledTimes(3);
  renewed.release().unwrap();
});

it('reobserves mutable values and preserves prior borrowers when packed bytes or size change', () => {
  const f = scopedMaterialFixture();
  const first = f.acquire();
  const original = f.writeBuffer.mock.calls[0]?.[2].slice();
  f.setValue(0.75);
  const changed = f.acquire();
  expect(changed.handle).not.toBe(first.handle);
  const unchanged = f.acquire();
  expect(unchanged.handle).toBe(changed.handle);
  expect(f.createBuffer).toHaveBeenCalledTimes(2);
  expect(f.writeBuffer.mock.calls[0]?.[2]).toEqual(original);
  expect(new Float32Array(f.writeBuffer.mock.calls[1]?.[2].buffer ?? new ArrayBuffer(0))[0]).toBe(
    0.75,
  );
  f.schema.push({ name: 'extra', type: 'vec4', default: [1, 2, 3, 4] });
  const resized = f.acquire();
  expect(resized.handle).not.toBe(changed.handle);
  expect(f.writeBuffer.mock.calls[2]?.[2].byteLength).toBeGreaterThan(original?.byteLength ?? 0);
  first.release().unwrap();
  changed.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(1);
  unchanged.release().unwrap();
  resized.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(3);
  expect(f.scope).toHaveLength(0);
});

it('compares actual layout, World, device generation and complete physical material entries', () => {
  const f = scopedMaterialFixture();
  const held = [f.acquire()];
  const replace = (change: () => void) => {
    change();
    const next = f.acquire();
    expect(held.every((binding) => binding.handle !== next.handle)).toBe(true);
    held.push(next);
  };
  replace(() => {
    f.state.defaultSampler = {};
  });
  replace(() => {
    f.state.defaultWhiteTextureView = {};
  });
  replace(() => {
    Object.assign(f.skylight, { skylightPrefilterView: {} });
  });
  replace(() => {
    Object.assign(f.skylight, { intensityBuffer: {} });
  });
  replace(() => {
    f.state.meshStorageBuffer.buffer = {};
  });
  replace(f.advanceGeneration);
  const originalDestroy = f.source.device.destroyBuffer;
  replace(() => {
    f.source.device = {
      ...f.source.device,
      destroyBuffer: vi.fn((): Result<void, RhiError> => ok(undefined)),
    };
  });
  const anotherLayout = f.acquire(f.scope, f.world, {} as BindGroupLayout);
  const anotherWorld = f.acquire(f.scope, new World());
  expect(held.every((binding) => binding.handle !== anotherLayout.handle)).toBe(true);
  expect(held.every((binding) => binding.handle !== anotherWorld.handle)).toBe(true);
  for (const call of f.createBindGroup.mock.calls) {
    const entry = call[0].entries.find((entry) => entry.binding === 47);
    expect(entry?.resource.kind).toBe('textureView');
    expect(call[0].entries.some((entry) => entry.binding === 46)).toBe(true);
  }
  for (const binding of held) binding.release().unwrap();
  expect(originalDestroy).toHaveBeenCalledTimes(held.length - 1);
  anotherLayout.release().unwrap();
  anotherWorld.release().unwrap();
  expect(f.scope).toHaveLength(0);
});

it('keeps shared material resources under the resolver completion and abort leases', () => {
  const f = scopedMaterialFixture();
  const store = createPreparedGraphicsStore();
  const transaction = store.beginFrame('material.scope', 1);
  const pipeline = transaction
    .prepare('pipeline', 'p', {
      shader: 'shader',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    })
    .unwrap();
  const refs = ['a', 'b'].map((name) =>
    transaction
      .prepare('bindings', name, {
        pipeline,
        values: { group: 1, material: { world: 0, guid: f.guid } },
      })
      .unwrap(),
  );
  const resolver = createPreparedGraphicsResolver({
    device: f.runtime.device,
    generation: 1,
    capabilityAvailable: true,
    lookup: (reference) => transaction.lookup(reference),
    resolvePipeline: () => ok({} as RenderPipeline),
    resolveBindings: () => ok(f.acquire()),
  });
  const resolved = refs.map((reference) => resolver.resolve(reference).unwrap());
  expect(resolved[0]?.handle).toBe(resolved[1]?.handle);
  expect(f.createBuffer).toHaveBeenCalledTimes(1);
  expect(resolver.leases).toHaveLength(2);
  resolver.leases[0]?.release().unwrap();
  expect(f.destroyBuffer).not.toHaveBeenCalled();
  transaction.abort();
  resolver.release().unwrap();
  resolver.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(1);
  expect(f.scope).toHaveLength(0);
});

it('never publishes a failed material creation into the resolver scope', () => {
  const f = scopedMaterialFixture();
  const error = new RhiError({
    code: 'rhi-not-available',
    expected: 'test failure',
    hint: 'retry',
  });
  f.writeBuffer.mockReturnValueOnce(err(error));
  expect(
    preparedMaterialBindings(
      f.runtime,
      [f.world],
      'shader',
      0,
      f.guid,
      f.layout,
      f.skylight,
      f.scope,
    ).ok,
  ).toBe(false);
  expect(f.createBindGroup).not.toHaveBeenCalled();
  expect(f.scope).toHaveLength(0);
  expect(f.destroyBuffer).toHaveBeenCalledTimes(1);
  f.createBindGroup.mockReturnValueOnce(err(error));
  expect(
    preparedMaterialBindings(
      f.runtime,
      [f.world],
      'shader',
      0,
      f.guid,
      f.layout,
      f.skylight,
      f.scope,
    ).ok,
  ).toBe(false);
  expect(f.scope).toHaveLength(0);
  expect(f.destroyBuffer).toHaveBeenCalledTimes(2);
  const recovered = f.acquire();
  expect(f.scope).toHaveLength(1);
  recovered.release().unwrap();
  expect(f.destroyBuffer).toHaveBeenCalledTimes(3);
});

it('uploads accepted values on World and published-reader paths without mutating the base', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abc';
  const base: MaterialAsset = { kind: 'material', values: { roughness: 0.8 } };
  assets.catalog(guid, base);
  const handle = world.internSharedRef('MaterialAsset', base);
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'roughness', kind: 0, value: [0.25] },
    })
    .unwrap();
  const uploads: number[] = [];
  let destroys = 0;
  const runtime = {
    assets,
    getParamSchema: () => [{ name: 'roughness', type: 'f32' }],
    getPipelineState: () => ({
      defaultSampler: {},
      skylightFallback: {
        irradianceView: {},
        prefilterView: {},
        brdfLutView: {},
        sampler: {},
        intensityBuffer: {},
      },
    }),
    device: {
      caps: { storageBuffer: false },
      limits: { maxSampledTexturesPerShaderStage: 16 },
      createBuffer: () => ok({}),
      destroyBuffer: () => {
        destroys++;
        return ok(undefined);
      },
      createBindGroup: () => ok({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, bytes: Uint8Array) => {
          uploads.push(new Float32Array(bytes.buffer, bytes.byteOffset, 1)[0] ?? NaN);
          return ok(undefined);
        },
      },
    },
  } as unknown as RenderSystemInternals;
  const identity = { source: 'material-values', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [
    {
      identity: 'material-consumer',
      extract: () => ok({}),
      assetDependencies: () => [guid],
      plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    },
  ]);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const resources = receiver.accept(packet).unwrap().resources;
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return resources;
  };
  const reader = publish();
  for (const source of [world, reader]) {
    const bindings = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    if ('release' in bindings) bindings.release?.();
  }
  expect(uploads).toEqual([0.25, 0.25]);
  expect(base.values?.roughness).toBe(0.8);
  const other = new World();
  const otherHandle = other.internSharedRef('MaterialAsset', base);
  const otherContent = other
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: otherHandle,
        parameter: 'roughness',
        kind: 0,
        value: [0.6],
      },
    })
    .unwrap();
  for (const [owner, expected] of [
    [1, 0.6],
    [0, 0.25],
  ] as const) {
    const bindings = preparedMaterialBindings(
      runtime,
      [world, other],
      'shader',
      owner,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(expected);
    if ('release' in bindings) bindings.release?.();
  }
  other.despawn(otherContent).unwrap();
  world.despawn(content).unwrap();
  for (const source of [world, publish()]) {
    const restored = preparedMaterialBindings(
      runtime,
      [source],
      'shader',
      0,
      guid,
      {} as BindGroupLayout,
    ).unwrap();
    expect(uploads.at(-1)).toBeCloseTo(0.8);
    if ('release' in restored) restored.release?.();
  }
  expect(destroys).toBe(6);
  publisher.dispose();
});

it('binds the shared direct DFG texture for prepared feature materials and renews it after recovery', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const guid = '12345678-1234-1234-1234-123456789abe';
  const material: MaterialAsset = { kind: 'material', values: { directMultiscatteringLut: 1 } };
  assets.catalog(guid, material);
  const fallback = createSkylightFallback(device, device.queue);
  const storage = device.createBuffer({ size: 256, usage: 128 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  let scope = DeviceScope.create(1, 'prepared-dfg');
  let lut = false;
  const runtime = {
    assets,
    device,
    get deviceScope() {
      return scope;
    },
    getParamSchema: () =>
      lut ? [{ name: 'directMultiscatteringLut', type: 'u32', default: 1 }] : [],
    getPipelineState: () => ({
      defaultSampler: fallback.sampler,
      skylightFallback: fallback,
      meshStorageBuffer: { buffer: storage },
    }),
  } as unknown as RenderSystemInternals;
  const groups = vi.spyOn(device, 'createBindGroup');
  const upload = vi.spyOn(device.queue, 'writeTexture');
  const prepare = () => {
    const result = preparedMaterialBindings(
      runtime,
      [world],
      'game::prepared-dfg',
      0,
      guid,
      layout,
    ).unwrap();
    const entry = Array.from(groups.mock.calls.at(-1)?.[0].entries ?? []).find(
      (binding) => binding.binding === STANDARD_DIRECT_DFG_LUT_BINDING,
    );
    if ('release' in result) result.release?.();
    return entry?.resource;
  };
  expect(prepare()).toBeUndefined();
  expect(upload).not.toHaveBeenCalled();
  lut = true;
  const first = prepare();
  expect(first).toMatchObject({ kind: 'textureView' });
  expect(prepare()).toEqual(first);
  expect(upload).toHaveBeenCalledTimes(1);
  scope.dispose();
  scope = DeviceScope.create(2, 'prepared-dfg');
  expect(prepare()).not.toEqual(first);
  expect(upload).toHaveBeenCalledTimes(2);
  scope.dispose();
  for (const texture of [
    fallback.irradianceTexture,
    fallback.prefilterTexture,
    fallback.brdfLutTexture,
  ])
    device.destroyTexture(texture).unwrap();
  device.destroyBuffer(fallback.intensityBuffer).unwrap();
  device.destroyBuffer(storage).unwrap();
});

for (const [cause, owner, materialGuid, expected] of [
  ['world', -1, '12345678-1234-1234-1234-123456789abf', 'source-world-unavailable'],
  ['handle', 0, '12345678-1234-1234-1234-123456789abc', 'guid-handle-unavailable'],
  ['pipeline', 0, '12345678-1234-1234-1234-123456789abf', 'pipeline-state-unavailable'],
] as const) {
  it(`distinguishes prepared material ${cause} unavailability at the actual binding owner`, () => {
    const fixture = scopedMaterialFixture();
    if (cause === 'pipeline') fixture.source.getPipelineState = () => null as never;
    const result = preparedMaterialBindings(
      fixture.runtime,
      [fixture.world],
      'shader',
      owner,
      materialGuid,
      fixture.layout,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected admission failure');
    expect(result.error.message).toContain(expected);
    expect(result.error.message).toContain(`world=${owner}`);
    expect(result.error.message).toContain(materialGuid);
    expect(fixture.createBuffer).not.toHaveBeenCalled();
    expect(fixture.createBindGroup).not.toHaveBeenCalled();
  });
}
it('distinguishes an accepted GUID that resolves to a non-material payload', () => {
  const fixture = scopedMaterialFixture();
  const wrong = new World();
  const handle = wrong.allocSharedRef('TextureAsset', { kind: 'texture' } as never);
  const scope = { handleForGuid: () => handle, resolveAsset: () => ok({ kind: 'texture' }) };
  const result = preparedMaterialBindings(
    fixture.runtime,
    [scope as never],
    'shader',
    0,
    fixture.guid,
    fixture.layout,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected admission failure');
  expect(result.error.message).toContain('asset-kind-mismatch:texture');
  expect(result.error.message).toContain(fixture.guid);
  expect(fixture.createBuffer).not.toHaveBeenCalled();
  expect(fixture.createBindGroup).not.toHaveBeenCalled();
});
it('does not invoke borrowed invalid-kind formatting while explaining admission failure', () => {
  const fixture = scopedMaterialFixture();
  const stringify = vi.fn(() => {
    throw new Error('borrowed toString must not run');
  });
  const scope = {
    handleForGuid: () => 1,
    resolveAsset: () => ok({ kind: { toString: stringify } }),
  };
  const result = preparedMaterialBindings(
    fixture.runtime,
    [scope as never],
    'shader',
    0,
    fixture.guid,
    fixture.layout,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected admission failure');
  expect(result.error.message).toContain('asset-kind-mismatch:object');
  expect(stringify).not.toHaveBeenCalled();
});

function lastUploadedRoughness(fixture: ReturnType<typeof scopedMaterialFixture>): number {
  const bytes = fixture.writeBuffer.mock.lastCall?.[2];
  if (bytes === undefined) throw new Error('Expected material UBO upload');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

it('binds the captured material handle when its GUID alias was retired', () => {
  const f = scopedMaterialFixture();
  const material: MaterialAsset = { kind: 'material', values: { roughness: 0.75 } };
  const handle = f.world.allocSharedRef('MaterialAsset', material);
  const byGuid = vi.fn(() => undefined);
  const resourceScope = {
    handleForGuid: byGuid,
    resolveAsset: (value: Handle<string, 'shared'>) =>
      value === handle ? ok(material) : err(new Error('stale captured material handle')),
  };
  const binding = preparedMaterialBindings(
    f.runtime,
    [resourceScope as never],
    'shader',
    0,
    f.guid,
    f.layout,
    f.skylight,
    f.scope,
    handle,
  ).unwrap();
  expect(byGuid).not.toHaveBeenCalled();
  expect(lastUploadedRoughness(f)).toBe(0.75);
  if ('release' in binding) binding.release?.();
});

it('rejects a stale captured material handle instead of selecting a different GUID alias', () => {
  const f = scopedMaterialFixture();
  const material: MaterialAsset = { kind: 'material', values: { roughness: 0.75 } };
  const replacement = f.world.allocSharedRef('MaterialAsset', material);
  const stale = (Number(replacement) + 1) as Handle<'MaterialAsset', 'shared'>;
  const byGuid = vi.fn(() => replacement);
  const resourceScope = {
    handleForGuid: byGuid,
    resolveAsset: (value: Handle<string, 'shared'>) =>
      value === replacement ? ok(material) : err(new Error('stale captured material handle')),
  };
  const binding = preparedMaterialBindings(
    f.runtime,
    [resourceScope as never],
    'shader',
    0,
    f.guid,
    f.layout,
    f.skylight,
    f.scope,
    stale,
  );
  expect(binding.ok).toBe(false);
  if (binding.ok) throw new Error('Expected stale reference failure');
  expect(binding.error.message).toContain('stale captured material handle');
  expect(byGuid).not.toHaveBeenCalled();
  expect(f.createBindGroup).not.toHaveBeenCalled();
});

it('keeps an exact feature material snapshot after a different same-GUID ordinary alias retires', () => {
  const f = scopedMaterialFixture();
  const guid = 'c1234567-1234-4234-8234-123456789abc';
  const material: MaterialAsset = Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.75 });
  f.source.assets.catalog(guid, material).unwrap();
  const feature: RenderFeature<{ handle: Handle<string, 'shared'> | undefined }> = {
    identity: 'exact-material-owner',
    extract: (context) => ok({ handle: context.referenceAsset?.(0, guid, material) }),
    assetDependencies: (data) => (data.handle === undefined ? [guid] : [guid, data.handle]),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
  };
  const identity = { source: 'exact-material-retirement', epoch: 1 };
  const publisher = createRenderPublisher(f.world, f.source.assets, identity, undefined, [feature]);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { packet, resources: accepted.resources };
  };
  const bind = (resources: ReturnType<typeof publish>['resources'], handle?: unknown) => {
    const result = preparedMaterialBindings(
      f.runtime,
      [resources],
      'shader',
      0,
      guid,
      f.layout,
      f.skylight,
      f.scope,
      handle,
    );
    if (result.ok && 'release' in result.value) result.value.release?.().unwrap();
    return result;
  };
  try {
    const first = publish();
    const handle = (first.packet.features[0]?.data as { handle: Handle<'MaterialAsset', 'shared'> })
      .handle;
    expect(handle).toBeTypeOf('number');
    const ordinary = f.world.allocSharedRef('MaterialAsset', material);
    const content = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [ordinary] } },
        {
          component: RuntimeMaterialValue,
          data: { asset: ordinary, parameter: 'roughness', kind: 0, value: [0.25] },
        },
      )
      .unwrap();
    const second = publish();
    expect(second.resources.handleForGuid(guid)).toBe(ordinary);
    expect(second.resources.resolveAsset<MaterialAsset>(ordinary).unwrap().values?.roughness).toBe(
      0.25,
    );
    expect(bind(second.resources, handle).ok).toBe(true);
    expect(lastUploadedRoughness(f)).toBe(0.75);
    f.world.despawn(content).unwrap();
    const third = publish();
    expect(third.packet.retiredAssets).toContain(ordinary);
    expect(third.packet.retiredAssets).not.toContain(handle);
    expect(third.resources.handleForGuid(guid)).toBeUndefined();
    expect(bind(third.resources).ok).toBe(false);
    expect(bind(third.resources, handle).ok).toBe(true);
    expect(lastUploadedRoughness(f)).toBe(0.75);
  } finally {
    publisher.dispose();
    receiver.dispose();
  }
});

it.each([
  null,
  -1,
  NaN,
  0.5,
  '1024',
])('rejects malformed explicit material handles without GUID fallback: %s', (handle) => {
  const f = scopedMaterialFixture();
  const result = preparedMaterialBindings(
    f.runtime,
    [f.world],
    'shader',
    0,
    f.guid,
    f.layout,
    f.skylight,
    f.scope,
    handle,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected malformed reference failure');
  expect(result.error.message).toContain('asset-handle-invalid');
  expect(f.createBindGroup).not.toHaveBeenCalled();
});
