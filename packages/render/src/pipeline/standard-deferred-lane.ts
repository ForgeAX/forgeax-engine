import {
  type GraphBuffer,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { addProjectedDecalPasses } from '../decals/graph';
import { addDepthPyramidPasses, type DepthPyramidProjection } from '../depth-pyramid/graph';
import { addAtmosphereBackground } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import type {
  RenderPipeline,
  RenderPipelineBuildError,
  RenderPipelineFeatureTarget,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { getSsaoParameters } from '../ssao-config';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses, type SsrSpatialGraphProjection } from '../ssr/graph';
import {
  DEFERRED_ATTACHMENT_BYTES,
  DEFERRED_COLOR_FORMATS,
  STANDARD_VISIBLE_SURFACE_FORMAT,
  SUBSURFACE_ATTACHMENT_BYTES,
  SUBSURFACE_DEFERRED_COLOR_FORMATS,
} from '../standard-attachments';
import { addSubsurfaceDiffusion } from '../subsurface/graph';
import {
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
  TRANSMISSION_BACK_PASS_SELECTOR,
} from '../systems/pass-selector';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  createStandardSceneDataTarget,
  requireStandardTemporalLane,
  type StandardSceneDataTargets,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  standardTransmissionRoute,
} from '../transmission/backdrop';
import type { TransmissionDemand } from '../transmission/projection';
import {
  addObservationCapturePass,
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
  type TemporalSecondaryReactivity,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses, type TypedShadowTargets } from '../typed-shadow-passes';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import type { StandardPipelineBuildContext } from './standard-build-context';
import {
  contributeStandardCloudComposite,
  contributeStandardCloudPreOpaque,
  createStandardCloudSceneTarget,
  createStandardCloudShadowTarget,
} from './standard-cloud-stage';
import { addStandardDeferredLighting } from './standard-deferred-lighting';
import {
  type StandardForwardReceiverInputs,
  standardForwardReceiverFeatureAccesses,
  standardForwardReceiverInputs,
} from './standard-forward-receiver';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  type StandardClusterGraphBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import type { StandardTopologyInputValue } from './standard-lighting/topology';
import { addStandardPost, contributeStandardSceneFeatures } from './standard-post';
import { addStandardTransparentPasses } from './standard-transparency';

type Graph = RenderGraphBuilder<RenderPipelineFrame>;
type InternalSize = GraphTextureDescriptor['size'];
type CopySize = { readonly width: number; readonly height: number };

function target(
  graph: Graph,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

/** Does the device hold every Deferred attachment this profile declares? */
function deferredLaneCapabilityError(
  topology: RenderPipelineTopology,
  visibleSurfaceEnabled: boolean,
): RenderGraphError | undefined {
  const lane = topology.lane;
  const attachmentBytes =
    topology.subsurface === undefined ? DEFERRED_ATTACHMENT_BYTES : SUBSURFACE_ATTACHMENT_BYTES;
  const requiredSurfaceBytes = visibleSurfaceEnabled
    ? attachmentBytes.visibleSurface
    : attachmentBytes.surface;
  if (
    visibleSurfaceEnabled &&
    (lane.primitiveIndex !== true ||
      lane.maxColorAttachments < 7 ||
      (lane.maxColorAttachmentBytesPerSample ?? 0) < DEFERRED_ATTACHMENT_BYTES.visibleSurface ||
      topology.camera.antialias === 'msaa')
  ) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `visible surfaces require primitive-index, seven targets, ${DEFERRED_ATTACHMENT_BYTES.visibleSurface} attachment bytes and single sampling`,
      hint: 'request these device features/limits before enabling visibleSurface',
      detail: {
        resourceLabel: 'visible-surface',
        field: 'capabilities',
        expected: `primitive-index / 7 targets / ${DEFERRED_ATTACHMENT_BYTES.visibleSurface} bytes / single sample`,
        actual: JSON.stringify(lane),
      },
    });
  }
  if (!lane.storageBuffer || lane.maxColorAttachments < DEFERRED_COLOR_FORMATS.length) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'Standard deferred requires storage buffers and six color attachments',
      hint: 'select a device with deferred capabilities or explicitly select the Forward profile',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'renderPath',
        expected: 'storage buffers and six MRTs',
        actual: `storageBuffer=${lane.storageBuffer}, maxColorAttachments=${lane.maxColorAttachments}`,
      },
    });
  }
  if ((lane.maxColorAttachmentBytesPerSample ?? 32) < requiredSurfaceBytes) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'Deferred attachments fit the device byte limit',
      hint: `request at least ${requiredSurfaceBytes} bytes/sample for this Deferred profile`,
      detail: {
        resourceLabel: 'subsurface-profile',
        field: 'capabilities',
        expected: `${requiredSurfaceBytes} bytes/sample`,
        actual: String(lane.maxColorAttachmentBytesPerSample),
      },
    });
  }
  return undefined;
}

/** The G-buffer attachments and scene color every Deferred stage reads or writes. */
interface DeferredSceneTargets {
  readonly depth: RenderPipelineTarget;
  /** Depth-only view of `depth`. */
  readonly depthSample: GraphTextureView;
  readonly normalRoughness: RenderPipelineTarget;
  readonly albedoMetallic: RenderPipelineTarget;
  readonly f0Occlusion: RenderPipelineTarget;
  readonly lightingContext: RenderPipelineTarget;
  readonly receiverGeometry: RenderPipelineTarget;
  readonly visibleSurface: RenderPipelineTarget | undefined;
  readonly scene: RenderPipelineTarget;
  readonly medium: SingleLayerMediumNearestTargets | undefined;
  /** Linear-HDR fallback radiance and its specular response, when any reflection consumer exists. */
  readonly reflection: DeferredReflectionTargets;
}

interface DeferredReflectionTargets {
  readonly fallback: RenderPipelineTarget | undefined;
  readonly response: RenderPipelineTarget | undefined;
}

function declareDeferredSceneTargets(
  graph: Graph,
  topology: RenderPipelineTopology,
  size: InternalSize,
  visibleSurfaceEnabled: boolean,
): Result<DeferredSceneTargets, RenderGraphError> {
  const formats =
    topology.subsurface === undefined ? DEFERRED_COLOR_FORMATS : SUBSURFACE_DEFERRED_COLOR_FORMATS;
  const depth = target(graph, 'hdrp-depth', { format: 'depth32float-stencil8', size });
  if (!depth.ok) return depth;
  const depthSample = graph.view(depth.value.texture, {
    label: 'ssr-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const normalRoughness = target(graph, 'gbuffer-normal-roughness', {
    format: DEFERRED_COLOR_FORMATS[1],
    size,
  });
  if (!normalRoughness.ok) return normalRoughness;
  const albedoMetallic = target(graph, 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[3],
    size,
  });
  if (!albedoMetallic.ok) return albedoMetallic;
  const f0Occlusion = target(graph, 'gbuffer-f0-occlusion', {
    format: DEFERRED_COLOR_FORMATS[2],
    size,
  });
  if (!f0Occlusion.ok) return f0Occlusion;
  const lightingContext = target(graph, 'gbuffer-lighting-context', { format: formats[4], size });
  if (!lightingContext.ok) return lightingContext;
  const receiverGeometry = target(graph, 'gbuffer-receiver-geometry', {
    format: DEFERRED_COLOR_FORMATS[5],
    size,
  });
  if (!receiverGeometry.ok) return receiverGeometry;
  const visibleSurface = visibleSurfaceEnabled
    ? target(graph, 'visible-surface', { format: STANDARD_VISIBLE_SURFACE_FORMAT, size })
    : ok(undefined);
  if (!visibleSurface.ok) return visibleSurface;
  const scene = target(graph, 'hdrp-scene-color', { format: formats[0], size });
  if (!scene.ok) return scene;
  const medium =
    topology.singleLayerMedium === true
      ? declareSingleLayerMediumTargets(graph, scene.value, size)
      : ok(undefined);
  if (!medium.ok) return medium;
  const reflection = declareReflectionTargets(graph, topology, size);
  if (!reflection.ok) return reflection;
  return ok({
    depth: depth.value,
    depthSample: depthSample.value,
    normalRoughness: normalRoughness.value,
    albedoMetallic: albedoMetallic.value,
    f0Occlusion: f0Occlusion.value,
    lightingContext: lightingContext.value,
    receiverGeometry: receiverGeometry.value,
    visibleSurface: visibleSurface.value,
    scene: scene.value,
    medium: medium.value,
    reflection: reflection.value,
  });
}

function declareSingleLayerMediumTargets(
  graph: Graph,
  scene: RenderPipelineTarget,
  size: InternalSize,
): Result<SingleLayerMediumNearestTargets, RenderGraphError> {
  const nearestLayer = target(graph, 'single-layer-medium-nearest-layer', {
    format: scene.format,
    size,
    // The color pass samples this target with a `texture_2d`; keep
    // it single-sample even when a future deferred path is MSAA.
    sampleCount: 1,
    domain: 'linear-ldr',
  });
  if (!nearestLayer.ok) return nearestLayer;
  const nearestDepth = target(graph, 'single-layer-medium-nearest-depth', {
    format: 'depth32float-stencil8',
    size,
    sampleCount: 1,
  });
  if (!nearestDepth.ok) return nearestDepth;
  return ok({ nearestLayer: nearestLayer.value, nearestDepth: nearestDepth.value });
}

function declareReflectionTargets(
  graph: Graph,
  topology: RenderPipelineTopology,
  size: InternalSize,
): Result<DeferredReflectionTargets, RenderGraphError> {
  const diffuseGi = topology.standardProfile?.diffuseGi;
  const required =
    topology.reflectionFallback?.enabled === true ||
    topology.ssr?.status === 'admitted' ||
    (diffuseGi?.gather !== 'baked' && diffuseGi?.reflections !== undefined);
  if (!required) return ok({ fallback: undefined, response: undefined });
  const fallback = target(graph, 'reflection-fallback-linear-hdr', {
    format: 'rgba16float',
    size,
    domain: 'linear-hdr',
  });
  if (!fallback.ok) return fallback;
  const response = target(graph, 'deferred-specular-response', { format: 'rgba16float', size });
  if (!response.ok) return response;
  return ok({ fallback: fallback.value, response: response.value });
}

/**
 * Admit the Standard temporal-v1 producer. `inGBuffer` reports whether the
 * G-buffer fragments can publish it beside the material facts; devices that
 * cannot hold this MRT shape keep the standalone producer.
 */
function admitDeferredTemporal(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  visibleSurfaceEnabled: boolean,
): Result<
  { readonly targets: StandardSceneDataTargets | undefined; readonly inGBuffer: boolean },
  RenderPipelineBuildError
> {
  const lane = topology.lane;
  const demand = aggregateTemporalDemand({
    taa: topology.camera.antialias === 'taa',
    motionBlur: topology.temporal?.motionBlur === true,
    ssr: topology.ssr?.status === 'admitted',
    visibleSurface: visibleSurfaceEnabled,
  });
  const admission = requireStandardTemporalLane({
    demand,
    compute: lane.compute,
    storageBuffer: lane.storageBuffer,
    rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
  });
  if (!admission.ok) return admission;
  if (demand.targetCount !== 1) return ok({ targets: undefined, inGBuffer: false });
  const temporal = createStandardSceneDataTarget(context.graph, topology.extent);
  if (!temporal.ok) return temporal;
  const attachmentBytes =
    topology.subsurface === undefined ? DEFERRED_ATTACHMENT_BYTES : SUBSURFACE_ATTACHMENT_BYTES;
  const inGBuffer =
    lane.maxColorAttachments >= 7 + Number(visibleSurfaceEnabled) &&
    (lane.maxColorAttachmentBytesPerSample ?? 0) >=
      (visibleSurfaceEnabled ? attachmentBytes.visibleSurfaceTemporal : attachmentBytes.temporal);
  return ok({ targets: temporal.value, inGBuffer });
}

function addDeferredShadows(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow: boolean,
  cameraPyramid: GraphTextureView | undefined,
) {
  const featureShadows = context.contributeShadowFeatures?.();
  if (featureShadows !== undefined && !featureShadows.ok) return featureShadows;
  return addTypedShadowPasses(context.graph, topology, {
    projectGpuDrivenShadow: context.projectGpuDrivenShadow,
    shadowFeatures: featureShadows?.value,
    cameraPyramid: cameraPyramid,
    staticLayers: context.gpuDrivenShadowDepthLayers,
    depthLayers: context.shadowDepthLayers,
    reuseAdjacentShadow: reuseAdjacentShadow,
  });
}

function importDeferredClusters(
  graph: Graph,
  lighting: StandardTopologyInputValue,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok || buffers.value === null) return buffers;
  const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  return buffers;
}

/**
 * Cloud density and its spatial shadow must be produced before the opaque
 * receiver pass. The composite is projected separately, after the receiver
 * has populated the scene target; declaration order is execution order for
 * the typed graph.
 */
function declareDeferredClouds(
  context: StandardPipelineBuildContext,
  scene: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  size: InternalSize,
) {
  const featureRasterWork =
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const cloudScene = createStandardCloudSceneTarget(context, featureRasterWork, {
    format: scene.format,
    size,
    domain: 'linear-hdr',
  });
  if (!cloudScene.ok) return cloudScene;
  const cloudShadow = createStandardCloudShadowTarget(context, featureRasterWork);
  if (!cloudShadow.ok) return cloudShadow;
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: scene,
    depth,
    cloudShadow: cloudShadow.value,
  });
  if (!featureTargets.ok) return featureTargets;
  return ok({
    cloudScene: cloudScene.value,
    cloudShadow: cloudShadow.value,
    featureTargets: featureTargets.value,
  });
}

// Background must precede geometry now that geometry initializes SceneColor.
function addDeferredBackground(
  graph: Graph,
  topology: RenderPipelineTopology,
  scene: RenderPipelineTarget,
  directional: GraphTextureView | undefined,
  cloudShadow: RenderPipelineTarget | undefined,
): Result<GraphEnvironment | undefined, RenderGraphError> {
  if (topology.atmosphere === true)
    return addAtmosphereBackground(graph, scene, { directional, cloud: cloudShadow?.view });
  const skybox = addTypedSkyboxPass(graph, scene);
  if (!skybox.ok) return skybox;
  return ok(undefined);
}

function gbufferColorTargets(
  targets: DeferredSceneTargets,
  temporal: StandardSceneDataTargets | undefined,
  temporalInGBuffer: boolean,
): RenderPipelineTarget[] {
  return [
    targets.scene,
    targets.normalRoughness,
    targets.f0Occlusion,
    targets.albedoMetallic,
    targets.lightingContext,
    targets.receiverGeometry,
    ...(targets.visibleSurface === undefined ? [] : [targets.visibleSurface]),
    ...(temporalInGBuffer && temporal !== undefined ? [temporal.temporal] : []),
  ];
}

function addEarlyGBufferPass(
  graph: Graph,
  targets: DeferredSceneTargets,
  temporal: StandardSceneDataTargets | undefined,
  temporalInGBuffer: boolean,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
): Result<void, RenderGraphError> {
  const visibleSurfaceEnabled = targets.visibleSurface !== undefined;
  return addTypedScenePass(graph, {
    name: 'g-buffer',
    color: targets.scene,
    colorTargets: gbufferColorTargets(targets, temporal, temporalInGBuffer),
    colorLoadOp: [
      'load',
      'clear',
      'clear',
      'clear',
      'clear',
      'clear',
      ...(visibleSurfaceEnabled ? ['clear' as const] : []),
      ...(temporalInGBuffer ? ['clear' as const] : []),
    ],
    colorClearValues: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      ...(visibleSurfaceEnabled ? [[0, 0, 0, 0] as const] : []),
      ...(temporalInGBuffer ? [[0, 0, -1, 1] as const] : []),
    ],
    gpuDrivenFilter: 'deferred-opaque',
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
    depth: targets.depth,
    selector: DEFERRED_PASS_SELECTOR,
    // The G-buffer only admits opaque Standard materials. Medium Surface
    // programs have no Deferred entry and acquire raw depth in their later
    // paired color pass; filtering here also avoids assembling their bind
    // groups before that producer exists.
    recordMode: 'opaque',
    passKind: 'deferred',
    clearColor: [0, 0, 0, 0],
  });
}

function addLateGBufferPass(
  graph: Graph,
  targets: DeferredSceneTargets,
  temporal: StandardSceneDataTargets | undefined,
  temporalInGBuffer: boolean,
  gpuDriven: RenderPipelineGpuDrivenProjection,
): Result<void, RenderGraphError> {
  return addTypedScenePass(graph, {
    name: 'g-buffer-late',
    color: targets.scene,
    colorTargets: gbufferColorTargets(targets, temporal, temporalInGBuffer),
    colorLoadOp: [
      'load',
      'load',
      'load',
      'load',
      'load',
      'load',
      ...(targets.visibleSurface !== undefined ? ['load' as const] : []),
      ...(temporalInGBuffer ? ['load' as const] : []),
    ],
    depthLoadOp: 'load',
    gpuDriven,
    gpuDrivenFilter: 'deferred-opaque',
    gpuDrivenPhase: 'late',
    depth: targets.depth,
    selector: DEFERRED_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'deferred',
  });
}

/** Decals write the G-buffer; visible-surface capture and probe placement read it. */
function addSurfaceStage(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  size: InternalSize,
) {
  const graph = context.graph;
  if (targets.visibleSurface !== undefined) {
    const capture = addObservationCapturePass(graph, targets.visibleSurface, 'visible-surface');
    if (!capture.ok) return capture;
  }
  const decals = addProjectedDecalPasses(graph, topology.projectedDecals ?? [], {
    depth: targets.depthSample,
    normal: targets.normalRoughness,
    albedo: targets.albedoMetallic,
    f0: targets.f0Occlusion,
    size,
  });
  if (!decals.ok) return decals;
  if (context.contributeProbePlacement !== undefined && targets.visibleSurface !== undefined) {
    const placed = context.contributeProbePlacement({
      depth: targets.depthSample,
      normal: decals.value.normal,
      identity: targets.visibleSurface,
    });
    if (!placed.ok) return placed;
  }
  return decals;
}

function addDeferredSsao(
  graph: Graph,
  topology: RenderPipelineTopology,
  copySize: CopySize,
  normal: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (topology.config?.ssao?.enabled !== true) return ok(undefined);
  const { resolutionScale } = getSsaoParameters(topology.config.ssao);
  const size = {
    width: Math.max(1, Math.round(copySize.width * resolutionScale)),
    height: Math.max(1, Math.round(copySize.height * resolutionScale)),
  };
  const raw = target(graph, 'ssao-raw', { format: 'rgba8unorm', size });
  if (!raw.ok) return raw;
  const blurred = target(graph, 'ssao-blurred', { format: 'r8unorm', size });
  if (!blurred.ok) return blurred;
  const passes = addTypedSsaoPasses(graph, {
    normal,
    depth,
    raw: raw.value,
    blurred: blurred.value,
  });
  if (!passes.ok) return passes;
  return ok(blurred.value);
}

interface DeferredSurfaceGBuffer {
  readonly normal: RenderPipelineTarget;
  readonly albedo: RenderPipelineTarget;
  readonly f0: RenderPipelineTarget;
}

/** Opaque light sources the Deferred lighting pass and the later forward receivers sample. */
interface DeferredLightSources {
  readonly shadows: TypedShadowTargets;
  readonly cloudShadow: RenderPipelineTarget | undefined;
  readonly ssao: RenderPipelineTarget | undefined;
  readonly environment: GraphEnvironment | undefined;
  readonly clusters: StandardClusterGraphBuffers | null;
}

function addDeferredLightingStage(
  graph: Graph,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  surfaces: DeferredSurfaceGBuffer,
  sources: DeferredLightSources,
  size: InternalSize,
  copySize: CopySize,
): Result<void, RenderGraphError> {
  const subsurfaceDiffuse =
    topology.subsurface === undefined
      ? ok(undefined)
      : target(graph, 'subsurface-diffuse', { format: 'rgba16float', size });
  if (!subsurfaceDiffuse.ok) return subsurfaceDiffuse;
  const { shadows, cloudShadow, ssao, environment, clusters } = sources;
  const reflection = targets.reflection;
  const lightingPass = addStandardDeferredLighting(graph, {
    color: targets.scene,
    ...(subsurfaceDiffuse.value === undefined ? {} : { diffuse: subsurfaceDiffuse.value }),
    gbuffer: [surfaces.normal, surfaces.albedo, surfaces.f0, targets.lightingContext],
    receiverGeometry: targets.receiverGeometry,
    depth: targets.depthSample,
    ...(reflection.fallback === undefined ? {} : { reflectionFallback: reflection.fallback }),
    ...(reflection.response === undefined ? {} : { response: reflection.response }),
    ...(ssao === undefined ? {} : { ssao }),
    ...(environment === undefined ? {} : { environment }),
    ...(shadows.directional === undefined ? {} : { directionalShadow: shadows.directional }),
    spotShadow: shadows.spot,
    shadowMoments: shadows.moments,
    ...(cloudShadow === undefined ? {} : { cloudShadow }),
    ...(shadows.point === undefined ? {} : { pointShadow: shadows.point }),
    cluster: clusters,
    extraAccesses: clusters === null ? [] : standardClusterReadAccesses(clusters),
    size: copySize,
  });
  if (!lightingPass.ok) return lightingPass;
  if (subsurfaceDiffuse.value === undefined || topology.subsurface === undefined)
    return ok(undefined);
  return addSubsurfaceDiffusion(graph, {
    scene: targets.scene,
    diffuse: subsurfaceDiffuse.value,
    profiles: targets.lightingContext.view,
    normal: surfaces.normal.view,
    depth: targets.depthSample,
    size: copySize,
    scale: [
      copySize.width / (topology.extent?.outputWidth ?? topology.surface.width),
      copySize.height / (topology.extent?.outputHeight ?? topology.surface.height),
    ],
    quality: topology.subsurface.quality,
  });
}

/**
 * SSR consumes the same Standard temporal-v1 producer as TAA and motion blur.
 * Insert it before the spatial chain so the graph dependency order is
 * explicit and one producer serves every temporal consumer; diffuse GI and
 * target coverage read the same frame facts.
 */
function addSceneDataConsumers(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  surfaces: DeferredSurfaceGBuffer,
  temporal: { readonly targets: StandardSceneDataTargets | undefined; readonly inGBuffer: boolean },
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  depthViews: DeferredDepthViews,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const reflection = targets.reflection;
  const temporalTargets = temporal.targets;
  if (temporalTargets !== undefined) {
    const producer = addStandardSceneDataPass(
      graph,
      temporalTargets.temporal,
      targets.depth,
      gpuDriven,
      temporal.inGBuffer ? 'forward-only-opaque' : 'opaque',
    );
    if (!producer.ok) return producer;
  }
  if (
    context.contributeDiffuseGi !== undefined &&
    targets.visibleSurface !== undefined &&
    temporalTargets !== undefined
  ) {
    const diffuse = context.contributeDiffuseGi({
      scene: targets.scene,
      depth: targets.depthSample,
      normal: surfaces.normal,
      albedo: surfaces.albedo,
      f0: surfaces.f0,
      identity: targets.visibleSurface,
      motion: temporalTargets.temporal,
      depthPyramid: () => {
        const pyramid = depthViews.closestPyramid();
        return pyramid.ok ? ok(pyramid.value.pyramid.pyramid) : pyramid;
      },
      ...(reflection.fallback === undefined || reflection.response === undefined
        ? {}
        : { reflection: { fallback: reflection.fallback, response: reflection.response } }),
    });
    if (!diffuse.ok) return diffuse;
  }
  if (context.targetCoverage === undefined) return ok(undefined);
  return addTargetCoveragePass(graph, context.targetCoverage, gpuDriven);
}

/** Screen-space reflections; returns the secondary reactivity TAA consumes, if produced. */
function addDeferredSsr(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  normal: RenderPipelineTarget,
  temporal: StandardSceneDataTargets | undefined,
  copySize: CopySize,
  depthViews: DeferredDepthViews,
): Result<TemporalSecondaryReactivity | undefined, RenderGraphError> {
  const ssr = topology.ssr;
  if (ssr === undefined) return ok(undefined);
  const ssrView = ssr.status === 'admitted' ? depthViews.sceneView() : ok(undefined);
  if (!ssrView.ok) return ssrView;
  const depthPyramid = ssr.status === 'admitted' ? depthViews.closestPyramid() : ok(undefined);
  if (!depthPyramid.ok) return depthPyramid;
  const history = context.ssrHistory;
  const fallback = targets.reflection.fallback;
  const spatial = addSsrSpatialPasses(context.graph, {
    admission: ssr,
    width: copySize.width,
    height: copySize.height,
    depth: targets.depthSample,
    normal: normal.view,
    scene: targets.scene.view,
    ...(temporal === undefined ? {} : { currentTemporal: temporal.temporal.view }),
    ...(fallback === undefined ? {} : { fallback: fallback.view }),
    ...(temporal === undefined || history === undefined
      ? {}
      : {
          temporal: {
            previousHistory: history.previous.view,
            outputHistory: history.output.view,
            previousSurface: history.previousSurface.view,
            outputSurface: history.outputSurface.view,
            params: history.params,
          },
        }),
    ...(ssrView.value === undefined ? {} : { view: ssrView.value }),
    ...(depthPyramid.value === undefined ? {} : { depthPyramid: depthPyramid.value.pyramid }),
  });
  if (!spatial.ok) return spatial;
  return composeDeferredSsr(context.graph, targets, normal, spatial.value, ssrView.value);
}

/** Composite traced radiance over the reflection fallback once every input exists. */
function composeDeferredSsr(
  graph: Graph,
  targets: DeferredSceneTargets,
  normal: RenderPipelineTarget,
  spatial: SsrSpatialGraphProjection,
  view: GraphBuffer | undefined,
): Result<TemporalSecondaryReactivity | undefined, RenderGraphError> {
  const { fallback, response } = targets.reflection;
  const resources = spatial.resources;
  if (
    resources === undefined ||
    fallback === undefined ||
    view === undefined ||
    response === undefined
  )
    return ok(undefined);
  const reactivity = spatial.reactivity;
  const surface = spatial.reactivitySurface;
  const composed = addSsrCompositionPass(graph, {
    scene: targets.scene,
    radiance: resources.radiancePyramid ?? resources.trace.view,
    fallback: fallback.view,
    response: response.view,
    normal: normal.view,
    view,
  });
  if (!composed.ok) return composed;
  return ok(
    reactivity === undefined || surface === undefined
      ? undefined
      : { view: reactivity, ...surface },
  );
}

/** What every forward scene writer after Deferred lighting binds. */
interface DeferredForwardScene {
  readonly color: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly environment: GraphEnvironment | undefined;
  readonly receiver: StandardForwardReceiverInputs;
  readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
}

/**
 * Forward-only opaque writers, then analytic fog over the opaque scene and the
 * cloud composite. Returns the scene target later translucent writers use.
 */
function addDeferredOpaqueForward(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  clouds: {
    readonly cloudScene: RenderPipelineTarget | undefined;
    readonly cloudShadow: RenderPipelineTarget | undefined;
    readonly featureTargets: readonly RenderPipelineFeatureTarget[];
  },
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const graph = context.graph;
  const { color, depth, environment, receiver, gpuDriven } = forward;
  const pass = addTypedScenePass(graph, {
    environment,
    name: 'forward',
    color,
    depth,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    ...receiver,
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
    passKind: 'forward',
    excludeSelector: DEFERRED_PASS_SELECTOR,
    // Keep the deferred opaque lane separate from Surface medium passes.
    recordMode: 'opaque' as const,
    gpuDrivenFilter: 'forward-only-opaque',
  });
  if (!pass.ok) return pass;
  // Atmosphere and analytic fog composite onto the opaque scene before
  // transmission copies and translucent draws. Every translucent writer then
  // fogs itself at its own depth, so blending composes depth-correctly.
  const fogged = addOpaqueFogPasses(graph, {
    topology,
    atmosphere: environment?.atmosphere,
    color,
    depth,
  });
  if (!fogged.ok) return fogged;
  if (clouds.cloudScene === undefined) return ok(color);
  const composite = contributeStandardCloudComposite(
    context,
    clouds.featureTargets,
    { input: color, output: clouds.cloudScene, cloudShadow: clouds.cloudShadow },
    receiver.extraAccesses,
    environment?.atmosphere,
  );
  if (!composite.ok) return composite;
  return ok(clouds.cloudScene);
}

/** Back faces of sorted transmission precede the front-face backdrop and the translucent prefix. */
function addSortedTransmissionPrefix(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  demand: TransmissionDemand,
  copySize: CopySize,
): Result<void, RenderGraphError> {
  const graph = context.graph;
  const { color, depth, environment, receiver } = forward;
  if (demand.needsBackPass === true) {
    const backdrop = addTransmissionBackdropPasses({
      graph,
      name: 'transmission-backdrop-backs',
      source: color,
      demand,
      copySize,
      surfaceSize: topology.surface,
      encodeRoughMip: context.encodeTransmissionMip,
      includeConsumerPasses: false,
    });
    if (!backdrop.ok) return backdrop;
    const backs = addTypedScenePass(graph, {
      environment,
      name: 'transmission-backs',
      color,
      depth,
      ...receiver,
      selector: TRANSMISSION_BACK_PASS_SELECTOR,
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode: 'transmission',
      transparentDepthWrite: true,
      transmissionBackdrop: backdrop.value.backdrop?.view,
    });
    if (!backs.ok) return backs;
  }
  return addTypedScenePass(graph, {
    environment,
    name: 'transparent-before-transmission',
    color,
    depth,
    ...receiver,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    recordMode: 'translucent-before-transmission',
    transparentDepthWrite: true,
  });
}

function addDeferredSingleLayerMedium(
  graph: Graph,
  forward: DeferredForwardScene,
  nearestTargets: SingleLayerMediumNearestTargets | undefined,
  backdrop: GraphTextureView | undefined,
  targetCaptures: GraphTextureView | undefined,
  size: InternalSize,
): Result<void, RenderGraphError> {
  const { color, depth, receiver, gpuDriven } = forward;
  const medium = requireSingleLayerMediumInputs(nearestTargets, backdrop);
  if (!medium.ok) return medium;
  const rawDepth = addSingleLayerMediumRawDepthProducer({
    graph,
    sourceColor: color,
    sourceDepth: depth,
    size,
  });
  if (!rawDepth.ok) return rawDepth;
  // Standard owns this producer fact. Deferred depth is single-sample, so
  // the independent r32float copy is available to both medium passes.
  const surfacePair: RenderPipelineSurfaceMediumPair = {
    opaqueColor: medium.value.backdrop,
    rawDepth: { status: 'available', view: rawDepth.value.view },
  };
  return addSingleLayerMediumPasses({
    graph,
    size,
    ...medium.value.nearestTargets,
    color,
    depth,
    ...receiver,
    extraAccesses: [
      ...receiver.extraAccesses,
      ...(targetCaptures === undefined
        ? []
        : [{ resource: targetCaptures, usage: 'sampled-read' as const }]),
    ],
    surfacePair,
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
  });
}

function addDeferredTransparentPasses(
  graph: Graph,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  size: InternalSize,
) {
  return addStandardTransparentPasses(graph, {
    color: forward.color,
    depth: forward.depth,
    size,
    transparency: topology.transparency,
    template: {
      environment: forward.environment,
      ...forward.receiver,
      passKind: 'forward',
    },
  });
}

/** Transmission backdrop, single-layer medium and every translucent writer, in blend order. */
function addDeferredTranslucency(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  route: ReturnType<typeof standardTransmissionRoute>,
  mediumTargets: SingleLayerMediumNearestTargets | undefined,
  targetCaptures: GraphTextureView | undefined,
): Result<void, RenderGraphError> {
  const graph = context.graph;
  const size = renderInternalSize(topology);
  const copySize = renderInternalCopySize(topology);
  const { transmissionActive, backdropActive } = route;
  const sortedTransmission = route.sorted;
  if (sortedTransmission) {
    const prefix = addSortedTransmissionPrefix(context, topology, forward, route.demand, copySize);
    if (!prefix.ok) return prefix;
  }
  const transmission = addTransmissionBackdropPasses({
    graph,
    source: forward.color,
    demand: route.backdropDemand,
    copySize,
    surfaceSize: topology.surface,
    encodeRoughMip: context.encodeTransmissionMip,
    includeConsumerPasses: false,
  });
  if (!transmission.ok) return transmission;
  const backdrop = transmission.value.backdrop?.view;
  if (topology.singleLayerMedium === true) {
    const medium = addDeferredSingleLayerMedium(
      graph,
      forward,
      mediumTargets,
      backdrop,
      targetCaptures,
      size,
    );
    if (!medium.ok) return medium;
  }
  if (backdropActive) {
    if (transmissionActive) {
      const transmissionPass = addTypedScenePass(graph, {
        environment: forward.environment,
        name: 'transmission-forward',
        color: forward.color,
        depth: forward.depth,
        selector: FORWARD_PASS_SELECTOR,
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        ...forward.receiver,
        passKind: 'forward',
        recordMode: sortedTransmission ? 'translucent' : 'transmission',
        transparentDepthWrite: true,
        // Inject the complete backdrop view so the Standard shader can select
        // the producer's optional roughness mip level. mipViews[0] is only the
        // copy destination view and intentionally exposes one level.
        transmissionBackdrop: backdrop,
      });
      if (!transmissionPass.ok) return transmissionPass;
    }
    if (!sortedTransmission) {
      const transparentPass = addDeferredTransparentPasses(graph, topology, forward, size);
      if (!transparentPass.ok) return transparentPass;
    }
    const temporal = addTransmissionBackdropTemporalPass(graph, forward.color);
    if (!temporal.ok) return temporal;
  }
  if (transmission.value.topology.active) return ok(undefined);
  return addDeferredTransparentPasses(graph, topology, forward, size);
}

/**
 * The local froxel volume composites after every translucent writer: its
 * per-pixel integral ends at opaque depth, so composited earlier each blended
 * surface behind the medium would cut its shape out of the haze. Generic post
 * features then consume the final scene target with the same clustered,
 * shadow and SSAO reads the Standard receiver exposes.
 */
function addDeferredSceneObservations(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  sources: DeferredLightSources,
  reflectionFallback: RenderPipelineTarget | undefined,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const { color, depth, environment, receiver } = forward;
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    atmosphere: environment?.atmosphere,
    color,
    depth,
    directionalShadow: sources.shadows.directional?.view,
    spotShadow: sources.shadows.spot.view,
    clusterBuffers: sources.clusters,
    cloudShadow: sources.cloudShadow?.view,
  });
  if (!volume.ok) return volume;
  const features = contributeStandardSceneFeatures(
    context,
    { color, colorResolve: undefined, depth },
    standardForwardReceiverFeatureAccesses(receiver),
    environment?.atmosphere,
  );
  if (!features.ok) return features;
  const observation = addTypedFrameObservationPass(graph, color);
  if (!observation.ok) return observation;
  if (reflectionFallback?.sampleCount !== 1) return ok(undefined);
  return addReflectionFallbackObservationPass(graph, reflectionFallback);
}

/** Lazily imported scene view and the one closest-depth pyramid SSR and diffuse GI share. */
interface DeferredDepthViews {
  readonly sceneView: () => Result<GraphBuffer, RenderGraphError>;
  readonly closestPyramid: () => Result<DepthPyramidProjection, RenderGraphError>;
}

function deferredDepthViews(
  graph: Graph,
  depthSample: GraphTextureView,
  copySize: CopySize,
): DeferredDepthViews {
  const sceneView = sceneViewImport(graph);
  // One closest-depth pyramid per view, built only when SSR or a diffuse GI
  // gather actually reads it.
  let closestPyramid: Result<DepthPyramidProjection, RenderGraphError> | undefined;
  return {
    sceneView,
    closestPyramid: () => {
      if (closestPyramid !== undefined) return closestPyramid;
      const view = sceneView();
      if (!view.ok) return view;
      closestPyramid = addDepthPyramidPasses(graph, {
        depth: depthSample,
        width: copySize.width,
        height: copySize.height,
        view: view.value,
      });
      return closestPyramid;
    },
  };
}

// The atmosphere samples the directional map along open view rays before
// geometry, so its receivers are not the camera's surfaces and the camera
// pyramid cannot cull their casters.
function addEarlyDeferredShadows(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow: boolean,
) {
  if (topology.atmosphere !== true) return ok(undefined);
  return addDeferredShadows(context, topology, reuseAdjacentShadow, undefined);
}

// Shadows follow the late pyramid so their caster cull can test it; the
// lighting pass is their first consumer either way.
function addLateDeferredShadows(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow: boolean,
  early: TypedShadowTargets | undefined,
  cameraPyramid: GraphTextureView | undefined,
) {
  if (early !== undefined) return ok(early);
  return addDeferredShadows(context, topology, reuseAdjacentShadow, cameraPyramid);
}

function projectDeferredGpuDriven(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
) {
  const fallback = targets.reflection.fallback;
  return context.projectGpuDriven({
    format: targets.scene.format,
    sampleCount: targets.scene.sampleCount,
    lateOcclusion: topology.config?.gpuOcclusion !== false,
    ...(fallback === undefined ? {} : { additionalColorFormats: [fallback.format] }),
  });
}

/** Early G-buffer, GPU late occlusion and its late G-buffer; returns the late camera pyramid. */
function addDeferredGBufferPasses(
  graph: Graph,
  targets: DeferredSceneTargets,
  temporal: { readonly targets: StandardSceneDataTargets | undefined; readonly inGBuffer: boolean },
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: CopySize,
  depthViews: DeferredDepthViews,
): Result<GraphTextureView | undefined, RenderGraphError> {
  const early = addEarlyGBufferPass(
    graph,
    targets,
    temporal.targets,
    temporal.inGBuffer,
    gpuDriven,
  );
  if (!early.ok) return early;
  const late = addGpuLateOcclusion(graph, {
    gpuDriven,
    depth: targets.depthSample,
    multisampled: targets.depth.sampleCount > 1,
    width: copySize.width,
    height: copySize.height,
    view: depthViews.sceneView,
  });
  if (!late.ok || late.value === undefined || gpuDriven === undefined) return late;
  const latePass = addLateGBufferPass(
    graph,
    targets,
    temporal.targets,
    temporal.inGBuffer,
    gpuDriven,
  );
  if (!latePass.ok) return latePass;
  return late;
}

function contributeDeferredCubeCaptures(
  context: StandardPipelineBuildContext,
  environment: GraphEnvironment | undefined,
): Result<GraphTextureView | undefined, RenderPipelineBuildError> {
  if (context.contributeCubeCaptures === undefined) return ok(undefined);
  return context.contributeCubeCaptures(environment);
}

/** Forward writers, translucency and scene observations; returns the final scene target. */
function addDeferredForwardStages(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  sources: DeferredLightSources,
  clouds: {
    readonly cloudScene: RenderPipelineTarget | undefined;
    readonly cloudShadow: RenderPipelineTarget | undefined;
    readonly featureTargets: readonly RenderPipelineFeatureTarget[];
  },
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  targetCaptures: GraphTextureView | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const clusters = sources.clusters;
  const opaque: DeferredForwardScene = {
    color: targets.scene,
    depth: targets.depth,
    environment: sources.environment,
    receiver: standardForwardReceiverInputs({
      shadows: sources.shadows,
      cloudShadow: sources.cloudShadow,
      ssao: sources.ssao,
      clusterReads: clusters === null ? [] : standardClusterReadAccesses(clusters),
    }),
    gpuDriven,
  };
  const sceneOutput = addDeferredOpaqueForward(context, topology, opaque, clouds);
  if (!sceneOutput.ok) return sceneOutput;
  const forward: DeferredForwardScene = { ...opaque, color: sceneOutput.value };
  const translucent = addDeferredTranslucency(
    context,
    topology,
    forward,
    standardTransmissionRoute(topology, targets.scene.sampleCount),
    targets.medium,
    targetCaptures,
  );
  if (!translucent.ok) return translucent;
  const observed = addDeferredSceneObservations(
    context,
    topology,
    forward,
    sources,
    targets.reflection.fallback,
  );
  if (!observed.ok) return observed;
  return sceneOutput;
}

export function buildStandardDeferredLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const visibleSurfaceEnabled = topology.standardProfile?.visibleSurface === true;
  const capabilityError = deferredLaneCapabilityError(topology, visibleSurfaceEnabled);
  if (capabilityError !== undefined) return err(capabilityError);
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize = renderInternalSize(topology);
  const internalCopySize = renderInternalCopySize(topology);
  const clusters = importDeferredClusters(graph, lighting);
  if (!clusters.ok) return clusters;
  const earlyShadows = addEarlyDeferredShadows(context, topology, reuseAdjacentShadow);
  if (!earlyShadows.ok) return earlyShadows;
  const targets = declareDeferredSceneTargets(graph, topology, internalSize, visibleSurfaceEnabled);
  if (!targets.ok) return targets;
  const { scene, depth } = targets.value;
  const temporal = admitDeferredTemporal(context, topology, visibleSurfaceEnabled);
  if (!temporal.ok) return temporal;
  const gpuDriven = projectDeferredGpuDriven(context, topology, targets.value);
  if (!gpuDriven.ok) return gpuDriven;
  const clouds = declareDeferredClouds(context, scene, depth, internalSize);
  if (!clouds.ok) return clouds;
  const environment = addDeferredBackground(
    graph,
    topology,
    scene,
    earlyShadows.value?.directional?.view,
    clouds.value.cloudShadow,
  );
  if (!environment.ok) return environment;
  const depthViews = deferredDepthViews(graph, targets.value.depthSample, internalCopySize);
  const cameraPyramid = addDeferredGBufferPasses(
    graph,
    targets.value,
    temporal.value,
    gpuDriven.value,
    internalCopySize,
    depthViews,
  );
  if (!cameraPyramid.ok) return cameraPyramid;
  const shadows = addLateDeferredShadows(
    context,
    topology,
    reuseAdjacentShadow,
    earlyShadows.value,
    cameraPyramid.value,
  );
  if (!shadows.ok) return shadows;
  const surfaces = addSurfaceStage(context, topology, targets.value, internalSize);
  if (!surfaces.ok) return surfaces;
  const ssao = addDeferredSsao(graph, topology, internalCopySize, surfaces.value.normal, depth);
  if (!ssao.ok) return ssao;
  const targetCaptures = contributeDeferredCubeCaptures(context, environment.value);
  if (!targetCaptures.ok) return targetCaptures;
  const sources: DeferredLightSources = {
    shadows: shadows.value,
    cloudShadow: clouds.value.cloudShadow,
    ssao: ssao.value,
    environment: environment.value,
    clusters: clusters.value,
  };
  const lit = addDeferredLightingStage(
    graph,
    topology,
    targets.value,
    surfaces.value,
    sources,
    internalSize,
    internalCopySize,
  );
  if (!lit.ok) return lit;
  const sceneData = addSceneDataConsumers(
    context,
    targets.value,
    surfaces.value,
    temporal.value,
    gpuDriven.value,
    depthViews,
  );
  if (!sceneData.ok) return sceneData;
  const secondaryReactivity = addDeferredSsr(
    context,
    topology,
    targets.value,
    surfaces.value.normal,
    temporal.value.targets,
    internalCopySize,
    depthViews,
  );
  if (!secondaryReactivity.ok) return secondaryReactivity;
  const sceneOutput = addDeferredForwardStages(
    context,
    topology,
    targets.value,
    sources,
    clouds.value,
    gpuDriven.value,
    targetCaptures.value,
  );
  if (!sceneOutput.ok) return sceneOutput;
  return addStandardPost(
    context,
    topology,
    sceneOutput.value,
    depth,
    surface.value,
    temporal.value.targets?.temporal,
    secondaryReactivity.value,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
  );
}
