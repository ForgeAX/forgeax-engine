import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  RhiError,
} from '@forgeax/engine-rhi';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  err,
  type MaterialAsset,
  ok,
  type ParamSchemaEntry,
  type Result,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createPreparedGraphicsStore } from '../../features/prepared-graphics-store';
import type { SkylightBindGroupResources } from '../../ibl/skylight-bind-group';
import { createPreparedGraphicsResolver } from '../../prepare/prepared-graphics-resolver';
import { renderPublicationTransfers } from '../../publication/contract';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { worldRenderResources } from '../../publication/resource-scope';
import {
  type PreparedMaterialBindingsScope,
  preparedMaterialBindings,
} from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';

function scopedMaterialFixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  let generation = 1;
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: { roughness: 0.25 },
  };
  const handle = assets.create(material).unwrap();
  const resourceScope = worldRenderResources(world);
  const reads = vi.spyOn(resourceScope, 'resolveAsset');
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
      [worldRenderResources(owner)],
      'shader',
      0,
      handle,
      bindingLayout,
      skylight,
      rows,
    ).unwrap();
    if (!('release' in binding)) throw new Error('expected a scoped material lease');
    return binding;
  };
  return {
    world,
    handle,
    assets,
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
      assets.update(handle, { values: { roughness: next } }).unwrap();
    },
    advanceGeneration: () => {
      generation++;
    },
    reads: () => reads.mock.calls.length,
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

it('reobserves managed values and preserves prior borrowers when packed bytes or size change', () => {
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
  const anotherAssets = new AssetRegistry();
  const anotherHandle = anotherAssets
    .create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
      values: { roughness: 0.25 },
    })
    .unwrap();
  const anotherWorldOwner = new World({ assets: anotherAssets });
  const anotherWorld = preparedMaterialBindings(
    f.runtime,
    [worldRenderResources(anotherWorldOwner)],
    'shader',
    0,
    anotherHandle,
    f.layout,
    f.skylight,
    f.scope,
  ).unwrap();
  if (!('release' in anotherWorld)) throw new Error('expected scoped material lease');
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
        values: { group: 1, material: { world: 0, handle: f.handle } },
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
      [worldRenderResources(f.world)],
      'shader',
      0,
      f.handle,
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
      [worldRenderResources(f.world)],
      'shader',
      0,
      f.handle,
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

function lastUploadedRoughness(fixture: ReturnType<typeof scopedMaterialFixture>): number {
  const bytes = fixture.writeBuffer.mock.lastCall?.[2];
  if (bytes === undefined) throw new Error('Expected material UBO upload');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

it('binds the captured material handle when its GUID alias was retired', () => {
  const f = scopedMaterialFixture();
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: { roughness: 0.75 },
  };
  const handle = f.assets.create(material).unwrap();
  const byGuid = vi.fn(() => undefined);
  const resourceScope = {
    handleForGuid: byGuid,
    resolveAsset: (value: number) =>
      value === handle ? ok(material) : err(new Error('stale captured material handle')),
  };
  const binding = preparedMaterialBindings(
    f.runtime,
    [resourceScope as never],
    'shader',
    0,
    handle,
    f.layout,
    f.skylight,
    f.scope,
  ).unwrap();
  expect(byGuid).not.toHaveBeenCalled();
  expect(lastUploadedRoughness(f)).toBe(0.75);
  if ('release' in binding) binding.release?.();
});

it('rejects a stale captured material handle instead of selecting a different GUID alias', () => {
  const f = scopedMaterialFixture();
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    values: { roughness: 0.75 },
  };
  const replacement = f.assets.create(material).unwrap();
  const stale = (Number(replacement) + 1) as number;
  const byGuid = vi.fn(() => replacement);
  const resourceScope = {
    handleForGuid: byGuid,
    resolveAsset: (value: number) =>
      value === replacement ? ok(material) : err(new Error('stale captured material handle')),
  };
  const binding = preparedMaterialBindings(
    f.runtime,
    [resourceScope as never],
    'shader',
    0,
    stale,
    f.layout,
    f.skylight,
    f.scope,
  );
  expect(binding.ok).toBe(false);
  if (binding.ok) throw new Error('Expected stale reference failure');
  expect(binding.error.message).toContain('stale captured material handle');
  expect(byGuid).not.toHaveBeenCalled();
  expect(f.createBindGroup).not.toHaveBeenCalled();
});

for (const [cause, owner, expected] of [
  ['world', -1, 'source-world-unavailable'],
  ['handle', 0, 'asset-handle-invalid'],
  ['pipeline', 0, 'pipeline-state-unavailable'],
] as const) {
  it(`distinguishes prepared material ${cause} unavailability at the binding owner`, () => {
    const f = scopedMaterialFixture();
    if (cause === 'pipeline') f.source.getPipelineState = () => null as never;
    const handle = cause === 'handle' ? 0 : f.handle;
    const result = preparedMaterialBindings(
      f.runtime,
      [worldRenderResources(f.world)],
      'shader',
      owner,
      handle,
      f.layout,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected admission failure');
    expect(result.error.message).toContain(expected);
    expect(result.error.message).toContain(`world=${owner}`);
    expect(result.error.message).toContain(`handle=${handle}`);
    expect(f.createBuffer).not.toHaveBeenCalled();
    expect(f.createBindGroup).not.toHaveBeenCalled();
  });
}

it('distinguishes a managed reference to a non-material payload', () => {
  const f = scopedMaterialFixture();
  const texture = f.assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      mips: { kind: 'none' },
      colorSpace: 'linear',
      data: new Uint8Array(4),
    })
    .unwrap();
  const result = preparedMaterialBindings(
    f.runtime,
    [worldRenderResources(f.world)],
    'shader',
    0,
    texture,
    f.layout,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected admission failure');
  expect(result.error.message).toContain('asset-kind-mismatch:texture');
  expect(f.createBuffer).not.toHaveBeenCalled();
  expect(f.createBindGroup).not.toHaveBeenCalled();
});

it('never formats a borrowed invalid-kind value while explaining admission failure', () => {
  const f = scopedMaterialFixture();
  const stringify = vi.fn(() => {
    throw new Error('borrowed toString must not run');
  });
  const scope = { resolveAsset: () => ok({ kind: { toString: stringify } }) };
  const result = preparedMaterialBindings(
    f.runtime,
    [scope as never],
    'shader',
    0,
    f.handle,
    f.layout,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected admission failure');
  expect(result.error.message).toContain('asset-kind-mismatch:object');
  expect(stringify).not.toHaveBeenCalled();
});

it('retains the exact feature material when an independent ordinary root is retired', () => {
  const f = scopedMaterialFixture();
  const featureHandle = f.assets
    .create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
      values: { roughness: 0.75 },
    })
    .unwrap();
  const ordinary = f.assets.create(f.assets.read(featureHandle).unwrap()).unwrap();
  f.assets.update(ordinary, { values: { roughness: 0.25 } }).unwrap();
  let ordinaryConsumed = true;
  const identity = { source: 'exact-managed-material', epoch: 1 };
  const publisher = createRenderPublisher(f.world, f.assets, identity, undefined, [
    {
      identity: 'material-roots',
      extract: () => ok({ handle: featureHandle }),
      assetDependencies: () => (ordinaryConsumed ? [featureHandle, ordinary] : [featureHandle]),
      plan: () => ok({ work: [{ scope: 'frame' as const, resources: [], passes: [] }] }),
    },
  ]);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { packet, resources: accepted.resources };
  };
  const bind = (resources: ReturnType<typeof publish>['resources'], handle: number) => {
    const result = preparedMaterialBindings(
      f.runtime,
      [resources],
      'shader',
      0,
      handle,
      f.layout,
      f.skylight,
      f.scope,
    );
    if (result.ok && 'release' in result.value) result.value.release?.().unwrap();
    return result;
  };
  try {
    const first = publish();
    expect(first.resources.resolveAsset<MaterialAsset>(ordinary).unwrap().values?.roughness).toBe(
      0.25,
    );
    expect(bind(first.resources, featureHandle).ok).toBe(true);
    expect(lastUploadedRoughness(f)).toBe(0.75);
    ordinaryConsumed = false;
    const second = publish();
    expect(second.packet.retiredAssets).toContain(ordinary);
    expect(second.packet.retiredAssets).not.toContain(featureHandle);
    expect(bind(second.resources, ordinary).ok).toBe(false);
    expect(bind(second.resources, featureHandle).ok).toBe(true);
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
])('rejects malformed explicit material handles without fallback: %s', (handle) => {
  const f = scopedMaterialFixture();
  const result = preparedMaterialBindings(
    f.runtime,
    [worldRenderResources(f.world)],
    'shader',
    0,
    handle as number,
    f.layout,
    f.skylight,
    f.scope,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected malformed reference failure');
  expect(result.error.message).toContain('asset-handle-invalid');
  expect(f.createBindGroup).not.toHaveBeenCalled();
});
