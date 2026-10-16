import {
  AssetRegistry,
  createMaterialLoader,
  RuntimeMeshVertices,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { toShared } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../../../../shader-compiler/src/material/pack-cooker';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { buildGpuDrivenDraws } from '../../extract/gpu-driven';
import { renderMaterialContext } from '../../extract/material-context';
import { Materials } from '../../materials';
import { DEFAULT_STANDARD_PROFILE } from '../../pipeline/standard-profile';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { createProbeOriginSupportRecorder } from '../../raytracing/probe-origin-support';
import { probeGlobalAttemptCurrent } from '../../raytracing/renderer-probe-global';
import {
  type PreparedProbePlacement,
  RendererProbePlacement,
} from '../../raytracing/renderer-probe-placement';
import type { RenderSystemInternals } from '../../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import {
  defaultMaterialSnapshot,
  type ExtractedFrame,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../../render-system-extract';
import { PersistentRenderScene } from '../../scene/render-scene';
import { createProbeGlobalMesh, probeGlobalProfile } from './probe-global.fixture';

const seeds = [{ id: 7, generation: 1, position: [0, 0, -3] as const, cellSize: 2, traced: true }];

it('admits and freezes bounded opt-in native Card capture configuration', () => {
  const cards = { resolution: 16, maxCaptureBytes: 16 * 1024 * 1024, budget: 4096 };
  const profile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred' as const,
    probePlacement: { seeds, global: { ...probeGlobalProfile, cards } },
  };
  expect(validateRenderProfile(profile)).toBeUndefined();
  const frozen = freezeRenderProfile(profile);
  expect(frozen.probePlacement?.global?.cards).not.toBe(cards);
  expect(Object.isFrozen(frozen.probePlacement?.global?.cards)).toBe(true);
  for (const invalid of [
    { ...cards, resolution: 7 },
    { ...cards, resolution: 513 },
    { ...cards, maxCaptureBytes: 0 },
    { ...cards, maxCaptureBytes: NaN },
    { ...cards, budget: 0 },
    { ...cards, budget: 1.5 },
  ]) {
    expect(
      validateRenderProfile({
        ...profile,
        probePlacement: { seeds, global: { ...probeGlobalProfile, cards: invalid } },
      }),
    ).toBeTypeOf('string');
  }
});

it('freezes one seeds/global profile and rejects ambiguous or invalid query inputs', () => {
  const profile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred' as const,
    probePlacement: { seeds, global: probeGlobalProfile },
  };
  expect(validateRenderProfile(profile)).toBeUndefined();
  const frozen = freezeRenderProfile(profile);
  expect(Object.isFrozen(frozen.probePlacement?.global?.grid.origin)).toBe(true);
  expect(Object.isFrozen(frozen.probePlacement?.seeds[0]?.position)).toBe(true);
  expect(
    validateRenderProfile({ ...profile, probePlacement: seeds } as unknown as typeof profile),
  ).toMatch(/configuration object/);
  for (const global of [
    { ...probeGlobalProfile, rayResolution: 257 },
    { ...probeGlobalProfile, tMax: 0 },
    { ...probeGlobalProfile, maxSteps: 0 },
    { ...probeGlobalProfile, maxInstances: 0 },
    { ...probeGlobalProfile, grid: { ...probeGlobalProfile.grid, dimensions: [3, 4, 4] as const } },
  ])
    expect(validateRenderProfile({ ...profile, probePlacement: { seeds, global } })).toBeTypeOf(
      'string',
    );
});

async function fixture(nativeCards = false, cardBudget = 4096) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  Object.defineProperty(device, 'limits', {
    value: {
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8,
      maxSampledTexturesPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
    },
  });
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const world = new World(),
    lease = createRenderReadLease(world);
  const mesh = await createProbeGlobalMesh();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const materialAsset = Materials.standard({ baseColor: [1, 1, 1, 1] });
  const materialHandle = world.allocSharedRef('MaterialAsset', materialAsset);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  const material = {
    ...defaultMaterialSnapshot(),
    materialHandle: Number(materialHandle),
    materialShaderId: 'forgeax::default-standard-pbr',
    renderState: { cullMode: 'back' as const },
    paramSnapshot: { alphaCutoff: 0 },
  };
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry(shaders);
  if (nativeCards) {
    const guid = 'native-card-fixture-material';
    const cooked = await createMaterialPackCooker().cook({ guid, source: materialAsset });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid, record, artifacts: cooked.artifacts }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready');
    assets.catalog(guid, materialAsset).unwrap();
    assets.recordMaterialReadiness(guid, ready);
    Object.assign(
      material,
      resolveMaterialSnapshot(
        Number(materialHandle),
        world,
        assets,
        undefined,
        undefined,
        renderMaterialContext(
          { backendKind: 'webgpu', storageBuffer: true },
          { maxSampledTexturesPerShaderStage: 16 },
        ).materialContext,
      ),
    );
  }
  const snapshot: RenderableSnapshot = {
    worldId: 0,
    entityKey: Number(entity),
    assetHandle: Number(meshHandle),
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      submeshes: mesh.submeshes,
      indexed: true,
      materials: [material],
      fallbackMaterial: material,
    }),
  };
  const persistent = new PersistentRenderScene({ getDevice: () => device });
  const frame: ExtractedFrame = {
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
      lightViewProj: undefined,
      splitPlanes: undefined,
      cascadeCount: undefined,
      cascadeBlend: undefined,
      shadowMapSize: undefined,
      depthBias: undefined,
      normalBias: undefined,
      directionalShadowQuality: undefined,
      directionalShadowError: undefined,
      directionalCsmConfig: undefined,
      directionalCsmDirection: undefined,
    },
    environment: undefined,
    environmentReady: true,
    renderables: [snapshot],
    dispatch: [],
    shadowCasterEntityKeys: new Set(),
    shadowCasterDrawKeys: new Set(),
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    skyboxCount: 0,
    fog: undefined,
    frustumStats: { culled: 0, total: 1 },
    visibilityStats: { explicitlyHidden: 0 },
    postProcessParams: new Map(),
    visibilitySnapshots: [],
    featureVisibilitySnapshots: [],
    hiddenEntityReports: [],
  };
  const extract = () => {
    persistent.extractComposition([world], { cameraOwner: 0, resourceOwner: 0 }, 0, () => frame, [
      lease,
    ]);
    const scene = persistent.compositionGpuDrivenState();
    assert(scene);
    return { scene, worlds: [world], leases: [lease] };
  };
  const errors: unknown[] = [];
  const runtime = {
    device,
    deviceScope: { generation: 1 },
    canvas: { width: 32, height: 32 },
    assets,
    gpuStore: (() => {
      const store = new GpuResidencyCache();
      store.configureGpuDevice(
        device,
        undefined,
        () => {
          throw new Error('no cube');
        },
        device.caps,
      );
      return store;
    })(),
    getPipelineState: () => ({ defaultSampler: device.createSampler({}).unwrap() }),
    standardProfile: {
      probePlacement: {
        seeds,
        global: {
          ...probeGlobalProfile,
          ...(nativeCards
            ? { cards: { resolution: 16, maxCaptureBytes: 1024 * 1024, budget: cardBudget } }
            : {}),
        },
      },
    },
    shaderRegistry: {
      entries: () => [{ wgsl: 'fn placeRasterProbes(' }],
      findMaterialArtifact: shaders.findMaterialArtifact.bind(shaders),
    },
    createShaderModule,
    errorRegistry: { fire: (error: unknown) => errors.push(error) },
  } as unknown as RenderSystemInternals;
  const owner = new RendererProbePlacement();
  let source = extract();
  const prepare = () =>
    owner.prepare({
      runtime,
      seeds: runtime.standardProfile?.probePlacement?.seeds ?? seeds,
      camera: 1,
      world: world.identity,
      records: new Uint32Array(16),
      width: 32,
      height: 32,
      globalSource: source,
    });
  const refresh = () => {
    source = extract();
  };
  const ready = async () => {
    for (let i = 0; i < 20; i++) {
      const result = prepare();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(JSON.stringify(errors));
  };
  const texture = device
    .createTexture({ size: { width: 32, height: 32 }, format: 'r32uint', usage: 4 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const viewBuffer = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }).unwrap();
  const encode = (
    prepared: PreparedProbePlacement,
    placementOnly = false,
    omitCardStage?: 'capture' | 'selectCandidates' | 'sampleCards' | 'support',
  ) => {
    const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
    prepared
      .record(
        pass,
        {
          ...prepared,
          depth: view,
          normal: view,
          identity: view,
          records: { buffer: prepared.records, size: prepared.recordBytes },
          view: { buffer: viewBuffer, size: VIEW_UNIFORM_BYTES },
        },
        prepared.count,
      )
      .unwrap();
    const g = prepared.global;
    assert(g);
    if (!placementOnly) {
      if (g.composeRequired) g.compose(pass, g.region.input, g.region.voxelCount).unwrap();
      g.emit(
        pass,
        {
          probes: { buffer: prepared.probes, size: 32 },
          candidate: { buffer: prepared.candidate, size: 32 },
          settings: { buffer: g.raySettings, size: 16 },
          rays: { buffer: g.rays, size: g.rayCount * 48 },
          diagnostics: { buffer: g.emission, size: 16 },
        },
        1,
        g.resolution,
      ).unwrap();
      g.query(
        pass,
        {
          voxels: g.region.input.voxels,
          grid: g.region.input.settings,
          rays: { buffer: g.rays, size: g.rayCount * 48 },
          hits: { buffer: g.hits, size: g.rayCount * 64 },
          settings: { buffer: g.querySettings, size: 16 },
        },
        g.rayCount,
      ).unwrap();
      g.support(
        pass,
        {
          probes: { buffer: prepared.probes, size: 32 },
          candidate: { buffer: prepared.candidate, size: 32 },
          emission: { buffer: g.emission, size: 16 },
          hits: { buffer: g.hits, size: g.rayCount * 64 },
          voxels: g.region.input.voxels,
          grid: g.region.input.settings,
          diagnostics: { buffer: g.diagnostics, size: 96 },
        },
        1,
        g.rayCount,
      ).unwrap();
    }
    pass.end();
    const cards = g.cards;
    if (cards && !placementOnly) {
      const encoder = device.createCommandEncoder({}).unwrap();
      if (cards.captureSlice !== undefined && omitCardStage !== 'capture') {
        const raster = encoder.beginRenderPass({ colorAttachments: [] });
        cards.capture(raster).unwrap();
        raster.end();
      }
      const compute = encoder.beginComputePass({});
      const inputs = {
        hits: { buffer: g.hits, size: g.rayCount * 64 },
        instances: g.region.input.instances,
        fields: g.region.input.fields,
        bounds: g.region.input.bounds,
        grid: g.region.input.settings,
        candidates: { buffer: cards.candidates, size: g.rayCount * 32 },
        cards: cards.region.projections,
        output: { buffer: cards.samples, size: g.rayCount * 448 },
        settings: cards.region.settings,
        textures: cards.region.capture.views,
      };
      for (const stage of ['selectCandidates', 'sampleCards'] as const)
        if (stage !== omitCardStage) cards.lookup(compute, inputs, g.rayCount, stage).unwrap();
      if (omitCardStage !== 'support')
        cards
          .support(
            compute,
            {
              rays: { buffer: g.rays, size: g.rayCount * 48 },
              hits: inputs.hits,
              candidates: inputs.candidates,
              samples: inputs.output,
              output: { buffer: cards.diagnostics, size: g.rayCount * 32 },
            },
            g.rayCount,
          )
          .unwrap();
      compute.end();
      encoder.finish().unwrap();
    }
  };
  return {
    world,
    lease,
    mesh,
    meshHandle,
    materialAsset,
    materialHandle,
    materialSnapshot: material,
    persistent,
    runtime,
    owner,
    prepare,
    ready,
    refresh,
    encode,
    errors,
    dispose: () => {
      owner.dispose();
      lease.dispose();
      persistent.dispose();
      device.destroyBuffer(viewBuffer);
      device.destroyTexture(texture);
    },
  };
}

it('rejects a placement-only prefix, preserves accepted regions and fences physical use separately', async () => {
  const f = await fixture();
  const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
  try {
    const first = await f.ready();
    assert(first.global);
    f.encode(first, true);
    first.commit();
    expect(f.owner.inspect().submittedFrames).toBe(0);
    const full = await f.ready();
    assert(full.global);
    f.encode(full);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    full.track(done);
    full.commit();
    expect(f.owner.inspect().submittedFrames).toBe(1);
    const oldRegion = full.global.region;
    const replacement = {
      ...probeGlobalProfile,
      grid: { ...probeGlobalProfile.grid, coverageDistance: 0.25 },
    };
    Object.assign(f.runtime, {
      standardProfile: { probePlacement: { seeds, global: replacement } },
    });
    const rejected = await f.ready();
    assert(rejected.global);
    expect(rejected.global.region).not.toBe(oldRegion);
    f.encode(rejected);
    rejected.track(done);
    f.world.spawn({ component: Transform, data: {} }).unwrap();
    expect(rejected.fence.currentGeneration()).toBe(-1);
    rejected.commit();
    expect(destroy.mock.calls.some(([b]) => b === oldRegion.input.voxels.buffer)).toBe(false);
    expect(destroy.mock.calls.some(([b]) => b === rejected.global?.rays)).toBe(false);
    f.refresh();
    const retry = await f.ready();
    f.encode(retry);
    retry.track(done);
    retry.commit();
    expect(f.owner.inspect().state).toBe('ready');
    expect(destroy.mock.calls.some(([b]) => b === oldRegion.input.voxels.buffer)).toBe(false);
    finish();
    await done;
    await Promise.resolve();
    expect(destroy.mock.calls.some(([b]) => b === oldRegion.input.voxels.buffer)).toBe(true);
  } finally {
    f.dispose();
  }
});

it('keeps async region preparation across unrelated source ticks and rejects pre-prepare source changes', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compile = f.runtime.createShaderModule;
    assert(compile);
    Object.assign(f.runtime, {
      createShaderModule: async (...args: Parameters<typeof compile>) => {
        if (args[1].label?.startsWith('probe-global.')) await delay;
        return compile(...args);
      },
    });
    expect(f.prepare()).toBeUndefined();
    f.world.spawn({ component: Transform, data: {} }).unwrap();
    expect(f.prepare()).toBeUndefined(); // Already extracted state is stale; no sticky region error.
    f.refresh();
    expect(f.prepare()).toBeUndefined();
    release();
    const ready = await f.ready();
    expect(f.owner.inspect().global?.compositionBuilds).toBe(1);
    f.encode(ready);
    ready.track(Promise.resolve());
    ready.commit();
    const count = f.owner.inspect().submittedFrames;
    const old = f.persistent.compositionGpuDrivenState()?.retained;
    assert(old);
    f.world.spawn({ component: Transform, data: {} }).unwrap();
    expect(old.isCurrent()).toBe(true);
    expect(old.isSourceCurrent()).toBe(false);
    expect(f.prepare()).toBeUndefined();
    expect(f.owner.inspect().submittedFrames).toBe(count);
    f.refresh();
    const next = await f.ready();
    expect(f.owner.inspect().global?.compositionBuilds).toBe(1);
    f.encode(next);
    next.track(Promise.resolve());
    next.commit();
    expect(f.owner.inspect().submittedFrames).toBe(count + 1);
  } finally {
    f.dispose();
  }
});

it('rejects vertex overrides and recovers after the owning override is removed', async () => {
  const f = await fixture();
  try {
    const initial = await f.ready();
    f.encode(initial);
    initial.track(Promise.resolve());
    initial.commit();
    const content = f.world
      .spawn({
        component: RuntimeMeshVertices,
        data: {
          asset: toShared<'MeshAsset'>(Number(f.meshHandle)),
          vertices: new Float32Array(f.mesh.vertices),
        },
      })
      .unwrap();
    f.refresh();
    expect(f.prepare()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.owner.inspect()).toMatchObject({
      state: 'failed',
      error: {
        code: 'rhi-not-available',
        detail: {
          error: {
            code: 'probe-global-preparation',
            message: expect.stringContaining('retained mesh has no admitted distance field'),
            detail: {
              code: 'ray-reference-invalid',
              detail: {
                cause: 'retained mesh has no admitted distance field; rebuild its producer',
              },
            },
          },
        },
      },
    });
    expect(f.errors).toMatchObject([f.owner.inspect().error]);
    f.world.despawn(content).unwrap();
    f.refresh();
    const repaired = await f.ready();
    f.encode(repaired);
    repaired.track(Promise.resolve());
    repaired.commit();
    expect(f.owner.inspect().state).toBe('ready');
  } finally {
    f.dispose();
  }
});

it('rejects incomplete or aliased support ranges before binding or dispatch', async () => {
  const f = await fixture();
  const device = f.runtime.device;
  const owned: import('@forgeax/engine-rhi').Buffer[] = [];
  try {
    const module = (await createShaderModule(device, { code: '' })).unwrap();
    const support = createProbeOriginSupportRecorder(device, module).unwrap();
    const range = (size: number) => {
      const buffer = device.createBuffer({ size: size + 512, usage: 128 | 64 | 12 }).unwrap();
      owned.push(buffer);
      return { buffer, offset: 256, size };
    };
    const input = {
      probes: range(32),
      candidate: range(32),
      emission: range(16),
      hits: range(81 * 64),
      voxels: range(17 ** 3 * 16),
      grid: range(48),
      diagnostics: range(96),
    };
    const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
    const dispatch = vi.spyOn(pass, 'dispatchWorkgroups'),
      bind = vi.spyOn(device, 'createBindGroup');
    for (const [count, rays] of [
      [0, 81],
      [1.5, 81],
      [1, 0],
      [2, 81],
      [4097, 65536],
      [1, 65537],
    ])
      expect(support.record(pass, input, count ?? 0, rays ?? 0).ok).toBe(false);
    for (const name of Object.keys(input) as (keyof typeof input)[]) {
      for (const size of [0, input[name].size - 4, Infinity, NaN])
        expect(support.record(pass, { ...input, [name]: { ...input[name], size } }, 1, 81).ok).toBe(
          false,
        );
      for (const offset of [
        -1,
        4,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER,
        device.limits.maxBufferSize,
      ])
        expect(
          support.record(pass, { ...input, [name]: { ...input[name], offset } }, 1, 81).ok,
        ).toBe(false);
      if (name !== 'diagnostics')
        expect(
          support.record(
            pass,
            { ...input, diagnostics: { ...input.diagnostics, buffer: input[name].buffer } },
            1,
            81,
          ).ok,
        ).toBe(false);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    support.record(pass, input, 1, 81).unwrap();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(1);
    pass.end();
  } finally {
    for (const buffer of owned) device.destroyBuffer(buffer);
    f.dispose();
  }
});

it('uses the receiver accepted revision as an attempt fence without rebuilding unchanged retained content', async () => {
  const f = await fixture();
  const publisher = createRenderPublisher(f.world, f.runtime.assets, {
    source: 'global-source',
    epoch: 1,
  });
  const receiver = new RenderPublicationReceiver({ source: 'global-source', epoch: 1 });
  const scene = new PersistentRenderScene({ getDevice: () => f.runtime.device });
  const accept = () => {
    f.world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    return receiver.accept(packet).unwrap();
  };
  try {
    const first = accept();
    scene.consumePublication(first);
    const initial = scene.compositionGpuDrivenState();
    assert(initial?.retained);
    expect(first.resources.revision).toBe(first.packet.revision);
    const current = probeGlobalAttemptCurrent({
      scene: initial,
      worlds: [first.resources],
      leases: undefined,
    });
    expect(current()).toBe(true);
    const second = accept();
    expect(second.resources).toBe(first.resources);
    expect(first.resources.revision).toBe(second.packet.revision);
    expect(initial.retained.isCurrent()).toBe(true);
    expect(initial.retained.isSourceCurrent()).toBe(false);
    expect(current()).toBe(false);
    scene.consumePublication(second);
    const refreshed = scene.compositionGpuDrivenState();
    assert(refreshed?.retained);
    expect(refreshed.retained.revision).toBe(initial.retained.revision);
    expect(initial.retained.isSourceCurrent()).toBe(false);
    expect(refreshed.retained.isSourceCurrent()).toBe(true);
    expect(
      probeGlobalAttemptCurrent({
        scene: refreshed,
        worlds: [second.resources],
        leases: undefined,
      })(),
    ).toBe(true);
  } finally {
    publisher.dispose();
    receiver.dispose();
    scene.dispose();
    f.dispose();
  }
});

it('retries missing cooked projection admission after readiness repair without changing source or catalog versions', async () => {
  const f = await fixture();
  try {
    const guid = 'probe-global-material';
    const cooked = await createMaterialPackCooker().cook({ guid, source: f.materialAsset });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid, record, artifacts: cooked.artifacts }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready');
    const published = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    published.catalog(guid, f.materialAsset).unwrap();
    published.recordMaterialReadiness(guid, ready);
    f.runtime.assets.catalog(guid, f.materialAsset).unwrap();
    Object.assign(
      f.materialSnapshot,
      resolveMaterialSnapshot(
        Number(f.materialHandle),
        f.world,
        published,
        undefined,
        undefined,
        renderMaterialContext(
          { backendKind: 'webgpu', storageBuffer: true },
          { maxSampledTexturesPerShaderStage: 16 },
        ).materialContext,
      ),
    );
    f.refresh();
    const source = f.persistent.compositionGpuDrivenState()?.retained;
    assert(source);
    const version = f.lease.captureVersion(),
      epoch = f.runtime.assets.catalogEpoch;
    expect(f.prepare()).toBeUndefined();
    await expect.poll(() => f.owner.inspect().state).toBe('failed');
    expect(f.runtime.assets.getMaterialProjectionForPayload(f.materialAsset)).toBeUndefined();
    f.runtime.assets.recordMaterialReadiness(guid, ready);
    expect(f.runtime.assets.catalogEpoch).toBe(epoch);
    expect(f.lease.captureVersion()).toEqual(version);
    expect(source.isCurrent()).toBe(true);
    expect(source.isSourceCurrent()).toBe(true);
    // No extraction or World mutation is needed: the repaired projection is
    // part of the region admission key, even when prior admission had none.
    const repaired = await f.ready();
    f.encode(repaired);
    repaired.track(Promise.resolve());
    repaired.commit();
    expect(f.owner.inspect().state).toBe('ready');
    expect(f.owner.inspect().global?.compositionBuilds).toBe(2);
  } finally {
    f.dispose();
  }
}, 60000);

it('captures the native Card atlas progressively within the per-frame tile budget', async () => {
  const f = await fixture(true, 2);
  try {
    const slices: unknown[] = [];
    for (let frame = 0; frame < 8; frame++) {
      const prepared = await f.ready();
      const cards = prepared.global?.cards;
      assert(cards);
      if (cards.captureSlice === undefined) break;
      expect(f.owner.inspect().global?.cards?.captured).toBe(false);
      slices.push(cards.captureSlice);
      f.encode(prepared);
      prepared.track(Promise.resolve());
      prepared.commit();
      // Every frame publishes: probes sample the captured tiles, the rest stay invalid.
      expect(f.owner.inspect().submittedFrames).toBe(frame + 1);
    }
    const tiles = (await f.ready()).global?.cards?.region.schedule.tiles ?? 0;
    expect(tiles).toBeGreaterThan(2);
    expect(slices).toEqual(
      Array.from({ length: Math.ceil(tiles / 2) }, (_, i) => ({
        first: 2 * i,
        count: Math.min(2, tiles - 2 * i),
        clear: false,
      })),
    );
    expect(f.owner.inspect().global?.cards?.captured).toBe(true);
  } finally {
    f.dispose();
  }
}, 60000);

it('requires all native Card writers before publication and reuses only a physically captured atlas', async () => {
  const f = await fixture(true);
  try {
    for (const stage of ['capture', 'selectCandidates', 'sampleCards', 'support'] as const) {
      const prepared = await f.ready();
      assert(prepared.global?.cards?.captureSlice);
      f.encode(prepared, false, stage);
      prepared.commit();
      expect(f.owner.inspect().submittedFrames).toBe(0);
      expect(f.owner.inspect().global?.cards?.captured).toBe(false);
    }
    const unsubmitted = await f.ready();
    f.encode(unsubmitted);
    unsubmitted.commit();
    expect(f.owner.inspect().submittedFrames).toBe(0);
    const first = await f.ready();
    f.encode(first);
    first.track(Promise.resolve());
    first.commit();
    expect(f.owner.inspect().submittedFrames).toBe(1);
    expect(f.owner.inspect().global?.cards).toMatchObject({ captured: true, count: 6 });
    const next = await f.ready();
    expect(next.global?.cards?.captureSlice).toBeUndefined();
    expect(next.global?.cards?.region).toBe(first.global?.cards?.region);
    f.encode(next);
    next.track(Promise.resolve());
    next.commit();
    expect(f.owner.inspect().submittedFrames).toBe(2);
  } finally {
    f.dispose();
  }
}, 60000);
