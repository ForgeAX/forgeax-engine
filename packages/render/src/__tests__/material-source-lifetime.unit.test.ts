import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { derive, type MaterialAsset, type TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { GpuResidencyCache } from '../device/gpu-residency';
import { createSkylightFallback } from '../ibl/skylight-bind-group';
import { MaterialResource } from '../material-resource';
import { type MaterialSourceSnapshot, materialSourceScope } from '../material-source';
import { worldRenderResources } from '../publication/resource-scope';
import {
  adoptPreparedMaterialBindings,
  clearPreparedMaterialBindings,
  createPreparedResolverCaches,
  preparedMaterialBindings,
} from '../record/prepared-material-bindings';
import type { RenderSystemInternals } from '../record/render-context';
import {
  defaultMaterialSnapshot,
  type ExtractedFrame,
  type RenderableSnapshot,
} from '../render-system-extract';
import { MaterialSourceEntries } from '../scene/material-source-entries';
import { PersistentRenderScene } from '../scene/render-scene';

function texture(fill: number): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64).fill(fill),
  };
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const scope = DeviceScope.create(1, 'material-source-lifetime');
  store.bindDeviceScope(scope);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const base = worldRenderResources(world);
  const image = texture(255);
  const textureHandle = runtimeAssetRegistry(assets).create(image).unwrap();
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'main', program: { module: 'test::source' } }],
    values: { sourceTexture: textureHandle, tint: [1, 1, 1, 1] },
  };
  const materialHandle = runtimeAssetRegistry(assets).create(material).unwrap();
  const source = (revision = 1, value = image): MaterialSourceSnapshot => ({
    root: materialHandle,
    revision: 1,
    assets: [
      { handle: materialHandle, revision: 1, value: material },
      { handle: textureHandle, revision, value },
    ],
  });
  return {
    device,
    store,
    scope,
    assets,
    world,
    base,
    image,
    textureHandle,
    materialHandle,
    source,
  };
}

it('owns only live dependency edges, retries and planar receivers across partial edits', () => {
  const rows = new MaterialSourceEntries();
  const versions = new Map<number, number>();
  const assetRevision = vi.fn((handle: number) => versions.get(handle) ?? 1);
  const scope = { ...worldRenderResources(new World()), assetRevision };
  const install = (root: number, dependency: number) => {
    const revision = versions.get(dependency) ?? 1;
    rows.set(root, {
      assetRevision: 1,
      ...(root === 1 ? { planarRouted: true } : {}),
      snapshot: {
        ...defaultMaterialSnapshot(root),
        sourceAssets: {
          root,
          revision: 1,
          assets: [
            { handle: root, revision: 1 },
            { handle: dependency, revision },
          ],
        },
      },
    });
  };
  const changed = new Set<number>();
  const collect = (changes: readonly { handle: number }[], retry: 'source' | 'all' = 'all') => {
    changed.clear();
    rows.collectSourceChanges(scope, changes, changed, retry);
    return [...changed];
  };
  for (let i = 1; i <= 128; i++) install(i, 1000 + Math.ceil(i / 2));
  expect(collect([])).toEqual([]);
  for (let index = 0; index < 60; index++) {
    const first = index * 2 + 1;
    const dependency = 1001 + index;
    versions.set(dependency, 2);
    assetRevision.mockClear();
    expect(collect([{ handle: dependency }, { handle: dependency }])).toEqual([first, first + 1]);
    expect(assetRevision.mock.calls.flat()).toEqual([first, dependency, first + 1, dependency]);
    // Unaccepted work must remain visible even after an observer advances.
    expect(collect([])).toEqual([first, first + 1]);
    install(first, 2000 + index);
    rows.delete(first + 1);
    expect(collect([{ handle: dependency }])).toEqual([]);
  }
  changed.clear();
  rows.collectPlanarReceivers(changed);
  expect([...changed]).toEqual([1]);
  const previous = rows.get(1);
  if (previous === undefined) throw new Error('missing material');
  rows.set(1, { ...previous, retry: { cause: 'texture pending' } });
  rows.set(8000, {
    snapshot: defaultMaterialSnapshot(8000),
    assetRevision: 1,
    retry: { cause: 'program pending' },
  });
  expect(collect([], 'source')).toEqual([1]);
  expect(collect([])).toEqual([1, 8000]);
  // The next observer may have opened after a source was edited.
  rows.set(1, previous);
  versions.set(2000, 8);
  rows.resetSourceObserver();
  expect(collect([], 'source')).toEqual([1]);
  rows.clear();
  expect(collect([{ handle: 2000 }])).toEqual([]);
});

it('SceneComposition owns accepted sources through removal, failed preparation, recovery and disposal', async () => {
  const { device, store, scope, assets, world, base, image, textureHandle, source } =
    await fixture();
  const entity = world.spawn({ component: Transform, data: {} }).unwrap();
  const readLease = createRenderReadLease(world);
  const firstSource = source();
  const resource = new MaterialResource({
    ...defaultMaterialSnapshot(),
    sourceAssets: firstSource,
  });
  const retained = vi.fn((owner, accepted) =>
    store.retainMaterialScope(materialSourceScope(owner, accepted)),
  );
  const persistent = new PersistentRenderScene({ retainMaterialSource: retained });
  const row: RenderableSnapshot = {
    entityKey: entity,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    material: resource,
    materials: [resource],
    materialBindingSources: ['engine-default'],
  };
  let rows = [row];
  let fail = false;
  const frame = (): ExtractedFrame => {
    if (fail) throw new Error('candidate-not-ready');
    return {
      cameras: [],
      auxiliaryCameras: [],
      cubeCameras: [],
      lights: {
        directional: undefined,
        directionalCount: 0,
        point: [],
        spot: [],
        rect: [],
        pointShadow: [],
      },
      environmentReady: true,
      renderables: rows,
      dispatch: [],
      hiddenEntityReports: [],
      visibilitySnapshots: [],
      featureVisibilitySnapshots: [],
      frustumStats: { culled: 0, total: rows.length },
      postProcessParams: new Map(),
    } as unknown as ExtractedFrame;
  };
  const extract = () => persistent.extractComposition(world, assets, frame, readLease);
  const created = vi.spyOn(device, 'createTexture');
  const destroyed = vi.spyOn(device, 'destroyTexture');
  try {
    extract();
    const fixed = materialSourceScope(base, firstSource);
    const first = store.ensureResident(textureHandle, image, fixed).unwrap();
    for (let index = 0; index < 3; index++) {
      extract();
      await Promise.resolve();
    }
    expect(retained).toHaveBeenCalledTimes(1);
    expect(first.texture.isDestroyed).toBe(false);
    fail = true;
    world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
    expect(extract).toThrow('candidate-not-ready');
    expect(first.texture.isDestroyed).toBe(false);
    fail = false;
    extract();
    persistent.resetGpuForRecover();
    expect(first.texture.isDestroyed).toBe(true);
    extract();
    expect(retained).toHaveBeenCalledTimes(2);
    const replacement = store.ensureResident(textureHandle, image, fixed).unwrap();
    rows = [];
    world.despawn(entity).unwrap();
    extract();
    expect(replacement.texture.isDestroyed).toBe(true);
    const lastEntity = world.spawn({ component: Transform, data: {} }).unwrap();
    rows = [{ ...row, entityKey: lastEntity }];
    persistent.shared.invalidate();
    const readded = extract();
    expect(readded.renderables).toHaveLength(1);
    expect(retained).toHaveBeenCalledTimes(3);
    const last = store.ensureResident(textureHandle, image, fixed).unwrap();
    expect(last.texture.isDestroyed).toBe(false);

    // One new lease succeeds before the next source fails to acquire.
    const provisional = { track: vi.fn(), release: vi.fn() };
    retained.mockReturnValueOnce(provisional).mockImplementationOnce(() => {
      throw new Error('material-source-unavailable');
    });
    for (let i = 0; i < 2; i++) {
      const material = new MaterialResource({
        ...defaultMaterialSnapshot(),
        sourceAssets: source(),
      });
      const nextEntity = world.spawn({ component: Transform, data: {} }).unwrap();
      rows.push({ ...row, entityKey: nextEntity, material, materials: [material] });
    }
    persistent.shared.invalidate();
    expect(extract).toThrow('material-source-unavailable');
    expect(provisional.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(extract().renderables).toHaveLength(3);
    persistent.dispose();
    expect(last.texture.isDestroyed).toBe(true);
    expect(created.mock.calls.length).toBe(destroyed.mock.calls.length);
  } finally {
    persistent.dispose();
    readLease.dispose();
    store.destroyAll();
    scope.retire();
    assets.dispose();
  }
  expect(scope.resourceDelta()).toBe(0);
});

it('prepared material cache retains only accepted rows across source, payload, layout and device changes', async () => {
  const { device, store, scope, assets, base, textureHandle, materialHandle, source } =
    await fixture();
  const schema = [
    { name: 'tint', type: 'color' as const },
    { name: 'sourceTexture', type: 'texture2d' as const },
  ];
  const entries = derive(schema).bglEntries.map((entry) => ({
    binding: entry.binding,
    visibility: entry.visibility,
    ...(entry.buffer === undefined ? {} : { buffer: entry.buffer }),
    ...(entry.texture === undefined ? {} : { texture: entry.texture }),
    ...(entry.sampler === undefined ? {} : { sampler: entry.sampler }),
  }));
  const layout = device.createBindGroupLayout({ entries }).unwrap();
  const fallback = createSkylightFallback(device, device.queue);
  const buffer = device.createBuffer({ size: 256, usage: 0x48 }).unwrap();
  const runtime = {
    device,
    gpuStore: store,
    assets,
    deviceScope: scope,
    getParamSchema: () => schema,
    getPipelineState: () => ({
      defaultSampler: fallback.sampler,
      fallbackTextureView: fallback.brdfLutView,
      skylightFallback: fallback,
      meshStorageBuffer: { buffer, sizeInBytes: 256 },
    }),
  } as unknown as RenderSystemInternals;
  const cache = createPreparedResolverCaches().materialBindings;
  const bind = (accepted?: MaterialSourceSnapshot, bindingLayout = layout) => {
    const result = preparedMaterialBindings(
      runtime,
      base,
      'test::source',
      materialHandle,
      bindingLayout,
      undefined,
      cache,
      accepted === undefined ? undefined : 1,
      accepted,
    );
    if (!result.ok || !('handle' in result.value))
      throw new Error('fixture requires a leased prepared material');
    return result.value;
  };
  const firstSource = source();
  const created = vi.spyOn(device, 'createTexture');
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const destroyedBuffers = vi.spyOn(device, 'destroyBuffer');
  const recoveredScope = DeviceScope.create(2, 'material-source-recovered');
  try {
    const first = bind(firstSource);
    adoptPreparedMaterialBindings(cache, new Set([first.handle]));
    first.release().unwrap();
    await Promise.resolve();
    const again = bind(firstSource);
    expect(again.handle).toBe(first.handle);
    expect(created).toHaveBeenCalledTimes(1);
    const firstView = store.getTextureGpuView(
      textureHandle,
      materialSourceScope(base, firstSource),
    );
    const nextSource = source(2, texture(0));
    const next = bind(nextSource);
    adoptPreparedMaterialBindings(cache, new Set([next.handle]));
    expect(store.getTextureGpuView(textureHandle, materialSourceScope(base, firstSource))).toBe(
      firstView,
    );
    again.release().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(1);
    next.release().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(1);
    const sourceBuffer = cache[0]?.buffer;
    const sourceLayout = device.createBindGroupLayout({ entries }).unwrap();
    const sameSource = bind(nextSource, sourceLayout);
    adoptPreparedMaterialBindings(cache, new Set([sameSource.handle]));
    expect(cache).toHaveLength(1);
    expect(cache[0]?.handle).toBe(sameSource.handle);
    expect(destroyedBuffers).toHaveBeenCalledWith(sourceBuffer);
    expect(destroyed).toHaveBeenCalledTimes(1);
    sameSource.release().unwrap();
    adoptPreparedMaterialBindings(cache, new Set());
    expect(destroyed).toHaveBeenCalledTimes(2);
    const pending = bind(source(3, texture(127)));
    clearPreparedMaterialBindings(cache);
    expect(destroyed).toHaveBeenCalledTimes(2);
    pending.release().unwrap();
    expect(destroyed).toHaveBeenCalledTimes(3);
    expect(created.mock.calls.length).toBe(destroyed.mock.calls.length);
    const borrowed = bind();
    adoptPreparedMaterialBindings(cache, new Set([borrowed.handle]));
    const firstBuffer = cache[0]?.buffer;
    assets
      .update(materialHandle, { values: { sourceTexture: textureHandle, tint: [0.5, 1, 1, 1] } })
      .unwrap();
    const rejected = bind();
    rejected.release().unwrap();
    expect(cache).toHaveLength(1);
    expect(cache[0]?.handle).toBe(borrowed.handle);
    expect(destroyedBuffers).not.toHaveBeenCalledWith(firstBuffer);
    const changed = bind();
    adoptPreparedMaterialBindings(cache, new Set([changed.handle]));
    borrowed.release().unwrap();
    expect(cache).toHaveLength(1);
    expect(cache[0]?.handle).toBe(changed.handle);
    expect(destroyedBuffers).toHaveBeenCalledWith(firstBuffer);
    const changedBuffer = cache[0]?.buffer;
    const nextLayout = device.createBindGroupLayout({ entries }).unwrap();
    const relaid = bind(undefined, nextLayout);
    adoptPreparedMaterialBindings(cache, new Set([relaid.handle]));
    changed.release().unwrap();
    expect(cache).toHaveLength(1);
    expect(cache[0]?.handle).toBe(relaid.handle);
    expect(destroyedBuffers).toHaveBeenCalledWith(changedBuffer);
    const relaidBuffer = cache[0]?.buffer;
    (runtime as { deviceScope: DeviceScope }).deviceScope = recoveredScope;
    const recovered = bind(undefined, nextLayout);
    adoptPreparedMaterialBindings(cache, new Set([recovered.handle]));
    relaid.release().unwrap();
    expect(cache).toHaveLength(1);
    expect(cache[0]?.handle).toBe(recovered.handle);
    expect(destroyedBuffers).toHaveBeenCalledWith(relaidBuffer);
    recovered.release().unwrap();
    clearPreparedMaterialBindings(cache);
    expect(cache).toHaveLength(0);
  } finally {
    clearPreparedMaterialBindings(cache);
    store.destroyAll();
    scope.retire();
    recoveredScope.retire();
    device.destroyBuffer(buffer);
    device.destroyBuffer(fallback.intensityBuffer);
    for (const texture of [
      fallback.irradianceTexture,
      fallback.prefilterTexture,
      fallback.brdfLutTexture,
    ])
      device.destroyTexture(texture);
    assets.dispose();
  }
  expect(scope.resourceDelta()).toBe(0);
});
