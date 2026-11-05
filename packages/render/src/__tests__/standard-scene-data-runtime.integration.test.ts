import { type AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import { rhi } from '@forgeax/engine-rhi-null';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt, MaterialArtifactRegistry } from '@forgeax/engine-shader';
import { ok, type ShaderEntryPointReads } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { installMaterialReadyShaders } from '../../../assets-runtime/src/material/runtime-shader';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import {
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_SSAO,
  AmbientOcclusion,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
} from '../components';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, BLOOM_DISABLED } from '../components/camera';
import { SceneDataUnavailableError } from '../errors/render';
import type { RenderFeature } from '../features/types';
import { Materials } from '../materials';
import { extractFrames } from '../render-system-extract-tail';
import {
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataTarget,
  sceneDataTargetOwner,
} from '../temporal/scene-data';
import type { SceneDataCatalog } from '../temporal/scene-data-catalog';
import { standardSceneDataContributorForDispatch } from '../temporal/standard-scene-data-admission';
import { STANDARD_CLUSTER_TEST_REFLECTION } from './cluster-test-abi';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const fullscreenRaster = `
struct CandidateVertex { @location(0) position: vec3<f32> }
@vertex fn vs_main(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@vertex fn vs_scene_index(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_opaque() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_gbuffer() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_ao_input() -> @location(0) u32 { return 0u; }
`;

const clusterTextureConsumerRaster = `
struct CandidateVertex { @location(0) position: vec3<f32> }
struct ClusterUniform {
  grid: vec4<u32>,
  near_far_log: vec4<f32>,
  ao: vec4<u32>,
  direct_ao: vec4<f32>,
  texture: vec4<u32>,
  cluster_layout: vec4<u32>,
}
@group(2) @binding(3) var cluster_data_texture: texture_2d<u32>;
@group(2) @binding(6) var<uniform> cluster_uniform: ClusterUniform;
@vertex fn vs_main(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@vertex fn vs_scene_index(input: CandidateVertex) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_opaque() -> @location(0) vec4<f32> {
  let word = textureLoad(cluster_data_texture, vec2<i32>(0), 0).x;
  let width = cluster_uniform.texture.w;
  return vec4<f32>(f32(word ^ width) * 0.0, 1.0, 1.0, 1.0);
}
@fragment fn fs_gbuffer() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
@fragment fn fs_ao_input() -> @location(0) u32 { return 0u; }
`;

const fullscreenRasterEntryPoints: readonly ShaderEntryPointReads[] = [
  { name: 'vs_main', stage: 'vertex', bindings: [] },
  { name: 'vs_scene_index', stage: 'vertex', bindings: [] },
  { name: 'fs_main', stage: 'fragment', bindings: [] },
  { name: 'fs_opaque', stage: 'fragment', bindings: [] },
  { name: 'fs_gbuffer', stage: 'fragment', bindings: [] },
  { name: 'fs_ao_input', stage: 'fragment', bindings: [] },
];

const reflectedClusterAbi = {
  ...STANDARD_CLUSTER_TEST_REFLECTION,
  boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.map((global) => ({
    ...global,
    ...(global.resourceKind === 'storage-buffer'
      ? { span: global.elementStride ?? global.span }
      : {}),
    elementType: global.resourceKind === 'storage-buffer' ? 'LightData' : 'struct',
  })),
};

const testCompilerProfile = {
  id: 'forgeax-material-wgsl-v1',
  language: 'wgsl',
  profileVersion: '1',
  adapterVersion: '1',
  compilerVersion: '1',
  nagaVersion: '30.0.1',
} as const;

const reflectedClusterTexture = {
  ...reflectedClusterAbi,
  boundGlobals: reflectedClusterAbi.boundGlobals.map((global) =>
    global.group === 2 && global.binding === 3
      ? {
          group: 2,
          binding: 3,
          addressSpace: 'handle',
          resourceKind: 'texture',
          resourceAccess: 'read-only',
          textureClass: 'sampled',
          sampleType: 'uint',
          viewDimension: '2d',
          multisampled: false,
          visibility: global.visibility,
          name: 'cluster_data_texture',
        }
      : global,
  ),
} as const;

function sceneDataConsumer(
  onTarget: (target: object) => void,
  onPlannedView: (view: { readonly identity: string; readonly render: boolean }) => void,
  options: {
    readonly onCatalog?: (catalog: SceneDataCatalog) => void;
    readonly onRequireError?: (error: unknown) => void;
    readonly priorTarget?: () => SceneDataTarget | undefined;
    readonly onPriorValidation?: (result: ReturnType<SceneDataCatalog['validate']>) => void;
  } = {},
): RenderFeature<null> {
  return {
    identity: 'test.standard-surface-normal-consumer',
    placement: 'scene',
    extract: () => ok(null),
    plan: (_data, context) => {
      const view = context.views.find((candidate) => candidate.render) ?? context.views[0];
      if (view === undefined) return ok({ work: [] });
      onPlannedView(view);
      options.onCatalog?.(view.sceneData);
      const previous = options.priorTarget?.();
      if (previous !== undefined) options.onPriorValidation?.(view.sceneData.validate(previous));
      let target: SceneDataTarget;
      try {
        target = view.sceneData.require(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
      } catch (error) {
        options.onRequireError?.(error);
        throw error;
      }
      onTarget(target);
      if (!view.render) return ok({ work: [] });
      return ok({
        work: [
          {
            scope: { view: view.identity },
            resources: [
              {
                kind: 'compute-program' as const,
                name: 'surface-consumer-program',
                program: {
                  wgsl: `
                    @group(0) @binding(0) var surfaceNormal: texture_2d<u32>;
                    @compute @workgroup_size(1) fn consume() {
                      let value = textureLoad(surfaceNormal, vec2<i32>(0), 0);
                    }
                  `,
                  entryPoints: ['consume'],
                  bindings: [
                    {
                      entries: [
                        {
                          binding: 0,
                          visibility: 4,
                          texture: {
                            sampleType: 'uint' as const,
                            viewDimension: '2d' as const,
                            multisampled: false,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
              {
                kind: 'prepared-gpu-resource' as const,
                name: 'surface-normal-view',
                resource: { kind: 'texture-view' as const, value: undefined },
                logicalTarget: target,
              },
              {
                kind: 'compute-bindings' as const,
                name: 'surface-consumer-bindings',
                program: 'surface-consumer-program',
                entries: [{ binding: 0, resource: 'surface-normal-view' }],
              },
            ],
            passes: [
              {
                kind: 'compute' as const,
                name: 'surface-normal-consumer',
                program: 'surface-consumer-program',
                bindings: 'surface-consumer-bindings',
                dispatches: [
                  { kind: 'direct' as const, entryPoint: 'consume', workgroups: [1, 1, 1] },
                ],
              },
            ],
          },
        ],
      });
    },
  };
}

function temporalSceneDataConsumer(
  onTarget: (target: SceneDataTarget) => void,
  onCatalog: (catalog: SceneDataCatalog) => void,
): RenderFeature<null> {
  return {
    identity: 'test.temporal-data-consumer',
    placement: 'post',
    extract: () => ok(null),
    plan: (_data, context) => {
      const view = context.views.find((candidate) => candidate.render);
      if (view === undefined) return ok({ work: [] });
      onCatalog(view.sceneData);
      const target = view.sceneData.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
      onTarget(target);
      return ok({
        work: [
          {
            scope: { view: view.identity },
            resources: [
              {
                kind: 'compute-program' as const,
                name: 'temporal-consumer-program',
                program: {
                  wgsl: `
                    @group(0) @binding(0) var temporal: texture_2d<f32>;
                    @compute @workgroup_size(1) fn consume() {
                      let value = textureLoad(temporal, vec2<i32>(0), 0);
                    }
                  `,
                  entryPoints: ['consume'],
                  bindings: [
                    {
                      entries: [
                        {
                          binding: 0,
                          visibility: 4,
                          texture: {
                            sampleType: 'unfilterable-float' as const,
                            viewDimension: '2d' as const,
                            multisampled: false,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
              {
                kind: 'prepared-gpu-resource' as const,
                name: 'temporal-view',
                resource: { kind: 'texture-view' as const, value: undefined },
                logicalTarget: target,
              },
              {
                kind: 'compute-bindings' as const,
                name: 'temporal-consumer-bindings',
                program: 'temporal-consumer-program',
                entries: [{ binding: 0, resource: 'temporal-view' }],
              },
            ],
            passes: [
              {
                kind: 'compute' as const,
                name: 'temporal-data-consumer',
                program: 'temporal-consumer-program',
                bindings: 'temporal-consumer-bindings',
                dispatches: [
                  { kind: 'direct' as const, entryPoint: 'consume', workgroups: [1, 1, 1] },
                ],
              },
            ],
          },
        ],
      });
    },
  };
}

function rhiNullWithoutStorageBuffer() {
  return {
    ...rhi,
    requestAdapter: async (...args: Parameters<typeof rhi.requestAdapter>) => {
      const requested = await rhi.requestAdapter(...args);
      if (!requested.ok) return requested;
      const adapter = requested.value;
      const projected = new Proxy(adapter, {
        get(target, property, receiver) {
          if (property !== 'requestDevice') {
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (...deviceArgs: Parameters<typeof target.requestDevice>) => {
            const device = await target.requestDevice(...deviceArgs);
            if (device.ok) {
              Object.defineProperty(device.value, 'caps', {
                value: { ...device.value.caps, storageBuffer: false },
              });
              Object.defineProperty(device.value, 'limits', {
                value: { ...device.value.limits, maxTextureDimension2D: 8192 },
              });
            }
            return device;
          };
        },
      });
      return ok(projected);
    },
  };
}

function sceneDataRhi(storageBuffer: boolean | undefined) {
  return storageBuffer === false ? rhiNullWithoutStorageBuffer() : rhi;
}

async function createSceneDataRuntime(
  feature: RenderFeature<null> | undefined,
  options: {
    readonly camera?: boolean;
    readonly unlit?: boolean;
    readonly forwardOnlyContributor?: boolean;
    readonly cookedStandard?: boolean;
    readonly morphTarget?: boolean;
    readonly temporal?: 'taa' | 'motion-blur';
    readonly ao?: boolean;
    readonly algorithm?: 'ssao' | 'gtao';
    readonly renderPath?: 'forward' | 'deferred';
    readonly recording?: boolean;
    readonly storageBuffer?: boolean;
    readonly clusterTextureConsumer?: boolean;
  } = {},
) {
  const rendererRhi = sceneDataRhi(options.storageBuffer);
  const recorder = options.recording
    ? attachRecorder({
        rhi: rendererRhi,
        createShaderModule: rendererRhi.createShaderModule,
        createShaderModuleImmediate: rendererRhi.createShaderModuleImmediate,
      }).unwrap()
    : undefined;
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    {
      rhi: recorder?.backend.rhi ?? rendererRhi,
      features: feature === undefined ? [] : [feature],
    },
    { shaderManifestUrl: sceneDataManifestUrl(options.clusterTextureConsumer === true) },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const profile = renderer.inspect().profile;
  expect(
    renderer.setProfile({
      ...profile,
      renderPath: options.renderPath ?? 'forward',
      ssao: options.ao === false ? false : { algorithm: options.algorithm ?? 'ssao' },
    }).ok,
  ).toBe(true);
  const errors: unknown[] = [];
  host.onError((error) => errors.push(error));
  const world = new World({ assets: host.assetRegistry });
  const meshSource = createBoxGeometry(1, 1, 1).unwrap();
  const positions = meshSource.attributes.position as Float32Array;
  const morphDelta = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    if ((positions[vertex] ?? 0) > 0) morphDelta[vertex] = 0.2;
  }
  const mesh = host.assetRegistry
    .create(
      options.morphTarget
        ? { ...meshSource, morphTargets: [{ position: morphDelta }] }
        : meshSource,
    )
    .unwrap();
  const cookedStandard = options.cookedStandard
    ? await cookStandardMaterialIntoRegistry(host.assetRegistry)
    : undefined;
  const standardMaterial =
    cookedStandard?.handle ??
    host.assetRegistry
      .create(Materials.standard({ baseColor: [0.7, 0.5, 0.3, 1], roughness: 0.5, metallic: 0 }))
      .unwrap();
  const unlitMaterial = host.assetRegistry.create(Materials.unlit([0.8, 0.4, 0.2, 1])).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      {
        component: MeshRenderer,
        data: { materials: [options.unlit ? unlitMaterial : standardMaterial] },
      },
    )
    .unwrap();
  const forwardOnlyEntity = options.forwardOnlyContributor
    ? world
        .spawn(
          { component: Transform, data: { pos: [1.5, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [unlitMaterial] } },
        )
        .unwrap()
    : undefined;
  const addForwardOnlyContributor = () =>
    world
      .spawn(
        { component: Transform, data: { pos: [1.5, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [unlitMaterial] } },
      )
      .unwrap();
  const enableMorph = () =>
    world.addComponent(entity, {
      component: MorphWeights,
      data: { weights: new Float32Array([1]) },
    });
  const disableMorph = () => world.removeComponent(entity, MorphWeights);
  let cameraEntity: EntityHandle | undefined;
  if (options.camera !== false) {
    cameraEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 6] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: options.temporal === 'taa' ? ANTIALIAS_TAA : ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
          },
        },
      )
      .unwrap();
    if (options.temporal === 'motion-blur') {
      world
        .addComponent(cameraEntity, {
          component: MotionBlur,
          data: { shutterAngle: 180, maxRadiusPixels: 16, sampleCount: 8, targetFps: 60 },
        })
        .unwrap();
    }
  }
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -0.9, -0.7], intensity: 3, castShadow: false },
    })
    .unwrap();
  const update = () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
  };
  update();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const drawFrame = () =>
    renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
  return {
    host,
    recorder,
    renderer,
    world,
    cameraEntity,
    entity,
    forwardOnlyEntity,
    cookedStandard,
    addForwardOnlyContributor,
    standardMaterial,
    unlitMaterial,
    enableMorph,
    disableMorph,
    errors,
    update,
    drawFrame,
  };
}

async function completeSceneDataFrame(
  fixture: Pick<Awaited<ReturnType<typeof createSceneDataRuntime>>, 'drawFrame'>,
) {
  const draw = fixture.drawFrame();
  if (!draw.ok) throw draw.error;
  const completed = await draw.value.completed;
  if (!completed.ok) throw completed.error;
  return draw.value;
}

type SceneDataRuntimeFixture = Awaited<ReturnType<typeof createSceneDataRuntime>>;
type SceneDataAoTargetName =
  | 'standard-scene-surface-normal'
  | 'gbuffer-normal-roughness'
  | 'ssao-raw'
  | 'ssao-blurred';

function sceneDataAoTargetSnapshot(
  host: SceneDataRuntimeFixture['host'],
  name: SceneDataAoTargetName,
) {
  const target = host.getCurrentGraphTarget(name);
  if (target === undefined) throw new Error(`Current graph target ${name} is unavailable`);
  return {
    name,
    graphGeneration: target.graphGeneration,
    textureIdentity: target.textureIdentity,
    descriptor: {
      format: target.descriptor.format,
      size: { ...target.descriptor.size },
      usage: target.descriptor.usage,
      sample: target.descriptor.sample,
    },
  };
}

function sceneDataAoGraphSnapshot(
  fixture: SceneDataRuntimeFixture,
  renderPath: 'forward' | 'deferred',
) {
  const renderer = fixture.renderer.inspect();
  const ao = renderer.standardLighting?.ambientOcclusion;
  if (ao?.graphGeneration === undefined) throw new Error('Current AO graph generation is absent');
  const targets = [
    sceneDataAoTargetSnapshot(
      fixture.host,
      renderPath === 'deferred' ? 'gbuffer-normal-roughness' : 'standard-scene-surface-normal',
    ),
    sceneDataAoTargetSnapshot(fixture.host, 'ssao-raw'),
    sceneDataAoTargetSnapshot(fixture.host, 'ssao-blurred'),
  ];
  const target = targets[0];
  if (target === undefined) throw new Error('Current AO graph target identity is absent');
  const activeCompiledGraph = renderer.renderGraphGenerationAllocation?.entries.find((entry) =>
    entry.roles.includes('active'),
  );
  if (activeCompiledGraph === undefined) {
    throw new Error('Active compiled graph allocation identity is absent');
  }
  expect(renderer.recoveryEvidence.graph.generation).toBe(target.graphGeneration);
  return {
    compiledGraphGeneration: activeCompiledGraph.generation,
    installedGraphGeneration: target.graphGeneration,
    ambientOcclusionGeneration: ao.graphGeneration,
    deviceGeneration: ao.deviceGeneration,
    directLightingStrength: ao.numerical.directLightingStrength,
    passNames: [...renderer.output.graphPassNames],
    targets,
  };
}

async function completeObservedSceneDataFrame(
  fixture: Pick<SceneDataRuntimeFixture, 'renderer' | 'drawFrame'>,
  domain: 'final-display' | 'linear-hdr',
) {
  const requested = fixture.renderer.requestObservation?.([domain]);
  if (requested === undefined) throw new Error('Renderer observation requests are unavailable');
  if (!requested.ok) throw requested.error;
  const draw = fixture.drawFrame();
  if (!draw.ok) throw draw.error;
  const completed = await draw.value.completed;
  if (!completed.ok) throw completed.error;
  const observed = await fixture.renderer.observe?.(draw.value, { include: [domain] });
  if (observed === undefined) throw new Error('Renderer observation reads are unavailable');
  expect(observed).toMatchObject({
    ok: false,
    error: {
      code: 'renderer-contract-failed',
      detail: {
        operation: 'observe',
        cause: expect.stringContaining('no mapAsync capability'),
      },
    },
  });
  return draw.value;
}

async function recordObservedSceneDataFrame(
  fixture: Pick<SceneDataRuntimeFixture, 'renderer' | 'drawFrame' | 'recorder'>,
  domain: 'final-display' | 'linear-hdr',
) {
  const recorder = fixture.recorder;
  if (recorder === undefined) throw new Error('Rhi Debug recorder is not attached');
  const requested = fixture.renderer.requestObservation?.([domain]);
  if (requested === undefined) throw new Error('Renderer observation requests are unavailable');
  if (!requested.ok) throw requested.error;
  const pendingTape = recorder.captureFrame({ seed: { maxResourceBytes: 0 } });
  const armed = await recorder.frameBoundary();
  if (!armed.ok) throw armed.error;
  const receipt = await completeSceneDataFrame(fixture);
  const observed = await fixture.renderer.observe?.(receipt, { include: [domain] });
  if (observed === undefined) throw new Error('Renderer observation reads are unavailable');
  expect(observed).toMatchObject({
    ok: false,
    error: {
      code: 'renderer-contract-failed',
      detail: {
        operation: 'observe',
        cause: expect.stringContaining('no mapAsync capability'),
      },
    },
  });
  const ended = await recorder.frameBoundary();
  if (!ended.ok) throw ended.error;
  const tape = await pendingTape;
  if (!tape.ok) throw tape.error;
  return { receipt, tape: tape.value };
}

function resourceDescriptorLabel(resource: FrameModel['resources'][number]): string | undefined {
  const descriptor = resource.descriptor;
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return undefined;
  }
  if (!('desc' in descriptor)) return undefined;
  const desc = descriptor.desc;
  if (desc === null || typeof desc !== 'object' || Array.isArray(desc) || !('label' in desc)) {
    return undefined;
  }
  return typeof desc.label === 'string' ? desc.label : undefined;
}

function isStandardMainLightingWork(work: FrameModel['works'][number]): boolean {
  return (
    work.kind === 'drawIndexed' &&
    work.pipeline.status === 'available' &&
    work.pipeline.shaders.some(
      (shader) =>
        shader.stage === 'fragment' &&
        ['fs_main', 'fs_opaque', 'fs_transparent'].includes(shader.entryPoint ?? '') &&
        shader.source?.includes('cluster_data_texture') === true,
    )
  );
}

function clusterTextureWrites(tape: V7Tape, textureHandleId: string) {
  const events = tape.events.filter(
    (event) =>
      event.kind === 'writeTexture' && event.destination.textureHandleId === textureHandleId,
  );
  const bytes = events.reduce((total, event) => {
    if (event.kind !== 'writeTexture') return total;
    const [width, height, depthOrArrayLayers] =
      'width' in event.size
        ? [event.size.width, event.size.height ?? 1, event.size.depthOrArrayLayers ?? 1]
        : (() => {
            const values = [...event.size];
            return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
          })();
    return total + (event.dataLayout.bytesPerRow ?? width * 16) * height * depthOrArrayLayers;
  }, 0);
  return { calls: events.length, bytes };
}

async function captureClusterFrameEvidence(fixture: SceneDataRuntimeFixture) {
  const recorded = await recordObservedSceneDataFrame(fixture, 'final-display');
  const tape = decodeTape(recorded.tape.bytes).unwrap();
  const model = buildFrameModel(tape);
  const target = fixture.host.getCurrentGraphTarget('standard-cluster-tables');
  if (target === undefined) throw new Error('current Cluster graph target is missing');
  const clusterResources = model.resources.filter(
    (resource) =>
      resource.kind === 'texture' &&
      resourceDescriptorLabel(resource) === 'standard-cluster-tables',
  );
  if (clusterResources.length === 0) throw new Error('recorded Cluster texture is missing');
  const textureViewSources = new Map<string, string>();
  for (const bootstrap of tape.bootstrap) {
    const sourceHandleId = bootstrap.create.sourceHandleId;
    if (bootstrap.kind === 'texture-view' && typeof sourceHandleId === 'string') {
      textureViewSources.set(bootstrap.handleId, sourceHandleId);
    }
  }
  for (const event of tape.events) {
    if (event.kind === 'createTextureView') {
      textureViewSources.set(event.resultHandleId, event.sourceHandleId);
    }
  }
  const mainWork = model.works.filter(isStandardMainLightingWork);
  const consumers = new Set<string>();
  let consumerBindingHandle: string | undefined;
  const clusterResourceIds = new Set(clusterResources.map((resource) => resource.resourceId));
  for (const work of mainWork) {
    for (const binding of work.bindings) {
      const bindingHandle = binding.resourceId;
      if (bindingHandle === null) continue;
      const sourceHandle = textureViewSources.get(bindingHandle) ?? bindingHandle;
      if (clusterResourceIds.has(sourceHandle)) {
        consumers.add(sourceHandle);
        consumerBindingHandle = bindingHandle;
      }
    }
  }
  if (consumers.size !== 1) {
    const referencedTextureHandles = new Set([
      ...clusterResourceIds,
      ...mainWork.flatMap((work) =>
        work.bindings.flatMap((binding) => {
          const id = binding.resourceId;
          return id === null ? [] : [textureViewSources.get(id) ?? id];
        }),
      ),
    ]);
    const referencedResources = model.resources
      .filter(
        (resource) =>
          resource.kind === 'texture' && referencedTextureHandles.has(resource.resourceId),
      )
      .map((resource) => ({
        resourceId: resource.resourceId,
        label: resourceDescriptorLabel(resource),
        origin: resource.origin,
      }));
    const workSummary = model.works.map((work) => ({
      kind: work.kind,
      shaders:
        work.pipeline.status === 'available'
          ? work.pipeline.shaders.map((shader) => ({
              stage: shader.stage,
              entryPoint: shader.entryPoint,
              source: shader.source?.slice(0, 100),
            }))
          : [],
      bindings: work.bindings.map((binding) => [
        binding.groupIndex,
        binding.binding,
        binding.resourceKind,
        binding.resourceId,
      ]),
    }));
    throw new Error(
      `expected Standard main to consume one recorded Cluster texture; targets=${JSON.stringify([...clusterResourceIds])}; referenced=${JSON.stringify(referencedResources)}; viewSources=${JSON.stringify([...textureViewSources])}; works=${JSON.stringify(workSummary)}`,
    );
  }
  const consumerTextureHandle = [...consumers][0];
  if (consumerTextureHandle === undefined) throw new Error('Cluster consumer handle is missing');
  const writtenClusterResources = clusterResources
    .map((resource) => ({
      textureHandle: resource.resourceId,
      writes: clusterTextureWrites(tape, resource.resourceId),
    }))
    .filter(({ writes }) => writes.calls > 0);
  if (writtenClusterResources.length > 1) {
    throw new Error(
      `expected at most one written Cluster texture for the completed frame: ${JSON.stringify(writtenClusterResources)}`,
    );
  }
  const writerTextureHandle = writtenClusterResources[0]?.textureHandle;
  const writer = writtenClusterResources[0]?.writes ?? { calls: 0, bytes: 0 };
  const trace = fixture.host.clusterWorkFrameTraceForConformance();
  if (trace === undefined || trace.clusterWork?.status !== 'captured') {
    throw new Error('completed frame has no captured Cluster work trace');
  }
  return {
    receipt: recorded.receipt,
    trace,
    clusterWork: trace.clusterWork,
    graphTarget: {
      graphGeneration: target.graphGeneration,
      recordFrameNumber: target.recordFrameNumber,
      textureIdentity: target.textureIdentity,
      descriptor: {
        format: target.descriptor.format,
        size: { ...target.descriptor.size },
        usage: target.descriptor.usage,
      },
    },
    writerTextureHandle,
    consumerTextureHandle,
    consumerBindingHandle,
    writer,
  };
}

function expectFirstClusterUpload(frame: Awaited<ReturnType<typeof captureClusterFrameEvidence>>) {
  const work = frame.clusterWork;
  if (work.status !== 'captured') throw new Error('Cluster work sample is unavailable');
  if (work.clusterUsedRows === undefined || work.clusterRowBytes === undefined) {
    throw new Error('Cluster table dimensions are unavailable');
  }
  expect(frame.receipt.presentation).toBe('ready');
  expect(frame.receipt.graphGeneration).toBe(frame.graphTarget.graphGeneration);
  expect(frame.trace.recordFrameNumber).toBe(frame.graphTarget.recordFrameNumber);
  expect(frame.trace).toMatchObject({
    recordFrameNumber: work.frameNumber,
    graphGeneration: frame.graphTarget.graphGeneration,
    deviceGeneration: frame.receipt.deviceGeneration,
    clusterTransportGeneration: work.clusterTransportGeneration,
    receipt: {
      publicReceiptFrameId: frame.receipt.frameId,
      deviceGeneration: frame.receipt.deviceGeneration,
      presentation: 'ready',
      completion: 'completed',
    },
  });
  expect(work).toMatchObject({
    status: 'captured',
    transport: 'cpu-texture',
    scope: 'cluster-texture-host-regions',
    invocations: 1,
    packedLightSlots: 1,
    acceptedWriteBytes: work.clusterUsedRows * work.clusterRowBytes,
    writeSucceeded: true,
  });
  expect(frame.writerTextureHandle).toBe(frame.consumerTextureHandle);
  expect(frame.writer).toMatchObject({
    calls: expect.any(Number),
    bytes: work.clusterUsedRows * work.clusterRowBytes,
  });
  expect(frame.writer.calls).toBeGreaterThan(0);
}

function expectStableClusterFrame(
  previous: Awaited<ReturnType<typeof captureClusterFrameEvidence>>,
  current: Awaited<ReturnType<typeof captureClusterFrameEvidence>>,
) {
  expect(current.receipt.presentation).toBe('ready');
  expect(current.receipt.graphGeneration).toBe(current.graphTarget.graphGeneration);
  expect(current.trace.recordFrameNumber).toBe(current.graphTarget.recordFrameNumber);
  expect(current.trace).toMatchObject({
    recordFrameNumber: current.clusterWork.frameNumber,
    graphGeneration: current.graphTarget.graphGeneration,
    receipt: {
      publicReceiptFrameId: current.receipt.frameId,
      completion: 'completed',
    },
  });
  expect(current.graphTarget.textureIdentity).toBe(previous.graphTarget.textureIdentity);
  expect(current.consumerTextureHandle).toBe(previous.consumerTextureHandle);
  expect(current.graphTarget.graphGeneration).toBe(previous.graphTarget.graphGeneration);
  expect(current.clusterWork.clusterTransportGeneration).toBe(
    previous.clusterWork.clusterTransportGeneration,
  );
  expect(current.clusterWork).toMatchObject({
    status: 'captured',
    transport: 'cpu-texture',
    invocations: 1,
    packedLightSlots: 0,
    acceptedWriteBytes: 0,
    writeSucceeded: true,
  });
  expect(current.writer.calls).toBe(0);
  expect(current.writer.bytes).toBe(0);
}

it('initializes the no-storage Cluster target on the first ready AO layout frame', async () => {
  const fixture = await createSceneDataRuntime(undefined, {
    ao: false,
    algorithm: 'gtao',
    recording: true,
    storageBuffer: false,
    clusterTextureConsumer: true,
  });
  const camera = fixture.cameraEntity;
  if (camera === undefined) throw new Error('Cluster layout fixture is missing its camera');
  fixture.world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: PointLight, data: { intensity: 8, range: 25 } },
    )
    .unwrap();
  fixture.update();
  fixture.host.setClusterWorkObservationForConformance(true);

  try {
    expect(fixture.renderer.inspect().capabilities.storageBuffer).toBe(false);
    const initialOff = await captureClusterFrameEvidence(fixture);
    expectFirstClusterUpload(initialOff);
    const initialOffStable = await captureClusterFrameEvidence(fixture);
    expectStableClusterFrame(initialOff, initialOffStable);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion?.status).toBe('off');

    fixture.world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: { algorithm: AMBIENT_OCCLUSION_GTAO, radius: 0.25 },
      })
      .unwrap();
    fixture.update();
    const aoEnabled = await captureClusterFrameEvidence(fixture);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
    });
    expectFirstClusterUpload(aoEnabled);
    expect(aoEnabled.clusterWork.clusterTransportGeneration).not.toBe(
      initialOffStable.clusterWork.clusterTransportGeneration,
    );
    const aoEnabledStable = await captureClusterFrameEvidence(fixture);
    expectStableClusterFrame(aoEnabled, aoEnabledStable);

    fixture.world.removeComponent(camera, AmbientOcclusion).unwrap();
    fixture.update();
    const aoDisabled = await captureClusterFrameEvidence(fixture);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion?.status).toBe('off');
    expectFirstClusterUpload(aoDisabled);
    expect(aoDisabled.clusterWork.clusterTransportGeneration).not.toBe(
      aoEnabledStable.clusterWork.clusterTransportGeneration,
    );
    const aoDisabledStable = await captureClusterFrameEvidence(fixture);
    expectStableClusterFrame(aoDisabled, aoDisabledStable);
  } finally {
    await fixture.host.dispose();
  }
});

function expectSameSceneDataAoGraph(
  expected: ReturnType<typeof sceneDataAoGraphSnapshot>,
  actual: ReturnType<typeof sceneDataAoGraphSnapshot>,
) {
  expect(actual.compiledGraphGeneration).toBe(expected.compiledGraphGeneration);
  expect(actual.installedGraphGeneration).toBe(expected.installedGraphGeneration);
  expect(actual.ambientOcclusionGeneration).toBe(expected.ambientOcclusionGeneration);
  expect(actual.deviceGeneration).toBe(expected.deviceGeneration);
  expect(actual.passNames).toEqual(expected.passNames);
  expect(actual.targets).toEqual(expected.targets);
}

it('keeps AO inspection and receipts on the installed graph across a failed candidate retry', async () => {
  const fixture = await createSceneDataRuntime(undefined, { ao: false, algorithm: 'gtao' });
  const camera = fixture.cameraEntity;
  if (camera === undefined) throw new Error('AO candidate fixture is missing its camera');
  fixture.host.setClusterWorkObservationForConformance(true);
  const rendererEvents: unknown[] = [];
  const candidateSnapshots: {
    readonly error: unknown;
    readonly inspection: ReturnType<typeof fixture.renderer.inspect>;
    readonly targetGeneration: number;
  }[] = [];
  const unsubscribe = fixture.renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    rendererEvents.push(event.error);
    const target = fixture.host.getCurrentGraphTarget('ssao-raw');
    candidateSnapshots.push({
      error: event.error,
      inspection: fixture.renderer.inspect(),
      targetGeneration: target?.graphGeneration ?? -1,
    });
  });
  try {
    fixture.world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: { algorithm: AMBIENT_OCCLUSION_GTAO, radius: 0.25 },
      })
      .unwrap();
    fixture.update();
    const acceptedReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const accepted = sceneDataAoGraphSnapshot(fixture, 'forward');
    const acceptedTrace = fixture.host.clusterWorkFrameTraceForConformance();
    if (acceptedTrace === undefined) throw new Error('Accepted AO frame trace is absent');
    expect(acceptedReceipt.presentation).toBe('ready');
    expect(acceptedReceipt.observationDomains).toEqual(['final-display']);
    expect(acceptedReceipt.graphGeneration).toBe(accepted.installedGraphGeneration);
    expect(accepted.ambientOcclusionGeneration).toBe(accepted.installedGraphGeneration);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      output: { extent: { width: 64, height: 64 } },
    });
    expect(acceptedTrace).toMatchObject({
      graphGeneration: accepted.installedGraphGeneration,
      observationFrameId: acceptedReceipt.frameId,
      receipt: {
        publicReceiptFrameId: acceptedReceipt.frameId,
        deviceGeneration: acceptedReceipt.deviceGeneration,
        completion: 'completed',
      },
    });
    expect(
      accepted.targets.every(
        (target) => target.graphGeneration === accepted.installedGraphGeneration,
      ),
    ).toBe(true);
    expect(accepted.passNames).toEqual(expect.arrayContaining(['ssao-calc', 'ssao-blur']));

    const requestedExtent = { width: 48, height: 48 };
    fixture.world.set(camera, AmbientOcclusion, { resolutionScale: 0.75 }).unwrap();
    fixture.update();
    fixture.host.armGtaoCandidatePreparationFailureForConformance();
    const failedReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const failed = sceneDataAoGraphSnapshot(fixture, 'forward');
    const failedTrace = fixture.host.clusterWorkFrameTraceForConformance();
    if (failedTrace === undefined) throw new Error('Failed AO frame trace is absent');
    expect(rendererEvents).toHaveLength(1);
    expect(rendererEvents[0]).toMatchObject({
      code: 'graph-build-failed',
      detail: {
        cause: {
          code: 'gtao-candidate-preparation-fault-injected',
          detail: {
            phase: 'post-allocation-before-promotion',
            candidateGeneration: expect.any(Number),
            passNames: expect.arrayContaining(['ssao-calc', 'ssao-blur']),
            resourceAllocation: { liveBytes: expect.any(Number) },
          },
        },
      },
    });
    expect(candidateSnapshots).toHaveLength(1);
    const failedEvent = rendererEvents[0] as {
      readonly detail: {
        readonly cause: {
          readonly detail: { readonly candidateGeneration: number };
        };
      };
    };
    const candidateGeneration = failedEvent.detail.cause.detail.candidateGeneration;
    expect(Number.isSafeInteger(candidateGeneration)).toBe(true);
    const failedCandidateEntry =
      candidateSnapshots[0]?.inspection.renderGraphGenerationAllocation?.entries.find(
        (entry) => entry.generation === candidateGeneration,
      );
    expect(failedCandidateEntry).toBeDefined();
    expect(failedCandidateEntry?.allocation.liveBytes).toBeGreaterThan(0);
    expect(candidateGeneration).toBeGreaterThan(accepted.compiledGraphGeneration);
    expect(candidateSnapshots[0]?.targetGeneration).toBe(accepted.installedGraphGeneration);
    expect(failedReceipt.presentation).toBe('ready');
    expect(failedReceipt.observationDomains).toEqual(['final-display']);
    expect(failedReceipt.graphGeneration).toBe(accepted.installedGraphGeneration);
    expect(failed.installedGraphGeneration).toBe(accepted.installedGraphGeneration);
    expect(failed.ambientOcclusionGeneration).toBe(accepted.installedGraphGeneration);
    expect(failed.compiledGraphGeneration).toBe(accepted.compiledGraphGeneration);
    expect(failed.targets).toEqual(accepted.targets);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      output: { extent: { width: 64, height: 64 } },
    });
    expect(failedTrace).toMatchObject({
      graphGeneration: accepted.installedGraphGeneration,
      observationFrameId: failedReceipt.frameId,
      receipt: {
        publicReceiptFrameId: failedReceipt.frameId,
        deviceGeneration: failedReceipt.deviceGeneration,
        completion: 'completed',
      },
    });
    expect(failed.ambientOcclusionGeneration).not.toBe(candidateGeneration);

    const retryReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const retry = sceneDataAoGraphSnapshot(fixture, 'forward');
    const retryTrace = fixture.host.clusterWorkFrameTraceForConformance();
    if (retryTrace === undefined) throw new Error('Retried AO frame trace is absent');
    expect(rendererEvents).toHaveLength(1);
    expect(retryReceipt.presentation).toBe('ready');
    expect(retryReceipt.observationDomains).toEqual(['final-display']);
    expect(retryReceipt.graphGeneration).toBe(retry.installedGraphGeneration);
    expect(retry.ambientOcclusionGeneration).toBe(retry.installedGraphGeneration);
    expect(retry.installedGraphGeneration).not.toBe(accepted.installedGraphGeneration);
    expect(retry.compiledGraphGeneration).toBeGreaterThan(candidateGeneration);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      output: { extent: requestedExtent },
    });
    expect(retryTrace).toMatchObject({
      graphGeneration: retry.installedGraphGeneration,
      observationFrameId: retryReceipt.frameId,
      receipt: {
        publicReceiptFrameId: retryReceipt.frameId,
        deviceGeneration: retryReceipt.deviceGeneration,
        completion: 'completed',
      },
    });
    expect(retry.passNames).toEqual(expect.arrayContaining(['ssao-calc', 'ssao-blur']));
    expect(
      retry.targets.every((target) => target.graphGeneration === retry.installedGraphGeneration),
    ).toBe(true);
    expect(retry.targets.slice(1).map((target) => target.descriptor.size)).toEqual([
      requestedExtent,
      requestedExtent,
    ]);
    await expect
      .poll(() =>
        fixture.renderer
          .inspect()
          .renderGraphGenerationAllocation?.entries.some(
            (entry) => entry.generation === candidateGeneration,
          ),
      )
      .toBe(false);
    expect(fixture.renderer.inspect().renderGraphGenerationAllocation?.pendingRetirementBytes).toBe(
      0,
    );

    const linearReceipt = await completeObservedSceneDataFrame(fixture, 'linear-hdr');
    const linear = sceneDataAoGraphSnapshot(fixture, 'forward');
    const linearTrace = fixture.host.clusterWorkFrameTraceForConformance();
    if (linearTrace === undefined) throw new Error('Linear HDR AO frame trace is absent');
    expect(linearReceipt.presentation).toBe('ready');
    expect(linearReceipt.observationDomains).toEqual(['linear-hdr']);
    expect(linearReceipt.graphGeneration).toBe(linear.installedGraphGeneration);
    expect(linear.ambientOcclusionGeneration).toBe(linear.installedGraphGeneration);
    expect(
      linear.targets.every((target) => target.graphGeneration === linear.installedGraphGeneration),
    ).toBe(true);
    expect(linearTrace).toMatchObject({
      graphGeneration: linear.installedGraphGeneration,
      observationFrameId: linearReceipt.frameId,
      receipt: {
        publicReceiptFrameId: linearReceipt.frameId,
        deviceGeneration: linearReceipt.deviceGeneration,
        completion: 'completed',
      },
    });
    expect(rendererEvents).toHaveLength(1);
  } finally {
    unsubscribe();
    await fixture.host.dispose();
  }
});

it('switches the real AO graph from compute GTAO through fragment SSAO and back', async () => {
  const fixture = await createSceneDataRuntime(undefined, { ao: false, algorithm: 'gtao' });
  const camera = fixture.cameraEntity;
  if (camera === undefined) throw new Error('AO transition fixture is missing its camera');
  try {
    const expectInstalledFrameIdentity = (
      receipt: Awaited<ReturnType<typeof completeObservedSceneDataFrame>>,
      graph: ReturnType<typeof sceneDataAoGraphSnapshot>,
    ) => {
      expect(receipt.presentation).toBe('ready');
      expect(receipt.observationDomains).toEqual(['final-display']);
      expect(receipt.graphGeneration).toBe(graph.installedGraphGeneration);
      expect(receipt.deviceGeneration).toBe(graph.deviceGeneration);
      expect(graph.ambientOcclusionGeneration).toBe(graph.installedGraphGeneration);
      expect(
        graph.targets.every((target) => target.graphGeneration === graph.installedGraphGeneration),
      ).toBe(true);
    };
    const drawTransitionFrame = async (phase: string) => {
      try {
        return await completeObservedSceneDataFrame(fixture, 'final-display');
      } catch (error) {
        const detail =
          typeof error === 'object' && error !== null
            ? {
                name: 'name' in error ? error.name : undefined,
                message: 'message' in error ? error.message : undefined,
                code: 'code' in error ? error.code : undefined,
                detail: 'detail' in error ? error.detail : undefined,
              }
            : error;
        throw new Error(`${phase} transition draw failed: ${JSON.stringify(detail)}`, {
          cause: error,
        });
      }
    };
    fixture.host.setGtaoExecutionOverrideForConformance('compute');
    fixture.world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: { algorithm: AMBIENT_OCCLUSION_GTAO, radius: 0.25 },
      })
      .unwrap();
    fixture.update();
    const computeReceipt = await drawTransitionFrame('GTAO compute');
    const compute = sceneDataAoGraphSnapshot(fixture, 'forward');
    expectInstalledFrameIdentity(computeReceipt, compute);
    expect(compute.passNames).toContain('gtao-calc-compute');
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'compute',
    });

    fixture.host.setGtaoExecutionOverrideForConformance(undefined);
    fixture.world.set(camera, AmbientOcclusion, { algorithm: AMBIENT_OCCLUSION_SSAO }).unwrap();
    fixture.update();
    const ssaoReceipt = await drawTransitionFrame('SSAO fragment');
    const ssao = sceneDataAoGraphSnapshot(fixture, 'forward');
    expectInstalledFrameIdentity(ssaoReceipt, ssao);
    expect(ssao.passNames).toEqual(expect.arrayContaining(['ssao-calc', 'ssao-blur']));
    expect(ssao.passNames).not.toContain('gtao-calc-compute');
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'ssao',
      execution: 'fragment',
    });

    fixture.host.setGtaoExecutionOverrideForConformance('compute');
    fixture.world.set(camera, AmbientOcclusion, { algorithm: AMBIENT_OCCLUSION_GTAO }).unwrap();
    fixture.update();
    const restoredReceipt = await drawTransitionFrame('restored GTAO compute');
    const restored = sceneDataAoGraphSnapshot(fixture, 'forward');
    expectInstalledFrameIdentity(restoredReceipt, restored);
    expect(restored.passNames).toContain('gtao-calc-compute');
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'compute',
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.host.dispose();
  }
});

it.each([
  ['ssao', true],
  ['ssao', false],
  ['gtao', true],
  ['gtao', false],
] as const)('admits visible Unlit %s input with storageBuffer=%s', async (algorithm, storageBuffer) => {
  let catalog: SceneDataCatalog | undefined;
  const fixture = await createSceneDataRuntime(
    sceneDataConsumer(
      () => {},
      () => {},
      {
        onCatalog: (value) => {
          catalog = value;
        },
      },
    ),
    { algorithm, storageBuffer, unlit: true },
  );
  try {
    await completeSceneDataFrame(fixture);
    await completeSceneDataFrame(fixture);
    expect(catalog?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
      status: 'available',
      completeness: 'exact',
      missingContributorIds: [],
    });
    expect(fixture.renderer.inspect().output.graphPassNames).toContain(
      'standard-scene-surface-data',
    );
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm,
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.host.dispose();
  }
});

it.each([
  'forward',
  'deferred',
] as const)('keeps same-demand AO graph resources stable across direct strength and recorder boundaries (%s)', async (renderPath) => {
  const fixture = await createSceneDataRuntime(undefined, {
    ao: false,
    recording: true,
    renderPath,
  });
  const camera = fixture.cameraEntity;
  const recorder = fixture.recorder;
  if (camera === undefined || recorder === undefined) {
    throw new Error('Recorded Standard AO fixture is missing its camera or recorder');
  }
  let failed = false;
  let failure: unknown;
  try {
    fixture.world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: { algorithm: AMBIENT_OCCLUSION_SSAO, directLightingStrength: 0 },
      })
      .unwrap();
    const ao0Receipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const ao0 = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(ao0Receipt.presentation).toBe('ready');
    expect(ao0Receipt.observationDomains).toEqual(['final-display']);
    expect(ao0Receipt.graphGeneration).toBe(ao0.installedGraphGeneration);
    expect(ao0Receipt.deviceGeneration).toBe(ao0.deviceGeneration);
    expect(ao0.directLightingStrength).toBe(0);
    expect(ao0.passNames).toEqual(expect.arrayContaining(['ssao-calc', 'ssao-blur']));
    expect(ao0.passNames).toContain(renderPath === 'deferred' ? 'lighting' : 'main');

    const ao0StableReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const ao0Stable = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(ao0StableReceipt.presentation).toBe('ready');
    expect(ao0StableReceipt.observationDomains).toEqual(['final-display']);
    expect(ao0StableReceipt.graphGeneration).toBe(ao0Stable.installedGraphGeneration);
    expectSameSceneDataAoGraph(ao0, ao0Stable);

    const authoredBeforeRecording = { ...fixture.world.get(camera, AmbientOcclusion).unwrap() };
    const recorded = await recordObservedSceneDataFrame(fixture, 'final-display');
    const recordedGraph = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(recorded.tape.bytes.byteLength).toBeGreaterThan(0);
    expect(recorded.receipt.presentation).toBe('ready');
    expect(recorded.receipt.observationDomains).toEqual(['final-display']);
    expect(recorded.receipt.graphGeneration).toBe(recordedGraph.installedGraphGeneration);
    expect(fixture.world.get(camera, AmbientOcclusion).unwrap()).toEqual(authoredBeforeRecording);
    expectSameSceneDataAoGraph(ao0, recordedGraph);

    const authoredAo0 = { ...fixture.world.get(camera, AmbientOcclusion).unwrap() };
    fixture.world.set(camera, AmbientOcclusion, { directLightingStrength: 1 }).unwrap();
    const authoredAo1 = { ...fixture.world.get(camera, AmbientOcclusion).unwrap() };
    expect({ ...authoredAo1, directLightingStrength: authoredAo0.directLightingStrength }).toEqual(
      authoredAo0,
    );
    const ao1Receipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const ao1 = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(ao1Receipt.presentation).toBe('ready');
    expect(ao1Receipt.observationDomains).toEqual(['final-display']);
    expect(ao1Receipt.graphGeneration).toBe(ao1.installedGraphGeneration);
    expect(ao1Receipt.deviceGeneration).toBe(ao1.deviceGeneration);
    expect(ao1.directLightingStrength).toBe(1);
    expectSameSceneDataAoGraph(ao0, ao1);

    fixture.world.set(camera, AmbientOcclusion, { directLightingStrength: 0 }).unwrap();
    const restoredReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const restored = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(restoredReceipt.presentation).toBe('ready');
    expect(restoredReceipt.observationDomains).toEqual(['final-display']);
    expect(restoredReceipt.graphGeneration).toBe(restored.installedGraphGeneration);
    expect(restored.directLightingStrength).toBe(0);
    expectSameSceneDataAoGraph(ao0, restored);

    const explicitProfile = fixture.renderer.inspect().profile;
    const reinstalled = fixture.renderer.setProfile({ ...explicitProfile });
    if (!reinstalled.ok) throw reinstalled.error;
    const reinstalledReceipt = await completeObservedSceneDataFrame(fixture, 'final-display');
    const reinstalledGraph = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(reinstalledReceipt.presentation).toBe('ready');
    expect(reinstalledReceipt.observationDomains).toEqual(['final-display']);
    expect(reinstalledReceipt.graphGeneration).toBe(reinstalledGraph.installedGraphGeneration);
    expect(reinstalledGraph.directLightingStrength).toBe(0);

    const linearReceipt = await completeObservedSceneDataFrame(fixture, 'linear-hdr');
    const linearGraph = sceneDataAoGraphSnapshot(fixture, renderPath);
    expect(linearReceipt.presentation).toBe('ready');
    expect(linearReceipt.observationDomains).toEqual(['linear-hdr']);
    expect(linearReceipt.graphGeneration).toBe(linearGraph.installedGraphGeneration);
    expect(linearGraph.installedGraphGeneration).not.toBe(
      reinstalledGraph.installedGraphGeneration,
    );
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    await fixture.host.dispose();
  } catch (cause) {
    if (!failed) failure = cause;
    failed = true;
  }
  const disposed = await recorder.dispose();
  if (!disposed.ok && !failed) failure = disposed.error;
  failed ||= !disposed.ok;
  if (failed) throw failure;
});

function noOpSceneDataFeature(): RenderFeature<null> {
  return {
    identity: 'test.scene-data-no-op',
    placement: 'scene',
    extract: () => ok(null),
    plan: () => ok({ work: [] }),
  };
}

async function cookStandardMaterialIntoRegistry(assets: AssetRegistry) {
  const guid = '019f0000-0000-7000-8000-0000000008d0';
  const output = await createMaterialPackCooker().cook({
    guid,
    source: Materials.standard({
      baseColor: [0.7, 0.5, 0.3, 1],
      roughness: 0.5,
      metallic: 0,
    }),
  });
  const record = validateCookedMaterialRecord(
    (output.payload as { readonly cooked: unknown }).cooked,
  ).unwrap();
  const specializationKey = record.specializationKey;
  if (specializationKey === undefined)
    throw new Error('Cooked Standard material has no publication specialization key');
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid,
      record,
      artifacts: Object.fromEntries(
        record.programs.map(({ artifact }) => [
          artifact.path,
          { mediaType: artifact.mediaType, bytes: artifact.bytes },
        ]),
      ),
    }),
    loadReference: async () => true,
  }).load({ guid, specializationKey });
  if (ready.status !== 'Ready')
    throw new Error(`Cooked Standard was not ready: ${ready.error.code}`);
  installMaterialReadyShaders(assets.shaderRegistry, ready, new MaterialArtifactRegistry());
  const loaded = await loadMaterialFixture(assets, { ...ready.record, guid });
  if (!loaded.ok) throw loaded.error;
  return { handle: loaded.value.handle, record, guid };
}

function sceneDataManifestUrl(clusterTextureConsumer = false): string {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier === 'forgeax::default-unlit') {
      entry.composedWgsl += fullscreenRaster;
      entry.entryPoints = fullscreenRasterEntryPoints;
    }
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.composedWgsl += fullscreenRaster;
    entry.entryPoints = fullscreenRasterEntryPoints;
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    entry.reflection = structuredClone(reflectedClusterAbi);
    for (const variant of entry.variants) {
      const noStorageClusterConsumer =
        clusterTextureConsumer &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE !== true;
      variant.composedWgsl += noStorageClusterConsumer
        ? clusterTextureConsumerRaster
        : fullscreenRaster;
      variant.entryPoints = fullscreenRasterEntryPoints;
      variant.hash = 'cafe1234';
      variant.sourceDigest = 'a'.repeat(64);
      variant.compilerProfile = testCompilerProfile;
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
      variant.reflection = structuredClone(
        noStorageClusterConsumer ? reflectedClusterTexture : reflectedClusterAbi,
      );
    }
  }
  manifest.entries.push({
    hash: 'fixture-ssao',
    wgsl: `
      @vertex fn vs_ssao(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
        return vec4<f32>(f32(index), 0.0, 0.0, 1.0);
      }
      @fragment fn fs_ssao_calc() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
      @fragment fn fs_ssao_blur() -> @location(0) f32 { return 1.0; }
      @fragment fn fs_ssao_cluster_pack() -> @location(0) vec4<u32> { return vec4<u32>(1u); }
    `,
    glsl: '',
    bindings: '[]',
  });
  manifest.entries.push({
    hash: 'fixture-gtao-compute',
    wgsl: '@compute @workgroup_size(1) fn cs_gtao_calc() {}',
    glsl: '',
    bindings: '[]',
  });
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

it('samples admitted Standard Forward surface data in the same real Renderer graph as AO', async () => {
  let requestedTarget: object | undefined;
  let plannedView: { readonly identity: string; readonly render: boolean } | undefined;
  let consumerPlanCount = 0;
  const feature = sceneDataConsumer(
    (target) => {
      requestedTarget = target;
    },
    (view) => {
      consumerPlanCount += 1;
      plannedView = view;
    },
  );
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, features: [feature] },
    { shaderManifestUrl: sceneDataManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const profile = renderer.inspect().profile;
  expect(
    renderer.setProfile({ ...profile, renderPath: 'forward', ssao: { algorithm: 'ssao' } }).ok,
  ).toBe(true);
  const errors: unknown[] = [];
  host.onError((error) => errors.push(error));
  const world = new World({ assets: host.assetRegistry });
  const mesh = host.assetRegistry.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = host.assetRegistry
    .create(Materials.standard({ baseColor: [0.7, 0.5, 0.3, 1], roughness: 0.5, metallic: 0 }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -0.9, -0.7], intensity: 3, castShadow: false },
    })
    .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const drawFrame = () =>
    renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
  const warming = drawFrame();
  expect(warming.ok, warming.ok ? '' : JSON.stringify(warming.error)).toBe(true);
  if (!warming.ok) return;
  expect((await warming.value.completed).ok).toBe(true);
  const warmupError = renderer
    .inspect()
    .featureDiagnostics.find((diagnostic) => diagnostic.identity === feature.identity)?.latestError;
  expect(warmupError).toMatchObject({
    code: 'render-feature-preparation-failed',
    detail: { reason: expect.stringContaining('rhi-not-available:') },
  });

  const ready = drawFrame();
  expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
  if (!ready.ok) return;
  expect((await ready.value.completed).ok).toBe(true);
  expect(requestedTarget).toBeDefined();
  expect(
    renderer.inspect().output.graphPassNames,
    JSON.stringify({
      errors,
      features: renderer.inspect().features,
      featureDiagnostics: renderer.inspect().featureDiagnostics,
      featureHost: renderer.inspect().featureHost,
      featureGraph: renderer.inspect().featureGraph,
      consumerPlanCount,
      plannedView,
    }),
  ).toEqual(expect.arrayContaining(['standard-scene-surface-data', 'surface-normal-consumer']));
  expect(errors).toEqual([]);
  await host.dispose();
});

it('admits a real cooked Standard Registry snapshot through production surface selection', async () => {
  let requestedTarget: object | undefined;
  let catalog: SceneDataCatalog | undefined;
  const feature = sceneDataConsumer(
    (target) => {
      requestedTarget = target;
    },
    () => {},
    { onCatalog: (current) => (catalog = current) },
  );
  const fixture = await createSceneDataRuntime(feature, { cookedStandard: true });
  try {
    const cooked = fixture.cookedStandard;
    if (cooked === undefined) throw new Error('Cooked Standard Registry fixture was not created');
    const frame = extractFrames([fixture.world], 0, fixture.host.assetRegistry, undefined, {
      materialContext: DEFAULT_MATERIAL_VARIANT_CONTEXT,
      cull: 'none',
    });
    const row = frame.renderables.find((candidate) => candidate.entityKey === fixture.entity);
    if (row === undefined) throw new Error('Cooked Standard did not produce a render snapshot');
    const material = row.materials.find(
      (candidate) => candidate.snapshot.materialHandle === Number(cooked.handle),
    );
    if (material === undefined)
      throw new Error('Cooked Standard snapshot was not in the Registry row');
    const passIndex = material.snapshot.passes.findIndex((pass) => {
      const tags = (pass.renderState?.tags as Record<string, string> | undefined) ?? {};
      return tags.LightMode === 'Forward';
    });
    const pass = material.snapshot.passes[passIndex];
    if (pass === undefined || passIndex < 0)
      throw new Error('Cooked Standard Forward pass is missing');
    const selectedProgramKey = material.snapshot.materialProgramKeys?.[pass.name];
    if (selectedProgramKey === undefined)
      throw new Error('Cooked Standard program selection is missing');
    const selectedArtifact = fixture.host.assetRegistry.shaderRegistry
      .findMaterialArtifact(selectedProgramKey)
      .unwrap();
    const cookedProgram = cooked.record.programs.find(
      (program) => program.specializationKey === selectedProgramKey,
    );
    if (cookedProgram === undefined)
      throw new Error('Selected Standard program is not present in the cooked publication');
    const publicationProgram = material.snapshot.materialPublication?.programs.find(
      (program) => program.pass === pass.name,
    );
    const sourceTuple = [row.worldId, row.entityKey, Number(cooked.handle), passIndex] as const;
    const contributor = standardSceneDataContributorForDispatch({
      row,
      sourceTuple,
      materialHandle: Number(cooked.handle),
      materialShaderId: selectedProgramKey,
      tags: (pass.renderState?.tags as Record<string, string> | undefined) ?? {},
      lane: 'forward',
      id: JSON.stringify(sourceTuple),
    });
    if (contributor === undefined) throw new Error('Cooked Standard pass did not enter coverage');
    expect(material.snapshot.materialPublication?.identity).toMatchObject({
      materialGuid: cooked.guid,
      publicationGeneration: cooked.record.publicationGeneration,
    });
    expect(material.snapshot.materialProgramKeys?.[pass.name]).toBe(
      cookedProgram.specializationKey,
    );
    expect(publicationProgram).toMatchObject({
      specializationKey: selectedProgramKey,
      artifactHash: cookedProgram.artifact.digest,
    });
    expect(material.snapshot.materialEntryPoints?.[pass.name]).toEqual(
      selectedArtifact.program.entryPoints,
    );
    expect(material.snapshot.materialEntryPoints?.[pass.name]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fs_ao_input', stage: 'fragment' })]),
    );
    expect(contributor.facts?.selectedProgramFacts).toMatchObject({
      specializationKey: selectedProgramKey,
      artifactHash: cookedProgram.artifact.digest,
    });
    await completeSceneDataFrame(fixture);
    await completeSceneDataFrame(fixture);
    expect(requestedTarget).toBeDefined();
    expect(catalog?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
      schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
      status: 'available',
      completeness: 'exact',
      missingContributorIds: [],
    });
    expect(catalog?.surfaceAdmissionIdentity).toEqual(expect.any(String));
    expect(fixture.renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['standard-scene-surface-data', 'surface-normal-consumer']),
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.host.dispose();
  }
}, 60_000);

it.each([
  ['without Motion Blur', 'taa'],
  ['with Motion Blur', 'motion-blur'],
] as const)('binds temporal-v1 through the real Standard post contribution %s', async (_label, temporal) => {
  let token: SceneDataTarget | undefined;
  let catalog: SceneDataCatalog | undefined;
  const feature = temporalSceneDataConsumer(
    (target) => {
      token = target;
    },
    (current) => {
      catalog = current;
    },
  );
  const fixture = await createSceneDataRuntime(feature, {
    unlit: true,
    temporal,
    ao: false,
  });
  try {
    const warmup = fixture.drawFrame();
    expect(warmup.ok, warmup.ok ? '' : JSON.stringify(warmup.error)).toBe(true);
    if (warmup.ok) expect((await warmup.value.completed).ok).toBe(true);

    const ready = fixture.drawFrame();
    expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
    if (!ready.ok) return;
    const completed = await ready.value.completed;
    expect(completed.ok, completed.ok ? '' : JSON.stringify(completed.error)).toBe(true);
    expect(ready.value.frameId).toBeGreaterThan(0);
    expect(token?.schema).toBe(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    expect(catalog?.inspect(SCENE_DATA_TEMPORAL_V1_SCHEMA)).toMatchObject({
      status: 'available',
      completeness: 'exact',
    });
    expect(catalog?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
      status: 'available',
      completeness: 'exact',
    });
    const passNames = fixture.renderer.inspect().output.graphPassNames;
    const producerIndex = passNames.indexOf('standard-scene-data');
    const consumerIndex = passNames.indexOf('temporal-data-consumer');
    expect({ producerIndex, consumerIndex, passNames }).toMatchObject({
      producerIndex: expect.any(Number),
      consumerIndex: expect.any(Number),
    });
    expect(producerIndex).toBeGreaterThanOrEqual(0);
    expect(consumerIndex).toBeGreaterThan(producerIndex);
    expect(passNames).not.toContain('standard-scene-surface-data');
    expect(passNames).not.toContain('ssao-calc');
    expect(passNames).not.toContain('ssao-blur');
    expect(passNames).not.toContain('gtao-calc');
    if (temporal === 'motion-blur') {
      expect(passNames).toContain('motion-blur');
    } else {
      expect(passNames).not.toContain('motion-blur');
    }
  } finally {
    await fixture.host.dispose();
  }
});

it.each([
  ['SSAO', 'ssao'],
  ['GTAO', 'gtao'],
] as const)('admits %s only for complete visible Standard AO inputs', async (_label, algorithm) => {
  for (const consumer of ['none', 'no-op', 'surface'] as const) {
    const requireErrors: unknown[] = [];
    const feature =
      consumer === 'none'
        ? undefined
        : consumer === 'no-op'
          ? noOpSceneDataFeature()
          : sceneDataConsumer(
              () => {},
              () => {},
              { onRequireError: (error) => requireErrors.push(error) },
            );
    const fixture = await createSceneDataRuntime(feature, { algorithm, morphTarget: true });
    try {
      let lastReadyFrameId = 0;
      for (let frame = 0; frame < 2; frame += 1) {
        const ready = fixture.drawFrame();
        expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
        if (ready.ok) {
          expect((await ready.value.completed).ok).toBe(true);
          lastReadyFrameId = ready.value.frameId;
        }
      }
      const morphAdded = fixture.enableMorph();
      expect(morphAdded.ok).toBe(true);
      fixture.update();
      const unsupported = fixture.drawFrame();
      expect(unsupported.ok, JSON.stringify({ algorithm, consumer, errors: fixture.errors })).toBe(
        false,
      );
      if (unsupported.ok) expect((await unsupported.value.completed).ok).toBe(true);
      const aoError = [...fixture.errors]
        .reverse()
        .find(
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'scene-data-unavailable',
        );
      expect({ algorithm, consumer, aoError }).toMatchObject({
        aoError: {
          code: 'scene-data-unavailable',
          detail: {
            schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
            reason: 'coverage-incomplete',
            missingContributorIds: expect.arrayContaining([expect.any(String)]),
            recovery: 'next-frame',
          },
        },
      });
      if (consumer === 'surface') {
        expect(requireErrors.at(-1)).toMatchObject({
          code: 'scene-data-unavailable',
          detail: {
            schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
            reason: 'coverage-incomplete',
          },
        });
      }
      expect(fixture.renderer.inspect().frame.frameId).toBe(lastReadyFrameId);

      const morphRemoved = fixture.disableMorph();
      expect(morphRemoved.ok).toBe(true);
      fixture.update();
      const recovered = fixture.drawFrame();
      expect(recovered.ok, recovered.ok ? '' : JSON.stringify(recovered.error)).toBe(true);
      if (!recovered.ok) continue;
      const completed = await recovered.value.completed;
      expect(completed.ok, completed.ok ? '' : JSON.stringify(completed.error)).toBe(true);
      expect(recovered.value.frameId).toBeGreaterThan(lastReadyFrameId);
      const inspection = fixture.renderer.inspect();
      expect(inspection.standardLighting?.ambientOcclusion).toMatchObject({
        status: 'active',
        algorithm,
        execution: 'fragment',
      });
      expect(inspection.output.graphPassNames).toContain('ssao-calc');
    } finally {
      await fixture.host.dispose();
    }
  }
});

it('reports a wrapped invalid AO radius and recovers the active GTAO graph', async () => {
  const fixture = await createSceneDataRuntime(undefined, { ao: false, algorithm: 'gtao' });
  const camera = fixture.cameraEntity;
  if (camera === undefined) throw new Error('AO recovery fixture is missing its camera');
  const rendererErrors: unknown[] = [];
  const unsubscribe = fixture.renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });
  try {
    await completeSceneDataFrame(fixture);
    fixture.world
      .addComponent(camera, {
        component: AmbientOcclusion,
        data: { algorithm: AMBIENT_OCCLUSION_GTAO, radius: 0.25 },
      })
      .unwrap();
    fixture.update();
    await completeSceneDataFrame(fixture);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'fragment',
    });
    expect(rendererErrors).toEqual([]);

    fixture.world.set(camera, AmbientOcclusion, { radius: 0 }).unwrap();
    fixture.update();
    await completeSceneDataFrame(fixture);

    expect(rendererErrors).toHaveLength(1);
    expect(rendererErrors[0]).toMatchObject({
      name: 'RendererOperationError',
      code: 'device-operation-failed',
      expected: 'the active device generation completes the renderer-owned operation',
      hint: 'inspect renderer state and the structured cause, then retry or recover',
      detail: {
        operation: 'renderer-event',
        cause: {
          code: 'ssao-radius-non-positive',
          expected: 'SSAO radius must be > 0',
          hint: expect.stringMatching(
            /radius.*positive value.*remove AmbientOcclusion.*disable AO/i,
          ),
          detail: { paramName: 'radius', value: 0 },
        },
      },
    });
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'off',
    });
    const disabledPassNames = fixture.renderer.inspect().output.graphPassNames;
    for (const passName of [
      'standard-scene-surface-data',
      'ssao-calc',
      'ssao-blur',
      'gtao-calc',
      'gtao-blur',
    ]) {
      expect(disabledPassNames).not.toContain(passName);
    }

    rendererErrors.length = 0;
    fixture.world.set(camera, AmbientOcclusion, { radius: 0.25 }).unwrap();
    fixture.update();
    await completeSceneDataFrame(fixture);
    expect(rendererErrors).toEqual([]);
    expect(fixture.renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'active',
      algorithm: 'gtao',
      execution: 'fragment',
    });
    expect(fixture.renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['ssao-calc', 'ssao-blur']),
    );
  } finally {
    unsubscribe();
    await fixture.host.dispose();
  }
});

it('returns producer-missing from a real camera-less Renderer view', async () => {
  let unavailable: unknown;
  let inspection: ReturnType<SceneDataCatalog['inspect']> | undefined;
  const feature = sceneDataConsumer(
    () => {},
    () => {},
    {
      onCatalog: (catalog) => {
        inspection = catalog.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA);
      },
      onRequireError: (error) => {
        unavailable = error;
      },
    },
  );
  const fixture = await createSceneDataRuntime(feature, { camera: false });
  try {
    const draw = fixture.drawFrame();
    expect(draw.ok, draw.ok ? '' : JSON.stringify(draw.error)).toBe(true);
    if (draw.ok) expect((await draw.value.completed).ok).toBe(true);
    expect(unavailable).toMatchObject({
      code: 'scene-data-unavailable',
      detail: {
        featureIdentity: feature.identity,
        schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
        lane: 'clustered',
        reason: 'producer-missing',
        missingContributorIds: [],
        recovery: 'next-frame',
      },
    });
    expect(inspection).toMatchObject({ status: 'unavailable', reason: 'producer-missing' });
    expect(fixture.renderer.inspect().output.graphPassNames).not.toContain(
      'standard-scene-surface-data',
    );
  } finally {
    await fixture.host.dispose();
  }
});

it('rejects unsupported visible deformation and recovers on the next admitted candidate', async () => {
  const requireErrors: unknown[] = [];
  const catalogs: SceneDataCatalog[] = [];
  const priorValidations: boolean[] = [];
  let admittedTarget: SceneDataTarget | undefined;
  const feature = sceneDataConsumer(
    (target) => {
      admittedTarget = target as SceneDataTarget;
    },
    () => {},
    {
      onCatalog: (catalog) => catalogs.push(catalog),
      onRequireError: (error) => requireErrors.push(error),
      priorTarget: () => admittedTarget,
      onPriorValidation: (result) => priorValidations.push(result.ok),
    },
  );
  const fixture = await createSceneDataRuntime(feature, { morphTarget: true });
  try {
    const warmup = fixture.drawFrame();
    expect(warmup.ok, warmup.ok ? '' : JSON.stringify(warmup.error)).toBe(true);
    if (warmup.ok) expect((await warmup.value.completed).ok).toBe(true);
    const ready = fixture.drawFrame();
    expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
    if (ready.ok) expect((await ready.value.completed).ok).toBe(true);
    expect(admittedTarget).toBeDefined();
    const initialTarget = admittedTarget;
    if (initialTarget === undefined) throw new Error('Initial Standard surface token is absent');
    const initialOwner = sceneDataTargetOwner(initialTarget);
    if (initialOwner === undefined) throw new Error('Initial Standard surface token has no owner');
    const steadyCompileAttempts = fixture.renderer.inspect().featureGraph?.compileAttempts;
    if (steadyCompileAttempts === undefined)
      throw new Error('Feature graph inspection is unavailable');

    fixture.world.set(fixture.entity, Transform, { pos: [0.25, 0, 0] }).unwrap();
    fixture.update();
    const valueChanged = fixture.drawFrame();
    expect(valueChanged.ok, valueChanged.ok ? '' : JSON.stringify(valueChanged.error)).toBe(true);
    if (valueChanged.ok) expect((await valueChanged.value.completed).ok).toBe(true);
    const valueChangedOwner =
      admittedTarget === undefined ? undefined : sceneDataTargetOwner(admittedTarget);
    expect(valueChangedOwner?.surfaceAdmissionIdentity).toBe(initialOwner.surfaceAdmissionIdentity);
    expect(valueChangedOwner?.surfaceAdmissionRevision).toBe(initialOwner.surfaceAdmissionRevision);
    expect(fixture.renderer.inspect().featureGraph?.compileAttempts).toBe(steadyCompileAttempts);
    const initialAdmission = catalogs.at(-1)?.surfaceAdmissionIdentity;
    const frameIdBeforeUnsupported = fixture.renderer.inspect().frame.frameId;

    fixture.enableMorph().unwrap();
    fixture.update();
    const unsupported = fixture.drawFrame();
    expect(unsupported).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: {
          cause: {
            code: 'scene-data-unavailable',
            detail: {
              schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
              reason: 'coverage-incomplete',
              recovery: 'next-frame',
            },
          },
        },
      },
    });
    expect(requireErrors.at(-1)).toMatchObject({
      code: 'scene-data-unavailable',
      detail: {
        schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
        reason: 'coverage-incomplete',
        missingContributorIds: expect.arrayContaining([expect.any(String)]),
        recovery: 'next-frame',
      },
    });
    const unsupportedCatalog = catalogs.at(-1);
    expect(unsupportedCatalog?.surfaceAdmissionIdentity).not.toBe(initialAdmission);
    expect(unsupportedCatalog?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject(
      {
        status: 'unavailable',
        reason: 'coverage-incomplete',
      },
    );
    expect(priorValidations.at(-1)).toBe(false);
    expect(fixture.renderer.inspect().frame.frameId).toBe(frameIdBeforeUnsupported);

    fixture.disableMorph().unwrap();
    fixture.update();
    const recovered = fixture.drawFrame();
    expect(recovered.ok, recovered.ok ? '' : JSON.stringify(recovered.error)).toBe(true);
    if (recovered.ok) expect((await recovered.value.completed).ok).toBe(true);
    const recoveryWarmupError = fixture.renderer
      .inspect()
      .featureDiagnostics.find(
        (diagnostic) => diagnostic.identity === feature.identity,
      )?.latestError;
    if (recoveryWarmupError !== undefined) {
      expect(recoveryWarmupError).toMatchObject({ code: 'render-feature-preparation-failed' });
      const retry = fixture.drawFrame();
      expect(retry.ok, retry.ok ? '' : JSON.stringify(retry.error)).toBe(true);
      if (retry.ok) expect((await retry.value.completed).ok).toBe(true);
    }
    expect(catalogs.at(-1)?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
      status: 'available',
      completeness: 'exact',
    });
    expect(priorValidations.at(-1)).toBe(false);
    const recoveredInspection = fixture.renderer.inspect();
    expect(
      recoveredInspection.output.graphPassNames,
      JSON.stringify({
        lastCatalog: catalogs.at(-1)?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA),
        lastOwner: admittedTarget === undefined ? undefined : sceneDataTargetOwner(admittedTarget),
        featureDiagnostics: recoveredInspection.featureDiagnostics,
        featureGraph: recoveredInspection.featureGraph,
      }),
    ).toEqual(expect.arrayContaining(['standard-scene-surface-data', 'surface-normal-consumer']));
  } finally {
    await fixture.host.dispose();
  }
});

it('reports the exact visible MorphWeights Standard contributor as incomplete coverage', async () => {
  const requireErrors: unknown[] = [];
  const feature = sceneDataConsumer(
    () => {},
    () => {},
    { onRequireError: (error) => requireErrors.push(error) },
  );
  const fixture = await createSceneDataRuntime(feature, { morphTarget: true });
  try {
    const warmup = fixture.drawFrame();
    expect(warmup.ok, warmup.ok ? '' : JSON.stringify(warmup.error)).toBe(true);
    if (warmup.ok) expect((await warmup.value.completed).ok).toBe(true);
    const ready = fixture.drawFrame();
    expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
    if (ready.ok) expect((await ready.value.completed).ok).toBe(true);

    const added = fixture.enableMorph();
    expect(added.ok, added.ok ? '' : JSON.stringify(added.error)).toBe(true);
    fixture.update();
    const frameIdBeforeUnsupported = fixture.renderer.inspect().frame.frameId;
    const morphed = fixture.drawFrame();
    expect(morphed).toMatchObject({
      ok: false,
      error: {
        code: 'device-operation-failed',
        detail: {
          cause: {
            code: 'scene-data-unavailable',
            detail: {
              schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
              reason: 'coverage-incomplete',
              recovery: 'next-frame',
            },
          },
        },
      },
    });

    const unavailable = requireErrors.at(-1);
    expect(unavailable).toMatchObject({
      code: 'scene-data-unavailable',
      detail: {
        schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
        reason: 'coverage-incomplete',
        recovery: 'next-frame',
      },
    });
    if (!(unavailable instanceof SceneDataUnavailableError)) {
      throw new Error('MorphWeights contributor did not produce SceneData coverage diagnostics');
    }
    const missingIds = unavailable.detail.missingContributorIds;
    expect(missingIds).toHaveLength(1);
    const contributor = JSON.parse(missingIds[0] ?? 'null') as unknown[];
    expect(contributor[0]).toBe(0);
    expect(contributor[1]).toBe(fixture.entity);
    expect(contributor[2]).toEqual(expect.any(Number));
    expect(contributor[3]).toEqual(expect.any(Number));
    expect(fixture.renderer.inspect().frame.frameId).toBe(frameIdBeforeUnsupported);
  } finally {
    await fixture.host.dispose();
  }
});

it.each([
  ['without a SceneData consumer', false],
  ['with a SceneData consumer', true],
] as const)('retains Deferred Forward-only opaque coverage %s', async (_label, consumesSurface) => {
  const requireErrors: unknown[] = [];
  const catalogs: SceneDataCatalog[] = [];
  const feature = consumesSurface
    ? sceneDataConsumer(
        () => {},
        () => {},
        {
          onCatalog: (catalog) => catalogs.push(catalog),
          onRequireError: (error) => requireErrors.push(error),
        },
      )
    : undefined;
  const fixture = await createSceneDataRuntime(feature, { renderPath: 'deferred' });
  try {
    for (let frame = 0; frame < 2; frame += 1) {
      const ready = fixture.drawFrame();
      expect(ready.ok, ready.ok ? '' : JSON.stringify(ready.error)).toBe(true);
      if (!ready.ok) return;
      const completed = await ready.value.completed;
      expect(completed.ok, completed.ok ? '' : JSON.stringify(completed.error)).toBe(true);
    }
    const forwardOnlyEntity = fixture.addForwardOnlyContributor();
    fixture.update();
    const acceptedFrameId = fixture.renderer.inspect().frame.frameId;
    const candidate = fixture.drawFrame();
    expect(candidate.ok, JSON.stringify(fixture.errors)).toBe(true);
    if (!candidate.ok) return;
    expect((await candidate.value.completed).ok).toBe(true);
    expect(fixture.renderer.inspect().frame.frameId).toBeGreaterThan(acceptedFrameId);
    expect(fixture.renderer.inspect().perFramePassNames).toContain('forward');
    if (!consumesSurface) {
      expect(fixture.errors).toEqual([]);
      return;
    }
    const unavailable = [...fixture.errors]
      .reverse()
      .find(
        (error: unknown) =>
          error instanceof SceneDataUnavailableError &&
          error.detail.schema === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
      );
    expect(unavailable).toBeInstanceOf(SceneDataUnavailableError);
    if (!(unavailable instanceof SceneDataUnavailableError)) return;
    expect(unavailable.detail).toMatchObject({
      schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
      reason: 'coverage-incomplete',
      recovery: 'next-frame',
    });
    const missingContributors = unavailable.detail.missingContributors;
    expect(missingContributors).toBeDefined();
    if (missingContributors === undefined) return;
    const missing = missingContributors.find(
      (contributor) => contributor.sourceTuple?.[1] === forwardOnlyEntity,
    );
    expect(missing).toMatchObject({
      sourceTuple: [0, forwardOnlyEntity, expect.any(Number), expect.any(Number)],
      reason: 'authored-program-not-standard-pbr',
      rejectedField: 'authored-shader-id',
    });
    if (consumesSurface) {
      expect(catalogs.at(-1)?.inspect(SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA)).toMatchObject({
        schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
        status: 'unavailable',
        reason: 'coverage-incomplete',
        missingContributorIds: expect.arrayContaining([JSON.stringify(missing?.sourceTuple)]),
      });
    }
    if (consumesSurface) expect(requireErrors.at(-1)).toBeInstanceOf(SceneDataUnavailableError);
    expect(fixture.renderer.inspect().frame.frameId).toBeGreaterThan(acceptedFrameId);
  } finally {
    await fixture.host.dispose();
  }
});
