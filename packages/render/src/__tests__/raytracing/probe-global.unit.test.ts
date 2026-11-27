import { readFileSync } from 'node:fs';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { describeMeshDraw } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type Buffer,
  type ComputePipeline,
  type Result,
  RhiError,
  type RhiRayQueryLimits,
  type Texture,
} from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullAdapter, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { err, type MaterialAsset, ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { prepareRuntimeAssetPublication } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { compileShader } from '../../../../shader-compiler/src/compile';
import { createMaterialPackCooker } from '../../../../shader-compiler/src/material/pack-cooker';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import {
  createScreenReceiverProfile,
  freezeRenderProfile,
  validateRenderProfile,
} from '../../assembly/renderer-facade';
import { MeshFilter, MeshRenderer } from '../../components';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { buildGpuDrivenDraws } from '../../extract/gpu-driven';
import { renderMaterialContext } from '../../extract/material-context';
import { MaterialResource } from '../../material-resource';
import { Materials } from '../../materials';
import { createRenderProfileSelection } from '../../pipeline/render-profile-selection';
import type { StandardIrradianceFieldGi } from '../../pipeline/standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../../pipeline/standard-profile';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { encodeRenderPublication } from '../../publication/record';
import { worldRenderResources } from '../../publication/resource-scope';
import { CardCaptureScheduler } from '../../raytracing/card-capture-schedule';
import { packCardLookupProjections } from '../../raytracing/card-lookup';
import { CardResidency } from '../../raytracing/card-residency';
import * as fieldEdits from '../../raytracing/field-edit';
import * as fieldReceivers from '../../raytracing/field-receiver';
import { adoptFieldSourceEpoch, writeFieldEdit } from '../../raytracing/irradiance-field-edit';
import { addIrradianceFieldPasses } from '../../raytracing/irradiance-field-graph';
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
import { RendererScreenProbe } from '../../raytracing/renderer-screen-probe';
import { addScreenProbePasses } from '../../raytracing/screen-probe-graph';
import { SCREEN_PROBE_DEFAULTS } from '../../raytracing/screen-probe-plan';
import { prepareSurfaceCapture, type SurfaceCapture } from '../../raytracing/surface-cards';
import {
  projectVisibleSurfaces,
  type VisibleSurfaceProjection,
  VisibleSurfaceRows,
} from '../../raytracing/visible-surface';
import { encodeCaptureOnlyFrame, frameSubmissionHooks } from '../../record/frame-submission';
import type { RenderSystemInternals } from '../../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import type { RenderPipelineFrame } from '../../render-pipeline';
import {
  defaultMaterialSnapshot,
  type ExtractedFrame,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../../render-system-extract';
import { PersistentRenderScene } from '../../scene/render-scene';
import {
  beginFrameSubmission,
  frameSubmitOutcome,
  submitEncodedFrame,
} from '../../world/frame-submit-systems';
import { registerGiSystems } from '../../world/gi-systems';
import { renderFrameEncoder } from '../../world/record-systems';
import { createRenderWorld, renderSubmission, runRenderRecord } from '../../world/render-world';
import { recordContext } from '../../world/view-record-context';
import { createProbeGlobalMesh, probeGlobalProfile } from './probe-global.fixture';

// Reuse immutable producer output; each fixture owns its bytes and runtime resources.
let probeMesh: ReturnType<typeof createProbeGlobalMesh> | undefined;
let nativeCardPublication: Promise<ReturnType<typeof prepareRuntimeAssetPublication>> | undefined;
let publishedScreen: Promise<readonly { wgsl: string }[]> | undefined;

async function addPublishedScreenFixture(registry: ShaderRegistry) {
  publishedScreen ??= (async () => {
    const { imports, rayScreenProbe, rayScreenProbeGenerate } = await loadEngineShaderEntries();
    return Promise.all(
      [rayScreenProbe, rayScreenProbeGenerate].map(async ({ source, id, defines }) =>
        (await compileShader(source, { id, imports, defines: defines ?? {} })).unwrap(),
      ),
    );
  })();
  const entries = [...registry.entries(), ...(await publishedScreen)];
  Object.assign(registry, { entries: () => entries });
}

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

async function fixture(nativeCards = false, cardBudget = 4096, rayQuery?: RhiRayQueryLimits) {
  const adapter =
    rayQuery === undefined
      ? (await rhi.requestAdapter()).unwrap()
      : new RhiNullAdapter({ rayQuery });
  const device = (await adapter.requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  Object.defineProperty(device, 'limits', {
    value: {
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8,
      maxSampledTexturesPerShaderStage: 16,
      maxTextureDimension2D: 8192,
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
      // Deliver every cooked program through the real compact artifact route.
      // Each Registry still reads, verifies, decodes and adopts its own publication.
      const artifacts = Object.fromEntries(
        ready.record.programs.map(({ artifact }) => [
          artifact.path,
          {
            path: artifact.path,
            mediaType: artifact.mediaType,
            contentEncoding: 'identity' as const,
            byteLength: artifact.bytes.byteLength,
            integrity: { algorithm: 'sha256' as const, digest: artifact.digest },
          },
        ]),
      );
      const programs = ready.record.programs.map(({ artifact, ...program }) => ({
        ...program,
        artifact: { path: artifact.path, mediaType: artifact.mediaType, digest: artifact.digest },
      }));
      return prepareRuntimeAssetPublication(
        [
          {
            guid,
            asset: { ...materialAsset, cooked: { ...ready.record, programs } } as MaterialAsset,
            artifacts,
          },
        ],
        Object.fromEntries(
          ready.record.programs.map(({ artifact }) => [artifact.path, artifact.bytes]),
        ),
      );
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
    entityKey: Number(entity),
    assetHandle: Number(meshHandle),
    transform: { world: mat4.identity(mat4.create()) },
    material: MaterialResource.from(material),
    materials: [MaterialResource.from(material)],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: buildGpuDrivenDraws({
      mesh: describeMeshDraw(mesh),
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
      depthBias: undefined,
      normalBias: undefined,
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
    visibilitySnapshot: undefined,
    hiddenEntityReports: [],
  };
  const extract = () => {
    persistent.extractComposition(
      world,
      assets,
      (request) =>
        typeof request === 'object'
          ? {
              ...frame,
              renderables: frame.renderables.filter((snapshot) =>
                request.entities?.has(snapshot.entityKey),
              ),
            }
          : request === 'none'
            ? { ...frame, renderables: [] }
            : frame,
      lease,
    );
    const scene = persistent.compositionGpuDrivenState();
    assert(scene);
    return { scene, sourceScope: worldRenderResources(world), lease };
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
        for (const phase of ['material', 'identity'] as const) {
          const raster = encoder.beginRenderPass({ colorAttachments: [] });
          cards.capture(raster, phase).unwrap();
          raster.end();
        }
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
    const support = (await createProbeOriginSupportRecorder(device, module)).unwrap();
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
      grid: range(64),
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
    return receiver.accept(encodeRenderPublication(packet)).unwrap();
  };
  try {
    const first = accept();
    scene.consumePublication(first);
    const initial = scene.compositionGpuDrivenState();
    assert(initial?.retained);
    expect(first.resources.revision).toBe(first.packet.revision);
    const current = probeGlobalAttemptCurrent({
      scene: initial,
      sourceScope: first.resources,
      lease: undefined,
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
        sourceScope: second.resources,
        lease: undefined,
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
      sourceScope: worldRenderResources(f.world),
      lease: undefined,
    };
    expect(probeGlobalSourceReferences(source, 7)).toEqual([retained.identity, 7]);
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
async function editableIrradianceFixture(
  initialGatherView = true,
  rayQuery?: RhiRayQueryLimits,
  hardwareRayTracing?: boolean,
) {
  const f = await fixture(true, 4096, rayQuery);
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
      programContract: {
        schemaVersion: 'shader-program-contract/1' as const,
        gbuffer: 'standard-gbuffer/2' as const,
      },
    }),
  );
  Object.assign(f.runtime.shaderRegistry ?? {}, { entries: () => entries });
  let profile: StandardIrradianceFieldGi = {
    gather: 'irradiance-field',
    maxDistance: 4,
    environment: [0, 0, 0],
    field: {
      ...(hardwareRayTracing === undefined ? {} : { hardwareRayTracing }),
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
  let gatherView = initialGatherView;
  let visibleSurface: VisibleSurfaceProjection | undefined;
  const prepare = () =>
    owner.prepare({
      runtime: f.runtime,
      ...f.source(),
      lights: [],
      profile,
      width: 32,
      height: 32,
      gatherView,
      focus: [0, 0, 0],
      visibleSurface,
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
    profile: () => profile,
    setGatherView: (requested: boolean) => {
      gatherView = requested;
    },
    setVisibleSurface: (projection: VisibleSurfaceProjection) => {
      visibleSurface = projection;
    },
    setFieldDemand: (resolution: 'full' | 'half', radiosity: boolean) => {
      profile = { ...profile, field: { ...profile.field, resolution, radiosity } };
    },
    setReflections: (enabled: boolean) => {
      const { reflections: _reflections, ...diffuse } = profile;
      profile = enabled
        ? { ...diffuse, reflections: { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 } }
        : diffuse;
    },
    move,
    spawn,
    remove: () => {
      f.world.despawn(f.entity).unwrap();
      Object.assign(f.frame, {
        renderables: f.frame.renderables.filter((row) => row.entityKey !== Number(f.entity)),
      });
      f.refresh();
    },
    dispose: () => {
      owner.dispose();
      f.dispose();
    },
  };
}

it.each([
  'no-rq',
  'instance-limit',
  'primitive-limit',
  'off',
  'hw',
] as const)('keeps actual software Screen preparing until this frame requests identity (%s)', {
  timeout: 60_000,
}, async (lane) => {
  const limits = {
    maxBlasGeometryCount: 1024,
    maxBlasPrimitiveCount: lane === 'primitive-limit' ? 1 : 65536,
    maxTlasInstanceCount: lane === 'instance-limit' ? 1 : 1024,
    maxAccelerationStructuresPerShaderStage: 1,
  };
  const f = await editableIrradianceFixture(
    false,
    lane === 'no-rq' ? undefined : limits,
    lane === 'off' ? false : undefined,
  );
  const screen = new RendererScreenProbe();
  const inputs: (Texture | Buffer)[] = [];
  const baselineDesc = { size: 32 * 32 * 16, usage: 128 };
  const baseline = f.runtime.device.createBuffer(baselineDesc).unwrap();
  inputs.push(baseline);
  try {
    if (lane === 'instance-limit') f.spawn(f.meshHandle);
    const profile = {
      ...f.profile(),
      gather: 'screen-probe' as const,
      probes:
        lane === 'no-rq'
          ? {
              ...SCREEN_PROBE_DEFAULTS,
              integration: 'screen-space' as const,
              irradiance: 'probe-sh3' as const,
              shortRangeAoMode: 'half-scalar' as const,
            }
          : SCREEN_PROBE_DEFAULTS,
    };
    const frozen = createRenderProfileSelection().select(
      freezeRenderProfile({ ...DEFAULT_STANDARD_PROFILE, diffuseGi: profile }),
      f.runtime.device,
    );
    const effective = createScreenReceiverProfile(() => f.owner.plannedTraversal === 'global-sdf');
    // Lock a frame before its late selection becomes usable by the writer.
    const firstFrame = effective(frozen, 0, 1, 1);
    const field = await f.ready();
    expect(field.traversal).toBe(lane === 'hw' ? 'ray-query' : 'global-sdf');
    const registry = f.runtime.shaderRegistry;
    assert(registry);
    await addPublishedScreenFixture(registry);

    for (let i = 0; i < 50; i++) {
      screen.prepare({
        reconstruction: 'current-support',
        runtime: f.runtime,
        profile,
        field,
        width: 32,
        height: 32,
        visibleSurface: frozen.visibleSurface === true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (lane === 'off' || lane === 'hw') expect(screen.ready).toBeDefined();
    else {
      expect(screen.ready).toBeUndefined();
      expect(screen.inspect(f.owner.inspect()).state).toBe('preparing');
    }
    expect(effective(frozen, 0, 1, 1)).toBe(firstFrame);
    const nextFrame = effective(frozen, 1, 1, 1);
    expect(nextFrame?.visibleSurface === true).toBe(lane !== 'hw');
    if (lane === 'hw') expect(nextFrame).toBe(frozen);
    const rows = new VisibleSurfaceRows();
    if (nextFrame?.visibleSurface) {
      const retained = f.source().scene.retained;
      assert(retained);
      f.setVisibleSurface(rows.update(retained, 1024).unwrap());
    }
    const nextField = await f.ready();
    for (let i = 0; i < 50 && screen.ready === undefined; i++) {
      screen.prepare({
        reconstruction: 'current-support',
        runtime: f.runtime,
        profile,
        field: nextField,
        width: 32,
        height: 32,
        visibleSurface: nextFrame?.visibleSurface === true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const prepared = screen.ready;
    assert(prepared);
    expect(prepared.receiver !== undefined).toBe(lane !== 'hw');
    if (lane !== 'hw') expect(prepared.receivers.unwrap().state).toBe('ready');
    if (lane === 'no-rq') {
      for (let frame = 2; frame < 5; frame++) {
        f.move(frame * 0.05);
        expect(effective(frozen, frame, 1, 1)).toBe(nextFrame);
        const retained = f.source().scene.retained;
        assert(retained);
        f.setVisibleSurface(rows.update(retained, 1024).unwrap());
        const updated = await f.ready();
        screen.prepare({
          reconstruction: 'current-support',
          runtime: f.runtime,
          profile,
          field: updated,
          width: 32,
          height: 32,
          visibleSurface: true,
        });
        expect(screen.ready?.receivers.unwrap().state).toBe('ready');
      }
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const texture = (
        name: string,
        format: 'rgba16float' | 'r32uint' | 'rg32uint' | 'rgba32uint' | 'r32float' | 'depth32float',
      ) => {
        const descriptor = { format, size: { width: 32, height: 32 }, usage: 4 | 16 };
        const texture = f.runtime.device.createTexture(descriptor).unwrap();
        inputs.push(texture);
        const view = f.runtime.device.createTextureView(texture, {}).unwrap();
        const handle = graph.importTexture(name, descriptor, () => texture).unwrap();
        return {
          texture: handle,
          view: graph.importView(handle, {}, () => view).unwrap(),
          format,
          sampleCount: 1 as const,
        };
      };
      const closestHzb = texture('hzb-closest', 'r32float');
      const hzb = texture('hzb', 'r32float');
      const targets = {
        scene: texture('scene', 'rgba16float'),
        diffuseGiBaseline: graph
          .importBuffer('direct-diffuse-baseline', baselineDesc, () => baseline)
          .unwrap(),
        depth: texture('depth', 'depth32float').view,
        normal: texture('normal', 'r32uint'),
        albedo: texture('albedo', 'r32uint'),
        f0: texture('f0', 'rg32uint'),
        motion: texture('motion', 'rgba16float'),
        closestHzb: () => ok(closestHzb.view),
        sceneHzb: () => ok(hzb.view),
        identity: texture('identity', 'rgba32uint'),
      };
      addScreenProbePasses(graph, prepared, targets).unwrap();
      const compiled = graph
        .compile({ device: f.runtime.device, surfaceSize: { width: 32, height: 32 } })
        .unwrap();
      try {
        const { passes } = compiled.inspect();
        expect(passes.some((pass) => pass.name === 'screen-probe.prepare-receivers')).toBe(true);
        expect(
          passes.find(({ name }) => name === 'screen-probe.trace-screen')?.accesses,
        ).toContainEqual({
          resource: 'hzb-closest',
          usage: 'sampled-read',
        });
        expect(
          passes.find(({ name }) => name === 'screen-probe.short-range-ao')?.accesses,
        ).toContainEqual({
          resource: 'hzb',
          usage: 'sampled-read',
        });
      } finally {
        (await compiled.retire()).unwrap();
      }
      const replacement = await editableIrradianceFixture(false);
      try {
        f.owner.prepare({
          runtime: replacement.runtime,
          ...replacement.source(),
          lights: [],
          profile: replacement.profile(),
          width: 32,
          height: 32,
          gatherView: false,
          focus: [0, 0, 0],
        });
        // Equal numeric generations do not borrow another World/device choice.
        expect(f.owner.plannedTraversal).toBeUndefined();
        expect(effective(frozen, 5, 1, 1)).toBe(frozen);
      } finally {
        f.owner.dispose();
        replacement.dispose();
      }
      f.owner.dispose();
      expect(f.owner.plannedTraversal).toBeUndefined();
      expect(effective(frozen, 6, 1, 1)).toBe(frozen);
    }
    expect(f.errors).toEqual([]);
  } finally {
    screen.dispose();
    for (const texture of inputs) f.runtime.device.destroyTexture(texture);
    f.dispose();
  }
});

it('derives receiver metadata only on demand and rejects a replaced raster frame', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const derive = vi.spyOn(fieldReceivers, 'deriveFieldReceivers');
  const rows = new VisibleSurfaceRows();
  try {
    const retained = f.source().scene.retained;
    assert(retained);
    const first = rows.update(retained, 1024).unwrap();
    f.setVisibleSurface(first);
    const field = await f.ready();
    for (let index = 0; index < 8; index++) {
      expect(f.owner.ready).toBe(field);
      expect(f.owner.inspect().state).toBe('ready');
    }
    expect(derive).not.toHaveBeenCalled();
    const result = field.receivers;
    const metadata = result.unwrap();
    assert(metadata.state === 'ready');
    expect(derive).toHaveBeenCalledTimes(1);
    expect(field.receivers).toBe(result);
    expect(derive).toHaveBeenCalledTimes(1);
    const row = first.entityBases.get(Number(f.entity));
    assert(row !== undefined);
    expect(metadata.resolve(row, 0, field.canonical.expected, field).unwrap().state).toBe(
      'identified',
    );
    const replacement = rows.update(retained, 1024).unwrap();
    expect(replacement).not.toBe(first);
    expect(replacement.records).toBe(first.records);
    f.setVisibleSurface(replacement);
    f.prepare();
    expect(f.owner.ready).toBe(field);
    expect(derive).toHaveBeenCalledTimes(1);
    // No consumer has requested the replacement metadata yet. The old result
    // must already be invalid, even when the backing and source revision match.
    expect(metadata.resolve(row, 0, field.canonical.expected, field).unwrap()).toEqual({
      state: 'unavailable',
      reason: 'stale-owner',
    });
    const next = field.receivers.unwrap();
    assert(next.state === 'ready');
    expect(derive).toHaveBeenCalledTimes(2);
    expect(next.resolve(row, 0, field.canonical.expected, field).unwrap().state).toBe('identified');
  } finally {
    derive.mockRestore();
    f.dispose();
  }
});

it('derives receiver identity from the actual ready field and same-frame raster projection', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  try {
    const source = f.source();
    const retained = source.scene.retained;
    assert(retained);
    const raster = projectVisibleSurfaces(retained.slots, 1024, retained).unwrap();
    f.setVisibleSurface(raster);
    const field = await f.ready();
    const result = field.receivers;
    expect(result).toMatchObject({ ok: true });
    const receivers = result.unwrap();
    expect(receivers).toMatchObject({ state: 'ready' });
    assert(receivers.state === 'ready');
    const row = raster.entityBases.get(Number(f.entity));
    assert(row !== undefined);
    const identity = receivers.resolve(row, 0, field.canonical.expected, field).unwrap();
    expect(identity).toMatchObject({
      state: 'identified',
      canonicalRow: 0,
      primitive: 0,
      contact: { state: 'unavailable', reason: 'receiver-contact-unqualified' },
    });
  } finally {
    f.dispose();
  }
});

it('keeps ready Screen receivers on the accepted frame when raster storage is reused', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const screen = new RendererScreenProbe();
  const rows = new VisibleSurfaceRows();
  try {
    const retained = f.source().scene.retained;
    assert(retained);
    const first = rows.update(retained, 1024).unwrap();
    f.setVisibleSurface(first);
    const initial = await f.ready();
    const before = initial.receivers.unwrap();
    assert(before.state === 'ready');
    const registry = f.runtime.shaderRegistry;
    assert(registry);
    await addPublishedScreenFixture(registry);
    const profile = {
      ...f.profile(),
      gather: 'screen-probe' as const,
      probes: SCREEN_PROBE_DEFAULTS,
    };
    for (let i = 0; i < 50 && screen.ready === undefined; i++) {
      screen.prepare({
        runtime: f.runtime,
        visibleSurface: true,
        profile,
        field: initial,
        width: 32,
        height: 32,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const prepared = screen.ready;
    assert(prepared);
    expect(prepared.receivers).toBe(initial.receivers);
    const revision = first.source?.revision;
    f.move(0.25);
    const nextRetained = f.source().scene.retained;
    assert(nextRetained);
    const next = rows.update(nextRetained, 1024).unwrap();
    expect(next.records.buffer).toBe(first.records.buffer);
    expect(next.layout).toBe(first.layout);
    expect(first.source?.revision).toBe(revision);
    expect(next.source?.revision).not.toBe(revision);
    // Real owner API, same borrowed row backing, old immutable witness.
    f.setVisibleSurface(first);
    const current = await f.ready();
    expect(current.receivers.unwrap()).toEqual({ state: 'unavailable', reason: 'stale-source' });
    f.setVisibleSurface(next);
    const ready = await f.ready();
    const mapped = ready.receivers.unwrap();
    assert(mapped.state === 'ready');
    const address = next.entityBases.get(Number(f.entity));
    assert(address !== undefined);
    expect(mapped.resolve(address, 0, ready.canonical.expected, ready).unwrap().state).toBe(
      'identified',
    );
    expect(before.resolve(address, 0, ready.canonical.expected, ready).unwrap()).toEqual({
      state: 'unavailable',
      reason: 'stale-owner',
    });
    screen.prepare({
      runtime: f.runtime,
      visibleSurface: true,
      profile,
      field: ready,
      width: 32,
      height: 32,
    });
    expect(screen.ready?.receivers).toBe(ready.receivers);
    f.owner.dispose();
    expect(prepared.receivers.unwrap().state).toBe('unavailable');
    expect(mapped.resolve(address, 0, ready.canonical.expected, ready).unwrap().state).toBe(
      'unavailable',
    );
    const replacement = await editableIrradianceFixture(false);
    try {
      const source = replacement.source().scene.retained;
      assert(source);
      replacement.setVisibleSurface(projectVisibleSurfaces(source.slots, 1024, source).unwrap());
      const newField = await replacement.ready();
      expect(newField.canonical.expected).toEqual(before.acceptedSource);
      expect(before.resolve(address, 0, newField.canonical.expected, newField).unwrap()).toEqual({
        state: 'unavailable',
        reason: 'stale-owner',
      });
    } finally {
      replacement.dispose();
    }
  } finally {
    screen.dispose();
    f.dispose();
  }
});

it('resolves surviving raster rows through canonical ownership after removal', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const rows = new VisibleSurfaceRows();
  try {
    const survivor = f.spawn(f.meshHandle);
    const retained = f.source().scene.retained;
    assert(retained);
    f.setVisibleSurface(rows.update(retained, 1024).unwrap());
    const first = await f.ready();
    const generation = first.generation;
    f.remove();
    const nextRetained = f.source().scene.retained;
    assert(nextRetained);
    const raster = rows.update(nextRetained, 1024).unwrap();
    f.setVisibleSurface(raster);
    const field = await f.ready();
    expect(field.generation).toBe(generation);
    const receivers = field.receivers.unwrap();
    assert(receivers.state === 'ready');
    const address = raster.entityBases.get(Number(survivor.entity));
    assert(address !== undefined);
    expect(receivers.resolve(address, 0, field.canonical.expected, field).unwrap()).toMatchObject({
      state: 'identified',
      canonicalRow: 1,
      owner: { entityKey: Number(survivor.entity) },
    });
    expect(receivers.resolve(0, 0, field.canonical.expected, field).unwrap().state).toBe(
      'unavailable',
    );
    expect(receivers.resolve(address, 0xffffffff, field.canonical.expected, field).ok).toBe(false);
  } finally {
    f.dispose();
  }
});

it('switches Screen Probe gather demand without resetting the shared field', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const pipelines = vi.spyOn(f.runtime.device, 'createComputePipeline');
  const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
  try {
    const field = await f.ready();
    const meta = field.buffers.meta.buffer;
    expect(field.view.gatherField).toBeUndefined();
    expect(field.extent().gathered).toBeUndefined();
    expect(pipelines.mock.calls.some(([d]) => d.compute.entryPoint === 'gatherField')).toBe(false);
    const before = pipelines.mock.calls.length;
    f.setGatherView(true);
    expect(await f.ready()).toBe(field);
    expect(field.buffers.meta.buffer).toBe(meta);
    expect(pipelines.mock.calls.slice(before).map(([d]) => d.compute.entryPoint)).toEqual([
      'gatherField',
      'upsampleField',
    ]);
    const gathered = field.extent().gathered;
    const upsampled = field.extent().upsampled;
    assert(gathered && upsampled);
    f.setGatherView(false);
    expect(await f.ready()).toBe(field);
    expect(field.extent().gathered).toBeUndefined();
    expect(destroy).toHaveBeenCalledWith(gathered);
    expect(destroy).toHaveBeenCalledWith(upsampled);
    const count = pipelines.mock.calls.length;
    f.setGatherView(true);
    expect(await f.ready()).toBe(field);
    expect(field.extent().gathered).toBeDefined();
    expect(pipelines.mock.calls).toHaveLength(count);
    expect(f.errors).toEqual([]);
  } finally {
    pipelines.mockRestore();
    destroy.mockRestore();
    f.dispose();
  }
});

it.each([true, false])('requests demanded gather while the initial core pipeline is pending (%s)', {
  timeout: 60_000,
}, async (gatherView) => {
  const f = await editableIrradianceFixture(gatherView);
  const device = f.runtime.device;
  const create = device.createComputePipeline.bind(device);
  const requested: string[] = [];
  let release: (() => void) | undefined;
  const original = Object.getOwnPropertyDescriptor(device, 'createComputePipelineAsync');
  Object.assign(device, {
    createComputePipelineAsync: (
      descriptor: Parameters<typeof device.createComputePipeline>[0],
    ) => {
      const entry = descriptor.compute.entryPoint ?? '';
      requested.push(entry);
      const result = create(descriptor);
      return entry === 'cardSurface'
        ? new Promise<typeof result>((resolve) => {
            release = () => resolve(result);
          })
        : Promise.resolve(result);
    },
  });
  try {
    f.prepare();
    await vi.waitFor(() => expect(requested).toContain('cardSurface'), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested.includes('gatherField')).toBe(gatherView);
    expect(requested).toEqual(
      expect.arrayContaining(['placeProbes', 'traceProbes', 'updateProbes', 'deriveProbes']),
    );
    expect(f.owner.ready).toBeUndefined();
    expect(f.owner.inspect().submittedFrames).toBe(0);
    release?.();
    await f.ready();
    expect(f.errors).toEqual([]);
  } finally {
    release?.();
    if (original) Object.defineProperty(device, 'createComputePipelineAsync', original);
    else Reflect.deleteProperty(device, 'createComputePipelineAsync');
    f.dispose();
  }
});

it('isolates shared field state when newly demanded gather preparation fails', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const original = f.runtime.device.createComputePipeline.bind(f.runtime.device);
  try {
    const field = await f.ready();
    const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
    const pipelines = vi
      .spyOn(f.runtime.device, 'createComputePipeline')
      .mockImplementation((d) => {
        if (d.compute.entryPoint === 'upsampleField')
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'controlled gather initialization',
              hint: 'restore the gather producer',
            }),
          );
        return original(d);
      });
    try {
      f.setGatherView(true);
      f.prepare();
      expect(f.owner.ready).toBeUndefined();
      await vi.waitFor(() => expect(f.owner.inspect().state).toBe('failed'));
      expect(f.owner.inspect().state).toBe('failed');
      expect(field.view.gatherField).toBeUndefined();
      expect(field.view.upsampleField).toBeUndefined();
      expect(destroy).not.toHaveBeenCalledWith(field.buffers.meta.buffer);
      expect(f.errors).toHaveLength(1);
      f.setGatherView(false);
      expect(await f.ready()).toBe(field);
      expect(f.owner.inspect().state).toBe('ready');
      f.setGatherView(true);
      f.prepare();
      expect(f.owner.inspect().state).toBe('failed');
      expect(f.errors).toHaveLength(1);
    } finally {
      pipelines.mockRestore();
      destroy.mockRestore();
    }
  } finally {
    f.dispose();
  }
});

it.each([
  'reject',
  'core-reject',
  'retire',
  'device-generation',
] as const)('drains concurrent initial gather before field %s retirement', {
  timeout: 60_000,
}, async (outcome) => {
  const f = await editableIrradianceFixture(true);
  const device = f.runtime.device;
  const create = device.createComputePipeline.bind(device);
  let finish: (() => void) | undefined;
  let deferred = false;
  Object.assign(device, {
    createComputePipelineAsync: (descriptor: Parameters<typeof create>[0]) => {
      if (
        descriptor.compute.entryPoint === 'cardSurface' &&
        (outcome === 'reject' || outcome === 'core-reject')
      )
        return Promise.reject(new Error('controlled core rejection'));
      const result = create(descriptor);
      const held = outcome === 'core-reject' ? 'traceProbes' : 'gatherField';
      if (descriptor.compute.entryPoint !== held || deferred) return Promise.resolve(result);
      deferred = true;
      return new Promise<typeof result>((resolve) => {
        finish = () =>
          resolve(
            outcome === 'core-reject'
              ? err(
                  new RhiError({
                    code: 'rhi-descriptor-invalid',
                    expected: 'later stage failure',
                    hint: 'controlled later failure',
                  }),
                )
              : result,
          );
      });
    },
  });
  const buffers = vi.spyOn(device, 'createBuffer');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  try {
    f.prepare();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const index = buffers.mock.calls.findIndex(([d]) => d.label === 'irradiance-field.meta');
    const result = buffers.mock.results[index];
    assert(result?.type === 'return' && result.value.ok);
    const meta = result.value.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).not.toHaveBeenCalledWith(meta);
    expect(f.owner.ready).toBeUndefined();
    if (outcome === 'retire') f.owner.disable();
    if (outcome === 'device-generation')
      Object.assign(recordContext(f.runtime).deviceScope, { generation: 2 });
    finish?.();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledWith(meta));
    expect(f.owner.ready).toBeUndefined();
    expect(f.owner.inspect().submittedFrames).toBe(0);
    expect(f.errors).toHaveLength(outcome === 'reject' || outcome === 'core-reject' ? 1 : 0);
    if (outcome === 'core-reject') {
      expect(JSON.stringify(f.errors)).toContain('controlled core rejection');
      expect(JSON.stringify(f.errors)).not.toContain('controlled later failure');
    }
  } finally {
    finish?.();
    Reflect.deleteProperty(device, 'createComputePipelineAsync');
    buffers.mockRestore();
    destroy.mockRestore();
    f.dispose();
  }
});

it('isolates a late gather failure after demand returns to Screen Probes', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  let finish: ((result: Result<ComputePipeline, RhiError>) => void) | undefined;
  const create = f.runtime.device.createComputePipeline.bind(f.runtime.device);
  const asyncCreate = vi.fn((descriptor: Parameters<typeof create>[0]) => {
    if (descriptor.compute.entryPoint === 'upsampleField')
      return new Promise<Result<ComputePipeline, RhiError>>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(create(descriptor));
  });
  try {
    const field = await f.ready();
    const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
    Object.assign(f.runtime.device, { createComputePipelineAsync: asyncCreate });
    f.setGatherView(true);
    f.prepare();
    expect(f.owner.ready).toBeUndefined();
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.setGatherView(false);
    f.prepare();
    expect(f.owner.ready).toBe(field);
    assert(finish);
    finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'valid gather',
          hint: 'late controlled failure',
        }),
      ),
    );
    finish = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.owner.ready).toBe(field);
    expect(f.owner.inspect().state).toBe('ready');
    expect(f.errors).toEqual([]);
    expect(destroy).not.toHaveBeenCalledWith(field.buffers.meta.buffer);
    f.setGatherView(true);
    f.prepare();
    expect(f.owner.ready).toBeUndefined();
    expect(f.owner.inspect().state).toBe('failed');
    expect(f.errors).toHaveLength(1);
    const count = asyncCreate.mock.calls.length;
    f.prepare();
    f.prepare();
    expect(asyncCreate).toHaveBeenCalledTimes(count);
    f.setGatherView(false);
    expect(await f.ready()).toBe(field);
    destroy.mockRestore();
  } finally {
    if (finish)
      finish(
        err(
          new RhiError({ code: 'rhi-not-available', expected: 'cleanup', hint: 'test teardown' }),
        ),
      );
    Reflect.deleteProperty(f.runtime.device, 'createComputePipelineAsync');
    f.dispose();
  }
});

for (const outcome of [
  'complete',
  'failure',
  'retire',
  'device-generation',
  'source-change',
] as const)
  it(`qualifies actual field preparation on async completion: ${outcome}`, {
    timeout: 60_000,
  }, async () => {
    const f = await editableIrradianceFixture(false);
    const device = f.runtime.device;
    const create = device.createComputePipeline.bind(device);
    const sync = vi.spyOn(device, 'createComputePipeline').mockImplementation(() => {
      throw new Error('field preparation reached synchronous compute creation');
    });
    let finish: ((result: Result<ComputePipeline, RhiError>) => void) | undefined;
    let result: Result<ComputePipeline, RhiError> | undefined;
    let deferred = false;
    const asyncCreate = vi.fn((descriptor: Parameters<typeof create>[0]) => {
      const prepared = create(descriptor);
      if (descriptor.label !== 'irradiance-field.traceProbes' || deferred)
        return Promise.resolve(prepared);
      deferred = true;
      result = prepared;
      return new Promise<Result<ComputePipeline, RhiError>>((resolve) => {
        finish = resolve;
      });
    });
    Object.assign(device, { createComputePipelineAsync: asyncCreate });
    const buffers = vi.spyOn(device, 'createBuffer');
    const destroy = vi.spyOn(device, 'destroyBuffer');
    try {
      f.prepare();
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(f.owner.ready).toBeUndefined();
      expect(f.owner.inspect().state).toBe('preparing');
      const count = asyncCreate.mock.calls.length;
      f.prepare();
      f.prepare();
      expect(asyncCreate).toHaveBeenCalledTimes(count);
      assert(finish && result);
      if (outcome === 'retire') f.owner.disable();
      if (outcome === 'device-generation')
        Object.assign(recordContext(f.runtime).deviceScope, { generation: 2 });
      if (outcome === 'source-change') {
        f.move(1);
        f.prepare();
      }
      const cause = new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'valid trace pipeline',
        hint: 'controlled backend validation failure',
      });
      finish(outcome === 'failure' || outcome === 'source-change' ? err(cause) : result);
      finish = undefined;
      if (outcome === 'complete') {
        const field = await f.ready();
        expect(field.view.gatherField).toBeUndefined();
        expect(f.errors).toEqual([]);
      } else {
        const metaIndex = buffers.mock.calls.findIndex(
          ([d]) => d.label === 'irradiance-field.meta',
        );
        const meta = buffers.mock.results[metaIndex];
        assert(meta?.type === 'return' && meta.value.ok);
        const buffer = meta.value.value;
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledWith(buffer));
        expect(f.owner.ready).toBeUndefined();
        if (outcome === 'failure') {
          expect(f.owner.inspect().state).toBe('failed');
          expect(f.errors).toHaveLength(1);
          const failedCount = asyncCreate.mock.calls.length;
          f.prepare();
          expect(asyncCreate).toHaveBeenCalledTimes(failedCount);
        } else {
          expect(f.errors).toEqual([]);
          if (outcome === 'source-change') expect(await f.ready()).toBeDefined();
        }
      }
      expect(sync).not.toHaveBeenCalled();
    } finally {
      if (finish && result) finish(result);
      sync.mockRestore();
      Reflect.deleteProperty(device, 'createComputePipelineAsync');
      buffers.mockRestore();
      destroy.mockRestore();
      f.dispose();
    }
  });

it('rebuilds once without gather when initial gather fails after demand turns off', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(true);
  const create = f.runtime.device.createComputePipeline.bind(f.runtime.device);
  let finish: ((result: Result<ComputePipeline, RhiError>) => void) | undefined;
  const asyncCreate = vi.fn((descriptor: Parameters<typeof create>[0]) => {
    if (descriptor.compute.entryPoint !== 'upsampleField')
      return Promise.resolve(create(descriptor));
    return new Promise<Result<ComputePipeline, RhiError>>((resolve) => {
      finish = resolve;
    });
  });
  Object.assign(f.runtime.device, { createComputePipelineAsync: asyncCreate });
  try {
    f.prepare();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(f.owner.ready).toBeUndefined();
    f.setGatherView(false);
    f.prepare();
    assert(finish);
    finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'initial gather',
          hint: 'controlled validation failure',
        }),
      ),
    );
    finish = undefined;
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    const field = await f.ready();
    expect(field.view.gatherField).toBeUndefined();
    expect(field.view.upsampleField).toBeUndefined();
    expect(
      asyncCreate.mock.calls.filter(([d]) => d.compute.entryPoint === 'upsampleField'),
    ).toHaveLength(1);
    const count = asyncCreate.mock.calls.length;
    expect(await f.ready()).toBe(field);
    expect(asyncCreate).toHaveBeenCalledTimes(count);
  } finally {
    if (finish)
      finish(
        err(
          new RhiError({ code: 'rhi-not-available', expected: 'cleanup', hint: 'test teardown' }),
        ),
      );
    Reflect.deleteProperty(f.runtime.device, 'createComputePipelineAsync');
    f.dispose();
  }
});

it('does not publish Screen pipelines completed for a previous device generation', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const screen = new RendererScreenProbe();
  const registry = f.runtime.shaderRegistry;
  assert(registry);
  await addPublishedScreenFixture(registry);
  const profile = {
    ...f.profile(),
    gather: 'screen-probe' as const,
    probes: SCREEN_PROBE_DEFAULTS,
  };
  const create = f.runtime.device.createComputePipeline.bind(f.runtime.device);
  let finish: (() => void) | undefined;
  let deferred = false;
  const asyncCreate = vi.fn((descriptor: Parameters<typeof create>[0]) => {
    const result = create(descriptor);
    if (descriptor.label !== 'screen-probe.placeUniformProbes' || deferred)
      return Promise.resolve(result);
    deferred = true;
    return new Promise<typeof result>((resolve) => {
      finish = () => resolve(result);
    });
  });
  try {
    const field = await f.ready();
    Object.assign(f.runtime.device, { createComputePipelineAsync: asyncCreate });
    screen.prepare({
      runtime: f.runtime,
      visibleSurface: true,
      profile,
      field,
      width: 32,
      height: 32,
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(screen.ready).toBeUndefined();
    Object.assign(recordContext(f.runtime).deviceScope, { generation: 2 });
    const current = await f.ready();
    expect(current).not.toBe(field);
    screen.prepare({
      runtime: f.runtime,
      visibleSurface: true,
      profile,
      field: current,
      width: 32,
      height: 32,
    });
    assert(finish);
    finish();
    finish = undefined;
    await vi.waitFor(() =>
      expect(
        asyncCreate.mock.calls.some(([d]) => d.label === 'screen-probe.traceWorldProbes'),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    screen.prepare({
      runtime: f.runtime,
      visibleSurface: true,
      profile,
      field: current,
      width: 32,
      height: 32,
    });
    await vi.waitFor(() =>
      expect(
        asyncCreate.mock.calls.filter(([d]) => d.label === 'screen-probe.placeUniformProbes'),
      ).toHaveLength(2),
    );
    expect(f.errors).toEqual([]);
  } finally {
    finish?.();
    screen.dispose();
    Reflect.deleteProperty(f.runtime.device, 'createComputePipelineAsync');
    f.dispose();
  }
});

it('does not publish a Screen Probe field without its shared Card view publication', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const registry = f.runtime.shaderRegistry;
  assert(registry);
  const entries = [...registry.entries()].filter(
    (entry) => !entry.wgsl.includes('fn gatherField('),
  );
  Object.assign(registry, { entries: () => entries });
  const create = vi.spyOn(f.runtime.device, 'createBuffer');
  try {
    for (let i = 0; i < 50 && f.owner.inspect().state !== 'failed'; i++) {
      f.prepare();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(f.owner.inspect().state).toBe('failed');
    expect(f.owner.ready).toBeUndefined();
    expect(f.errors).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    f.dispose();
  }
});

for (const event of ['gather-demand', 'dispose'] as const)
  it(`settles pending shared-field preparation after ${event}`, { timeout: 60_000 }, async () => {
    const f = await editableIrradianceFixture(false);
    const compile = f.runtime.createShaderModule;
    assert(compile);
    let release: () => void = () => {};
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(f.runtime, 'createShaderModule').mockImplementation(async (device, d) => {
      if (d.label === 'irradiance-field.view') {
        started = true;
        await gate;
      }
      return compile(device, d);
    });
    const create = vi.spyOn(f.runtime.device, 'createBuffer');
    const destroy = vi.spyOn(f.runtime.device, 'destroyBuffer');
    try {
      for (let i = 0; i < 50 && !started; i++) {
        f.prepare();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(started).toBe(true);
      if (event === 'dispose') f.owner.dispose();
      else {
        f.setGatherView(true);
        f.prepare();
      }
      release();
      if (event === 'gather-demand') {
        const field = await f.ready();
        expect(field.view.gatherField).toBeDefined();
        expect(field.view.upsampleField).toBeDefined();
      } else {
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
        expect(f.owner.ready).toBeUndefined();
        const index = create.mock.calls.findIndex(([d]) => d.label === 'irradiance-field.meta');
        const result = create.mock.results[index];
        assert(result?.type === 'return' && result.value.ok);
        expect(destroy).toHaveBeenCalledWith(result.value.value);
      }
      expect(f.errors).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
      create.mockRestore();
      destroy.mockRestore();
      f.dispose();
    }
  });

it('owns independent canonical texture and typed source facts in the live field sample group', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const groups = vi.spyOn(f.runtime.device, 'createBindGroup');
  const layouts = vi.spyOn(f.runtime.device, 'createBindGroupLayout');
  const buffers = vi.spyOn(f.runtime.device, 'createBuffer');
  const compile = vi.spyOn(f.runtime, 'createShaderModule');
  try {
    const field = await f.ready();
    const groupIndex = groups.mock.results.findIndex(
      (r) => r.type === 'return' && r.value.ok && r.value.value === field.sample,
    );
    const group = groups.mock.calls[groupIndex]?.[0];
    assert(group);
    const entries = [...group.entries];
    const settings = entries.find((entry) => entry.binding === 4)?.resource;
    assert(settings?.kind === 'buffer');
    expect(settings.value.buffer).not.toBe(field.region.input.settings.buffer);
    expect(settings.value.size).toBe(64);
    expect(entries.find((entry) => entry.binding === 6)?.resource.kind).toBe('textureView');
    const sampleLayout = layouts.mock.calls.find((_, index) => {
      const result = layouts.mock.results[index];
      return result?.type === 'return' && result.value.ok && result.value.value === group.layout;
    })?.[0];
    expect(
      sampleLayout && [...sampleLayout.entries].find((entry) => entry.binding === 6)?.texture,
    ).toEqual({
      sampleType: 'uint',
      viewDimension: '2d',
    });
    expect(
      buffers.mock.calls.some(
        ([d]) => d.label === 'irradiance-field.visibility-inputs' && d.size === 64,
      ),
    ).toBe(true);
    expect(
      compile.mock.calls.some(([, d]) => d.label === 'irradiance-field.canonical-projection'),
    ).toBe(true);
  } finally {
    compile.mockRestore();
    buffers.mockRestore();
    layouts.mockRestore();
    groups.mockRestore();
    f.dispose();
  }
});

it('declares complete canonical projection and visibility facts before every live field consumer', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(false);
  const inputs: (Texture | Buffer)[] = [];
  const baselineDesc = { size: 32 * 32 * 16, usage: 128 };
  const baseline = f.runtime.device.createBuffer(baselineDesc).unwrap();
  inputs.push(baseline);
  try {
    const field = await f.ready();
    let graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const target = (
      label: string,
      format: 'rgba16float' | 'r32uint' | 'rg32uint' | 'depth32float',
    ) => {
      const descriptor = {
        format,
        size: { width: 32, height: 32 },
        usage: 4 | 16,
      };
      const texture = f.runtime.device.createTexture(descriptor).unwrap();
      inputs.push(texture);
      const view = f.runtime.device.createTextureView(texture, {}).unwrap();
      const handle = graph.importTexture(label, descriptor, () => texture).unwrap();
      return {
        texture: handle,
        view: graph.importView(handle, {}, () => view).unwrap(),
        format,
        sampleCount: 1 as const,
      };
    };
    const targets = () => ({
      scene: target('scene', 'rgba16float'),
      diffuseGiBaseline: graph
        .importBuffer('direct-diffuse-baseline', baselineDesc, () => baseline)
        .unwrap(),
      normal: target('normal', 'r32uint'),
      albedo: target('albedo', 'r32uint'),
      f0: target('f0', 'rg32uint'),
      depth: target('depth', 'depth32float').view,
      motion: target('motion', 'rgba16float'),
    });
    const rejected = targets();
    expect(() => addIrradianceFieldPasses(graph, field, rejected)).toThrow(
      'field view gather requires its gather kernel',
    );
    graph = new RenderGraphBuilder<RenderPipelineFrame>();
    f.setGatherView(true);
    expect(await f.ready()).toBe(field);
    addIrradianceFieldPasses(graph, field, targets()).unwrap();
    const compiled = graph
      .compile({ device: f.runtime.device, surfaceSize: { width: 32, height: 32 } })
      .unwrap();
    try {
      const info = compiled.inspect();
      const names = info.passes.map((pass) => pass.name);
      const identity = info.passes.find(
        (pass) => pass.name === 'irradiance-field.card.capture-identity',
      );
      const receivers = info.passes.find((pass) => pass.name === 'irradiance-field.card-receivers');
      const surface = info.passes.find((pass) => pass.name === 'irradiance-field.card-surface');
      assert(identity && receivers && surface);
      expect(receivers.kind).toBe('copy');
      expect(receivers.accesses).toEqual([
        { resource: 'irradiance-field.card-receiver-staging', usage: 'copy-src' },
        { resource: 'irradiance-field.card-receivers', usage: 'copy-dst' },
      ]);
      expect(names.indexOf('irradiance-field.card.capture')).toBeLessThan(
        names.indexOf(identity.name),
      );
      expect(names.indexOf(identity.name)).toBeLessThan(names.indexOf(receivers.name));
      expect(names.indexOf(receivers.name)).toBeLessThan(names.indexOf(surface.name));
      const primitive = identity.accesses.find((access) => access.usage === 'color-attachment');
      assert(primitive);
      expect(surface.accesses).toContainEqual({
        resource: primitive.resource,
        usage: 'sampled-read',
      });
      for (const name of ['irradiance-field.radiosity', 'irradiance-field.gather']) {
        const pass = info.passes.find((p) => p.name === name);
        assert(pass);
        expect(names.indexOf('irradiance-field.canonical-scene')).toBeLessThan(names.indexOf(name));
        expect(names.indexOf('irradiance-field.visibility-inputs')).toBeLessThan(
          names.indexOf(name),
        );
        expect(pass.accesses).toContainEqual({
          resource: 'irradiance-field.canonical-scene',
          usage: 'sampled-read',
        });
        expect(pass.accesses).toContainEqual({
          resource: 'irradiance-field.visibility-inputs',
          usage: 'uniform-read',
        });
      }
      expect(
        info.passes.find((p) => p.name === 'irradiance-field.canonical-scene')?.accesses,
      ).toContainEqual({ resource: 'irradiance-field.region.fields', usage: 'storage-read' });
    } finally {
      (await compiled.retire()).unwrap();
    }
  } finally {
    for (const texture of inputs) f.runtime.device.destroyTexture(texture);
    f.dispose();
  }
});

it('prepares a diffuse-only field without a reflection publication', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  try {
    const registry = f.runtime.shaderRegistry;
    assert(registry);
    const entries = [...registry.entries()].filter(
      (entry) => !entry.wgsl.includes('fn fs_ray_reflection_field('),
    );
    Object.assign(registry, { entries: () => entries });
    const field = await f.ready();
    expect(field.buffers.irradiance.size).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});

async function reflectionReady(f: Awaited<ReturnType<typeof editableIrradianceFixture>>) {
  for (let i = 0; i < 50; i++) {
    f.prepare();
    const reflection = f.owner.ready?.reflection();
    if (reflection?.state === 'ready') return reflection.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(JSON.stringify(f.owner.inspect()));
}

it('routes full half and radiosity demand through the existing field generation', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const pipelines = vi.spyOn(f.runtime.device, 'createComputePipeline');
  try {
    let previous: Awaited<ReturnType<typeof f.ready>> | undefined;
    for (const [resolution, radiosity] of [
      ['full', false],
      ['half', false],
      ['half', true],
      ['full', true],
      ['full', false],
    ] as const) {
      const before = pipelines.mock.calls.length;
      f.setFieldDemand(resolution, radiosity);
      const current = await f.ready();
      const entries = pipelines.mock.calls.slice(before).map(([d]) => d.compute.entryPoint);
      expect(entries).toContain(radiosity ? 'radiateCards' : 'copyDirectCards');
      expect(entries).not.toContain(radiosity ? 'copyDirectCards' : 'radiateCards');
      expect(entries.includes('upsampleField')).toBe(resolution === 'half');
      expect(current.view.upsampleField !== undefined).toBe(resolution === 'half');
      expect(current.extent().upsampled !== undefined).toBe(resolution === 'half');
      if (previous) {
        expect(current.generation).toBeGreaterThan(previous.generation);
        expect(current.buffers.meta.buffer).not.toBe(previous.buffers.meta.buffer);
        expect(previous.fence.currentGeneration()).not.toBe(previous.generation);
      }
      const pipelineCount = pipelines.mock.calls.length;
      expect(await f.ready()).toBe(current);
      expect(pipelines.mock.calls).toHaveLength(pipelineCount);
      previous = current;
    }
  } finally {
    f.dispose();
  }
});

function holdReflectionCompile(f: Awaited<ReturnType<typeof editableIrradianceFixture>>) {
  const compile = f.runtime.createShaderModule;
  assert(compile);
  let release: () => void = () => {};
  let failure = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(f.runtime, 'createShaderModule')
    .mockImplementation(async (device, descriptor) => {
      if (descriptor.label === 'irradiance-field.traceReflections') {
        await gate;
        if (failure) throw new Error('controlled optional reflection preparation failure');
      }
      return compile(device, descriptor);
    });
  return {
    release: () => release(),
    fail: () => {
      failure = true;
      release();
    },
    restore: () => spy.mockRestore(),
  };
}

it('compiles a changed reflection publication without recreating diffuse kernels', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const compile = vi.spyOn(f.runtime, 'createShaderModule');
  try {
    const base = await f.ready(),
      view = base.view;
    const registry = f.runtime.shaderRegistry;
    assert(registry);
    const entries = [...registry.entries()].map((e) =>
      e.wgsl.includes('fn generateFieldReflections(')
        ? { ...e, wgsl: `${e.wgsl}\n// Current reflection publication.\n` }
        : e,
    );
    Object.assign(registry, { entries: () => entries });
    f.setReflections(true);
    await reflectionReady(f);
    expect(f.owner.ready).toBe(base);
    expect(base.view).toBe(view);
    expect(compile.mock.calls.filter(([, d]) => d.label === 'irradiance-field.view')).toHaveLength(
      1,
    );
    expect(
      compile.mock.calls.filter(([, d]) => d.label === 'irradiance-field.reflection-view'),
    ).toHaveLength(1);
  } finally {
    compile.mockRestore();
    f.dispose();
  }
});

it('binds the actual base sample group in the demanded reflection kernel', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(),
    device = f.runtime.device;
  const depth = device
    .createTexture({ size: { width: 32, height: 32 }, format: 'depth32float', usage: 4 })
    .unwrap();
  const normal = device
    .createTexture({ size: { width: 32, height: 32 }, format: 'rgba32uint', usage: 4 })
    .unwrap();
  const view = device.createBuffer({ size: VIEW_UNIFORM_BYTES, usage: 64 | 8 }).unwrap();
  try {
    const base = await f.ready();
    f.setReflections(true);
    const bundle = await reflectionReady(f),
      extent = base.extent().reflection;
    assert(extent);
    const encoder = device.createCommandEncoder({}).unwrap(),
      pass = encoder.beginComputePass({});
    const bind = vi.spyOn(pass, 'setBindGroup');
    bundle.view.generateFieldReflections
      .record(
        pass,
        [
          base.buffers.frame,
          device.createTextureView(depth, {}).unwrap(),
          device.createTextureView(normal, {}).unwrap(),
          { buffer: view },
          { buffer: extent.rays },
          { buffer: extent.signal },
        ],
        base.sample,
        1024,
      )
      .unwrap();
    expect(bind).toHaveBeenCalledWith(1, base.sample);
    pass.end();
    encoder.finish().unwrap();
    bind.mockRestore();
  } finally {
    f.dispose();
    device.destroyBuffer(view);
    device.destroyTexture(depth);
    device.destroyTexture(normal);
  }
});

it('ignores an optional preparation failure after demand turns off and retries on demand', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(),
    held = holdReflectionCompile(f);
  try {
    const base = await f.ready();
    f.setReflections(true);
    f.prepare();
    f.setReflections(false);
    f.prepare();
    held.fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(base.reflection().state).toBe('unrequested');
    expect(f.errors).toEqual([]);
    expect(f.owner.ready).toBe(base);
    held.restore();
    f.setReflections(true);
    await reflectionReady(f);
    expect(f.owner.ready).toBe(base);
  } finally {
    held.release();
    held.restore();
    f.dispose();
  }
});

it('prepares optional reflections on demand without replacing field history or layout', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const device = f.runtime.device;
  const compile = vi.spyOn(f.runtime, 'createShaderModule');
  const groups = vi.spyOn(device, 'createBindGroup');
  const layouts = vi.spyOn(device, 'createPipelineLayout');
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  try {
    const base = await f.ready();
    const meta = base.buffers.meta.buffer;
    const groupIndex = groups.mock.results.findIndex(
      (r) => r.type === 'return' && r.value.ok && r.value.value === base.sample,
    );
    assert(groupIndex >= 0);
    const sampleLayout = groups.mock.calls[groupIndex]?.[0].layout;
    assert(sampleLayout);
    f.setReflections(true);
    const bundle = await reflectionReady(f);
    expect(f.owner.ready).toBe(base);
    expect(base.buffers.meta.buffer).toBe(meta);
    expect(f.owner.inspect().generation).toBe(base.generation);
    expect(base.extent().reflection).toBeDefined();
    const generated = pipelines.mock.calls.find(
      ([d]) => d.label === 'irradiance-field.generateFieldReflections',
    )?.[0];
    assert(generated);
    const layoutIndex = layouts.mock.results.findIndex(
      (r) => r.type === 'return' && r.value.ok && r.value.value === generated.layout,
    );
    const reflectionLayout = layouts.mock.calls[layoutIndex]?.[0];
    assert(reflectionLayout);
    expect([...reflectionLayout.bindGroupLayouts][1]).toBe(sampleLayout);
    expect(compile.mock.calls.filter(([, d]) => d.label === 'irradiance-field.view')).toHaveLength(
      1,
    );
    expect(compile.mock.calls.some(([, d]) => d.label === 'irradiance-field.reflection-view')).toBe(
      false,
    );
    f.setReflections(false);
    f.prepare();
    expect(base.extent().reflection).toBeUndefined();
    f.setReflections(true);
    expect(await reflectionReady(f)).toBe(bundle);
    expect(
      pipelines.mock.calls.filter(([d]) => d.label === 'irradiance-field.traceReflections'),
    ).toHaveLength(1);
    expect(f.owner.ready).toBe(base);
  } finally {
    compile.mockRestore();
    groups.mockRestore();
    layouts.mockRestore();
    pipelines.mockRestore();
    f.dispose();
  }
});

it('recovers diffuse after optional reflection failure and consumes a later publication', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  try {
    const registry = f.runtime.shaderRegistry;
    assert(registry);
    const all = [...registry.entries()];
    Object.assign(registry, {
      entries: () => all.filter((e) => !e.wgsl.includes('fn fs_ray_reflection_field(')),
    });
    const base = await f.ready();
    f.setReflections(true);
    f.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(base.reflection().state).toBe('failed');
    expect(f.owner.inspect().state).toBe('failed');
    expect(f.errors).toHaveLength(1);
    f.setReflections(false);
    f.prepare();
    expect(f.owner.inspect().state).not.toBe('failed');
    expect(f.owner.ready).toBe(base);
    Object.assign(registry, { entries: () => all });
    f.setReflections(true);
    await reflectionReady(f);
    expect(f.owner.ready).toBe(base);
    expect(f.errors).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('keeps diffuse usable when reflection preparation is pending and demand turns off', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const held = holdReflectionCompile(f);
  try {
    const base = await f.ready();
    f.setReflections(true);
    f.prepare();
    expect(base.reflection().state).toBe('preparing');
    expect(base.extent().reflection).toBeUndefined();
    f.setReflections(false);
    f.prepare();
    expect(f.owner.ready).toBe(base);
    held.release();
    await reflectionReady(f);
    expect(base.extent().reflection).toBeUndefined();
    f.setReflections(true);
    f.prepare();
    expect(base.extent().reflection).toBeDefined();
    expect(f.errors).toEqual([]);
  } finally {
    held.release();
    held.restore();
    f.dispose();
  }
});

for (const event of ['retire', 'device-generation'] as const)
  it(`does not publish late optional reflection pipelines after ${event}`, {
    timeout: 60_000,
  }, async () => {
    const f = await editableIrradianceFixture();
    const held = holdReflectionCompile(f);
    const pipelines = vi.spyOn(f.runtime.device, 'createComputePipeline');
    try {
      const base = await f.ready();
      f.setReflections(true);
      f.prepare();
      expect(base.reflection().state).toBe('preparing');
      if (event === 'retire') f.owner.disable();
      else Object.assign(recordContext(f.runtime).deviceScope, { generation: 2 });
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(base.reflection().state).not.toBe('ready');
      expect(
        pipelines.mock.calls.some(([d]) => d.label === 'irradiance-field.traceReflections'),
      ).toBe(false);
      expect(f.errors).toEqual([]);
    } finally {
      held.release();
      held.restore();
      pipelines.mockRestore();
      f.dispose();
    }
  });

it('keeps optional reflection bundles separate for two device-owned fields', {
  timeout: 60_000,
}, async () => {
  const a = await editableIrradianceFixture(),
    b = await editableIrradianceFixture();
  try {
    const first = await a.ready(),
      second = await b.ready();
    a.setReflections(true);
    const left = await reflectionReady(a);
    expect(second.reflection().state).toBe('unrequested');
    expect(second.extent().reflection).toBeUndefined();
    b.setReflections(true);
    const right = await reflectionReady(b);
    expect(left).not.toBe(right);
    expect(first.sample).not.toBe(second.sample);
    expect(first.buffers.meta.buffer).not.toBe(second.buffers.meta.buffer);
    a.setReflections(false);
    a.prepare();
    expect(first.extent().reflection).toBeUndefined();
    expect(second.extent().reflection).toBeDefined();
  } finally {
    a.dispose();
    b.dispose();
  }
});

it('keeps independent reflection demand for two view owners on the same runtime device', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture(),
    other = new RendererIrradianceField();
  try {
    const first = await f.ready(),
      profile = f.profile();
    const prepareOther = (reflections: boolean) =>
      other.prepare({
        runtime: f.runtime,
        ...f.source(),
        lights: [],
        profile: reflections
          ? { ...profile, reflections: { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 } }
          : profile,
        width: 32,
        height: 32,
        gatherView: true,
        focus: [0, 0, 0],
      });
    for (let i = 0; i < 50 && other.ready === undefined; i++) {
      prepareOther(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const second = other.ready;
    assert(second);
    f.setReflections(true);
    const left = await reflectionReady(f);
    expect(second.reflection().state).toBe('unrequested');
    expect(second.extent().reflection).toBeUndefined();
    for (let i = 0; i < 50 && second.reflection().state !== 'ready'; i++) {
      prepareOther(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const right = second.reflection();
    assert(right.state === 'ready');
    expect(left).not.toBe(right.value);
    expect(first.sample).not.toBe(second.sample);
    expect(first.buffers.meta.buffer).not.toBe(second.buffers.meta.buffer);
    f.setReflections(false);
    f.prepare();
    expect(first.extent().reflection).toBeUndefined();
    expect(second.extent().reflection).toBeDefined();
    expect(f.owner.ready).toBe(first);
    expect(other.ready).toBe(second);
    expect(f.errors).toEqual([]);
  } finally {
    other.dispose();
    f.dispose();
  }
});

it('prepares no reflection modules or pipelines while reflections are off', {
  timeout: 60_000,
}, async () => {
  const f = await editableIrradianceFixture();
  const compile = vi.spyOn(f.runtime, 'createShaderModule');
  const pipelines = vi.spyOn(f.runtime.device, 'createComputePipeline');
  try {
    await f.ready();
    const labels = compile.mock.calls.map(([, descriptor]) => descriptor.label);
    expect(labels).not.toContain('irradiance-field.traceReflections');
    expect(labels).not.toContain('irradiance-field.reflection-composite');
    const created = pipelines.mock.calls.map(([descriptor]) => descriptor.label);
    for (const stage of [
      'traceReflections',
      'generateFieldReflections',
      'accumulateFieldReflections',
      'filterFieldReflections',
    ])
      expect(created).not.toContain(`irradiance-field.${stage}`);
  } finally {
    compile.mockRestore();
    pipelines.mockRestore();
    f.dispose();
  }
});

function actualFieldSubmission(
  f: Awaited<ReturnType<typeof editableIrradianceFixture>>,
  field: NonNullable<RendererIrradianceField['ready']>,
  captureOnly: boolean,
) {
  const world = createRenderWorld();
  registerGiSystems(world);
  beginFrameSubmission(world);
  expect(runRenderRecord(world, { device: f.runtime.device, frameId: 1 }).ok).toBe(true);
  Object.assign(f.runtime, { renderWorld: world });
  const encoder = renderFrameEncoder(world);
  assert(encoder.kind === 'open');
  const attempt = { lightTextureResamples: [] } as never;
  const scene = f.source().scene;
  const capture = encodeCaptureOnlyFrame(
    f.runtime,
    {} as never,
    attempt,
    encoder.encoder,
    [],
    scene,
  );
  const hooks = frameSubmissionHooks(
    f.runtime,
    {} as never,
    attempt,
    {
      rayDiffuse: undefined,
      irradianceField: field,
      bakedField: undefined,
      screenProbe: undefined,
      probePlacement: undefined,
    },
    undefined,
    scene,
    undefined,
    undefined,
  );
  assert(hooks);
  const work = captureOnly
    ? capture
    : {
        ...capture,
        isCurrent: () =>
          hooks.generationFence.currentGeneration() === hooks.generationFence.capturedGeneration,
        rejectionCause: hooks.generationFence.rejectionCause,
        onSubmittedWork: hooks.onSubmittedWork,
      };
  const submit = vi.spyOn(f.runtime.device.queue, 'submit');
  return {
    world,
    scene,
    work,
    submit,
    submitFrame: () =>
      submitEncodedFrame(
        world,
        { device: f.runtime.device, frameId: 1, rendererInternals: f.runtime, shared: true },
        [work],
        frameSubmitOutcome(world),
      ),
  };
}

for (const captureOnly of [true, false])
  it(`rejects an unsubmitted ${captureOnly ? 'capture' : 'display'} view after the actual retained scene is replaced`, async () => {
    const f = await editableIrradianceFixture();
    try {
      const before = await f.ready();
      const recorded = actualFieldSubmission(f, before, captureOnly);
      const retained = recorded.scene.retained;
      assert(retained);
      f.move(1);
      await f.ready();
      const next = f.source().scene;
      expect(next).not.toBe(recorded.scene);
      expect(recorded.scene.retained).toBe(retained);
      expect(next.retained).not.toBe(retained);
      expect(retained.isSourceCurrent()).toBe(false);
      expect(next.retained?.isSourceCurrent()).toBe(true);
      expect(recorded.submitFrame()).toBe(false);
      expect(recorded.submit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      f.dispose();
    }
  }, 30_000);

it('edits the next field after actual submission while its physical completion is pending', async () => {
  const f = await editableIrradianceFixture();
  let complete!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    complete = () => resolve(undefined);
  });
  try {
    const before = await f.ready();
    const track = vi.spyOn(before, 'track');
    const retire = vi.spyOn(before, 'retire');
    const recorded = actualFieldSubmission(f, before, false);
    vi.spyOn(f.runtime.device.queue, 'onSubmittedWorkDone').mockReturnValue(pending);
    expect(recorded.submitFrame()).toBe(true);
    expect(recorded.submit).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledExactlyOnceWith(pending);
    expect(renderSubmission(recorded.world).completion).toBe(pending);
    f.move(1);
    expect(await f.ready()).toBe(before);
    expect(retire).not.toHaveBeenCalled();
    expect(recorded.submit).toHaveBeenCalledTimes(1);
  } finally {
    complete();
    await pending;
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('fences the previous recorded canonical epoch and ignores its late projection completion', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready();
    const oldFacts = field.canonical.expected;
    const immutableFacts = [...oldFacts];
    const recorded = actualFieldSubmission(f, field, false);
    field.canonical.submitted(oldFacts[3]);
    expect(field.canonical.required()).toBe(false);
    f.move(1);
    expect(await f.ready()).toBe(field);
    expect(field.canonical.expected[3]).toBeGreaterThan(oldFacts[3]);
    expect(field.canonical.expected).not.toBe(oldFacts);
    expect(Object.isFrozen(oldFacts)).toBe(true);
    expect([...oldFacts]).toEqual(immutableFacts);
    expect(recorded.submitFrame()).toBe(false);
    expect(recorded.submit).not.toHaveBeenCalled();
    field.canonical.submitted(oldFacts[3]);
    expect(field.canonical.required()).toBe(true);
    field.canonical.submitted(field.canonical.expected[3]);
    expect(field.canonical.required()).toBe(false);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('invalidates canonical transport before placement writes and retires a failed invalidation', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready();
    const facts = field.canonical.expected;
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    const invalidate = vi.spyOn(f.runtime.device.queue, 'writeTexture').mockReturnValue(
      err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'successful canonical invalidation',
          hint: 'controlled RHI failure',
        }),
      ),
    );
    f.move(1);
    f.prepare();
    expect(invalidate).toHaveBeenCalled();
    expect(
      write.mock.calls.some(([buffer]) => buffer === field.region.input.instances.buffer),
    ).toBe(false);
    expect(field.canonical.expected).toBe(facts);
    expect(f.owner.ready).not.toBe(field);
    invalidate.mockRestore();
    write.mockRestore();
    expect(await f.ready()).not.toBe(field);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

function controlledMove(
  field: NonNullable<RendererIrradianceField['ready']>,
  x: number,
): fieldEdits.FieldEdit {
  const [id, row] = [...field.editState].find(([, row]) => row.index === 0) ?? [];
  assert(id !== undefined && row !== undefined);
  const to = row.transform.slice();
  to[12] = x;
  return {
    moved: [{ id, index: row.index, from: row.transform.slice(), to, local: row.local }],
    removed: [],
    added: [],
    rematerialized: [],
  };
}

it('rejects late source epochs before any write and publishes each accepted transaction once', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready(),
      region = field.region,
      initial = region.placement.current;
    const first = initial.surface.sourceEpoch;
    assert(first !== undefined && first > 0);
    expect(region.input.instances.size / 144).toBeGreaterThan(initial.instances.length);
    expect(field.canonical.expected).toEqual([
      region.input.instances.size / 4,
      region.input.fields.size / 4,
      initial.instances.length,
      first,
    ]);
    const beforeWrite = vi.fn(() => ok(undefined));
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    adoptFieldSourceEpoch(f.runtime.device, region, first, beforeWrite);
    expect(write).not.toHaveBeenCalled();
    expect(beforeWrite).not.toHaveBeenCalled();
    adoptFieldSourceEpoch(f.runtime.device, region, first + 1, beforeWrite);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    const accepted = region.placement.current;
    expect(accepted).not.toBe(initial);
    expect(initial.surface.sourceEpoch).toBe(first);
    expect(accepted.surface.sourceEpoch).toBe(first + 1);
    write.mockClear();
    beforeWrite.mockClear();
    for (const epoch of [first, 0, -1, 1.5, 0x100000000]) {
      expect(() => adoptFieldSourceEpoch(f.runtime.device, region, epoch, beforeWrite)).toThrow();
      expect(() =>
        writeFieldEdit(
          f.runtime.device,
          region,
          field.cards,
          controlledMove(field, 1),
          field.editState,
          epoch,
          beforeWrite,
        ),
      ).toThrow();
      expect(write).not.toHaveBeenCalled();
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(region.placement.current).toBe(accepted);
    }
    const noChange = { moved: [], removed: [], added: [], rematerialized: [] };
    const equal = writeFieldEdit(
      f.runtime.device,
      region,
      field.cards,
      noChange,
      field.editState,
      first + 1,
      beforeWrite,
    );
    equal.publish();
    expect(write).not.toHaveBeenCalled();
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(() => equal.publish()).toThrow('stale or repeated');
    expect(write).not.toHaveBeenCalled();
    const edit = controlledMove(field, 1);
    const moved = writeFieldEdit(
      f.runtime.device,
      region,
      field.cards,
      edit,
      field.editState,
      first + 2,
    );
    fieldEdits.adoptFieldEdit(field.editState, edit);
    moved.publish();
    const published = region.placement.current;
    write.mockClear();
    expect(() => moved.publish()).toThrow('stale or repeated');
    expect(write).not.toHaveBeenCalled();
    expect(region.placement.current).toBe(published);
    expect(published.surface.sourceEpoch).toBe(first + 2);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('owns independent current row images for two poses of one Mesh and never rewrites held snapshots', async () => {
  const f = await editableIrradianceFixture();
  try {
    f.spawn(f.meshHandle);
    f.world.set(f.entity, Transform, { scale: [1.3, 1, 1] }).unwrap();
    propagateTransforms(f.world).unwrap();
    f.snapshot.transform.world.set(f.world.get(f.entity, GlobalTransform).unwrap().world);
    f.refresh();
    const field = await f.ready();
    const cold = field.region.placement.current;
    const coldBytes = cold.instanceData.slice(),
      coldHeaders = cold.surface.headers.slice();
    expect(cold.instances).toHaveLength(2);
    expect(cold.instances[0]?.field).toBe(cold.instances[1]?.field);
    const untouched = cold.instanceData.slice(144, 288);
    const secondHeader = cold.surface.headers.slice(24, 44);
    expect(cold.surface.headers[22]).toBeGreaterThan(0);
    expect(cold.surface.headers[42]).toBe(0);
    for (const x of [0.5, 1]) {
      f.move(x);
      expect(await f.ready()).toBe(field);
      const current = field.region.placement.current;
      expect(current).not.toBe(cold);
      expect(current.instanceData.slice(144, 288)).toEqual(untouched);
      expect(current.surface.headers.slice(24, 44)).toEqual(secondHeader);
      const inverse = new DataView(current.instanceData.buffer, current.instanceData.byteOffset);
      expect(inverse.getFloat32(48, true)).toBeCloseTo(-x / 1.3, 6);
    }
    expect(cold.instanceData).toEqual(coldBytes);
    expect(cold.surface.headers).toEqual(coldHeaders);
    expect(cold.instances[0]?.transform[12]).toBe(0);
    expect(cold.surface.headers.byteLength).toBeLessThanOrEqual(16 + 80 * 1024);
    expect(cold.instanceData.byteLength).toBe(cold.surface.headerCapacity * 144);
  } finally {
    f.dispose();
  }
}, 30_000);

it('publishes the Card directory count when a later streaming admission stays pending', async () => {
  const f = await editableIrradianceFixture();
  let release!: () => void;
  const pending = new Promise<ReturnType<typeof ok<undefined>>>((resolve) => {
    release = () => resolve(ok(undefined));
  });
  let capture: SurfaceCapture | undefined;
  const owned: Buffer[] = [];
  try {
    f.spawn(f.meshHandle);
    f.spawn(f.meshHandle);
    const field = await f.ready();
    const device = f.runtime.device;
    const lowered = field.region.sources.map((source) => {
      const instance = field.region.instances[source.firstInstance];
      assert(instance);
      return field.cards.lower(source, instance, instance.instanceId);
    });
    const first = lowered[0];
    assert(first);
    capture = (
      await prepareSurfaceCapture(
        device,
        createShaderModule,
        [first],
        { kind: 'cards', resolution: 16 },
        1024 * 1024,
        64,
      )
    ).unwrap();
    const packed = packCardLookupProjections(
      capture,
      capture.entries.map((entry) => ({ instanceId: entry.instanceId, key: entry.geometryKey })),
      lowered,
    );
    const image = new Uint8Array(capture.capacity * 80);
    const imageView = new DataView(image.buffer);
    for (let tile = 0; tile < capture.capacity; tile++)
      imageView.setUint32(tile * 80 + 64, 0xffffffff, true);
    image.set(packed.bytes);
    const buffer = (bytes: Uint8Array, usage: number) => {
      const result = device.createBuffer({ size: bytes.byteLength, usage: usage | 8 }).unwrap();
      device.queue.writeBuffer(result, 0, bytes).unwrap();
      owned.push(result);
      return result;
    };
    const projections = { buffer: buffer(image, 128), bytes: image };
    const settings = {
      buffer: buffer(new Uint8Array(Uint32Array.of(packed.count, 16, 0, 0).buffer), 64),
    };
    const residency = new CardResidency(
      device,
      { capture, projections, settings, lower: field.cards.lower },
      field.editState,
      field.region.sources,
      field.region.instances,
    );
    const schedule = new CardCaptureScheduler(capture.allocatedTiles, 16);
    const initialCount = capture.allocatedTiles;
    const admitted = capture.admitted.bind(capture);
    const admit = capture.admit.bind(capture);
    vi.spyOn(capture, 'admitted').mockImplementation(
      (source) => source.instance.instanceId !== 2 && admitted(source),
    );
    const admission = vi
      .spyOn(capture, 'admit')
      .mockImplementation((source) => (source.instance.instanceId === 2 ? pending : admit(source)));
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    residency.stream([[0, 0, 0]], schedule, 16);
    expect(admission).toHaveBeenCalledOnce();
    expect(capture.has(1)).toBe(true);
    expect(capture.has(2)).toBe(false);
    expect(capture.allocatedTiles).toBeGreaterThan(initialCount);
    const countWrites = writes.mock.calls.filter(
      ([buffer, offset]) => buffer === settings.buffer && offset === 0,
    );
    expect(countWrites).toHaveLength(1);
    const countBytes = countWrites[0]?.[2];
    assert(countBytes instanceof Uint8Array);
    const publishedCount = new DataView(countBytes.buffer, countBytes.byteOffset).getUint32(
      0,
      true,
    );
    expect(publishedCount).toBe(capture.allocatedTiles);
    const imageWrites = writes.mock.calls.filter(([buffer]) => buffer === projections.buffer);
    expect(imageWrites).toHaveLength(1);
    expect(imageWrites[0]?.[1]).toBe(0);
    expect(imageWrites[0]?.[2].byteLength).toBe(image.byteLength);
    const table = new DataView(image.buffer);
    for (const [rank, owner] of [0, 1].entries()) {
      const head = table.getUint32(rank * 80 + 72, true);
      expect(head).toBeGreaterThan(0);
      expect(head).toBeLessThanOrEqual(publishedCount);
      expect(table.getUint32((head - 1) * 80 + 64, true)).toBe(owner);
    }
  } finally {
    release();
    await pending;
    vi.restoreAllMocks();
    capture?.dispose();
    for (const buffer of owned) f.runtime.device.destroyBuffer(buffer).unwrap();
    f.dispose();
  }
}, 30_000);

it('removes an owned instance without replacing the surviving field generation', async () => {
  const f = await editableIrradianceFixture();
  try {
    f.spawn(f.meshHandle);
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    const field = await f.ready();
    const initialBounds = write.mock.calls.find(
      ([buffer, offset]) => buffer === field.region.input.bounds.buffer && offset === 0,
    )?.[2];
    assert(initialBounds instanceof Uint8Array);
    expect(new DataView(initialBounds.buffer, initialBounds.byteOffset).getUint32(28, true)).toBe(
      1,
    );
    write.mockClear();
    const held = field.region.placement.current;
    const oldBytes = held.instanceData.slice();
    const oldHeaders = held.surface.headers.slice();
    const oldCards = field.cards.projections.bytes.slice();
    const generation = f.owner.inspect().generation;
    const retire = vi.spyOn(field, 'retire');
    f.remove();
    expect(await f.ready()).toBe(field);
    expect(f.owner.inspect().generation).toBe(generation);
    expect(retire).not.toHaveBeenCalled();
    expect(field.editState.size).toBe(1);
    expect(field.cards.capture.has(0)).toBe(false);
    expect(field.cards.capture.has(1)).toBe(true);
    const next = field.region.placement.current;
    expect(next).not.toBe(held);
    expect(next.instances[0]?.mask).toBe(0);
    expect(next.instances[1]?.mask).toBe(255);
    expect(new DataView(next.instanceData.buffer).getUint32(76, true)).toBe(0);
    expect(next.instanceData.slice(144, 288)).toEqual(oldBytes.slice(144, 288));
    expect(next.surface.headers[6]).toBe(0);
    expect(next.surface.headers.slice(24, 44)).toEqual(oldHeaders.slice(24, 44));
    expect(held.instanceData).toEqual(oldBytes);
    expect(held.surface.headers).toEqual(oldHeaders);
    expect(held.instances[0]?.mask).toBe(255);
    expect(
      write.mock.calls.filter(
        ([buffer, offset]) => buffer === field.region.input.bounds.buffer && offset === 28,
      ),
    ).toEqual([]);
    const projections = write.mock.calls.filter(
      ([buffer]) => buffer === field.cards.projections.buffer,
    );
    expect(projections).toHaveLength(1);
    expect(projections[0]?.[1]).toBe(0);
    const removed = projections[0]?.[2];
    assert(removed instanceof Uint8Array);
    expect(removed).toEqual(field.cards.projections.bytes);
    expect(removed.byteLength).toBe(oldCards.byteLength);
    const view = new DataView(removed.buffer, removed.byteOffset, removed.byteLength);
    const before = new DataView(oldCards.buffer);
    const surviving: number[] = [];
    for (let offset = 0; offset < removed.byteLength; offset += 80) {
      if (before.getUint32(offset + 64, true) === 0) {
        expect(view.getUint32(offset + 64, true)).toBe(0xffffffff);
        expect(view.getUint32(offset + 68, true)).toBe(0);
      } else {
        expect(removed.slice(offset, offset + 72)).toEqual(oldCards.slice(offset, offset + 72));
      }
      if (view.getUint32(offset + 64, true) === 1) surviving.push(offset / 80);
    }
    expect(surviving.length).toBeGreaterThan(0);
    expect(view.getUint32(72, true)).toBe((surviving[0] ?? -1) + 1);
    for (let tile = 1; tile < removed.byteLength / 80; tile++)
      expect(view.getUint32(tile * 80 + 72, true)).toBe(0);
    for (const [index, tile] of surviving.entries())
      expect(view.getUint32(tile * 80 + 76, true)).toBe((surviving[index + 1] ?? -1) + 1);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('keeps the surviving canonical row address through a removal and subsequent moves', async () => {
  const f = await editableIrradianceFixture();
  try {
    const otherMesh = f.assets.create(await createProbeGlobalMesh(1, 1, 0.2)).unwrap();
    const survivor = f.spawn(otherMesh);
    const field = await f.ready();
    const held = field.region.placement.current;
    expect(held.instances[0]?.field).not.toBe(held.instances[1]?.field);
    expect(held.instances[1]?.geometryId).toBe(1);
    for (const x of [2, 3]) {
      f.world.set(survivor.entity, Transform, { pos: [x, 0, 0] }).unwrap();
      propagateTransforms(f.world).unwrap();
      survivor.snapshot.transform.world.set(
        f.world.get(survivor.entity, GlobalTransform).unwrap().world,
      );
      if (x === 2) f.remove();
      else f.refresh();
      expect(await f.ready()).toBe(field);
      const next = field.region.placement.current;
      expect(next.instances[0]?.mask).toBe(0);
      expect(next.instances[1]?.transform[12]).toBe(x);
      expect(next.instances[1]?.geometryId).toBe(1);
      expect(new DataView(next.instanceData.buffer).getUint32(144 + 80, true)).toBe(24);
      expect(next.surface.meshes).toBe(held.surface.meshes);
      expect([...field.editState.values()].map((row) => row.index)).toEqual([1]);
      expect(field.cards.capture.has(0)).toBe(false);
      expect(field.cards.capture.has(1)).toBe(true);
    }
    expect(held.instances[0]?.mask).toBe(255);
    expect(held.instances[1]?.transform[12]).toBe(0);
  } finally {
    f.dispose();
  }
}, 30_000);

it('rejects unsupported membership, stale identities and undersized canonical spans before every publication', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready(),
      region = field.region,
      current = region.placement.current;
    const move = controlledMove(field, 1),
      first = move.moved[0];
    assert(first);
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    const retransform = vi.spyOn(field.cards.capture, 'retransform');
    const rematerialize = vi.spyOn(field.cards.capture, 'rematerialize');
    const stale = { ...first, id: `${first.id}:stale-generation` };
    const source = region.sources[0],
      instance = current.instances[0];
    assert(source && instance);
    const added = {
      ...move,
      moved: [],
      added: [{ id: `${first.id}:new-generation`, source, instance, local: first.local }],
    };
    const removed = {
      ...move,
      moved: [],
      removed: [{ id: first.id, index: first.index, from: first.from, local: first.local }],
    };
    const removal = removed.removed[0];
    assert(removal);
    for (const [target, edit] of [
      [region, { ...removed, removed: [{ ...removal, id: `${first.id}:stale` }] }],
      [region, { ...removed, removed: [...removed.removed, ...removed.removed] }],
      [region, { ...move, removed: removed.removed }],
      [
        region,
        {
          ...removed,
          removed: [{ ...removal, from: Float32Array.from(first.to) }],
        },
      ],
      [region, added],
      [region, { ...move, moved: [stale] }],
      [
        region,
        {
          ...move,
          moved: [
            {
              ...first,
              from: Float32Array.from(first.from, (_, i) => (i === 12 ? 2 : (first.from[i] ?? 0))),
            },
          ],
        },
      ],
      [
        { ...region, input: { ...region.input, fields: { ...region.input.fields, size: 16 } } },
        move,
      ],
      [
        {
          ...region,
          input: { ...region.input, instances: { ...region.input.instances, size: 143 } },
        },
        move,
      ],
    ] as const) {
      expect(() =>
        writeFieldEdit(
          f.runtime.device,
          target,
          field.cards,
          edit,
          field.editState,
          (current.surface.sourceEpoch ?? 0) + 1,
        ),
      ).toThrow();
      expect(region.placement.current).toBe(current);
      expect(write).not.toHaveBeenCalled();
      expect(retransform).not.toHaveBeenCalled();
      expect(rematerialize).not.toHaveBeenCalled();
    }
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('rejects material admission without GPU writes or Card CPU publication, and keeps coverage per instance', async () => {
  const f = await editableIrradianceFixture();
  try {
    f.spawn(f.meshHandle);
    const field = await f.ready(),
      region = field.region,
      current = region.placement.current;
    const move = controlledMove(field, 1),
      first = move.moved[0];
    assert(first);
    const source = region.sources[0],
      instance = current.instances[0];
    assert(source && instance);
    const edit: fieldEdits.FieldEdit = {
      moved: [],
      removed: [],
      added: [],
      rematerialized: [
        {
          id: first.id,
          index: 0,
          source,
          instance: { ...instance, surfaceCoverage: 'unavailable' },
          local: first.local,
        },
      ],
    };
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    const before = field.cards.capture.entry(0);
    const retransform = vi.spyOn(field.cards.capture, 'retransform');
    const rematerialize = vi.spyOn(field.cards.capture, 'rematerialize');
    const admitted = vi.spyOn(field.cards.capture, 'admitted').mockReturnValue(false);
    expect(() =>
      writeFieldEdit(
        f.runtime.device,
        region,
        field.cards,
        edit,
        field.editState,
        (current.surface.sourceEpoch ?? 0) + 1,
      ),
    ).toThrow('prior Card admission');
    expect(write).not.toHaveBeenCalled();
    expect(retransform).not.toHaveBeenCalled();
    expect(rematerialize).not.toHaveBeenCalled();
    expect(field.cards.capture.entry(0)).toBe(before);
    expect(region.placement.current).toBe(current);
    admitted.mockRestore();
    const materialEdit = edit.rematerialized[0];
    assert(materialEdit);
    const displaced = Float32Array.from(instance.transform);
    displaced[12] = 1;
    expect(() =>
      writeFieldEdit(
        f.runtime.device,
        region,
        field.cards,
        {
          ...edit,
          rematerialized: [{ ...materialEdit, instance: { ...instance, transform: displaced } }],
        },
        field.editState,
        (current.surface.sourceEpoch ?? 0) + 1,
      ),
    ).toThrow('disagree');
    expect(write).not.toHaveBeenCalled();
    expect(rematerialize).not.toHaveBeenCalled();
    const written = writeFieldEdit(
      f.runtime.device,
      region,
      field.cards,
      edit,
      field.editState,
      (current.surface.sourceEpoch ?? 0) + 1,
    );
    expect(region.placement.current).toBe(current);
    fieldEdits.adoptFieldEdit(field.editState, edit);
    written.publish();
    const next = region.placement.current;
    expect(next.surface.headers[6]).toBe(0);
    expect(next.surface.headers[26]).toBe(1);
    expect(current.surface.headers[6]).toBe(1);
    expect(next.instances[0]?.surfaceCoverage).toBe('unavailable');
    expect(next.instances[1]?.surfaceCoverage).toBe('opaque');
    expect(next.instances[0]?.field).toBe(next.instances[1]?.field);
    expect(rematerialize).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('refuses a changed coverage pattern before any physical write or accepted epoch mutation', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready();
    const region = field.region,
      current = region.placement.current;
    const instance = current.instances[0],
      source = region.sources[0];
    const move = controlledMove(field, 1).moved[0];
    assert(instance && source && move);
    assert(!('missing' in instance.field) && instance.field.surface);
    const count = instance.field.surface.indices.length / 3;
    const bits = new Uint32Array(Math.ceil(count / 32));
    bits[0] = 1;
    const edit: fieldEdits.FieldEdit = {
      moved: [],
      removed: [],
      added: [],
      rematerialized: [
        {
          id: move.id,
          index: 0,
          source,
          instance: { ...instance, surfaceCoverage: { kind: 'partial', opaquePrimitives: bits } },
          local: move.local,
        },
      ],
    };
    const write = vi.spyOn(f.runtime.device.queue, 'writeBuffer');
    const rematerialize = vi.spyOn(field.cards.capture, 'rematerialize');
    const before = current.surface.headers.slice();
    const epoch = current.surface.sourceEpoch;
    const invalidate = vi.fn(() => ok(undefined));
    expect(() =>
      writeFieldEdit(
        f.runtime.device,
        region,
        field.cards,
        edit,
        field.editState,
        (current.surface.sourceEpoch ?? 0) + 1,
        invalidate,
      ),
    ).toThrow('coverage changes require a complete scene rebuild');
    expect(write).not.toHaveBeenCalled();
    expect(rematerialize).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(region.placement.current).toBe(current);
    expect(current.surface.headers).toEqual(before);
    expect(current.surface.sourceEpoch).toBe(epoch);
    expect(current.instances[0]?.surfaceCoverage).toBe('opaque');
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

it('invalidates first and publishes ready only after physical rows, Card adoption and edit boxes', async () => {
  const f = await editableIrradianceFixture();
  try {
    const field = await f.ready(),
      region = field.region;
    const old = region.placement.current;
    const events: string[] = [];
    const write = f.runtime.device.queue.writeBuffer.bind(f.runtime.device.queue);
    vi.spyOn(f.runtime.device.queue, 'writeBuffer').mockImplementation((...args) => {
      const bytes = args[2];
      if (args[0] === region.input.fields.buffer && args[1] === 0) {
        const view =
          bytes instanceof ArrayBuffer
            ? new DataView(bytes)
            : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        events.push(view.getUint32(0, true) === 0 ? 'invalidate' : 'ready');
      } else if (args[0] === region.input.instances.buffer) events.push('instance');
      else if (args[0] === region.input.settings.buffer && args[1] === 40) events.push('edit-box');
      return write(...args);
    });
    const adopt = fieldEdits.adoptFieldEdit;
    vi.spyOn(fieldEdits, 'adoptFieldEdit').mockImplementation((...args) => {
      events.push('adopt');
      return adopt(...args);
    });
    f.move(1);
    expect(await f.ready()).toBe(field);
    expect(events[0]).toBe('invalidate');
    expect(events.at(-1)).toBe('ready');
    expect(events.indexOf('instance')).toBeGreaterThan(0);
    expect(events.indexOf('adopt')).toBeGreaterThan(events.indexOf('instance'));
    expect(events.indexOf('edit-box')).toBeGreaterThan(events.indexOf('adopt'));
    expect(region.placement.current).not.toBe(old);
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 30_000);

function finalReadyWrite(
  args: Parameters<RenderSystemInternals['device']['queue']['writeBuffer']>,
  field: NonNullable<RendererIrradianceField['ready']>,
): boolean {
  const data = args[2];
  return (
    args[0] === field.region.input.fields.buffer &&
    args[1] === 0 &&
    data instanceof Uint8Array &&
    data.byteLength === 4 &&
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) === 0x53534650
  );
}

for (const mutation of ['move', 'remove'] as const)
  for (const failure of [
    'second-physical-write',
    'card-mutation',
    'row-adoption',
    'residency-adoption',
    'edit-box-write',
    'final-ready-write',
  ] as const)
    it(`retires a partially applied irradiance ${mutation} after ${failure} and rebuilds coherently`, async () => {
      const f = await editableIrradianceFixture();
      const cleanup: (() => void)[] = [];
      try {
        if (mutation === 'remove') f.spawn(f.meshHandle);
        const before = await f.ready();
        const held = before.region.placement.current;
        const retire = vi.spyOn(before, 'retire');
        const quiet = [...before.editState.values()].find((row) => row.index === 0)?.transform[12];
        if (mutation === 'move') f.move((quiet ?? 0) + 1);
        else f.remove();
        const current = f.source().scene;
        assert(current.retained);
        expect(current.retained.revision).toBeGreaterThan(before.retained.revision);
        expect(current.retained.meshes).toBe(before.retained.meshes);
        expect(current.scene.changedSlotsSince(before.content)).toContain(0);
        const planning = vi.spyOn(fieldEdits, 'diffFieldEdit');
        cleanup.push(() => planning.mockRestore());
        let injected = false;
        if (failure === 'card-mutation') {
          const spy = vi
            .spyOn(before.cards.capture, mutation === 'move' ? 'retransform' : 'remove')
            .mockImplementation(() => {
              injected = true;
              throw new Error(failure);
            });
          cleanup.push(() => spy.mockRestore());
        } else if (failure === 'row-adoption') {
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
                args[1] === 40) ||
              (failure === 'final-ready-write' && finalReadyWrite(args, before))
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
        expect(before.region.placement.current).toBe(held);
        for (const restore of cleanup.splice(0)) restore();
        const replacement = await f.ready();
        expect(replacement).not.toBe(before);
        expect(
          [...replacement.editState.values()].find((row) => row.index === 0)?.transform[12],
        ).toBe(mutation === 'move' ? (quiet ?? 0) + 1 : 0);
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
