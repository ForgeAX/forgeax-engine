import {
  type GraphAccess,
  type GraphBuffer,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import { addProjectedDecalPasses } from '../decals/graph';
import { addDepthPyramidPasses, type DepthPyramidProjection } from '../depth-pyramid/graph';
import { addAtmosphereBackground } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
} from '../gpu-texture-usage';
import { addRayReceiverNormalProjection } from '../raytracing/ray-graph-shared';
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
import { getSsaoParameters, ssaoUsesLighting } from '../ssao-config';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses, type SsrSpatialGraphProjection } from '../ssr/graph';
import {
  COMPACT_DEFERRED_ATTACHMENT_BYTES,
  COMPACT_DEFERRED_COLOR_FORMATS,
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
  addDefaultDepthPrepass,
  addDefaultDepthVelocity,
  addDefaultVelocityTemporalProjection,
  createDefaultVelocityTarget,
} from '../temporal/default-gbuffer-velocity';
import {
  SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
} from '../temporal/scene-data';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  bindStandardSceneDataTarget,
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
import { addTsrOpaqueGuide } from '../tsr/opaque';
import {
  addObservationCapturePass,
  addReflectionFallbackObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
  type TemporalSecondaryReactivity,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses, type TypedShadowTargets } from '../typed-shadow-passes';
import { addWaterFluidGraph } from '../water/fluid-graph';
import { addWaterSlwPasses } from '../water/slw-graph';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import { addSsaoLinearDepthPass, type SceneColorAo } from './ssao-scene-color';
import {
  contributeStandardAfterDepthFeatures,
  resolveStandardGtaoExecution,
  type StandardPipelineBuildContext,
  standardWaterInfoGraphTargets,
  type WaterInfoGraphTargets,
} from './standard-build-context';
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
const COMPACT_RECEIVER_TARGETS = {
  channels: { label: 'deferred-lighting-channels', format: 'r32uint', bytes: 4 },
  context: { label: 'deferred-surface-context', format: 'rg32uint', bytes: 8 },
  geometry: { label: 'deferred-receiver-geometry', format: 'rgba32uint', bytes: 16 },
} as const;

function compactReceiverTarget(topology: RenderPipelineTopology) {
  if (topology.compactGbuffer === undefined) return undefined;
  // The identity writer is at location 6, after the optional receiver target.
  const receiver =
    topology.compactReceiver ??
    (topology.standardProfile?.visibleSurface === true ? 'channels' : undefined);
  return receiver === undefined ? undefined : COMPACT_RECEIVER_TARGETS[receiver];
}

function deferredLaneCapabilityError(
  topology: RenderPipelineTopology,
  visibleSurfaceEnabled: boolean,
): RenderGraphError | undefined {
  const lane = topology.lane;
  const compact = topology.compactGbuffer !== undefined;
  const receiverBytes = compactReceiverTarget(topology)?.bytes ?? 0;
  const attachmentBytes = compact
    ? COMPACT_DEFERRED_ATTACHMENT_BYTES
    : topology.subsurface === undefined
      ? DEFERRED_ATTACHMENT_BYTES
      : SUBSURFACE_ATTACHMENT_BYTES;
  const attachmentCount =
    (compact ? COMPACT_DEFERRED_COLOR_FORMATS : DEFERRED_COLOR_FORMATS).length +
    Number(receiverBytes > 0);
  const requiredSurfaceBytes = visibleSurfaceEnabled
    ? attachmentBytes.visibleSurface + receiverBytes
    : attachmentBytes.surface + receiverBytes;
  if (
    visibleSurfaceEnabled &&
    (lane.primitiveIndex !== true ||
      lane.maxColorAttachments < attachmentCount + 1 ||
      (lane.maxColorAttachmentBytesPerSample ?? 0) < requiredSurfaceBytes ||
      isMultisampleAntialias(topology.camera.antialias))
  ) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `visible surfaces require primitive-index, ${attachmentCount + 1} targets, ${requiredSurfaceBytes} attachment bytes and single sampling`,
      hint: 'request these device features/limits before enabling visibleSurface',
      detail: {
        resourceLabel: 'visible-surface',
        field: 'capabilities',
        expected: `primitive-index / ${attachmentCount + 1} targets / ${requiredSurfaceBytes} bytes / single sample`,
        actual: JSON.stringify(lane),
      },
    });
  }
  if (!lane.storageBuffer || lane.maxColorAttachments < attachmentCount) {
    return new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `Standard deferred requires storage buffers and ${attachmentCount} color attachments`,
      hint: 'select a device with deferred capabilities or explicitly select the Forward profile',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'renderPath',
        expected: `storage buffers and ${attachmentCount} MRTs`,
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
  readonly dielectricSpecular: RenderPipelineTarget;
  readonly lightingContext: RenderPipelineTarget;
  readonly receiverGeometry: RenderPipelineTarget | undefined;
  readonly compactGbuffer: RenderPipelineTopology['compactGbuffer'];
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
  const compactGbuffer = topology.compactGbuffer;
  const formats =
    compactGbuffer !== undefined
      ? COMPACT_DEFERRED_COLOR_FORMATS
      : topology.subsurface === undefined
        ? DEFERRED_COLOR_FORMATS
        : SUBSURFACE_DEFERRED_COLOR_FORMATS;
  const depth = target(graph, 'hdrp-depth', { format: 'depth32float-stencil8', size });
  if (!depth.ok) return depth;
  const depthSample = graph.view(depth.value.texture, {
    label: 'ssr-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const compact = compactGbuffer !== undefined;
  const normalRoughness = target(graph, compact ? 'gbuffer-a' : 'gbuffer-normal-roughness', {
    format: formats[1],
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!normalRoughness.ok) return normalRoughness;
  const albedoMetallic = target(graph, compact ? 'gbuffer-c' : 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[3],
    size,
  });
  if (!albedoMetallic.ok) return albedoMetallic;
  const dielectricSpecular = target(graph, compact ? 'gbuffer-b' : 'gbuffer-dielectric-specular', {
    format: DEFERRED_COLOR_FORMATS[2],
    size,
  });
  if (!dielectricSpecular.ok) return dielectricSpecular;
  const lightingContext = target(graph, compact ? 'gbuffer-d' : 'gbuffer-lighting-context', {
    format: formats[4],
    size,
  });
  if (!lightingContext.ok) return lightingContext;
  const compactReceiver = compactReceiverTarget(topology);
  const receiverGeometry =
    compactGbuffer === undefined
      ? target(graph, 'gbuffer-receiver-geometry', { format: DEFERRED_COLOR_FORMATS[5], size })
      : compactReceiver === undefined
        ? ok(undefined)
        : target(graph, compactReceiver.label, { format: compactReceiver.format, size });
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
    dielectricSpecular: dielectricSpecular.value,
    lightingContext: lightingContext.value,
    receiverGeometry: receiverGeometry.value,
    compactGbuffer,
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

interface DeferredTemporal {
  readonly targets: StandardSceneDataTargets | undefined;
  readonly inGBuffer: boolean;
  readonly velocity?: RenderPipelineTarget;
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
): Result<DeferredTemporal, RenderPipelineBuildError> {
  const lane = topology.lane;
  const demand = aggregateTemporalDemand({
    taa: isTemporalAntialias(topology.camera.antialias),
    motionBlur: topology.temporal?.motionBlur === true,
    ssr: topology.ssr?.status === 'admitted',
    visibleSurface: visibleSurfaceEnabled,
    diffuseGi: topology.standardProfile?.diffuseGi !== undefined,
  });
  const admission = requireStandardTemporalLane({
    demand,
    compute: lane.compute,
    storageBuffer: lane.storageBuffer,
    rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
  });
  if (!admission.ok) return admission;
  if (demand.targetCount !== 1) return ok({ targets: undefined, inGBuffer: false });
  if (topology.compactGbuffer !== undefined) {
    const velocity = createDefaultVelocityTarget(context.graph, renderInternalSize(topology));
    return velocity.ok
      ? ok({ targets: undefined, inGBuffer: false, velocity: velocity.value })
      : velocity;
  }
  const temporal = createStandardSceneDataTarget(context.graph, topology.extent);
  if (!temporal.ok) return temporal;
  const attachmentBytes =
    topology.subsurface === undefined ? DEFERRED_ATTACHMENT_BYTES : SUBSURFACE_ATTACHMENT_BYTES;
  const attachmentCount = DEFERRED_COLOR_FORMATS.length;
  const inGBuffer =
    lane.maxColorAttachments >= attachmentCount + 1 + Number(visibleSurfaceEnabled) &&
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
  const fluid = topology.water === true ? addWaterFluidGraph(context) : undefined;
  if (fluid !== undefined && !fluid.ok) return fluid;
  return addTypedShadowPasses(context.graph, topology, {
    waterInfoTargets: standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
    ...(fluid?.ok === true ? { surfaceFluidSimulation: fluid.value } : {}),
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
  const waterInfo = context.contributeFeatures({
    targets: featureTargets.value,
    placement: 'scene',
    include: ['water-info-producer', 'water-gpu-mesh', 'water-advanced-producer'],
  });
  if (!waterInfo.ok) return waterInfo;
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
  if (topology.atmosphere === true && topology.atmosphereBackgroundOnly === true) {
    return addAtmosphereBackground(graph, scene, {}, { mode: 'sky' });
  }
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
    targets.dielectricSpecular,
    targets.albedoMetallic,
    targets.lightingContext,
    ...(targets.receiverGeometry === undefined ? [] : [targets.receiverGeometry]),
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
  waterInfoTargets: WaterInfoGraphTargets,
  waterInputs: readonly GraphAccess[] = [],
  prepass = false,
  materialSceneDepth?: boolean,
  primed = false,
): Result<void, RenderGraphError> {
  const colorTargets = gbufferColorTargets(targets, temporal, temporalInGBuffer);
  return addTypedScenePass(graph, {
    materialSceneDepth,
    name: prepass ? 'main-depth-deferred' : 'g-buffer',
    color: targets.scene,
    colorTargets,
    colorLoadOp: colorTargets.map((_, index) => (index === 0 ? 'load' : 'clear')),
    colorClearValues: colorTargets.map((_, index) =>
      temporalInGBuffer && index === colorTargets.length - 1 ? [0, 0, -1, 1] : [0, 0, 0, 0],
    ),
    gpuDrivenFilter: 'deferred-opaque',
    ...(gpuDriven === undefined || prepass ? {} : { gpuDriven }),
    ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    depth: targets.depth,
    ...(primed || (!prepass && waterInputs.length !== 0)
      ? { depthLoadOp: 'load' as const, opaqueDepthPrimed: true, extraAccesses: waterInputs }
      : {}),
    selector: DEFERRED_PASS_SELECTOR,
    // The G-buffer only admits opaque Standard materials. Medium Surface
    // programs have no Deferred entry and acquire raw depth in their later
    // paired color pass; filtering here also avoids assembling their bind
    // groups before that producer exists.
    recordMode: prepass ? 'opaque-depth' : 'opaque',
    passKind: 'deferred',
    ...(targets.compactGbuffer === undefined ? {} : { fragmentEntryPoint: 'fs_gbuffer_compact' }),
    clearColor: [0, 0, 0, 0],
  });
}

function addLateGBufferPass(
  graph: Graph,
  targets: DeferredSceneTargets,
  temporal: StandardSceneDataTargets | undefined,
  temporalInGBuffer: boolean,
  gpuDriven: RenderPipelineGpuDrivenProjection,
  waterInfoTargets: WaterInfoGraphTargets,
  waterInputs: readonly GraphAccess[] = [],
  materialSceneDepth?: boolean,
  primed = false,
): Result<void, RenderGraphError> {
  const colorTargets = gbufferColorTargets(targets, temporal, temporalInGBuffer);
  return addTypedScenePass(graph, {
    materialSceneDepth,
    name: 'g-buffer-late',
    color: targets.scene,
    colorTargets,
    colorLoadOp: colorTargets.map(() => 'load'),
    depthLoadOp: 'load',
    extraAccesses: waterInputs,
    opaqueDepthPrimed: primed || waterInputs.length !== 0,
    gpuDriven,
    ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    gpuDrivenFilter: 'deferred-opaque',
    gpuDrivenPhase: 'late',
    depth: targets.depth,
    selector: DEFERRED_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'deferred',
    ...(targets.compactGbuffer === undefined ? {} : { fragmentEntryPoint: 'fs_gbuffer_compact' }),
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
    f0: targets.dielectricSpecular,
    ...(targets.compactGbuffer === undefined ? {} : { compactGbuffer: true }),
    size,
  });
  if (!decals.ok) return decals;
  const hasRayConsumers =
    context.contributeDiffuseGi !== undefined ||
    (context.contributeProbePlacement !== undefined && targets.visibleSurface !== undefined);
  const rayNormal =
    targets.compactGbuffer === undefined || !hasRayConsumers
      ? ok(decals.value.normal)
      : addRayReceiverNormalProjection(graph, decals.value.normal.view, decals.value.f0.view, size);
  if (!rayNormal.ok) return rayNormal;
  if (context.contributeProbePlacement !== undefined && targets.visibleSurface !== undefined) {
    const placed = context.contributeProbePlacement({
      depth: targets.depthSample,
      normal: rayNormal.value,
      identity: targets.visibleSurface,
    });
    if (!placed.ok) return placed;
  }
  return ok({ ...decals.value, rayNormal: rayNormal.value });
}

function addDeferredSsao(
  graph: Graph,
  topology: RenderPipelineTopology,
  copySize: CopySize,
  normal: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  executionOverride: StandardPipelineBuildContext['gtaoExecutionOverride'],
): Result<SceneColorAo | undefined, RenderGraphError> {
  if (topology.config?.ambientOcclusion?.enabled !== true) return ok(undefined);
  const parameters = getSsaoParameters(topology.config.ambientOcclusion);
  const depthNormals = topology.compactGbuffer !== undefined && parameters.method === 'gtao';
  const execution = resolveStandardGtaoExecution(
    parameters.method,
    topology.lane.compute && !depthNormals,
    executionOverride,
  );
  if (!execution.ok) return execution;
  const size = {
    width: Math.max(1, Math.round(copySize.width * parameters.resolutionScale)),
    height: Math.max(1, Math.round(copySize.height * parameters.resolutionScale)),
  };
  const raw = target(graph, 'ssao-raw', {
    format: parameters.method === 'spiral-ssao' ? 'r8unorm' : 'rgba8unorm',
    size,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      (execution.value === 'compute' ? GPU_TEXTURE_USAGE_STORAGE_BINDING : 0),
  });
  if (!raw.ok) return raw;
  const blurred = target(graph, 'ssao-blurred', {
    format: 'r8unorm',
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!blurred.ok) return blurred;
  let horizontal: RenderPipelineTarget | undefined;
  if (parameters.method === 'spiral-ssao') {
    const intermediate = target(graph, 'ssao-horizontal', {
      format: 'r8unorm',
      size: size,
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
    });
    if (!intermediate.ok) return intermediate;
    horizontal = intermediate.value;
  }
  const linear =
    parameters.method === 'spiral-ssao'
      ? addSsaoLinearDepthPass(graph, depth, size)
      : ok(undefined);
  if (!linear.ok) return linear;
  const passes = addTypedSsaoPasses(graph, {
    normal: depthNormals ? undefined : normal,
    depth,
    raw: raw.value,
    blurred: blurred.value,
    execution: execution.value,
    horizontal,
    gbufferNormalLayout: topology.compactGbuffer ?? 'standard-gbuffer/2',
    ...linear.value,
  });
  if (!passes.ok) return passes;
  return ok({ ao: blurred.value, depth, ...linear.value });
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
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const subsurfaceDiffuse =
    topology.subsurface === undefined
      ? ok(undefined)
      : target(graph, 'subsurface-diffuse', { format: 'rgba16float', size });
  if (!subsurfaceDiffuse.ok) return subsurfaceDiffuse;
  const { shadows, cloudShadow, ssao, environment, clusters } = sources;
  const reflection = targets.reflection;
  const lightingPass = addStandardDeferredLighting(graph, {
    color: targets.scene,
    localProbes: topology.reflectionFallback?.localProbes === true,
    ...(subsurfaceDiffuse.value === undefined ? {} : { diffuse: subsurfaceDiffuse.value }),
    gbuffer: [surfaces.normal, surfaces.albedo, surfaces.f0, targets.lightingContext],
    ...(targets.receiverGeometry === undefined
      ? {}
      : { receiverGeometry: targets.receiverGeometry }),
    ...(targets.compactGbuffer === undefined ? {} : { compactGbuffer: targets.compactGbuffer }),
    projectedDirectionalPcf:
      topology.standardProfile?.deferredDirectionalShadowReceiver === 'projected' ||
      (targets.compactGbuffer !== undefined && topology.compactReceiver !== 'geometry'),
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
  return lightingPass.ok ? subsurfaceDiffuse : lightingPass;
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
  surfaces: DeferredSurfaceGBuffer & { readonly rayNormal: RenderPipelineTarget },
  temporal: DeferredTemporal,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  depthViews: DeferredDepthViews,
  subsurfaceDiffuse: RenderPipelineTarget | undefined,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const reflection = targets.reflection;
  const temporalTargets = temporal.targets;
  if (temporalTargets !== undefined && temporal.velocity === undefined) {
    const producer = addStandardSceneDataPass(
      graph,
      temporalTargets.temporal,
      targets.depth,
      gpuDriven,
      temporal.inGBuffer ? 'forward-only-opaque' : 'opaque',
      waterInfoTargets,
      context.getWaterMeshGraphAccesses?.(),
    );
    if (!producer.ok) return producer;
  }
  if (context.contributeDiffuseGi !== undefined && temporalTargets !== undefined) {
    const diffuse = context.contributeDiffuseGi({
      scene: targets.scene,
      depth: targets.depthSample,
      normal: surfaces.rayNormal,
      albedo: surfaces.albedo,
      ...(targets.compactGbuffer === undefined ? {} : { compactGbuffer: true }),
      ...(subsurfaceDiffuse === undefined ? {} : { subsurfaceDiffuse }),
      f0: surfaces.f0,
      ...(targets.visibleSurface === undefined ? {} : { identity: targets.visibleSurface }),
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
  return addTargetCoveragePass(graph, context.targetCoverage, gpuDriven, waterInfoTargets);
}

/** Screen-space reflections; returns the secondary reactivity TAA consumes, if produced. */
function addDeferredSsr(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  normal: RenderPipelineTarget,
  temporal: DeferredTemporal,
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
  const currentTemporal = temporal.targets?.temporal.view;
  const spatial = addSsrSpatialPasses(context.graph, {
    quality: topology.standardProfile?.quality?.ssr,
    admission: ssr,
    execution: topology.lane.compute ? 'compute' : 'fragment',
    width: copySize.width,
    height: copySize.height,
    depth: targets.depthSample,
    normal: normal.view,
    gbufferV2: true,
    ...(targets.compactGbuffer === undefined
      ? {}
      : { compactMaterial: targets.dielectricSpecular.view }),
    scene: targets.scene.view,
    ...(currentTemporal === undefined ? {} : { currentTemporal }),
    ...(fallback === undefined ? {} : { fallback: fallback.view }),
    ...(currentTemporal === undefined || history === undefined
      ? {}
      : {
          temporal: {
            profile: 'opaque',
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
  return composeDeferredSsr(
    context.graph,
    targets,
    normal,
    spatial.value,
    ssrView.value,
    topology.lane.compute ? 'compute' : 'fragment',
  );
}

/** Composite traced radiance over the reflection fallback once every input exists. */
function composeDeferredSsr(
  graph: Graph,
  targets: DeferredSceneTargets,
  normal: RenderPipelineTarget,
  spatial: SsrSpatialGraphProjection,
  view: GraphBuffer | undefined,
  execution: 'compute' | 'fragment',
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
    execution,
    mipLevelCount: resources.mipLevelCount ?? 1,
    scene: targets.scene,
    radiance: resources.radiancePyramid ?? resources.trace.view,
    fallback: fallback.view,
    response: response.view,
    normal: normal.view,
    gbufferV2: true,
    ...(targets.compactGbuffer === undefined
      ? {}
      : { compactMaterial: targets.dielectricSpecular.view }),
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
  readonly temporal?: RenderPipelineTarget;
  readonly color: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly environment: GraphEnvironment | undefined;
  readonly receiver: StandardForwardReceiverInputs & {
    readonly waterInfoTargets?: WaterInfoGraphTargets;
  };
  readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
  readonly sceneDataTargets: readonly RenderPipelineTarget[];
  readonly depthPrimed?: boolean;
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
  // These surfaces are absent from the GBuffer; its AO describes the geometry
  // behind them. Keep their own Forward lighting independent of that AO.
  const { ssao, ...opaqueReceiver } = receiver;
  const pass = addTypedScenePass(graph, {
    environment,
    name: 'forward',
    opaqueDepthPrimed:
      forward.depthPrimed === true || (context.getWaterMeshGraphAccesses?.().length ?? 0) !== 0,
    color,
    depth,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    ...opaqueReceiver,
    sampled: receiver.sampled.filter((target) => target !== ssao),
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
    renderInternalSize(topology),
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
    ...(forward.temporal === undefined ? {} : { temporal: forward.temporal }),
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
function addDeferredMaterialTranslucency(
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

/** UE partitions the existing translucency queue by view immersion, not by fragment. */
function addDeferredTranslucency(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  route: ReturnType<typeof standardTransmissionRoute>,
  mediumTargets: SingleLayerMediumNearestTargets | undefined,
  targetCaptures: GraphTextureView | undefined,
  water: {
    readonly temporal: StandardSceneDataTargets | undefined;
    readonly depthViews: DeferredDepthViews;
  },
): Result<GraphTextureView | undefined, RenderPipelineBuildError> {
  const translucent = (scene: DeferredForwardScene) =>
    addDeferredMaterialTranslucency(context, topology, scene, route, mediumTargets, targetCaptures);
  if (topology.water !== true) {
    const transparent = translucent(forward);
    return transparent.ok ? ok(undefined) : transparent;
  }
  const view = water.depthViews.sceneView();
  if (!view.ok) return view;
  const underwater = topology.waterView?.kind === 'available' && topology.waterView.underwater;
  const size = renderInternalCopySize(topology);
  const slw = addWaterSlwPasses({
    graph: context.graph,
    topology,
    context,
    color: forward.color,
    depth: forward.depth,
    ...(water.temporal === undefined ? {} : { opaqueTemporal: water.temporal.temporal }),
    receiver: forward.receiver,
    view: view.value,
    foamSimulation: { kind: 'no-simulation' },
    width: size.width,
    height: size.height,
    ...(underwater ? { beforeSceneColorCopy: () => translucent(forward) } : {}),
  });
  if (!slw.ok) return slw;
  if (!underwater) {
    const transparent = translucent({ ...forward, depth: slw.value.depth });
    if (!transparent.ok) return transparent;
  }
  return ok(slw.value.foamSimulation);
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
    forward.sceneDataTargets,
  );
  if (!features.ok) return features;
  if (reflectionFallback?.sampleCount !== 1) return ok(undefined);
  return addReflectionFallbackObservationPass(graph, reflectionFallback);
}

/** Lazily imported scene view and the one closest-depth pyramid SSR and diffuse GI share. */
interface DeferredDepthViews {
  readonly nativeInputs: StandardPipelineBuildContext['nativeInputs'];
  readonly sceneView: () => Result<GraphBuffer, RenderGraphError>;
  readonly closestPyramid: () => Result<DepthPyramidProjection, RenderGraphError>;
}

function deferredDepthViews(
  graph: Graph,
  depthSample: GraphTextureView,
  copySize: CopySize,
  execution: 'compute' | 'fragment',
  nativeInputs: StandardPipelineBuildContext['nativeInputs'],
): DeferredDepthViews {
  const sceneView = sceneViewImport(graph);
  // One closest-depth pyramid per view, built only when SSR or a diffuse GI
  // gather actually reads it.
  let closestPyramid: Result<DepthPyramidProjection, RenderGraphError> | undefined;
  return {
    nativeInputs,
    sceneView,
    closestPyramid: () => {
      if (closestPyramid !== undefined) return closestPyramid;
      const view = sceneView();
      if (!view.ok) return view;
      closestPyramid = addDepthPyramidPasses(graph, {
        nativeInputs,
        depth: depthSample,
        execution,
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
    lateOcclusion: topology.opaque.lateOcclusion,
    ...(fallback === undefined ? {} : { additionalColorFormats: [fallback.format] }),
  });
}

/** Early G-buffer, GPU late occlusion and its late G-buffer; returns the late camera pyramid. */
function addDeferredGBufferPasses(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  temporal: DeferredTemporal,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: CopySize,
  depthViews: DeferredDepthViews,
  waterInfoTargets: WaterInfoGraphTargets,
  materialSceneDepth: boolean | undefined,
): Result<GraphTextureView | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInputs = context.getWaterMeshGraphAccesses?.() ?? [];
  if (temporal.velocity !== undefined) {
    const prepass = addDefaultDepthPrepass(graph, targets.depth);
    if (!prepass.ok) return prepass;
    const velocity = addDefaultDepthVelocity(graph, targets.depth, temporal.velocity, gpuDriven);
    if (!velocity.ok) return velocity;
    const late = addGpuLateOcclusion(graph, {
      gpuDriven,
      depth: targets.depthSample,
      multisampled: false,
      width: copySize.width,
      height: copySize.height,
      view: depthViews.sceneView,
    });
    if (!late.ok) return late;
    if (late.value !== undefined && gpuDriven !== undefined) {
      const velocityLate = addDefaultDepthVelocity(
        graph,
        targets.depth,
        temporal.velocity,
        gpuDriven,
        true,
      );
      if (!velocityLate.ok) return velocityLate;
    }
    const base = addEarlyGBufferPass(
      graph,
      targets,
      undefined,
      false,
      gpuDriven,
      waterInfoTargets,
      waterInputs,
      false,
      materialSceneDepth,
      true,
    );
    if (!base.ok || late.value === undefined || gpuDriven === undefined)
      return base.ok ? late : base;
    const baseLate = addLateGBufferPass(
      graph,
      targets,
      undefined,
      false,
      gpuDriven,
      waterInfoTargets,
      waterInputs,
      materialSceneDepth,
      true,
    );
    return baseLate.ok ? late : baseLate;
  }
  if (waterInputs.length > 0) {
    const deferredDepth = addEarlyGBufferPass(
      graph,
      targets,
      temporal.targets,
      temporal.inGBuffer,
      undefined,
      waterInfoTargets,
      [],
      true,
      materialSceneDepth,
    );
    if (!deferredDepth.ok) return deferredDepth;
    const forwardDepth = addTypedScenePass(graph, {
      materialSceneDepth,
      name: 'main-depth-forward',
      color: targets.scene,
      depth: targets.depth,
      selector: FORWARD_PASS_SELECTOR,
      excludeSelector: DEFERRED_PASS_SELECTOR,
      recordMode: 'opaque-depth',
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    });
    if (!forwardDepth.ok) return forwardDepth;
    const afterDepth = contributeStandardAfterDepthFeatures(context, targets.scene, targets.depth);
    if (!afterDepth.ok) return afterDepth;
  }
  const early = addEarlyGBufferPass(
    graph,
    targets,
    temporal.targets,
    temporal.inGBuffer,
    gpuDriven,
    waterInfoTargets,
    waterInputs,
    false,
    materialSceneDepth,
  );
  if (!early.ok) return early;
  const late = addGpuLateOcclusion(graph, {
    nativeInputs: depthViews.nativeInputs,
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
    waterInfoTargets,
    waterInputs,
    materialSceneDepth,
  );
  if (!latePass.ok) return latePass;
  return late;
}

function contributeDeferredCubeCaptures(
  context: StandardPipelineBuildContext,
  environment: GraphEnvironment | undefined,
  shadows: TypedShadowTargets,
): Result<GraphTextureView | undefined, RenderPipelineBuildError> {
  if (context.contributeCubeCaptures === undefined) return ok(undefined);
  return context.contributeCubeCaptures(environment, shadows);
}

/** Forward writers, translucency and scene observations retain their produced graph inputs. */
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
  temporal: DeferredTemporal,
  depthViews: DeferredDepthViews,
): Result<
  {
    readonly color: RenderPipelineTarget;
    readonly waterFoamSimulation: GraphTextureView | undefined;
  },
  RenderPipelineBuildError
> {
  const clusters = sources.clusters;
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const opaque: DeferredForwardScene = {
    depthPrimed: temporal.velocity !== undefined,
    color: targets.scene,
    depth: targets.depth,
    environment: sources.environment,
    receiver: {
      ...standardForwardReceiverInputs({
        materialSceneDepth: topology.materialSceneDepth,
        shadows: sources.shadows,
        cloudShadow: sources.cloudShadow,
        ssao: sources.ssao,
        planarReflection: targetCaptures,
        clusterReads: clusters === null ? [] : standardClusterReadAccesses(clusters),
      }),
      extraAccesses: [
        ...(clusters === null ? [] : standardClusterReadAccesses(clusters)),
        ...(context.getWaterMeshGraphAccesses?.() ?? []),
      ],
      ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    },
    gpuDriven,
    sceneDataTargets: [
      bindStandardSceneDataTarget(
        targets.normalRoughness,
        topology,
        SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
      ),
      bindStandardSceneDataTarget(
        targets.depth,
        topology,
        SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      ),
    ],
  };
  const sceneOutput = addDeferredOpaqueForward(context, topology, opaque, clouds);
  if (!sceneOutput.ok) return sceneOutput;
  const forward: DeferredForwardScene = {
    ...opaque,
    color: sceneOutput.value,
    ...(temporal.targets === undefined ? {} : { temporal: temporal.targets.temporal }),
  };
  const translucent = addDeferredTranslucency(
    context,
    topology,
    forward,
    standardTransmissionRoute(topology, targets.scene.sampleCount),
    targets.medium,
    targetCaptures,
    { temporal: temporal.targets, depthViews },
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
  return ok({ color: sceneOutput.value, waterFoamSimulation: translucent.value });
}

function addDeferredTemporalInputs(...inputs: Parameters<typeof addDeferredSsr>) {
  const [context, topology, targets] = inputs;
  const opaqueGuide = addTsrOpaqueGuide(context.graph, topology, targets.scene);
  if (!opaqueGuide.ok) return opaqueGuide;
  const secondaryReactivity = addDeferredSsr(...inputs);
  if (!secondaryReactivity.ok) return secondaryReactivity;
  return ok({ opaqueGuide: opaqueGuide.value, secondaryReactivity: secondaryReactivity.value });
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
  const environmentFeatures = context.contributeFeatures({
    targets: [],
    namedTargets: {},
    passNames: [],
    placement: 'environment',
  });
  if (!environmentFeatures.ok) return environmentFeatures;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize = renderInternalSize(topology);
  const internalCopySize = renderInternalCopySize(topology);
  const clusters = importDeferredClusters(graph, lighting);
  if (!clusters.ok) return clusters;
  const targets = declareDeferredSceneTargets(graph, topology, internalSize, visibleSurfaceEnabled);
  if (!targets.ok) return targets;
  const { scene, depth } = targets.value;
  const temporal = admitDeferredTemporal(context, topology, visibleSurfaceEnabled);
  if (!temporal.ok) return temporal;
  const gpuDriven = projectDeferredGpuDriven(context, topology, targets.value);
  if (!gpuDriven.ok) return gpuDriven;
  const clouds = declareDeferredClouds(context, scene, depth, internalSize);
  if (!clouds.ok) return clouds;
  const earlyShadows = addEarlyDeferredShadows(context, topology, reuseAdjacentShadow);
  if (!earlyShadows.ok) return earlyShadows;
  const environment = addDeferredBackground(
    graph,
    topology,
    scene,
    earlyShadows.value?.directional?.view,
    clouds.value.cloudShadow,
  );
  if (!environment.ok) return environment;
  const depthViews = deferredDepthViews(
    graph,
    targets.value.depthSample,
    internalCopySize,
    topology.lane.compute ? 'compute' : 'fragment',
    context.nativeInputs,
  );
  const cameraPyramid = addDeferredGBufferPasses(
    context,
    targets.value,
    temporal.value,
    gpuDriven.value,
    internalCopySize,
    depthViews,
    standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
    topology.materialSceneDepth,
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
  const buildDeferredLightingAndPostStages = () => {
    const ssao = addDeferredSsao(
      graph,
      topology,
      internalCopySize,
      surfaces.value.normal,
      depth,
      context.gtaoExecutionOverride,
    );
    if (!ssao.ok) return ssao;
    const targetCaptures = contributeDeferredCubeCaptures(
      context,
      environment.value,
      shadows.value,
    );
    if (!targetCaptures.ok) return targetCaptures;
    const sources: DeferredLightSources = {
      shadows: shadows.value,
      cloudShadow: clouds.value.cloudShadow,
      ssao: ssaoUsesLighting(topology.config?.ambientOcclusion) ? ssao.value?.ao : undefined,
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
    const velocity = temporal.value.velocity;
    const usePackedTemporal =
      velocity !== undefined &&
      (topology.ssr?.status === 'admitted' ||
        topology.water === true ||
        topology.singleLayerMedium === true ||
        context.contributeDiffuseGi !== undefined);
    const reconstructionView = usePackedTemporal ? depthViews.sceneView() : ok(undefined);
    if (!reconstructionView.ok) return reconstructionView;
    const projected =
      velocity === undefined || reconstructionView.value === undefined
        ? ok(undefined)
        : addDefaultVelocityTemporalProjection(
            graph,
            velocity,
            { depth: targets.value.depthSample, view: reconstructionView.value },
            internalCopySize,
          );
    if (!projected.ok) return projected;
    const mediumTemporal =
      projected.value === undefined
        ? temporal.value
        : { ...temporal.value, targets: { temporal: projected.value } };
    const sceneData = addSceneDataConsumers(
      context,
      targets.value,
      surfaces.value,
      mediumTemporal,
      gpuDriven.value,
      depthViews,
      lit.value,
    );
    if (!sceneData.ok) return sceneData;
    if (lit.value !== undefined && topology.subsurface !== undefined) {
      const subsurface = addSubsurfaceDiffusion(graph, {
        scene: targets.value.scene,
        diffuse: lit.value,
        profiles: targets.value.lightingContext.view,
        normal: surfaces.value.normal.view,
        depth: targets.value.depthSample,
        size: internalCopySize,
        scale: [
          internalCopySize.width / (topology.extent?.outputWidth ?? topology.surface.width),
          internalCopySize.height / (topology.extent?.outputHeight ?? topology.surface.height),
        ],
        quality: topology.subsurface.quality,
        ...(targets.value.compactGbuffer === undefined ? {} : { compact: true }),
      });
      if (!subsurface.ok) return subsurface;
    }
    const temporalInputs = addDeferredTemporalInputs(
      context,
      topology,
      { ...targets.value, dielectricSpecular: surfaces.value.f0 },
      surfaces.value.normal,
      mediumTemporal,
      internalCopySize,
      depthViews,
    );
    if (!temporalInputs.ok) return temporalInputs;
    const sceneOutput = addDeferredForwardStages(
      context,
      topology,
      targets.value,
      sources,
      clouds.value,
      gpuDriven.value,
      targetCaptures.value,
      mediumTemporal,
      depthViews,
    );
    if (!sceneOutput.ok) return sceneOutput;
    const postVelocity =
      topology.water === true || topology.singleLayerMedium === true ? undefined : velocity;
    const velocityView = postVelocity === undefined ? ok(undefined) : depthViews.sceneView();
    if (!velocityView.ok) return velocityView;
    return addStandardPost(
      context,
      topology,
      sceneOutput.value.color,
      depth,
      surface.value,
      postVelocity ?? mediumTemporal.targets?.temporal,
      temporalInputs.value.secondaryReactivity,
      context.targetCoverage?.coverage,
      context.targetCoverage?.depth,
      temporalInputs.value.opaqueGuide,
      standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
      gpuDriven.value,
      sceneOutput.value.waterFoamSimulation,
      ssao.value,
      velocityView.value === undefined
        ? undefined
        : { depth: targets.value.depthSample, view: velocityView.value },
    );
  };
  return buildDeferredLightingAndPostStages();
}
