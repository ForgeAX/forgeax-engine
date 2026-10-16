import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { type SamplerAsset, type TextureAsset, toShared } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import {
  projectMeshMaterialBindingObservation,
  publishMeshMaterialBindingResidency,
} from '../mesh-material-bindings';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import {
  createMaterialResidencyObserver,
  observeMaterialResidency,
} from '../render-system-residency';

it('keeps mutable readiness, first failures, sampler and video observations without detail rows', async () => {
  const world = new World();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('No cubemap');
    },
    device.caps,
  );
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
  const textureHandle = world.allocSharedRef('TextureAsset', texture);
  const samplerHandle = world.allocSharedRef('SamplerAsset', sampler);
  const material: MaterialSnapshot = {
    ...defaultMaterialSnapshot(),
    textureHandles: new Map([['source', textureHandle]]),
    samplerHandles: new Map([['source', samplerHandle]]),
  };
  let videoReady = false;
  const internals = {
    gpuStore: store,
    dynamicTextureStore: {
      getView: () => (videoReady ? store.getTextureGpuView(textureHandle, world) : undefined),
    },
  } as unknown as RenderSystemInternals;
  const compare = (value: MaterialSnapshot) => {
    const full = observeMaterialResidency(world, value, internals);
    const status = observeMaterialResidency(world, value, internals, false);
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
    mips.levelCount = 0;
    expect(compare(material).preparationFailure?.code).toBe('texture-mip-policy-invalid');
    mips.levelCount = 3;
    expect(compare(material).readiness).toBe('ready');
    const video = {
      ...material,
      videoTextureFields: new Map([['clip', toShared<'VideoAsset'>(1)]]),
    };
    expect(compare(video).readiness).toBe('pending');
    videoReady = true;
    expect(compare(video).readiness).toBe('ready');
    store.destroyAll();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('No cubemap');
      },
      device.caps,
    );
    expect(compare(material).readiness).toBe('ready');
    expect(observeMaterialResidency(undefined, material, internals, false).readiness).toBe(
      'pending',
    );
  } finally {
    store.destroyAll();
  }
});

it('observes a repeated material once per World and refreshes the next phase', () => {
  const first = new World(),
    second = new World();
  const clip = toShared<'VideoAsset'>(1);
  const material = { ...defaultMaterialSnapshot(), videoTextureFields: new Map([['clip', clip]]) };
  let ready = true;
  const getView = vi.fn(() => (ready ? {} : undefined));
  const internals = { dynamicTextureStore: { getView } } as unknown as RenderSystemInternals;
  const observe = createMaterialResidencyObserver(internals, false);
  for (let i = 0; i < 2048; i++) expect(observe(first, material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(1);
  expect(observe(second, material).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(2);
  expect(observe(first, { ...material }).readiness).toBe('ready');
  expect(getView).toHaveBeenCalledTimes(3);
  ready = false;
  const next = createMaterialResidencyObserver(internals, false);
  expect(next(first, material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
  expect(next(undefined, material).readiness).toBe('pending');
  expect(getView).toHaveBeenCalledTimes(4);
});

it('validates a shared texture once across value clones, then validates the next phase again', async () => {
  const world = new World();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw Error('No cubemap');
    },
    device.caps,
  );
  const mips = { kind: 'packed' as const, levelCount: 1 };
  const extent = { width: 1, height: 1 };
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent },
    mips,
    data: new Uint8Array(4),
  };
  const handle = world.allocSharedRef('TextureAsset', texture);
  const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
  const internals = { gpuStore: store } as RenderSystemInternals;
  try {
    // Warm GPU admission separately so these reads measure only observation.
    store.ensureResident(handle, texture, world).unwrap();
    const width = vi.fn(() => 1);
    Object.defineProperty(extent, 'width', { get: width });
    const observe = createMaterialResidencyObserver(internals, false);
    expect(observe(world, material).readiness).toBe('ready');
    const reads = width.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    for (let index = 0; index < 2048; index++) {
      expect(observe(world, { ...material, roughness: index / 2048 }).readiness).toBe('ready');
    }
    expect(width).toHaveBeenCalledTimes(reads);
    mips.levelCount = 0;
    expect(
      createMaterialResidencyObserver(internals, false)(world, material).preparationFailure?.code,
    ).toBe('texture-mip-policy-invalid');
    mips.levelCount = 1;
    expect(createMaterialResidencyObserver(internals, false)(world, material).readiness).toBe(
      'ready',
    );
    expect(width.mock.calls.length).toBeGreaterThan(reads);
  } finally {
    store.destroyAll();
  }
});

it('captures a shared residency record before the producer changes it', () => {
  const world = new World();
  const observe = createMaterialResidencyObserver({} as RenderSystemInternals, false);
  const value = observe(world, defaultMaterialSnapshot());
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
    worldId: 0,
    entityKey: 1,
    bindings: [{ handle: 1, source: 'engine-default' as const }],
    diagnostics: [],
  };
  const published = publishMeshMaterialBindingResidency(source);
  const count = reads;
  const first = projectMeshMaterialBindingObservation({ ...input, residency: [published] });
  const second = projectMeshMaterialBindingObservation({ ...input, residency: [published] });
  expect(reads).toBe(count);
  expect(first.residency[0]).toBe(second.residency[0]);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
  handle = 9;
  const raw = projectMeshMaterialBindingObservation({ ...input, residency: [source] });
  const rawAgain = projectMeshMaterialBindingObservation({ ...input, residency: [source] });
  expect(raw.residency[0]).not.toBe(rawAgain.residency[0]);
  expect(raw.residency[0]?.samplers[0]?.handle).toBe(9);
  expect(first.residency[0]?.samplers[0]?.handle).toBe(7);
});
