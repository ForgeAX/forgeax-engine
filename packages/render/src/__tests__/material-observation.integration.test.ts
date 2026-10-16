import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type TextureAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import {
  projectMeshMaterialBindingObservation,
  summarizeMeshMaterialBindings,
} from '../mesh-material-bindings';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import {
  createMaterialResidencyObserver,
  observeMaterialResidency,
} from '../render-system-residency';

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
    const worlds = [new World(), new World()] as const;
    const handles = [
      worlds[0].allocSharedRef('MaterialAsset', { kind: 'material' }),
      worlds[1].allocSharedRef('MaterialAsset', { kind: 'material' }),
    ] as const;
    expect(handles[0]).toBe(handles[1]);
    const reads = worlds.map((world) => vi.spyOn(world.sharedRefs, 'resolve'));
    const internals = {
      assets: new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
    } as RenderSystemInternals;
    const observe = createMaterialResidencyObserver(internals);
    const observations = worlds.map((world, index) =>
      observe(world, { ...defaultMaterialSnapshot(), materialHandle: handles[index] }),
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
      repeated.push(observe(worlds[scope], material));
    }
    expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1]);
    for (const [index, observation] of repeated.entries())
      expect(observation).toBe(observations[index % 2]);
    worlds[0].sharedRefs.release(handles[0]).unwrap();
    const next = createMaterialResidencyObserver(internals);
    expect(
      next(worlds[0], { ...defaultMaterialSnapshot(), materialHandle: handles[0] }).readiness,
    ).toBe('failed');
    expect(
      next(worlds[1], { ...defaultMaterialSnapshot(), materialHandle: handles[1] }).readiness,
    ).toBe('ready');
    expect(observations[0]?.readiness).toBe('ready');
    worlds[1].sharedRefs.release(handles[1]).unwrap();
  });

  it('reads cooked child readiness from the accepted program owner', () => {
    const world = new World();
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    const root = '019f0000-0000-7000-8000-000000000201';
    const child = '019f0000-0000-7000-8000-000000000202';
    const payload = { kind: 'material' as const, parent: assets.parseGuid(root), values: {} };
    assets.catalog(child, payload).unwrap();
    const missing = {
      status: 'Error' as const,
      error: {
        code: 'material-specialization-not-cooked' as const,
        expected: 'the selected material program is cooked',
        hint: 'cook the selected program',
        retryable: false,
        recoveryActions: [],
        detail: { guid: child, specializationKey: '' },
      },
    };
    assets.recordMaterialReadiness(child, missing);
    const material = {
      ...defaultMaterialSnapshot(),
      materialHandle: world.allocSharedRef('MaterialAsset', payload),
    };
    const internals = { assets } as RenderSystemInternals;
    const accepted = {
      ...material,
      materialPublication: {
        identity: {
          materialGuid: root,
          publicationGeneration: 1,
          specializationKey: 'root/1',
          artifactHash: 'sha256:accepted-root',
        },
        programs: [],
      },
    };
    expect(observeMaterialResidency(world, accepted, internals).readiness).toBe('ready');
    // An uncooked child and a failed actual program owner remain failures.
    expect(observeMaterialResidency(world, material, internals).readiness).toBe('failed');
    assets.recordMaterialReadiness(root, {
      ...missing,
      error: { ...missing.error, detail: { ...missing.error.detail, guid: root } },
    });
    expect(observeMaterialResidency(world, accepted, internals).readiness).toBe('failed');
  });

  it('keeps texture, sampler and video overrides separate from the same value-only material', () => {
    const world = new World();
    const materialHandle = world.allocSharedRef('MaterialAsset', { kind: 'material' });
    const missing = world.allocSharedRef('TextureAsset', { kind: 'texture' } as TextureAsset);
    world.sharedRefs.release(missing).unwrap();
    const internals = {
      assets: new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
      dynamicTextureStore: { getView: () => undefined },
    } as unknown as RenderSystemInternals;
    const material = { ...defaultMaterialSnapshot(), materialHandle };
    const observe = createMaterialResidencyObserver(internals);
    const ready = observe(world, material);
    for (const field of [
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
      'emissiveTexture',
      'occlusionTexture',
    ]) {
      expect(observe(world, { ...material, [field]: missing }).readiness).toBe('failed');
    }
    expect(
      observe(world, { ...material, textureHandles: new Map([['extra', missing]]) }).readiness,
    ).toBe('failed');
    expect(
      observe(world, {
        ...material,
        samplerHandles: new Map([['extra', toShared<'SamplerAsset'>(missing)]]),
      }).readiness,
    ).toBe('failed');
    expect(
      observe(world, {
        ...material,
        videoTextureFields: new Map([['extra', toShared<'VideoAsset'>(missing)]]),
      }).readiness,
    ).toBe('pending');
    expect(observe(world, { ...material, roughness: 0.6 })).toBe(ready);
    world.sharedRefs.release(materialHandle).unwrap();
  });

  it('keeps distinct material snapshots and observes resource failures in the next phase', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('no cubemap');
      },
      device.caps,
    );
    const world = new World();
    const texture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'packed', levelCount: 1 },
      data: new Uint8Array(4),
    };
    const first = world.allocSharedRef('TextureAsset', texture);
    const second = world.allocSharedRef('TextureAsset', { ...texture });
    const firstMaterial = { ...defaultMaterialSnapshot(), baseColorTexture: first };
    const secondMaterial = { ...firstMaterial, baseColorTexture: second };
    const internals = { gpuStore } as RenderSystemInternals;
    const observe = createMaterialResidencyObserver(internals);
    const ensureResident = vi.spyOn(gpuStore, 'ensureResident');
    try {
      const observation = observe(world, firstMaterial);
      expect(observe(world, firstMaterial)).toBe(observation);
      expect(observe(world, secondMaterial)).toMatchObject({ textures: [{ handle: second }] });
      expect(ensureResident).toHaveBeenCalledTimes(2);
      world.sharedRefs.release(first).unwrap();
      expect(createMaterialResidencyObserver(internals)(world, firstMaterial).readiness).toBe(
        'failed',
      );
      expect(observation.readiness).toBe('ready');
    } finally {
      gpuStore.destroyAll();
      world.sharedRefs.release(second).unwrap();
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

  it('keeps accepted texture allocations while observing mutable source mip validity', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('no cubemap');
      },
      device.caps,
    );
    const world = new World();
    const shape = vi.fn(() => ({ viewDimension: '2d' as const, extent: { width: 4, height: 4 } }));
    const mips = { kind: 'packed' as const, levelCount: 3 };
    const texture: TextureAsset = {
      kind: 'texture',
      get shape() {
        return shape();
      },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips,
      data: new Uint8Array(84),
    };
    const handle = world.allocSharedRef('TextureAsset', texture);
    const material = { baseColorTexture: handle } as MaterialSnapshot;
    const internals = { gpuStore } as RenderSystemInternals;
    const createTexture = vi.spyOn(device, 'createTexture');
    try {
      const cold = observeMaterialResidency(world, material, internals);
      expect(cold).toMatchObject({ readiness: 'ready', textures: [{ handle, mipLevelCount: 3 }] });
      expect(shape).toHaveBeenCalled();
      shape.mockClear();
      for (let receiver = 0; receiver < 100; receiver++) {
        expect(observeMaterialResidency(world, material, internals)).toEqual(cold);
      }
      expect(shape).toHaveBeenCalledTimes(100);
      expect(createTexture).toHaveBeenCalledTimes(1);
      mips.levelCount = 0;
      expect(observeMaterialResidency(world, material, internals).preparationFailure?.code).toBe(
        'texture-mip-policy-invalid',
      );
      mips.levelCount = 2;
      // A valid author edit alone does not replace the accepted GPU allocation.
      expect(observeMaterialResidency(world, material, internals).textures).toEqual(cold.textures);
      mips.levelCount = 3;
      gpuStore.invalidateTexture(handle, world);
      expect(observeMaterialResidency(world, material, internals)).toEqual(cold);
      expect(shape).toHaveBeenCalled();
      expect(createTexture).toHaveBeenCalledTimes(2);
    } finally {
      gpuStore.destroyAll();
      world.sharedRefs.release(handle).unwrap();
    }
  });
});
