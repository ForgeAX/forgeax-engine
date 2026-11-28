import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  type Asset,
  type AssetHandle,
  type GpuTextureAsset,
  ok,
  type SamplerAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { MaterialResource } from '../material-resource';
import {
  projectMeshMaterialBindingObservation,
  publishMeshMaterialBindingResidency,
} from '../mesh-material-bindings';
import { worldRenderResources } from '../publication/resource-scope';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import {
  createMaterialResidencyObserver,
  observeMaterialResidency,
  prepareGeneratedDrawTextures,
} from '../render-system-residency';
import { MaterialFrame } from '../scene/material-dispatch';
import { receiptRow } from './gpu-draw-selection-fixture';

function assetWorld() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  return new World({ assets });
}

it('starts only generated textures of selected submeshes in their source scope', () => {
  const world = assetWorld();
  const assets = runtimeAssetRegistry(world.assets);
  const scope = worldRenderResources(world);
  const generated: GpuTextureAsset = {
    kind: 'gpu-texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    mips: { kind: 'none' },
    source: {
      kind: 'generated',
      generator: '01900000-0000-7000-8000-000000000010',
      output: 'albedo',
    },
  };
  const selected = 1000 as AssetHandle<'gpu-texture'>;
  const skipped = 1001 as AssetHandle<'gpu-texture'>;
  const resolveAsset = scope.resolveAsset;
  vi.spyOn(scope, 'resolveAsset').mockImplementation(
    <T extends Asset>(handle: number, revision?: number) =>
      handle === selected || handle === skipped
        ? ok(generated as T)
        : resolveAsset<T>(handle, revision),
  );
  const ordinary = assets
    .create({
      kind: 'texture',
      format: generated.format,
      colorSpace: generated.colorSpace,
      shape: generated.shape,
      mips: { kind: 'none' },
      data: new Uint8Array(16),
    })
    .unwrap();
  const first = new MaterialResource({
    ...defaultMaterialSnapshot(1),
    baseColorTexture: selected,
    normalTexture: ordinary,
  });
  const second = new MaterialResource({ ...defaultMaterialSnapshot(2), baseColorTexture: skipped });
  const frame = new MaterialFrame(undefined);
  vi.spyOn(frame, 'get').mockImplementation((resource) => ({
    resource,
    snapshot: resource.snapshot,
    passes: [],
    bindings: 1,
  }));
  const row: ValidatedRenderable = {
    source: { ...receiptRow().source, material: first, materials: [first, second] },
    mesh: {
      submeshes: [{ materialSlot: 0 }, { materialSlot: 1 }],
    } as unknown as ValidatedRenderable['mesh'],
    submeshIndices: [0],
    meshSlot: 0,
    renderableIndex: 0,
    renderState: undefined,
    stencilReference: undefined,
    world: scope,
  };
  const store = new GpuResidencyCache();
  const prepare = vi.spyOn(store, 'ensureResident');
  prepareGeneratedDrawTextures([row, row], frame, worldRenderResources(assetWorld()), store);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(selected, generated, scope);
});

it('keeps mutable readiness, first failures, sampler and video observations without detail rows', async () => {
  const world = assetWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const mips = { kind: 'packed' as const, levelCount: 3 };
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    mips,
    data: new Uint8Array(84),
  };
  const sampler: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
  const textureHandle = runtimeAssetRegistry(world.assets).create(texture).unwrap();
  const samplerHandle = runtimeAssetRegistry(world.assets).create(sampler).unwrap();
  const material: MaterialSnapshot = {
    ...defaultMaterialSnapshot(),
    textureHandles: new Map([['source', textureHandle]]),
    samplerHandles: new Map([['source', samplerHandle]]),
  };
  let videoReady = false;
  const internals = {
    gpuStore: store,
    dynamicTextureStore: {
      getView: () =>
        videoReady
          ? store.getTextureGpuView(textureHandle, worldRenderResources(world))
          : undefined,
    },
  } as unknown as RenderSystemInternals;
  const compare = (value: MaterialSnapshot) => {
    const full = observeMaterialResidency(worldRenderResources(world), value, internals);
    const status = observeMaterialResidency(worldRenderResources(world), value, internals, false);
    expect(status.readiness).toBe(full.readiness);
    expect(status.preparationFailure).toEqual(full.preparationFailure);
    expect(status.textures).toEqual([]);
    expect(status.samplers).toEqual([]);
    return full;
  };
  try {
    const ready = compare(material);
    expect(ready.readiness).toBe('ready');
    expect(ready.textures).toEqual([{ handle: Number(textureHandle), mipLevelCount: 3 }]);
    expect(ready.samplers).toEqual([{ handle: Number(samplerHandle), resident: true }]);
    expect(
      runtimeAssetRegistry(world.assets).update(textureHandle, {
        mips: { kind: 'packed', levelCount: 0 },
      }).ok,
    ).toBe(false);
    expect(compare(material).readiness).toBe('ready');
    const video = {
      ...material,
      videoTextureFields: new Map([['clip', Number(1) as AssetHandle<'video'>]]),
    };
    expect(compare(video).readiness).toBe('pending');
    videoReady = true;
    expect(compare(video).readiness).toBe('ready');
    store.destroyAll();
    store.configureGpuDevice(device, undefined, device.caps);
    expect(compare(material).readiness).toBe('ready');
    expect(observeMaterialResidency(undefined, material, internals, false).readiness).toBe(
      'pending',
    );
  } finally {
    store.destroyAll();
  }
});

it('observes a repeated material once per World and refreshes the next phase', () => {
  const first = assetWorld(),
    second = assetWorld();
  const clip = Number(1) as AssetHandle<'video'>;
  const material = { ...defaultMaterialSnapshot(), videoTextureFields: new Map([['clip', clip]]) };
  let ready = true;
  const getView = vi.fn(() => (ready ? {} : undefined));
  const internals = { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals;
  const observe = createMaterialResidencyObserver(internals, false);
  for (let i = 0; i < 2048; i++)
    expect(observe(worldRenderResources(first), material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(1);
  expect(observe(worldRenderResources(second), material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(2);
  expect(observe(worldRenderResources(first), { ...material }).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(3);
  ready = false;
  const next = createMaterialResidencyObserver(internals, false);
  expect(next(worldRenderResources(first), material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
  expect(next(undefined, material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
});

it('observes the exact source version when value-only material variants share a handle', () => {
  const scope = worldRenderResources(assetWorld());
  const internals = {} as RenderSystemInternals;
  const root = 15;
  const accepted = {
    ...defaultMaterialSnapshot(root),
    sourceAssets: {
      root,
      revision: 1,
      assets: [
        { handle: root, revision: 1, value: { kind: 'material' as const, passes: [], values: {} } },
      ],
    },
  };
  const unavailable = {
    ...defaultMaterialSnapshot(root),
    sourceAssets: { root, revision: 2, assets: [{ handle: root, revision: 2 }] },
  };
  for (const [first, second] of [
    [accepted, unavailable],
    [unavailable, accepted],
  ] as const) {
    const observe = createMaterialResidencyObserver(internals, false);
    for (const material of [first, second, { ...first }]) {
      expect(observe(scope, material)).toEqual(
        observeMaterialResidency(scope, material, internals, false),
      );
    }
  }
});

it('does not re-project an owned material residency key for every consumer', () => {
  const scope = worldRenderResources(assetWorld());
  let reads = 0;
  const material = new Proxy(
    { ...defaultMaterialSnapshot(), immutableValues: true as const },
    {
      get(target, key, receiver) {
        if (key === 'textureHandles') reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const internals = {} as RenderSystemInternals;
  const observe = createMaterialResidencyObserver(internals, false);
  const first = observe(scope, material);
  expect(first.readiness).toBe('ready');
  const initialReads = reads;
  for (let consumer = 0; consumer < 2048; consumer++) expect(observe(scope, material)).toBe(first);
  expect(reads).toBe(initialReads);
  expect(observe(undefined, material).readiness).toBe('pending');
  expect(observe(scope, material)).toBe(first);
  const nextPhase = createMaterialResidencyObserver(internals, false);
  const beforeNext = reads;
  expect(nextPhase(scope, material).readiness).toBe('ready');
  expect(reads).toBeGreaterThan(beforeNext);
});

it('keeps borrowed residency key reads and never invokes an ownership getter', () => {
  const scope = worldRenderResources(assetWorld());
  let reads = 0;
  const ownership = vi.fn(() => true);
  const material = { ...defaultMaterialSnapshot() };
  Object.defineProperty(material, 'immutableValues', { get: ownership });
  const borrowed = new Proxy(material, {
    get(target, key, receiver) {
      if (key === 'textureHandles') reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const observe = createMaterialResidencyObserver({} as RenderSystemInternals, false);
  observe(scope, borrowed);
  const initialReads = reads;
  observe(scope, borrowed);
  expect(reads).toBeGreaterThan(initialReads);
  expect(ownership).not.toHaveBeenCalled();
});

it('retains the complete owned observation when ownership inspection reenters another material', () => {
  const first = worldRenderResources(assetWorld());
  const second = worldRenderResources(assetWorld());
  let ready = true;
  const getView = vi.fn(() => (ready ? {} : undefined));
  const observe = createMaterialResidencyObserver(
    { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals,
    false,
  );
  const other = { ...defaultMaterialSnapshot(), immutableValues: true as const };
  let nested = false;
  const material = new Proxy(
    { ...other, videoTextureFields: new Map([['clip', Number(1) as AssetHandle<'video'>]]) },
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'immutableValues' && !nested) {
          nested = true;
          expect(observe(first, other).readiness).toBe('ready');
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const captured = observe(first, material);
  expect(nested).toBe(true);
  expect(captured.readiness).toBe('ready');
  ready = false;
  expect(observe(first, material)).toBe(captured);
  expect(getView).toHaveBeenCalledTimes(1);
  const otherRenderer = createMaterialResidencyObserver(
    { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals,
    false,
  );
  expect(otherRenderer(second, material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(2);
  expect(observe(first, material)).toBe(captured);
});

it('reuses the accepted texture allocation across value clones and rejects invalid edits before observation', async () => {
  const world = assetWorld();
  const assets = runtimeAssetRegistry(world.assets);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const handle = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'packed', levelCount: 1 },
      data: new Uint8Array(4),
    })
    .unwrap();
  const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
  const internals = { gpuStore: store } as RenderSystemInternals;
  const scope = worldRenderResources(world);
  const createTexture = vi.spyOn(device, 'createTexture');
  try {
    const published = scope.resolveAsset<TextureAsset>(handle).unwrap();
    const entry = store.ensureResident(handle, published, scope).unwrap();
    expect(entry.receipt.shape).toBe(published.shape);
    expect(entry.receipt.fixedSourceMips).toBe(published.mips);
    expect(Object.isFrozen(published.shape.extent)).toBe(true);
    const observe = createMaterialResidencyObserver(internals, false);
    for (let index = 0; index < 2048; index++)
      expect(observe(scope, { ...material, roughness: index / 2048 }).readiness).toBe('ready');
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(assets.update(handle, { mips: { kind: 'packed', levelCount: 0 } }).ok).toBe(false);
    expect(createMaterialResidencyObserver(internals, false)(scope, material).readiness).toBe(
      'ready',
    );
    expect(createTexture).toHaveBeenCalledTimes(1);
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it.each([
  'mutable extent',
  'frozen getter',
] as const)('observes live %s edits across different materials in one phase', async (mode) => {
  const world = assetWorld();
  const assets = runtimeAssetRegistry(world.assets);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const size = { width: 1, height: 1 };
  const extent =
    mode === 'mutable extent'
      ? size
      : Object.freeze({
          get width() {
            return size.width;
          },
          height: 1,
        });
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: Object.freeze({ viewDimension: '2d', extent }),
    mips: Object.freeze({ kind: 'none' }),
    data: new Uint8Array(4),
  };
  const handle = assets
    .create({ ...texture, shape: { viewDimension: '2d', extent: size } })
    .unwrap();
  const scope = { ...worldRenderResources(world), resolveAsset: <T>() => ok(texture as T) };
  const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
  const observe = createMaterialResidencyObserver(
    { gpuStore: store } as RenderSystemInternals,
    false,
  );
  try {
    const entry = store.ensureResident(handle, texture, scope).unwrap();
    expect(entry.receipt.fixedSourceMips).toBeUndefined();
    expect(observe(scope, material).readiness).toBe('ready');
    size.width = 0;
    expect(observe(scope, { ...material, roughness: 0.3 })).toMatchObject({
      readiness: 'failed',
      preparationFailure: { code: 'texture-shape-invalid', detail: { field: 'width' } },
    });
    size.width = 1;
    expect(observe(scope, { ...material, roughness: 0.4 }).readiness).toBe('ready');
  } finally {
    store.destroyAll();
    assets.dispose();
  }
});

it('captures a shared residency record before the producer changes it', () => {
  const world = assetWorld();
  const observe = createMaterialResidencyObserver({} as RenderSystemInternals, false);
  const value = observe(worldRenderResources(world), defaultMaterialSnapshot());
  const captured = [];
  for (let entityKey = 1; entityKey <= 128; entityKey++) {
    const projected = projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey,
      bindings: [{ handle: 0, source: 'engine-default' }],
      diagnostics: [],
      residency: [value],
    });
    captured.push(projected.residency[0]);
    expect(projected.residency[0]).toEqual(value);
    expect(Object.isFrozen(projected.residency[0])).toBe(true);
  }
  Reflect.set(value, 'readiness', 'failed');
  expect(captured.every((record) => record?.readiness === 'ready')).toBe(true);
});

it('detaches raw mutable residency even when only its outer record is frozen', () => {
  const textures = [{ handle: 17, mipLevelCount: 3 }];
  const samplers = [{ handle: 18, resident: true }];
  const detail = { slot: 1 };
  const failure = { code: 'invalid', expected: 'texture', hint: 'repair', detail };
  const value = Object.freeze({
    readiness: 'last-known-good' as const,
    textures,
    samplers,
    preparationFailure: failure,
  });
  const projected = projectMeshMaterialBindingObservation({
    worldId: 0,
    entityKey: 9,
    bindings: [{ handle: 0, source: 'engine-default' }],
    diagnostics: [],
    residency: [value],
  });
  const texture = textures[0],
    sampler = samplers[0];
  if (texture === undefined || sampler === undefined)
    throw Error('Missing mutable observation fixture');
  texture.mipLevelCount = 0;
  sampler.resident = false;
  detail.slot = 2;
  expect(projected.residency[0]).not.toBe(value);
  expect(projected.residency[0]).toMatchObject({
    textures: [{ handle: 17, mipLevelCount: 3 }],
    samplers: [{ handle: 18, resident: true }],
    preparationFailure: { detail: { slot: 1 } },
  });
});

it('shares producer-captured residency while recapturing raw and shallow-frozen accessors', () => {
  let handle = 7,
    reads = 0;
  const sampler = {
    get handle() {
      reads++;
      return handle;
    },
    resident: true,
  };
  const source = Object.freeze({ readiness: 'ready' as const, samplers: [sampler], textures: [] });
  const input = {
    entityKey: 1,
    bindings: [{ handle: 1, source: 'engine-default' as const }],
    diagnostics: [],
  };
  const published = publishMeshMaterialBindingResidency(source);
  const count = reads;
  const first = projectMeshMaterialBindingObservation({
    worldId: 0,
    ...input,
    residency: [published],
  });
  const second = projectMeshMaterialBindingObservation({
    worldId: 0,
    ...input,
    residency: [published],
  });
  expect(reads).toBe(count);
  expect(first.residency[0]).toBe(second.residency[0]);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
  handle = 9;
  const raw = projectMeshMaterialBindingObservation({ worldId: 0, ...input, residency: [source] });
  const rawAgain = projectMeshMaterialBindingObservation({
    worldId: 0,
    ...input,
    residency: [source],
  });
  expect(raw.residency[0]).not.toBe(rawAgain.residency[0]);
  expect(raw.residency[0]?.samplers[0]?.handle).toBe(9);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
});
