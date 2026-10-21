import { readFileSync } from 'node:fs';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { prepareRuntimeAssetPublication } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../../shader-compiler/src/material/pack-cooker';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { buildGpuDrivenDraws } from '../../extract/gpu-driven';
import { renderMaterialContext } from '../../extract/material-context';
import { MaterialResource } from '../../material-resource';
import { Materials } from '../../materials';
import type { StandardIrradianceFieldGi } from '../../pipeline/standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../../pipeline/standard-profile';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { worldRenderResources } from '../../publication/resource-scope';
import * as fieldEdits from '../../raytracing/field-edit';
import { createProbeOriginSupportRecorder } from '../../raytracing/probe-origin-support';
import { RendererIrradianceField } from '../../raytracing/renderer-irradiance-field';
import {
  probeGlobalAttemptCurrent,
  probeGlobalSourceReferences,
} from '../../raytracing/renderer-probe-global';
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

// Reuse immutable producer output; each fixture owns its bytes and runtime resources.
let probeMesh: ReturnType<typeof createProbeGlobalMesh> | undefined;
let nativeCardPublication: Promise<ReturnType<typeof prepareRuntimeAssetPublication>> | undefined;
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
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry({ shaderRegistry: shaders });
  const world = new World({ assets }),
    lease = createRenderReadLease(world);
  probeMesh ??= createProbeGlobalMesh();
  const mesh = structuredClone(await probeMesh);
  const meshHandle = assets.create(mesh).unwrap();
  const materialAsset = Materials.standard({ baseColor: [1, 1, 1, 1] });
  const materialHandle = assets.create(materialAsset).unwrap();
  let loadedMaterialHandle = materialHandle;
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
  if (nativeCards) {
    const guid = '01900000-0000-7000-8000-000000000abc';
    nativeCardPublication ??= (async () => {
      const cooked = await createMaterialPackCooker().cook({ guid, source: materialAsset });
      const record = validateCookedMaterialRecord(
        (cooked.payload as { cooked: unknown }).cooked,
      ).unwrap();
      const ready = await createMaterialLoader({
        loadPublication: async () => ({ guid, record, artifacts: cooked.artifacts }),
        loadReference: async () => true,
      }).load({ guid, specializationKey: record.specializationKey ?? '' });
      assert(ready.status === 'Ready');
      return prepareRuntimeAssetPublication([
        { guid, asset: { ...materialAsset, cooked: ready.record } as MaterialAsset },
      ]);
    })();
    (await nativeCardPublication)(assets);
    const loaded = (await assets.load(guid, 'material')).unwrap();
    loadedMaterialHandle = loaded;
    assets
      .replace(materialHandle, runtimeAssets(assets).resolveAsset<MaterialAsset>(loaded).unwrap())
      .unwrap();
    Object.assign(
      material,
      resolveMaterialSnapshot(
        Number(materialHandle),
        worldRenderResources(world),
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
    material: MaterialResource.from(material),
    materials: [MaterialResource.from(material)],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh,
      deformation: 'rigid',
      materials: [material],
      fallbackMaterial: material,
    }),
  };
  const persistent = new PersistentRenderScene({ assets, getDevice: () => device });
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
    persistent.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) =>
        typeof request === 'object'
          ? {
              ...frame,
              renderables: frame.renderables.filter((snapshot) =>
                request.entitiesByWorld[snapshot.worldId]?.has(snapshot.entityKey),
              ),
            }
          : request === 'none'
            ? { ...frame, renderables: [] }
            : frame,
      [lease],
    );
    const scene = persistent.compositionGpuDrivenState();
    assert(scene);
    return { scene, worlds: [worldRenderResources(world)], leases: [lease] };
  };
  const errors: unknown[] = [];
  const runtime = {
    device,
    deviceScope: { generation: 1 },
    canvas: { width: 32, height: 32 },
    assets,
    gpuStore: (() => {
      const store = new GpuResidencyCache();
      store.configureGpuDevice(device, undefined, device.caps);
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
    source: () => source,
    snapshot,
    frame,
    entity,
    assets,
    world,
    lease,
    mesh,
    meshHandle,
    materialAsset,
    materialHandle,
    loadedMaterialHandle,
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

it('rejects edited geometry without a field and recovers after its producer is replaced', async () => {
  const f = await fixture();
  try {
    const initial = await f.ready();
    f.encode(initial);
    initial.track(Promise.resolve());
    initial.commit();
    f.assets.update(f.meshHandle, { vertices: new Float32Array(f.mesh.vertices) }).unwrap();
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
    f.assets.replace(f.meshHandle, f.mesh).unwrap();
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
  const scene = new PersistentRenderScene({ assets: f.assets, getDevice: () => f.runtime.device });
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

it('recovers program admission after replacing the bound runtime material', async () => {
  const f = await fixture(true);
  const preserved = f.assets.copy(f.materialHandle).unwrap();
  try {
    const original = runtimeAssets(f.assets).resolveAsset<MaterialAsset>(preserved).unwrap();
    assert(original);
    f.assets
      .replace(f.materialHandle, {
        ...f.materialAsset,
        passes: [{ name: 'Forward', program: { module: 'unqualified::surface' } }],
      })
      .unwrap();
    f.refresh();
    const worldVersion = f.lease.captureVersion();
    expect(f.prepare()).toBeUndefined();
    await expect.poll(() => f.owner.inspect().state).toBe('failed');
    f.assets.replace(f.materialHandle, original).unwrap();
    expect(f.lease.captureVersion()).toEqual(worldVersion);
    f.refresh();
    const repaired = await f.ready();
    f.encode(repaired);
    repaired.track(Promise.resolve());
    repaired.commit();
    expect(f.owner.inspect().state).toBe('ready');
  } finally {
    f.assets.release(preserved).unwrap();
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

it('fences asset writes through the held closure without reading the source roster', async () => {
  const f = await fixture();
  try {
    const scene = f.persistent.compositionGpuDrivenState();
    assert(scene?.retained);
    const retained = scene.retained;
    const source = {
      scene: {
        ...scene,
        retained: {
          ...retained,
          get slots(): never {
            throw new Error('asset freshness must not inspect source slots');
          },
        },
      },
      worlds: [worldRenderResources(f.world)],
      leases: [],
    };
    expect(probeGlobalSourceReferences(source)).toEqual([retained.identity, retained.revision]);
    expect(retained.isCurrent()).toBe(true);
    const unrelated = f.assets
      .create(Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.2 }))
      .unwrap();
    f.assets.update(unrelated, { values: { roughness: 0.3 } }).unwrap();
    expect(retained.isCurrent()).toBe(true);
    // Managed payload identity stays stable; the closure's change evidence must still reject it.
    f.assets.update(f.materialHandle, { values: { roughness: 0.8 } }).unwrap();
    expect(retained.isCurrent()).toBe(false);
    f.refresh();
    const current = f.persistent.compositionGpuDrivenState()?.retained;
    assert(current);
    expect(current.isCurrent()).toBe(true);
    expect(current.revision).toBeGreaterThan(retained.revision);
  } finally {
    f.dispose();
  }
});

// Null RHI qualifies the real preparation/adoption/retirement owner, not shader
// compilation, pixels, GPU completion, natural GC or performance.
async function editableIrradianceFixture() {
  const f = await fixture(true);
  propagateTransforms(f.world).unwrap();
  f.refresh();
  const move = (x: number) => {
    f.world.set(f.entity, Transform, { pos: [x, 0, 0] }).unwrap();
    propagateTransforms(f.world).unwrap();
    f.snapshot.transform.world.set(f.world.get(f.entity, GlobalTransform).unwrap().world);
    f.refresh();
  };
  const entries = ['ray-irradiance-field', 'ray-diffuse-composite', 'ray-reflection-composite'].map(
    (name) => ({
      wgsl: readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8'),
    }),
  );
  Object.assign(f.runtime.shaderRegistry ?? {}, { entries: () => entries });
  const profile: StandardIrradianceFieldGi = {
    gather: 'irradiance-field',
    maxDistance: 4,
    environment: [0, 0, 0],
    field: {
      region: {
        grid: probeGlobalProfile.grid,
        maxInstances: probeGlobalProfile.maxInstances,
        maxFieldBytes: probeGlobalProfile.maxFieldBytes,
      },
      probeSpacing: 1,
      raysPerProbe: 16,
      probeBudget: 2,
      hysteresis: 0.9,
      cards: { resolution: 16, maxCaptureBytes: 1024 * 1024, budget: 16 },
      resolution: 'half',
      radiosity: false,
    },
  };
  const owner = new RendererIrradianceField();
  const prepare = () =>
    owner.prepare({
      runtime: f.runtime,
      ...f.source(),
      lights: [],
      profile,
      width: 32,
      height: 32,
      gatherView: true,
      focus: [0, 0, 0],
    });
  const ready = async () => {
    for (let i = 0; i < 50; i++) {
      prepare();
      if (owner.ready !== undefined) return owner.ready;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(JSON.stringify(owner.inspect()));
  };
  const spawn = (meshHandle: typeof f.meshHandle) => {
    const entity = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [f.materialHandle] } },
      )
      .unwrap();
    const snapshot: RenderableSnapshot = {
      ...f.snapshot,
      entityKey: Number(entity),
      assetHandle: Number(meshHandle),
      transform: { world: mat4.identity(mat4.create()) },
    };
    Object.assign(f.frame, { renderables: [...f.frame.renderables, snapshot] });
    propagateTransforms(f.world).unwrap();
    f.refresh();
    return { entity, snapshot };
  };
  return {
    ...f,
    owner,
    prepare,
    ready,
    move,
    spawn,
    dispose: () => {
      owner.dispose();
      f.dispose();
    },
  };
}

for (const failure of [
  'second-physical-write',
  'row-adoption',
  'residency-adoption',
  'edit-box-write',
] as const)
  it(`retires a partially applied irradiance region after ${failure} and rebuilds coherently`, async () => {
    const f = await editableIrradianceFixture();
    const cleanup: (() => void)[] = [];
    try {
      const before = await f.ready();
      const retire = vi.spyOn(before, 'retire');
      const quiet = [...before.editState.values()].find((row) => row.index === 0)?.transform[12];
      f.move((quiet ?? 0) + 1);
      const current = f.source().scene;
      assert(current.retained);
      expect(current.retained.revision).toBeGreaterThan(before.retained.revision);
      expect(current.retained.meshes).toBe(before.retained.meshes);
      expect(current.scene.changedSlotsSince(before.revision)).toContain(0);
      const planning = vi.spyOn(fieldEdits, 'diffFieldEdit');
      cleanup.push(() => planning.mockRestore());
      let injected = false;
      if (failure === 'row-adoption') {
        const spy = vi.spyOn(fieldEdits, 'adoptFieldEdit').mockImplementation(() => {
          injected = true;
          throw new Error(failure);
        });
        cleanup.push(() => spy.mockRestore());
      } else if (failure === 'residency-adoption') {
        assert(before.residency !== undefined);
        const spy = vi.spyOn(before.residency, 'applyEdit').mockImplementation(() => {
          injected = true;
          throw new Error(failure);
        });
        cleanup.push(() => spy.mockRestore());
      } else {
        const queue = f.runtime.device.queue,
          write = queue.writeBuffer.bind(queue);
        let writes = 0;
        const spy = vi.spyOn(queue, 'writeBuffer').mockImplementation((...args) => {
          writes++;
          if (
            (failure === 'second-physical-write' && writes === 2) ||
            (failure === 'edit-box-write' &&
              args[0] === before.region.input.settings.buffer &&
              args[1] === 40)
          ) {
            injected = true;
            throw new Error(failure);
          }
          return write(...args);
        });
        cleanup.push(() => spy.mockRestore());
      }
      f.prepare();
      expect(planning).toHaveBeenCalledOnce();
      expect(injected).toBe(true);
      expect(retire).toHaveBeenCalledOnce();
      expect(f.owner.ready).toBeUndefined();
      for (const restore of cleanup.splice(0)) restore();
      const replacement = await f.ready();
      expect(replacement).not.toBe(before);
      expect(
        [...replacement.editState.values()].find((row) => row.index === 0)?.transform[12],
      ).toBe((quiet ?? 0) + 1);
      expect(replacement.editState.size).toBe(1);
      expect(replacement.retained).toBe(f.source().scene.retained);
    } finally {
      for (const restore of cleanup) restore();
      f.dispose();
    }
  });

it('reports current async field synchronization failure after retiring its candidate, then recovers on a fresh source', async () => {
  const f = await editableIrradianceFixture();
  const planning = vi.spyOn(fieldEdits, 'diffFieldEdit').mockImplementation(() => {
    throw new Error('async-field-sync-fault');
  });
  const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
  const compile = f.runtime.createShaderModule;
  assert(compile !== undefined);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const compiler = vi
    .spyOn(f.runtime, 'createShaderModule')
    .mockImplementation(async (device, desc) => {
      // The actual Global SDF/Card region has passed its current-source fence
      // before this first Irradiance-only compile, but its candidate is unpublished.
      if (!held && desc.label === 'irradiance-field.visibility') {
        held = true;
        entered();
        await gate;
      }
      return compile(device, desc);
    });
  try {
    const previous = f.source().scene.retained;
    f.prepare();
    await waiting;
    f.move(1);
    expect(f.source().scene.retained?.revision).toBeGreaterThan(previous?.revision ?? -1);
    expect(f.source().scene.retained?.meshes).toBe(previous?.meshes);
    f.prepare();
    release();
    for (let i = 0; i < 50 && f.owner.inspect().state !== 'failed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toBe(true);
    expect(planning).toHaveBeenCalledOnce();
    expect(f.owner.inspect().state).toBe('failed');
    expect(f.owner.ready).toBeUndefined();
    expect(f.errors).toHaveLength(1);
    expect(destroy).toHaveBeenCalled();
    planning.mockRestore();
    compiler.mockRestore();
    f.move(2);
    const healthy = await f.ready();
    expect([...healthy.editState.values()].find((row) => row.index === 0)?.transform[12]).toBe(2);
  } finally {
    release();
    planning.mockRestore();
    compiler.mockRestore();
    destroy.mockRestore();
    f.dispose();
  }
});
