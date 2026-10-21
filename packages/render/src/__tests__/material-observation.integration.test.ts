import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import {
  projectMeshMaterialBindingObservation,
  summarizeMeshMaterialBindings,
} from '../mesh-material-bindings';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot } from '../render-system-extract';
import {
  createMaterialResidencyObserver,
  observeMaterialResidency,
} from '../render-system-residency';

function assetWorld() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  return new World({ assets });
}

const bindings = [
  { handle: 11, source: 'renderer-override' as const },
  { handle: 12, source: 'mesh-default' as const },
  { handle: 0, source: 'engine-default' as const },
];

const failure = {
  code: 'material-specialization-stale-generation',
  expected: 'a stable material publication generation',
  hint: 'retry the producer-owned material rebuild',
  detail: { material: 'mat-a', dependencies: ['texture/a'] },
};

describe('resident MeshMaterialBindingObservation', () => {
  it('observes cloned value-only materials once per asset and scope, then refreshes the owner', () => {
    const worlds = [assetWorld(), assetWorld()] as const;
    const handles = [
      runtimeAssetRegistry(worlds[0].assets)
        .create({ kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] })
        .unwrap(),
      runtimeAssetRegistry(worlds[1].assets)
        .create({ kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] })
        .unwrap(),
    ] as const;
    expect(handles[0]).not.toBe(handles[1]);
    const reads = worlds.map((world) => vi.spyOn(worldRenderResources(world), 'resolveAsset'));
    const internals = {
      assets: new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }),
    } as RenderSystemInternals;
    const observe = createMaterialResidencyObserver(internals);
    const observations = worlds.map((world, index) =>
      observe(worldRenderResources(world), {
        ...defaultMaterialSnapshot(),
        materialHandle: handles[index],
      }),
    );
    const repeated = [];
    for (let index = 0; index < 200; index++) {
      const scope = index % 2;
      const material = {
        ...defaultMaterialSnapshot(),
        materialHandle: handles[scope],
        roughness: index / 200,
        paramSnapshot: { factor: index },
      };
      const world = worlds[scope];
      if (world === undefined) throw new Error('expected a World asset scope');
      repeated.push(observe(worldRenderResources(world), material));
    }
    expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1]);
    for (const [index, observation] of repeated.entries())
      expect(observation).toBe(observations[index % 2]);
    runtimeAssetRegistry(worlds[0].assets).release(handles[0]).unwrap();
    const next = createMaterialResidencyObserver(internals);
    expect(
      next(worldRenderResources(worlds[0]), {
        ...defaultMaterialSnapshot(),
        materialHandle: handles[0],
      }).readiness,
    ).toBe('failed');
    expect(
      next(worldRenderResources(worlds[1]), {
        ...defaultMaterialSnapshot(),
        materialHandle: handles[1],
      }).readiness,
    ).toBe('ready');
    expect(observations[0]?.readiness).toBe('ready');
    runtimeAssetRegistry(worlds[1].assets).release(handles[1]).unwrap();
  });

  it('keeps accepted runtime material readiness when the source reload is rejected', async () => {
    const world = assetWorld();
    const assets = runtimeAssetRegistry(world.assets);
    const guid = '019f0000-0000-7000-8000-000000000202';
    publishRuntimeAssets(assets, [
      {
        guid,
        asset: { kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] },
      },
    ]);
    const handle = (await assets.load(guid, 'material')).unwrap();
    const material = { ...defaultMaterialSnapshot(), materialHandle: handle };
    const internals = { assets } as RenderSystemInternals;
    const scope = worldRenderResources(world);
    const revision = scope.assetRevision(handle);
    expect(observeMaterialResidency(scope, material, internals).readiness).toBe('ready');
    publishRuntimeAssets(assets, [{ guid, asset: { kind: 'material', passes: null } as never }]);
    expect((await assets.reload(handle, { conflict: 'overwrite' })).ok).toBe(false);
    expect(scope.assetRevision(handle)).toBe(revision);
    expect(observeMaterialResidency(scope, material, internals).readiness).toBe('ready');
  });

  it('keeps texture, sampler and video overrides separate from the same value-only material', () => {
    const world = assetWorld();
    const materialHandle = runtimeAssetRegistry(world.assets)
      .create({ kind: 'material', passes: [{ name: 'main', program: { module: 'fixture' } }] })
      .unwrap();
    const missing = runtimeAssetRegistry(world.assets)
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        mips: { kind: 'none' },
        data: new Uint8Array(4),
      })
      .unwrap();
    runtimeAssetRegistry(world.assets).release(missing).unwrap();
    const internals = {
      assets: new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) }),
      dynamicTextureStore: { getView: () => undefined },
    } as unknown as RenderSystemInternals;
    const material = { ...defaultMaterialSnapshot(), materialHandle };
    const observe = createMaterialResidencyObserver(internals);
    const ready = observe(worldRenderResources(world), material);
    for (const field of [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
      'emissiveTexture',
      'occlusionTexture',
    ]) {
      expect(
        observe(worldRenderResources(world), { ...material, [field]: missing }).readiness,
      ).toBe('failed');
    }
    expect(
      observe(worldRenderResources(world), {
        ...material,
        textureHandles: new Map([['extra', missing]]),
      }).readiness,
    ).toBe('failed');
    expect(
      observe(worldRenderResources(world), {
        ...material,
        samplerHandles: new Map([['extra', Number(missing) as AssetHandle<'sampler'>]]),
      }).readiness,
    ).toBe('failed');
    expect(
      observe(worldRenderResources(world), {
        ...material,
        videoTextureFields: new Map([['extra', Number(missing) as AssetHandle<'video'>]]),
      }).readiness,
    ).toBe('pending');
    expect(observe(worldRenderResources(world), { ...material, roughness: 0.6 })).toBe(ready);
    runtimeAssetRegistry(world.assets).release(materialHandle).unwrap();
  });

  it('keeps distinct material snapshots and observes resource failures in the next phase', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(device, undefined, device.caps);
    const world = assetWorld();
    const texture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'packed', levelCount: 1 },
      data: new Uint8Array(4),
    };
    const first = runtimeAssetRegistry(world.assets).create(texture).unwrap();
    const second = runtimeAssetRegistry(world.assets)
      .create({ ...texture })
      .unwrap();
    const firstMaterial = { ...defaultMaterialSnapshot(), baseColorTexture: first };
    const secondMaterial = { ...firstMaterial, baseColorTexture: second };
    const internals = { gpuStore } as RenderSystemInternals;
    const observe = createMaterialResidencyObserver(internals);
    const ensureResident = vi.spyOn(gpuStore, 'ensureResident');
    try {
      const observation = observe(worldRenderResources(world), firstMaterial);
      expect(observe(worldRenderResources(world), firstMaterial)).toBe(observation);
      expect(observe(worldRenderResources(world), secondMaterial)).toMatchObject({
        textures: [{ handle: second }],
      });
      expect(ensureResident).toHaveBeenCalledTimes(2);
      runtimeAssetRegistry(world.assets).release(first).unwrap();
      expect(
        createMaterialResidencyObserver(internals)(worldRenderResources(world), firstMaterial)
          .readiness,
      ).toBe('failed');
      expect(observation.readiness).toBe('ready');
    } finally {
      gpuStore.destroyAll();
      runtimeAssetRegistry(world.assets).release(second).unwrap();
    }
  });

  it('projects sampler, readiness, mip, and nearest preparation failure without producer fields', () => {
    const observation = projectMeshMaterialBindingObservation({
      worldId: 2,
      entityKey: 9,
      bindings,
      diagnostics: [],
      residency: [
        {
          readiness: 'ready',
          samplers: [{ handle: 101, resident: true }],
          textures: [{ handle: 201, mipLevelCount: 4 }],
        },
        {
          readiness: 'pending',
          samplers: [{ handle: 102, resident: false }],
          textures: [{ handle: 202, mipLevelCount: 1 }],
        },
        {
          readiness: 'last-known-good',
          samplers: [{ handle: 103, resident: true }],
          textures: [{ handle: 203, mipLevelCount: 2 }],
          preparationFailure: failure,
        },
      ],
    });

    expect(observation).toMatchObject({
      worldId: 2,
      entityKey: 9,
      bindings,
      residency: [
        { readiness: 'ready', textures: [{ mipLevelCount: 4 }] },
        { readiness: 'pending' },
        { readiness: 'last-known-good', preparationFailure: failure },
      ],
    });
    expect(observation).not.toHaveProperty('materialAsset');
    expect(observation).not.toHaveProperty('producerReadiness');
  });

  it('recomputes aggregate counts from the retained observations', () => {
    const first = projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey: 1,
      bindings,
      diagnostics: [],
      residency: [
        { readiness: 'ready', samplers: [], textures: [] },
        { readiness: 'failed', samplers: [], textures: [], preparationFailure: failure },
        { readiness: 'pending', samplers: [], textures: [] },
      ],
    });
    expect(summarizeMeshMaterialBindings([first])).toEqual({
      total: 3,
      ready: 1,
      pending: 1,
      failed: 1,
      lastKnownGood: 0,
      textureCount: 0,
      samplerCount: 0,
    });

    const rebuilt = projectMeshMaterialBindingObservation({
      ...first,
      residency: [
        { readiness: 'ready', samplers: [], textures: [] },
        { readiness: 'last-known-good', samplers: [], textures: [], preparationFailure: failure },
        { readiness: 'ready', samplers: [], textures: [] },
      ],
    });
    expect(summarizeMeshMaterialBindings([rebuilt])).toEqual({
      total: 3,
      ready: 2,
      pending: 0,
      failed: 0,
      lastKnownGood: 1,
      textureCount: 0,
      samplerCount: 0,
    });
  });

  it('keeps accepted GPU texture allocations after an invalid edit and adopts a valid replacement', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(device, undefined, device.caps);
    const world = assetWorld();
    const assets = runtimeAssetRegistry(world.assets);
    const handle = assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'packed', levelCount: 3 },
        data: new Uint8Array(84),
      })
      .unwrap();
    const material = { ...defaultMaterialSnapshot(), baseColorTexture: handle };
    const internals = { gpuStore } as RenderSystemInternals;
    const createTexture = vi.spyOn(device, 'createTexture');
    const scope = worldRenderResources(world);
    try {
      const cold = observeMaterialResidency(scope, material, internals);
      expect(cold).toMatchObject({ readiness: 'ready', textures: [{ handle, mipLevelCount: 3 }] });
      for (let receiver = 0; receiver < 100; receiver++)
        expect(observeMaterialResidency(scope, material, internals)).toEqual(cold);
      expect(createTexture).toHaveBeenCalledTimes(1);
      expect(assets.update(handle, { mips: { kind: 'packed', levelCount: 0 } }).ok).toBe(false);
      expect(observeMaterialResidency(scope, material, internals)).toEqual(cold);
      expect(createTexture).toHaveBeenCalledTimes(1);
      assets.update(handle, { mips: { kind: 'none' }, data: new Uint8Array(64) }).unwrap();
      // The residency owner adopts changed textures at the next preparation boundary.
      gpuStore.invalidateTexture(handle, scope);
      expect(observeMaterialResidency(scope, material, internals)).toMatchObject({
        readiness: 'ready',
        textures: [{ handle, mipLevelCount: 1 }],
      });
      expect(createTexture).toHaveBeenCalledTimes(2);
    } finally {
      gpuStore.destroyAll();
      assets.dispose();
    }
  });
});
