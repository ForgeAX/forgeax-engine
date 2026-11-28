import {
  type GraphAccess,
  type GraphBuffer,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import { addProjectedDecalPasses } from '../decals/graph';
import { addDepthPyramidPasses, type DepthPyramidProjection } from '../depth-pyramid/graph';
import { addStandardAtmosphere } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { addRayReceiverNormalProjection } from '../raytracing/ray-graph-shared';
import { currentGpuRaster } from '../record/current-gpu-raster';
import { currentOutputDither, type DisplayPorts } from '../record/display-ports';
import type { RenderFrameState } from '../record/frame-snapshot';
import { addCurrentReflectionProbeFilters } from '../record/reflection-probe-pmrem';
import { SceneColorDraws } from '../record/scene-color-draws';
import type {
  RenderPipeline,
  RenderPipelineBuildError,
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
import type { ShadowDepthLayers } from '../shadow-depth-layers';
import { ssaoUsesLighting } from '../ssao-config';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses, type SsrSpatialGraphProjection } from '../ssr/graph';
import { addSsrHitColor } from '../ssr/hit-color';
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
import { addTransmissionBackdropPasses, standardTransmissionRoute } from '../transmission/backdrop';
import type { TransmissionDemand } from '../transmission/projection';
import { addTsrOpaqueGuide } from '../tsr/opaque';
import {
  addObservationCapturePass,
  addReflectionFallbackObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  type TemporalSecondaryReactivity,
} from '../typed-render-graph-primitives';
import {
  addPlanarReflectionPass,
  addTypedShadowPasses,
  currentShadowViews,
  type TypedShadowTargets,
} from '../typed-shadow-passes';
import { addWaterFluidGraph } from '../water/fluid-graph';
import { addWaterSlwPasses } from '../water/slw-graph';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  declareSingleLayerMediumTargets,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import {
  contributeStandardAfterDepthFeatures,
  prepareStandardWaterView,
  type StandardPipelineBuildContext,
  standardWaterInfoGraphTargets,
  type WaterInfoGraphTargets,
} from './standard-build-context';
import {
  contributeStandardCloudComposite,
  declareOrderedCloudPhase,
  declareStandardCloudPhase,
  type StandardCloudPhase,
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
import {
  addStandardDebugOutputPost,
  addStandardPost,
  contributeStandardSceneFeatures,
  type OrderedStandardPostInputs,
} from './standard-post';
import { standardTopology } from './standard-profile';
import { addStandardScreenGtao } from './standard-screen-gtao';
import { addStandardScreenSsao } from './standard-screen-ssao';
import {
  addCurrentStandardTranslucency,
  addStandardTransparentPasses,
} from './standard-transparency';
import { type ReadViewHzb, standardAoHzbLevels, viewHzb } from './standard-view-hzb';

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
  readonly composeReflection?: true;
  readonly fallback: RenderPipelineTarget | undefined;
  readonly response: RenderPipelineTarget | undefined;
}

function declareDeferredSceneTargets(
  graph: Graph,
  topology: RenderPipelineTopology,
  size: InternalSize,
  visibleSurfaceEnabled: boolean,
  currentMaterialDepth?: boolean,
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
      ? declareSingleLayerMediumTargets(graph, size, 1)
      : ok(undefined);
  if (!medium.ok) return medium;
  const reflection = declareReflectionTargets(graph, topology, size);
  if (!reflection.ok) return reflection;
  return ok({
    depth: currentMaterialDepth
      ? { ...depth.value, currentMaterialDepthExtent: renderInternalCopySize(topology) }
      : depth.value,
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

function declareReflectionTargets(
  graph: Graph,
  topology: RenderPipelineTopology,
  size: InternalSize,
): Result<DeferredReflectionTargets, RenderGraphError> {
  const diffuseGi = topology.standardProfile?.diffuseGi;
  const required =
    topology.reflectionFallback?.enabled === true ||
    topology.ssr?.status === 'admitted' ||
    diffuseGi?.gather === 'screen-probe' ||
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
  return ok({
    fallback: fallback.value,
    response: response.value,
    ...(topology.ssr?.status === 'admitted' ? { composeReflection: true as const } : {}),
  });
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
    gtao:
      ssaoUsesLighting(topology.config?.ambientOcclusion) &&
      topology.config?.ambientOcclusion?.method === 'gtao' &&
      topology.config.ambientOcclusion.gtao?.temporalFilter !== false,
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
    const velocity = createDefaultVelocityTarget(
      context.graph,
      renderInternalSize(topology),
      topology.standardProfile?.diffuseGi?.gather === 'screen-probe' &&
        topology.standardProfile.diffuseGi.probes.integration === 'screen-space',
    );
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
    currentViews: context.currentShadowViews,
    currentReceiverDepth: context.currentShadowReceiverDepth,
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
  const clouds = declareStandardCloudPhase(
    context,
    scene,
    depth,
    {
      size,
      domain: 'linear-hdr',
    },
    true,
  );
  if (!clouds.ok) return clouds;
  const waterInfo = context.contributeFeatures({
    targets: clouds.value.featureTargets,
    placement: 'scene',
    include: ['water-info-producer', 'water-gpu-mesh', 'water-advanced-producer'],
  });
  if (!waterInfo.ok) return waterInfo;
  return clouds;
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
    return addStandardAtmosphere(graph, topology, scene, { directional, cloud: cloudShadow?.view });
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
  clearSceneColor = false,
): Result<void, RenderGraphError> {
  const colorTargets = gbufferColorTargets(targets, temporal, temporalInGBuffer);
  return addTypedScenePass(graph, {
    materialSceneDepth,
    name: prepass ? 'main-depth-deferred' : 'g-buffer',
    color: targets.scene,
    colorTargets,
    colorLoadOp: colorTargets.map((_, index) =>
      index === 0 ? (clearSceneColor ? 'clear' : 'load') : 'clear',
    ),
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

function addDeferredScreenAo(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  copySize: CopySize,
  normal: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  velocity: RenderPipelineTarget | undefined,
  hzb?: ReadViewHzb,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const config = topology.config?.ambientOcclusion;
  if (!ssaoUsesLighting(config)) return ok(undefined);
  const normalLayout = topology.compactGbuffer ?? 'standard-gbuffer/2';
  return config?.method === 'gtao'
    ? addStandardScreenGtao(context, topology, {
        depth,
        size: copySize,
        normal,
        normalLayout,
        velocity,
        hzb,
      })
    : addStandardScreenSsao(context, topology, {
        depth,
        size: copySize,
        normal,
        normalLayout,
        hzb,
      });
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

function admitsDeferredPcfLighting(
  topology: RenderPipelineTopology,
  sources: DeferredLightSources,
) {
  return (
    topology.deferredPcfLighting === true &&
    (sources.environment?.atmosphere === undefined ||
      topology.perPixelAtmosphereTransmittance === false) &&
    sources.cloudShadow === undefined
  );
}

function addDeferredLightingStage(
  graph: Graph,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  surfaces: DeferredSurfaceGBuffer,
  sources: DeferredLightSources,
  size: InternalSize,
  copySize: CopySize,
  diffuseGiBaseline: GraphBuffer | undefined,
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
    pcfLighting: admitsDeferredPcfLighting(topology, sources),
    localProbes: topology.reflectionFallback?.localProbes === true,
    ...(reflection.composeReflection === true ? { composeReflection: true } : {}),
    perPixelAtmosphereTransmittance: topology.perPixelAtmosphereTransmittance,
    lightProbes: topology.deferredLightProbes === true,
    capsuleShadows: topology.deferredCapsuleShadows === true,
    ...(subsurfaceDiffuse.value === undefined ? {} : { diffuse: subsurfaceDiffuse.value }),
    ...(diffuseGiBaseline === undefined ? {} : { diffuseGiBaseline }),
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
    ...(cloudShadow === undefined ? {} : { cloudShadow }),
    ...(shadows.point === undefined ? {} : { pointShadow: shadows.point }),
    cluster: clusters,
    extraAccesses: clusters === null ? [] : standardClusterReadAccesses(clusters),
    size: copySize,
  });
  return lightingPass.ok ? subsurfaceDiffuse : lightingPass;
}

function addDeferredSubsurfaceStage(
  graph: Graph,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  normal: RenderPipelineTarget,
  diffuse: RenderPipelineTarget | undefined,
  size: CopySize,
) {
  const quality = topology.subsurface?.quality;
  if (quality === undefined || diffuse === undefined) return ok(undefined);
  return addSubsurfaceDiffusion(graph, {
    scene: targets.scene,
    diffuse,
    profiles: targets.lightingContext.view,
    normal: normal.view,
    depth: targets.depthSample,
    size,
    scale: [
      size.width / (topology.extent?.outputWidth ?? topology.surface.width),
      size.height / (topology.extent?.outputHeight ?? topology.surface.height),
    ],
    quality,
    ...(targets.compactGbuffer === undefined ? {} : { compact: true }),
  });
}

function deferredDiffuseGiBaseline(
  context: StandardPipelineBuildContext,
  temporal: DeferredTemporal,
  size: { readonly width: number; readonly height: number },
) {
  if (
    context.contributeDiffuseGi === undefined ||
    (temporal.targets === undefined && temporal.velocity === undefined)
  )
    return ok(undefined);
  return context.graph.createBuffer('diffuse-gi-baseline', {
    size: size.width * size.height * 3 * Uint32Array.BYTES_PER_ELEMENT,
  });
}

/** Water can overlay the packed target only when no consumer needs the float SceneData projection. */
function deferredWaterVelocity(topology: RenderPipelineTopology, temporal: DeferredTemporal) {
  return topology.water === true &&
    temporal.targets === undefined &&
    temporal.velocity?.format === 'r32uint'
    ? temporal.velocity
    : undefined;
}

function needsDeferredTemporalProjection(
  topology: RenderPipelineTopology,
  velocity: DeferredTemporal['velocity'],
  diffuseGiBaseline: GraphBuffer | undefined,
): boolean {
  return (
    velocity !== undefined &&
    (topology.ssr?.status === 'admitted' ||
      topology.singleLayerMedium === true ||
      diffuseGiBaseline !== undefined)
  );
}

/** Publish reconstructed motion before GTAO and other consumers read it. */
function addDeferredSceneDataProducer(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  temporal: DeferredTemporal,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  waterInfoTargets: WaterInfoGraphTargets,
) {
  if (temporal.targets === undefined || temporal.velocity !== undefined) return ok(undefined);
  return addStandardSceneDataPass(
    context.graph,
    temporal.targets.temporal,
    targets.depth,
    gpuDriven,
    temporal.inGBuffer ? 'forward-only-opaque' : 'opaque',
    waterInfoTargets,
    context.getWaterMeshGraphAccesses?.(),
  );
}

function addSceneDataConsumers(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  surfaces: DeferredSurfaceGBuffer & { readonly rayNormal: RenderPipelineTarget },
  temporal: DeferredTemporal,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  depthViews: DeferredDepthViews,
  diffuseGiBaseline: GraphBuffer | undefined,
  subsurfaceDiffuse: RenderPipelineTarget | undefined,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const reflection = targets.reflection;
  const temporalTargets = temporal.targets;
  if (
    context.contributeDiffuseGi !== undefined &&
    temporalTargets !== undefined &&
    diffuseGiBaseline !== undefined
  ) {
    const diffuse = context.contributeDiffuseGi({
      scene: targets.scene,
      diffuseGiBaseline,
      ...(subsurfaceDiffuse === undefined ? {} : { subsurfaceDiffuse }),
      depth: targets.depthSample,
      normal: surfaces.rayNormal,
      albedo: surfaces.albedo,
      ...(targets.compactGbuffer === undefined ? {} : { compactGbuffer: true }),
      f0: surfaces.f0,
      ...(targets.visibleSurface === undefined ? {} : { identity: targets.visibleSurface }),
      motion: temporalTargets.temporal,
      ...(temporal.velocity?.format === 'rg32uint' ? { motionWithDepth: temporal.velocity } : {}),
      sceneHzb: () => {
        const hzb = depthViews.hzb();
        return hzb.ok ? ok(hzb.value.pyramid) : hzb;
      },
      closestHzb: () => {
        const pyramid = depthViews.closestHzb();
        return pyramid.ok ? ok(pyramid.value.pyramid.pyramid) : pyramid;
      },
      ...(reflection.fallback === undefined || reflection.response === undefined
        ? {}
        : {
            reflection: {
              fallback: reflection.fallback,
              response: reflection.response,
              ...(reflection.composeReflection === true ? { composeReflection: true } : {}),
            },
          }),
    });
    if (!diffuse.ok) return diffuse;
  }
  if (context.targetCoverage === undefined) return ok(undefined);
  return addTargetCoveragePass(graph, context.targetCoverage, gpuDriven, waterInfoTargets);
}

/** Only consumers of the full Standard temporal descriptor expand packed velocity. */
function projectDeferredTemporal(
  graph: Graph,
  temporal: DeferredTemporal,
  depthSample: GraphTextureView,
  depthViews: DeferredDepthViews,
  size: CopySize,
  required: boolean,
): Result<DeferredTemporal, RenderGraphError> {
  const velocity = temporal.velocity;
  if (!required || velocity === undefined) return ok(temporal);
  const view = depthViews.sceneView();
  if (!view.ok) return view;
  const projected = addDefaultVelocityTemporalProjection(
    graph,
    velocity,
    { depth: depthSample, view: view.value },
    size,
  );
  return projected.ok ? ok({ ...temporal, targets: { temporal: projected.value } }) : projected;
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
  if (ssr?.status !== 'admitted') return ok(undefined);
  const ssrView = depthViews.sceneView();
  if (!ssrView.ok) return ssrView;
  const depthPyramid = depthViews.hzb();
  if (!depthPyramid.ok) return depthPyramid;
  const fallback = targets.reflection.fallback;
  const currentTemporal = temporal.targets?.temporal.view;
  const hitColor = addSsrHitColor(context, targets.scene, copySize, 'ssr-scene-color');
  if (!hitColor.ok) return hitColor;
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
    scene: hitColor.value.view,
    ...(context.ssrSceneColorHistory === undefined
      ? {}
      : { sceneColorHistory: context.ssrSceneColorHistory.view }),
    ...(currentTemporal === undefined ? {} : { currentTemporal }),
    ...(fallback === undefined ? {} : { fallback: fallback.view }),
    ...(ssrView.value === undefined ? {} : { view: ssrView.value }),
    depthPyramid: depthPyramid.value,
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
    scene: targets.scene,
    composeEnvironment: targets.reflection.composeReflection === true,
    radiance: resources.trace.view,
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

/** Materials without a GBuffer entry draw against the already-lit scene and depth. */
function addForwardOnlyOpaque(
  graph: Graph,
  forward: Pick<
    DeferredForwardScene,
    'color' | 'depth' | 'environment' | 'receiver' | 'gpuDriven' | 'depthPrimed'
  >,
  waterDepth: boolean,
  writer?: SceneColorDraws,
) {
  const { color, depth, environment, receiver, gpuDriven } = forward;
  // These surfaces are absent from the GBuffer; its AO describes the geometry
  // behind them. Keep their own Forward lighting independent of that AO.
  const { ssao, ...opaqueReceiver } = receiver;
  return addTypedScenePass(graph, {
    ...(writer === undefined ? {} : { writer }),
    environment,
    name: 'forward',
    opaqueDepthPrimed: forward.depthPrimed === true || waterDepth,
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
}

/**
 * Forward-only opaque writers, then analytic fog over the opaque scene and the
 * cloud composite. Returns the scene target later translucent writers use.
 */
function addDeferredOpaqueForward(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  clouds: StandardCloudPhase | undefined,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  const graph = context.graph;
  const { color, depth, environment } = forward;
  const pass = addForwardOnlyOpaque(
    graph,
    forward,
    (context.getWaterMeshGraphAccesses?.().length ?? 0) !== 0,
  );
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
  return compositeDeferredClouds(context, topology, clouds, forward);
}

function compositeDeferredClouds(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  clouds: StandardCloudPhase | undefined,
  {
    color,
    depth,
    environment,
    receiver,
  }: Pick<DeferredForwardScene, 'color' | 'depth' | 'environment' | 'receiver'>,
): Result<RenderPipelineTarget, RenderPipelineBuildError> {
  if (clouds?.scene === undefined) return ok(color);
  const composite = contributeStandardCloudComposite(
    context,
    clouds.featureTargets,
    {
      input: color,
      depth,
      depthSize: renderInternalCopySize(topology),
      output: clouds.scene,
      cloudShadow: clouds.shadow,
    },
    receiver.extraAccesses,
    renderInternalSize(topology),
    environment?.atmosphere,
  );
  return composite.ok ? ok(clouds.scene) : composite;
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
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  size: InternalSize,
) {
  const graph = context.graph;
  return addStandardTransparentPasses(graph, {
    color: forward.color,
    depth: forward.depth,
    size,
    transparency: topology.transparency,
    currentTransparency: context.currentTransparency,
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
  if (context.currentTransmission)
    return addCurrentStandardTranslucency(graph, {
      color: forward.color,
      depth: forward.depth,
      size,
      transparency: topology.transparency,
      currentTransparency: context.currentTransparency,
      template: { environment: forward.environment, ...forward.receiver, passKind: 'forward' },
    });
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
      const transparentPass = addDeferredTransparentPasses(context, topology, forward, size);
      if (!transparentPass.ok) return transparentPass;
    }
  }
  if (transmission.value.topology.active) return ok(undefined);
  return addDeferredTransparentPasses(context, topology, forward, size);
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
    readonly sceneVelocity: RenderPipelineTarget | undefined;
    readonly depthViews: DeferredDepthViews;
    readonly targets: DeferredSceneTargets;
  },
): Result<
  {
    readonly depth: RenderPipelineTarget;
    readonly sampledDepth: GraphTextureView;
    readonly foamSimulation?: GraphTextureView;
  },
  RenderPipelineBuildError
> {
  const translucent = (scene: DeferredForwardScene) =>
    addDeferredMaterialTranslucency(context, topology, scene, route, mediumTargets, targetCaptures);
  if (topology.water !== true) {
    const transparent = translucent(forward);
    return transparent.ok
      ? ok({ depth: forward.depth, sampledDepth: water.targets.depthSample })
      : transparent;
  }
  const view = water.depthViews.sceneView();
  if (!view.ok) return view;
  const underwater = topology.waterView?.kind === 'available' && topology.waterView.underwater;
  const size = renderInternalCopySize(topology);
  // Compact Deferred primes both opaque lanes before lighting. The later
  // Forward-only color draw reuses that depth, so Water can read the same HZB.
  const hzb =
    forward.depthPrimed && topology.ssr?.status === 'admitted'
      ? water.depthViews.hzb()
      : ok(undefined);
  if (!hzb.ok) return hzb;
  const slw = addWaterSlwPasses({
    graph: context.graph,
    topology,
    context,
    color: forward.color,
    depth: forward.depth,
    ...(hzb.value === undefined ? {} : { depthPyramid: hzb.value }),
    ...(water.targets.reflection.fallback === undefined
      ? {}
      : {
          opaqueSurface: {
            normal: water.targets.normalRoughness,
            fallback: water.targets.reflection.fallback,
            gbufferV2: true,
            ...(water.targets.compactGbuffer === undefined
              ? {}
              : {
                  compactMaterial: water.targets.dielectricSpecular.view,
                }),
          },
        }),
    ...(water.temporal === undefined ? {} : { opaqueTemporal: water.temporal.temporal }),
    ...(water.sceneVelocity === undefined ? {} : { sceneVelocity: water.sceneVelocity }),
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
  return ok({
    depth: slw.value.depth,
    sampledDepth: slw.value.sampledDepth,
    foamSimulation: slw.value.foamSimulation,
  });
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
    spotShadow: sources.shadows.spot?.view,
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

/** Shared opaque scene depth and the Near bound used by Lumen screen traversal. */
interface DeferredDepthViews {
  readonly nativeInputs: StandardPipelineBuildContext['nativeInputs'];
  readonly sceneView: () => Result<GraphBuffer, RenderGraphError>;
  readonly hzb: ReadViewHzb;
  readonly closestHzb: () => Result<DepthPyramidProjection, RenderGraphError>;
}

function deferredDepthViews(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  depthSample: GraphTextureView,
  copySize: CopySize,
): DeferredDepthViews {
  const { graph, nativeInputs } = context;
  const sceneView = sceneViewImport(graph);
  const hzb = viewHzb(
    context,
    topology,
    depthSample,
    copySize,
    topology.ssr?.status === 'admitted' ? undefined : standardAoHzbLevels(topology),
  );
  // Lumen and Deferred Water validate near opaque hits against this depth.
  let closestHzb: Result<DepthPyramidProjection, RenderGraphError> | undefined;
  return {
    nativeInputs,
    sceneView,
    hzb,
    closestHzb: () => {
      if (closestHzb !== undefined) return closestHzb;
      const view = sceneView();
      if (!view.ok) return view;
      closestHzb = addDepthPyramidPasses(graph, {
        label: 'hzb-closest',
        reduction: 'closest',
        nativeInputs,
        depth: depthSample,
        execution:
          topology.lane.compute && topology.lane.storageTexture !== false ? 'compute' : 'fragment',
        width: copySize.width,
        height: copySize.height,
        view: view.value,
      });
      return closestHzb;
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

/** The compact lane records velocity first, then uses that opaque depth for Water selection. */
function addDeferredVelocityGBufferPasses(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  velocityTarget: RenderPipelineTarget,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: CopySize,
  sceneView: DeferredDepthViews['sceneView'],
  waterInfoTargets: WaterInfoGraphTargets,
  waterInputs: readonly GraphAccess[],
  materialSceneDepth: boolean | undefined,
  clearSceneColor = false,
): Result<{ readonly pyramid?: GraphTextureView } | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const prepass = addDefaultDepthPrepass(graph, targets.depth);
  if (!prepass.ok) return prepass;
  const velocity = addDefaultDepthVelocity(graph, targets.depth, velocityTarget, gpuDriven);
  if (!velocity.ok) return velocity;
  const late = addGpuLateOcclusion(graph, {
    gpuDriven,
    depth: targets.depthSample,
    multisampled: false,
    width: copySize.width,
    height: copySize.height,
    view: sceneView,
  });
  if (!late.ok) return late;
  if (late.value !== undefined && gpuDriven !== undefined) {
    const velocityLate = addDefaultDepthVelocity(
      graph,
      targets.depth,
      velocityTarget,
      gpuDriven,
      'late',
    );
    if (!velocityLate.ok) return velocityLate;
  }
  if (waterInputs.length > 0) {
    const afterDepth = contributeStandardAfterDepthFeatures(context, targets.scene, targets.depth);
    if (!afterDepth.ok) return afterDepth;
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
    clearSceneColor,
  );
  if (!base.ok || late.value === undefined || gpuDriven === undefined) return base.ok ? late : base;
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

/** Early G-buffer, GPU late occlusion and its late G-buffer; returns the late camera pyramid. */
function addDeferredGBufferPasses(
  context: StandardPipelineBuildContext,
  targets: DeferredSceneTargets,
  temporal: DeferredTemporal,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: CopySize,
  depthViews: Pick<DeferredDepthViews, 'nativeInputs' | 'sceneView'>,
  waterInfoTargets: WaterInfoGraphTargets,
  materialSceneDepth: boolean | undefined,
  clearSceneColor = false,
): Result<{ readonly pyramid?: GraphTextureView } | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInputs = context.getWaterMeshGraphAccesses?.() ?? [];
  if (temporal.velocity !== undefined)
    return addDeferredVelocityGBufferPasses(
      context,
      targets,
      temporal.velocity,
      gpuDriven,
      copySize,
      depthViews.sceneView,
      waterInfoTargets,
      waterInputs,
      materialSceneDepth,
      clearSceneColor,
    );
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
    false,
    clearSceneColor,
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
  clouds: StandardCloudPhase | undefined,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  targetCaptures: GraphTextureView | undefined,
  temporal: DeferredTemporal,
  depthViews: DeferredDepthViews,
  waterVelocity: RenderPipelineTarget | undefined,
): Result<
  {
    readonly color: RenderPipelineTarget;
    readonly depth: RenderPipelineTarget;
    readonly sampledDepth: GraphTextureView;
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
  const beforeMedium = contributeStandardSceneFeatures(
    context,
    {
      color: forward.color,
      colorResolve: undefined,
      depth: forward.depth,
      temporal: isTemporalAntialias(topology.camera.antialias) ? forward.temporal : undefined,
    },
    standardForwardReceiverFeatureAccesses(forward.receiver),
    forward.environment?.atmosphere,
    forward.sceneDataTargets,
    'before-medium',
  );
  if (!beforeMedium.ok) return beforeMedium;
  const translucent = addDeferredTranslucency(
    context,
    topology,
    forward,
    standardTransmissionRoute(topology),
    targets.medium,
    targetCaptures,
    { temporal: temporal.targets, sceneVelocity: waterVelocity, depthViews, targets },
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
  return ok({
    color: sceneOutput.value,
    depth: translucent.value.depth,
    sampledDepth: translucent.value.sampledDepth,
    waterFoamSimulation: translucent.value.foamSimulation,
  });
}

function addDeferredTemporalInputs(...inputs: Parameters<typeof addDeferredSsr>) {
  const [context, topology, targets] = inputs;
  const opaqueGuide = addTsrOpaqueGuide(context.graph, topology, targets.scene);
  if (!opaqueGuide.ok) return opaqueGuide;
  const secondaryReactivity = addDeferredSsr(...inputs);
  if (!secondaryReactivity.ok) return secondaryReactivity;
  return ok({ opaqueGuide: opaqueGuide.value, secondaryReactivity: secondaryReactivity.value });
}

const NO_WATER_INFO_TARGETS: WaterInfoGraphTargets = new Map();

/** Ordinary Deferred display. Only these physical producers participate: cluster tables,
 * current camera visibility, GBuffer, shadows, lighting, ordered scene draws and output. */
export function buildDeferredDisplay(
  graph: Graph,
  input: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  ports: DisplayPorts,
  frameState: RenderFrameState,
  depthLayers: ShadowDepthLayers,
  retainIndirectBundles: boolean,
  capabilities: Pick<import('@forgeax/engine-rhi').RhiCaps, 'rgba16floatRenderable'>,
  post: OrderedStandardPostInputs,
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  const topology = standardTopology(input);
  const caps = deferredLaneCapabilityError(topology, false);
  if (caps !== undefined) return err(caps);
  const endpoint = importRenderPipelineSurface(graph, topology);
  if (!endpoint.ok) return endpoint;
  const size = renderInternalSize(topology);
  const extent = renderInternalCopySize(topology);
  const buffers = importDeferredClusters(graph, lighting);
  if (!buffers.ok) return buffers;
  const sceneTargets = declareDeferredSceneTargets(graph, topology, size, false, true);
  if (!sceneTargets.ok) return sceneTargets;
  const targets = sceneTargets.value;
  const { scene, depth } = targets;
  const context = {
    graph,
    projectGpuDriven: () => ok(undefined),
    contributeFeatures: () => ok(undefined),
    readOutputDither: currentOutputDither,
    ...post,
    capabilities,
    observationCaptureDomains: ports.captureDomains,
  };
  const phases = declareDeferredDisplayPhases(context, topology, targets, size);
  if (!phases.ok) return phases;
  const { clouds, cloudShadow, temporal, water, waterInfoTargets } = phases.value;
  const probes = addCurrentReflectionProbeFilters(graph);
  if (!probes.ok) return probes;
  const gpu =
    ports.geometry === 'direct'
      ? ok(undefined)
      : currentGpuRaster(
          graph,
          { format: scene.format, sampleCount: 1, lateOcclusion: ports.geometry === 'occlusion' },
          frameState,
          retainIndirectBundles,
        );
  if (!gpu.ok) return gpu;
  const addShadows = () =>
    addTypedShadowPasses(graph, topology, {
      currentViews: currentShadowViews(topology.shadow, true),
      currentReceiverDepth: ports.geometry === 'direct' ? undefined : ports.cullShadowReceivers,
      depthLayers,
      reuseAdjacentShadow: true,
      ...(water === undefined
        ? {}
        : {
            waterInfoTargets,
            surfaceFluidSimulation: water.fluid,
          }),
    });
  // Open sky rays must see shadows before any camera-depth culling.
  const earlyShadows = topology.atmosphere === true ? addShadows() : ok(undefined);
  if (!earlyShadows.ok) return earlyShadows;
  const environment = addDeferredBackground(
    graph,
    topology,
    scene,
    earlyShadows.value?.directional?.view,
    cloudShadow,
  );
  if (!environment.ok) return environment;
  const depthViews = deferredDepthViews(context, topology, targets.depthSample, extent);
  const geometry = addDeferredGBufferPasses(
    context,
    targets,
    temporal,
    gpu.value,
    extent,
    depthViews,
    waterInfoTargets,
    true,
  );
  if (!geometry.ok) return geometry;
  const shadows = earlyShadows.value === undefined ? addShadows() : ok(earlyShadows.value);
  if (!shadows.ok) return shadows;
  const surfaces = addDeferredDisplayDepthFollowers(
    context,
    topology,
    targets,
    size,
    temporal,
    gpu.value,
    shadows.value,
    waterInfoTargets,
  );
  if (!surfaces.ok) return surfaces;
  const ssao = addDeferredScreenAo(
    context,
    topology,
    extent,
    surfaces.value.normal,
    depth,
    temporal.velocity ?? temporal.targets?.temporal,
    depthViews.hzb,
  );
  if (!ssao.ok) return ssao;
  const sources: DeferredLightSources = {
    shadows: shadows.value,
    cloudShadow,
    ssao: ssao.value,
    environment: environment.value,
    clusters: buffers.value,
  };
  const lightingPass = addDeferredDisplayLighting(
    graph,
    topology,
    targets,
    surfaces.value,
    sources,
    size,
    extent,
  );
  if (!lightingPass.ok) return lightingPass;
  const shaded = {
    ...targets,
    normalRoughness: surfaces.value.normal,
    dielectricSpecular: surfaces.value.f0,
  };
  const output = addDeferredDisplayForwardAndPost(context, topology, shaded, endpoint.value, {
    sources,
    size,
    depthViews,
    extent,
    temporal,
    gpuDriven: gpu.value,
    weighted: ports.weighted,
    clouds,
    planarReflection: context.planarReflection,
    waterInfoTargets,
  });
  return output.ok ? gpu : output;
}

function addDeferredDisplayLighting(
  graph: Graph,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  surfaces: DeferredSurfaceGBuffer,
  sources: DeferredLightSources,
  size: InternalSize,
  extent: CopySize,
) {
  const lighting = addDeferredLightingStage(
    graph,
    topology,
    targets,
    surfaces,
    sources,
    size,
    extent,
    undefined,
  );
  if (!lighting.ok) return lighting;
  return addDeferredSubsurfaceStage(
    graph,
    topology,
    targets,
    surfaces.normal,
    lighting.value,
    extent,
  );
}

/** The mirror and reconstructed scene data are ready before lighting and forward readers. */
function addDeferredDisplayDepthFollowers(
  context: StandardPipelineBuildContext & OrderedStandardPostInputs,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  size: InternalSize,
  temporal: DeferredTemporal,
  gpu: RenderPipelineGpuDrivenProjection | undefined,
  shadows: TypedShadowTargets,
  waterInfoTargets: WaterInfoGraphTargets,
) {
  const capture = addPlanarReflectionPass(context.graph, shadows, context.planarReflection);
  if (!capture.ok) return capture;
  const surfaces = addSurfaceStage(context, topology, targets, size);
  if (!surfaces.ok) return surfaces;
  const data = addDeferredSceneDataProducer(context, targets, temporal, gpu, waterInfoTargets);
  return data.ok ? surfaces : data;
}

/** Bind the scene and history producers before the ordered camera issues work. */
function declareDeferredDisplayPhases(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  { scene, depth }: DeferredSceneTargets,
  size: InternalSize,
) {
  const clouds = declareOrderedCloudPhase(context, scene, depth, size);
  if (!clouds.ok) return clouds;
  const temporal = admitDeferredTemporal(context, topology, false);
  if (!temporal.ok) return temporal;
  const water = prepareStandardWaterView(context, topology);
  if (!water.ok) return water;
  return ok({
    water: water.value,
    waterInfoTargets: water.value?.targets ?? NO_WATER_INFO_TARGETS,
    clouds: clouds.value,
    cloudShadow: clouds.value?.shadow,
    temporal: temporal.value,
  });
}

/** Measure opaque color, then issue the remaining draws before resolving temporal history. */
function addDeferredDisplayForwardAndPost(
  context: StandardPipelineBuildContext & OrderedStandardPostInputs,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  surface: Parameters<typeof addStandardPost>[4],
  input: {
    readonly sources: DeferredLightSources;
    readonly size: InternalSize;
    readonly depthViews: DeferredDepthViews;
    readonly extent: CopySize;
    readonly temporal: DeferredTemporal;
    readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
    readonly weighted: boolean;
    readonly clouds: StandardCloudPhase | undefined;
    readonly planarReflection: GraphTextureView | undefined;
    readonly waterInfoTargets: WaterInfoGraphTargets;
  },
) {
  const { graph } = context;
  const { depth } = targets;
  const { depthViews, extent, temporal, gpuDriven } = input;
  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(
      graph,
      context.targetCoverage,
      gpuDriven,
      input.waterInfoTargets,
    );
    if (!coverage.ok) return coverage;
  }
  const sceneTemporal = projectDeferredTemporal(
    graph,
    temporal,
    targets.depthSample,
    depthViews,
    extent,
    needsDeferredTemporalProjection(topology, temporal.velocity, undefined),
  );
  if (!sceneTemporal.ok) return sceneTemporal;
  const temporalInputs = addDeferredTemporalInputs(
    context,
    topology,
    targets,
    targets.normalRoughness,
    sceneTemporal.value,
    extent,
    depthViews,
  );
  if (!temporalInputs.ok) return temporalInputs;
  const currentTemporal = sceneTemporal.value;
  const waterVelocity = deferredWaterVelocity(topology, currentTemporal);
  const recorded = recordDeferredDisplayScene(
    context,
    topology,
    targets,
    {
      ...input,
      temporal: currentTemporal,
    },
    waterVelocity,
  );
  if (!recorded.ok) return recorded;
  const velocity =
    topology.water === true
      ? waterVelocity
      : topology.singleLayerMedium === true
        ? undefined
        : temporal.velocity;
  const velocityView = velocity === undefined ? ok(undefined) : depthViews.sceneView();
  if (!velocityView.ok) return velocityView;
  const visible = recorded.value;
  return addStandardPost(context, topology, visible.color, depth, surface, {
    sceneTemporal: velocity ?? currentTemporal.targets?.temporal,
    sceneColorDepth: visible.depth,
    coverage: context.targetCoverage?.coverage,
    coverageDepth: context.targetCoverage?.depth,
    ...temporalInputs.value,
    gpuDriven,
    waterInfoTargets: input.waterInfoTargets,
    waterFoamSimulation: visible.waterFoamSimulation,
    sceneVelocity:
      velocityView.value === undefined
        ? undefined
        : { depth: visible.sampledDepth, view: velocityView.value },
  });
}

function recordDeferredDisplayScene(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  input: Parameters<typeof addDeferredDisplayForwardAndPost>[4],
  waterVelocity: RenderPipelineTarget | undefined,
) {
  if (topology.water === true) {
    return addDeferredForwardStages(
      context,
      topology,
      targets,
      input.sources,
      input.clouds,
      input.gpuDriven,
      input.planarReflection,
      input.temporal,
      input.depthViews,
      waterVelocity,
    );
  }
  const color = addDeferredDisplayColorDraws(context, topology, targets, input);
  return color.ok
    ? ok({
        color: color.value,
        depth: targets.depth,
        sampledDepth: targets.depthSample,
        waterFoamSimulation: undefined,
      })
    : color;
}

function addDeferredDisplayColorDraws(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  targets: DeferredSceneTargets,
  input: Parameters<typeof addDeferredDisplayForwardAndPost>[4],
) {
  const { graph } = context;
  const { scene, depth, medium } = targets;
  const { sources, gpuDriven, clouds } = input;
  const color = clouds?.scene ?? scene;
  const writer = medium === undefined ? new SceneColorDraws(color.view, depth.view) : undefined;
  const atmosphere = sources.environment?.atmosphere;
  const fog = topology.analyticFog === true || atmosphere !== undefined;
  const receiver = standardForwardReceiverInputs({
    shadows: sources.shadows,
    cloudShadow: sources.cloudShadow,
    materialSceneDepth: true,
    planarReflection: input.planarReflection,
    ssao: sources.ssao,
    clusterReads: sources.clusters === null ? [] : standardClusterReadAccesses(sources.clusters),
  });
  const opaque = addForwardOnlyOpaque(
    graph,
    {
      color: scene,
      depth,
      receiver,
      environment: sources.environment,
      gpuDriven,
      depthPrimed: input.temporal.velocity !== undefined,
    },
    false,
    fog || color !== scene ? undefined : writer,
  );
  if (!opaque.ok) return opaque;
  if (fog) {
    const fogged = addOpaqueFogPasses(graph, { topology, atmosphere, color: scene, depth });
    if (!fogged.ok) return fogged;
  }
  const composite = compositeDeferredClouds(context, topology, clouds, {
    color: scene,
    depth,
    environment: sources.environment,
    receiver,
  });
  if (!composite.ok) return composite;
  const translucent = recordDeferredDisplayTranslucency(
    context,
    topology,
    {
      color,
      depth,
      receiver,
      environment: sources.environment,
      gpuDriven,
      sceneDataTargets: [],
      ...(input.temporal.targets === undefined
        ? {}
        : { temporal: input.temporal.targets.temporal }),
    },
    writer,
    medium,
    input,
  );
  if (!translucent.ok) return translucent;
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    atmosphere,
    color,
    depth,
    directionalShadow: sources.shadows.directional?.view,
    spotShadow: sources.shadows.spot?.view,
    clusterBuffers: sources.clusters,
    cloudShadow: clouds?.shadow?.view,
  });
  return volume.ok ? ok(color) : volume;
}

function recordDeferredDisplayTranslucency(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  forward: DeferredForwardScene,
  writer: SceneColorDraws | undefined,
  medium: DeferredSceneTargets['medium'],
  input: Parameters<typeof addDeferredDisplayForwardAndPost>[4],
) {
  const { graph } = context;
  const { color, depth, receiver, environment } = forward;
  if (writer === undefined) {
    return addDeferredMaterialTranslucency(
      context,
      topology,
      forward,
      standardTransmissionRoute(topology),
      medium,
      input.planarReflection,
    );
  }
  const transparency = addCurrentStandardTranslucency(graph, {
    color,
    depth,
    size: input.size,
    transparency: undefined,
    currentTransparency: input.weighted,
    template: { ...receiver, writer, environment, passKind: 'forward' },
  });
  return transparency.ok ? writer.install(graph, 'deferred-display-draws') : transparency;
}

function buildDeferredSurfaceOnlyDebugLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  vpExt: NonNullable<StandardPipelineBuildContext['viewportOutput']>,
  vpBucket: 'surface-only' | 'surface-with-ao',
  visibleSurfaceEnabled: boolean,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize = renderInternalSize(topology);
  const internalCopySize = renderInternalCopySize(topology);
  const targets = declareDeferredSceneTargets(
    graph,
    topology,
    internalSize,
    visibleSurfaceEnabled,
    context.currentMaterialDepth,
  );
  if (!targets.ok) return targets;
  const { depth } = targets.value;
  const temporal: DeferredTemporal = { targets: undefined, inGBuffer: false };
  const gpuDriven = projectDeferredGpuDriven(context, topology, targets.value);
  if (!gpuDriven.ok) return gpuDriven;
  const depthViews = deferredDepthViews(
    context,
    topology,
    targets.value.depthSample,
    internalCopySize,
  );
  const gbuffer = addDeferredGBufferPasses(
    context,
    targets.value,
    temporal,
    gpuDriven.value,
    internalCopySize,
    depthViews,
    standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
    topology.materialSceneDepth,
    true,
  );
  if (!gbuffer.ok) return gbuffer;
  const surfaces = addSurfaceStage(context, topology, targets.value, internalSize);
  if (!surfaces.ok) return surfaces;
  const ssao =
    vpBucket === 'surface-with-ao'
      ? addDeferredScreenAo(
          context,
          topology,
          internalCopySize,
          surfaces.value.normal,
          depth,
          undefined,
          depthViews.hzb,
        )
      : ok(undefined);
  if (!ssao.ok) return ssao;
  const debugOut = target(graph, 'viewport-debug-output', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!debugOut.ok) return debugOut;
  const vis = vpExt.addVisualizerPass(graph, {
    compact: targets.value.compactGbuffer !== undefined,
    hasScreenAo: ssao.value !== undefined,
    hasReceiverGeometry:
      targets.value.receiverGeometry !== undefined &&
      (targets.value.compactGbuffer === undefined || topology.compactReceiver === 'geometry'),
    hasLitColor: false,
    normalRoughness: surfaces.value.normal,
    albedoMetallic: surfaces.value.albedo,
    dielectricSpecular: surfaces.value.f0,
    sceneColor: targets.value.scene,
    receiverGeometry: targets.value.receiverGeometry,
    depth: targets.value.depthSample,
    screenAo: ssao.value,
    output: debugOut.value,
  });
  if (!vis.ok) return vis;
  return addStandardDebugOutputPost(context, topology, debugOut.value, depth, surface.value);
}

function prepareDeferredViewportDebugInputs(
  graph: StandardPipelineBuildContext['graph'],
  vpExt: StandardPipelineBuildContext['viewportOutput'],
  vpBucket: import('../viewport-output-contract').ViewportOutputTopologyBucket | undefined,
  targetsValue: Extract<ReturnType<typeof declareDeferredSceneTargets>, { ok: true }>['value'],
  surfacesValue: Extract<ReturnType<typeof addSurfaceStage>, { ok: true }>['value'],
  internalSize: ReturnType<typeof renderInternalSize>,
  internalCopySize: ReturnType<typeof renderInternalCopySize>,
): Result<
  {
    readonly lightingTargets: typeof targetsValue;
    readonly lightingSurfaces: typeof surfacesValue;
    readonly overviewEmissiveCopy: RenderPipelineTarget | undefined;
  },
  RenderPipelineBuildError
> {
  if (vpExt === undefined || vpBucket === undefined) {
    return ok({
      lightingTargets: targetsValue,
      lightingSurfaces: surfacesValue,
      overviewEmissiveCopy: undefined,
    });
  }
  if (vpBucket === 'lighting-only') {
    const outScene = target(graph, 'viewport-debug-lighting-scene', {
      format: targetsValue.scene.format,
      size: internalSize,
    });
    if (!outScene.ok) return outScene;
    const outAlbedo = target(graph, 'viewport-debug-lighting-albedo', {
      format: surfacesValue.albedo.format,
      size: internalSize,
    });
    if (!outAlbedo.ok) return outAlbedo;
    const outSpecular = target(graph, 'viewport-debug-lighting-specular', {
      format: surfacesValue.f0.format,
      size: internalSize,
    });
    if (!outSpecular.ok) return outSpecular;
    const overridden = vpExt.addLightingOnlyOverridePass(graph, {
      compact: targetsValue.compactGbuffer !== undefined,
      normalRoughness: surfacesValue.normal,
      albedoMetallic: surfacesValue.albedo,
      dielectricSpecular: surfacesValue.f0,
      scene: targetsValue.scene,
      outAlbedoMetallic: outAlbedo.value,
      outDielectricSpecular: outSpecular.value,
      outScene: outScene.value,
    });
    if (!overridden.ok) return overridden;
    return ok({
      lightingTargets: { ...targetsValue, scene: outScene.value },
      lightingSurfaces: { ...surfacesValue, albedo: outAlbedo.value, f0: outSpecular.value },
      overviewEmissiveCopy: undefined,
    });
  }
  if (vpBucket === 'overview') {
    const emissiveCopy = target(graph, 'viewport-debug-emissive-copy', {
      format: targetsValue.scene.format,
      size: internalSize,
    });
    if (!emissiveCopy.ok) return emissiveCopy;
    const copied = graph.addCopyPass('viewport-debug-emissive-copy', {
      accesses: [
        { resource: targetsValue.scene.view, usage: 'copy-src' },
        { resource: emissiveCopy.value.view, usage: 'copy-dst' },
      ],
      encodeDirect: (encoder, _graphFrame, resources) => {
        const src = resources.texture(targetsValue.scene.texture);
        const dst = resources.texture(emissiveCopy.value.texture);
        if (!src.ok) throw src.error;
        if (!dst.ok) throw dst.error;
        encoder.copyTextureToTexture(
          { texture: src.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { texture: dst.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { ...internalCopySize, depthOrArrayLayers: 1 },
        );
      },
    });
    if (!copied.ok) return copied;
    return ok({
      lightingTargets: targetsValue,
      lightingSurfaces: surfacesValue,
      overviewEmissiveCopy: emissiveCopy.value,
    });
  }
  return ok({
    lightingTargets: targetsValue,
    lightingSurfaces: surfacesValue,
    overviewEmissiveCopy: undefined,
  });
}

function buildDeferredOverviewOutput(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  vpExt: StandardPipelineBuildContext['viewportOutput'],
  vpBucket: import('../viewport-output-contract').ViewportOutputTopologyBucket | undefined,
  targetsValue: Extract<ReturnType<typeof declareDeferredSceneTargets>, { ok: true }>['value'],
  surfacesValue: Extract<ReturnType<typeof addSurfaceStage>, { ok: true }>['value'],
  sceneColor: RenderPipelineTarget,
  overviewEmissiveCopy: RenderPipelineTarget | undefined,
  ssaoView: RenderPipelineTarget | undefined,
  depth: RenderPipelineTarget,
  surfaceValue: Parameters<typeof addStandardDebugOutputPost>[4],
): ReturnType<RenderPipeline['build']> | undefined {
  if (vpExt === undefined || vpBucket !== 'overview') return undefined;
  const debugOut = target(context.graph, 'viewport-debug-output', {
    format: 'rgba16float',
    size: 'surface',
    domain: 'linear-ldr',
  });
  if (!debugOut.ok) return debugOut;
  const vis = vpExt.addVisualizerPass(context.graph, {
    compact: targetsValue.compactGbuffer !== undefined,
    hasScreenAo: ssaoView !== undefined,
    hasReceiverGeometry:
      targetsValue.receiverGeometry !== undefined &&
      (targetsValue.compactGbuffer === undefined || topology.compactReceiver === 'geometry'),
    hasLitColor: true,
    normalRoughness: surfacesValue.normal,
    albedoMetallic: surfacesValue.albedo,
    dielectricSpecular: surfacesValue.f0,
    sceneColor,
    emissiveCopy: overviewEmissiveCopy,
    receiverGeometry: targetsValue.receiverGeometry,
    depth: targetsValue.depthSample,
    screenAo: ssaoView,
    output: debugOut.value,
  });
  if (!vis.ok) return vis;
  return addStandardDebugOutputPost(context, topology, debugOut.value, depth, surfaceValue);
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
  const vpBucket = topology.viewportOutput;
  const vpExt = vpBucket !== undefined ? context.viewportOutput : undefined;
  if (vpExt !== undefined && (vpBucket === 'surface-only' || vpBucket === 'surface-with-ao')) {
    return buildDeferredSurfaceOnlyDebugLane(
      context,
      topology,
      vpExt,
      vpBucket,
      visibleSurfaceEnabled,
    );
  }

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
  const targets = declareDeferredSceneTargets(
    graph,
    topology,
    internalSize,
    visibleSurfaceEnabled,
    context.currentMaterialDepth,
  );
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
    clouds.value.shadow,
  );
  if (!environment.ok) return environment;
  const depthViews = deferredDepthViews(
    context,
    topology,
    targets.value.depthSample,
    internalCopySize,
  );
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const cameraPyramid = addDeferredGBufferPasses(
    context,
    targets.value,
    temporal.value,
    gpuDriven.value,
    internalCopySize,
    depthViews,
    waterInfoTargets,
    topology.materialSceneDepth,
  );
  if (!cameraPyramid.ok) return cameraPyramid;
  const shadows = addLateDeferredShadows(
    context,
    topology,
    reuseAdjacentShadow,
    earlyShadows.value,
    cameraPyramid.value?.pyramid,
  );
  if (!shadows.ok) return shadows;
  const surfaces = addSurfaceStage(context, topology, targets.value, internalSize);
  if (!surfaces.ok) return surfaces;
  const sceneDataProducer = addDeferredSceneDataProducer(
    context,
    targets.value,
    temporal.value,
    gpuDriven.value,
    waterInfoTargets,
  );
  if (!sceneDataProducer.ok) return sceneDataProducer;
  const buildDeferredLightingAndPostStages = () => {
    const ssao = addDeferredScreenAo(
      context,
      topology,
      internalCopySize,
      surfaces.value.normal,
      depth,
      temporal.value.velocity ?? temporal.value.targets?.temporal,
      depthViews.hzb,
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
      cloudShadow: clouds.value.shadow,
      ssao: ssao.value,
      environment: environment.value,
      clusters: clusters.value,
    };
    const baseline = deferredDiffuseGiBaseline(context, temporal.value, internalCopySize);
    if (!baseline.ok) return baseline;

    const vpDebugPrepared = prepareDeferredViewportDebugInputs(
      graph,
      vpExt,
      vpBucket,
      targets.value,
      surfaces.value,
      internalSize,
      internalCopySize,
    );
    if (!vpDebugPrepared.ok) return vpDebugPrepared;
    const { lightingTargets, lightingSurfaces, overviewEmissiveCopy } = vpDebugPrepared.value;

    const lit = addDeferredLightingStage(
      graph,
      topology,
      lightingTargets,
      lightingSurfaces,
      sources,
      internalSize,
      internalCopySize,
      baseline.value,
    );
    if (!lit.ok) return lit;
    const resolveDeferredFullPostStage = (
      ssaoView: typeof ssao.value,
      sources: DeferredLightSources,
      baselineValue: typeof baseline.value,
      overviewEmissiveCopy: RenderPipelineTarget | undefined,
      litValue: typeof lit.value,
    ): Result<
      | {
          readonly kind: 'post';
          readonly color: RenderPipelineTarget;
          readonly options: Parameters<typeof addStandardPost>[5];
        }
      | { readonly kind: 'early'; readonly result: ReturnType<RenderPipeline['build']> },
      RenderPipelineBuildError
    > => {
      const velocity = temporal.value.velocity;
      const projected = projectDeferredTemporal(
        graph,
        temporal.value,
        targets.value.depthSample,
        depthViews,
        internalCopySize,
        needsDeferredTemporalProjection(topology, velocity, baselineValue),
      );
      if (!projected.ok) return projected;
      const mediumTemporal = projected.value;
      const sceneData = addSceneDataConsumers(
        context,
        targets.value,
        surfaces.value,
        mediumTemporal,
        gpuDriven.value,
        depthViews,
        baselineValue,
        litValue,
      );
      if (!sceneData.ok) return sceneData;
      const subsurface = addDeferredSubsurfaceStage(
        graph,
        topology,
        targets.value,
        surfaces.value.normal,
        litValue,
        internalCopySize,
      );
      if (!subsurface.ok) return subsurface;
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
      const waterVelocity = deferredWaterVelocity(topology, mediumTemporal);
      const sceneOutput = addDeferredForwardStages(
        context,
        topology,
        {
          ...targets.value,
          normalRoughness: surfaces.value.normal,
          dielectricSpecular: surfaces.value.f0,
        },
        sources,
        clouds.value,
        gpuDriven.value,
        targetCaptures.value,
        mediumTemporal,
        depthViews,
        waterVelocity,
      );
      if (!sceneOutput.ok) return sceneOutput;
      const overviewOutput = buildDeferredOverviewOutput(
        context,
        topology,
        vpExt,
        vpBucket,
        targets.value,
        surfaces.value,
        sceneOutput.value.color,
        overviewEmissiveCopy,
        ssaoView,
        depth,
        surface.value,
      );
      if (overviewOutput !== undefined) {
        return ok({ kind: 'early', result: overviewOutput });
      }
      const postVelocity =
        topology.water === true
          ? waterVelocity
          : topology.singleLayerMedium === true
            ? undefined
            : velocity;
      const velocityView = postVelocity === undefined ? ok(undefined) : depthViews.sceneView();
      if (!velocityView.ok) return velocityView;
      return ok({
        kind: 'post',
        color: sceneOutput.value.color,
        options: {
          sceneTemporal: postVelocity ?? mediumTemporal.targets?.temporal,
          sceneColorDepth: sceneOutput.value.depth,
          secondaryReactivity: temporalInputs.value.secondaryReactivity,
          coverage: context.targetCoverage?.coverage,
          coverageDepth: context.targetCoverage?.depth,
          opaqueGuide: temporalInputs.value.opaqueGuide,
          waterInfoTargets: standardWaterInfoGraphTargets(
            context,
            context.viewIdentity ?? 'camera:0',
          ),
          gpuDriven: gpuDriven.value,
          waterFoamSimulation: sceneOutput.value.waterFoamSimulation,
          sceneVelocity:
            velocityView.value === undefined
              ? undefined
              : { depth: sceneOutput.value.sampledDepth, view: velocityView.value },
        },
      });
    };
    const resolvedPost =
      vpExt !== undefined && vpBucket === 'lighting-only'
        ? ok({
            kind: 'post' as const,
            color: lightingTargets.scene,
            options: { gpuDriven: gpuDriven.value } as Parameters<typeof addStandardPost>[5],
          })
        : resolveDeferredFullPostStage(
            ssao.value,
            sources,
            baseline.value,
            overviewEmissiveCopy,
            lit.value,
          );
    if (!resolvedPost.ok) return resolvedPost;
    if (resolvedPost.value.kind === 'early') return resolvedPost.value.result;
    return addStandardPost(
      context,
      topology,
      resolvedPost.value.color,
      depth,
      surface.value,
      resolvedPost.value.options,
    );
  };
  return buildDeferredLightingAndPostStages();
}
