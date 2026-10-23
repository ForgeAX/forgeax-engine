import type {
  GraphTextureDescriptor,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { addAtmosphereBackground } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
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
import { FORWARD_PASS_SELECTOR, TRANSMISSION_BACK_PASS_SELECTOR } from '../systems/pass-selector';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  createStandardSceneDataTarget,
  requireStandardTemporalLane,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  standardTransmissionRoute,
} from '../transmission/backdrop';
import type { TransmissionDemand } from '../transmission/projection';
import {
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  type TypedScenePassOptions,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses, type TypedShadowTargets } from '../typed-shadow-passes';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumMsaaPairProducer,
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumMsaaPair,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import type { StandardPipelineBuildContext } from './standard-build-context';
import {
  contributeStandardCloudComposite,
  contributeStandardCloudPreOpaque,
  createStandardCloudSceneTarget,
  createStandardCloudShadowTarget,
} from './standard-cloud-stage';
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
  addStandardPost,
  contributeStandardSceneFeatures,
  type StandardPostSurface,
} from './standard-post';
import { addStandardTransparentPasses } from './standard-transparency';

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

/** The lane's scene attachments, fixed once declared. */
interface ForwardSceneTargets {
  /** Rasterized scene color: the 4x target under MSAA, else `resolved`. */
  readonly color: RenderPipelineTarget;
  /** Single-sample scene color every later stage reads. */
  readonly resolved: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly msaa: boolean;
}

/** Color/depth/resolve attachments every forward scene pass shares. */
function forwardSceneAttachments(scene: ForwardSceneTargets) {
  return {
    color: scene.color,
    depth: scene.depth,
    ...(scene.msaa ? { resolve: scene.resolved } : {}),
  };
}

/** A storage-format scene color whose storage and view formats differ needs the view format. */
function sceneColorViewFormats(topology: RenderPipelineTopology, format: TextureFormat) {
  return format === topology.surface.storageFormat &&
    topology.surface.storageFormat !== topology.surface.viewFormat
    ? { viewFormats: [topology.surface.viewFormat] }
    : {};
}

/**
 * Every non-clear lane keeps a linear float scene target until the shared
 * Output Transform. This includes no-AA, FXAA, MSAA and the no-storage
 * fallback: the final dither and display encoding must have one graph-owned
 * boundary. MSAA resolves into this separate linear target, which the shared
 * Output Transform then writes into the surface storage view. A clear-only
 * frame writes the encoded surface directly.
 */
function declareForwardSceneTargets(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  surface: StandardPostSurface,
  msaa: boolean,
  internalSize: GraphTextureDescriptor['size'],
): Result<ForwardSceneTargets, RenderGraphError> {
  const graph = context.graph;
  const depth = target(graph, 'scene-depth', {
    format: 'depth32float-stencil8',
    size: internalSize,
    sampleCount: msaa ? 4 : 1,
  });
  if (!depth.ok) return depth;
  const sceneFormat = context.forwardOutput?.format ?? 'rgba16float';
  const domain = context.forwardOutput?.domain ?? 'linear-ldr';
  const resolved =
    topology.clearOnly === true
      ? encodedSceneColor(graph, topology, surface)
      : target(graph, 'scene-color', {
          format: sceneFormat,
          size: internalSize,
          sampleCount: 1,
          domain,
          ...sceneColorViewFormats(topology, sceneFormat),
        });
  if (!resolved.ok) return resolved;
  const color = msaa
    ? target(graph, 'scene-color-msaa', {
        format: sceneFormat,
        size: internalSize,
        sampleCount: 4,
        domain,
        ...sceneColorViewFormats(topology, sceneFormat),
      })
    : resolved;
  if (!color.ok) return color;
  return ok({ color: color.value, resolved: resolved.value, depth: depth.value, msaa });
}

/** The surface's display view, or a graph-owned encoded target when it has none. */
function encodedSceneColor(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  surface: StandardPostSurface,
): Result<RenderPipelineTarget, RenderGraphError> {
  if (surface.display !== undefined) return ok(surface.display);
  return target(graph, 'scene-color', {
    format: topology.surface.storageFormat,
    size: 'surface',
    sampleCount: 1,
    domain: 'display-encoded',
  });
}

function declareSingleLayerMediumTargets(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  internalSize: GraphTextureDescriptor['size'],
): Result<SingleLayerMediumNearestTargets | undefined, RenderGraphError> {
  if (topology.singleLayerMedium !== true) return ok(undefined);
  const sampleCount = scene.msaa ? 4 : 1;
  const nearestLayer = target(context.graph, 'single-layer-medium-nearest-layer', {
    format: scene.color.format,
    size: internalSize,
    sampleCount,
    domain: context.forwardOutput?.domain ?? 'linear-ldr',
  });
  if (!nearestLayer.ok) return nearestLayer;
  const nearestDepth = target(context.graph, 'single-layer-medium-nearest-depth', {
    format: 'depth32float-stencil8',
    size: internalSize,
    sampleCount,
  });
  if (!nearestDepth.ok) return nearestDepth;
  return ok({ nearestLayer: nearestLayer.value, nearestDepth: nearestDepth.value });
}

/** Declare and clear the linear-HDR reflection fallback color target when enabled. */
function declareReflectionFallback(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  internalSize: GraphTextureDescriptor['size'],
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (!topology.reflectionFallback?.enabled) return ok(undefined);
  const fallback = target(graph, 'reflection-fallback-linear-hdr', {
    format: 'rgba16float',
    size: internalSize,
    sampleCount: scene.color.sampleCount,
    domain: 'linear-hdr',
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!fallback.ok) return fallback;
  const initialized = graph.addRasterPass('reflection-fallback-clear', {
    accesses: [{ resource: fallback.value.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: fallback.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encode: () => {},
  });
  if (!initialized.ok) return initialized;
  return fallback;
}

function addForwardShadows(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow: boolean,
): Result<TypedShadowTargets, RenderPipelineBuildError> {
  const featureShadows = context.contributeShadowFeatures?.();
  if (featureShadows !== undefined && !featureShadows.ok) return featureShadows;
  return addTypedShadowPasses(context.graph, topology, {
    projectGpuDrivenShadow: context.projectGpuDrivenShadow,
    shadowFeatures: featureShadows?.value,
    staticLayers: context.gpuDrivenShadowDepthLayers,
    depthLayers: context.shadowDepthLayers,
    reuseAdjacentShadow: reuseAdjacentShadow,
  });
}

/** Clustered lighting imports its buffers and builds light membership; other inputs need none. */
function addForwardClusters(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  lighting: StandardTopologyInputValue,
  clearOnly: boolean,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  if (clearOnly) return ok(null);
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok || buffers.value === null) return buffers;
  const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  return buffers;
}

/** The atmosphere sky when enabled, else the skybox; returns the atmosphere environment. */
function addForwardBackground(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
): Result<GraphEnvironment | undefined, RenderGraphError> {
  if (topology.atmosphere === true) return addAtmosphereBackground(graph, color);
  const skybox = addTypedSkyboxPass(graph, color);
  if (!skybox.ok) return skybox;
  return ok(undefined);
}

function projectForwardGpuDriven(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
  reflectionFallback: RenderPipelineTarget | undefined,
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  return context.projectGpuDriven({
    format: color.format,
    sampleCount: color.sampleCount,
    lateOcclusion: topology.config?.gpuOcclusion !== false,
    ...(reflectionFallback === undefined
      ? {}
      : { additionalColorFormats: [reflectionFallback.format] }),
  });
}

/** The early opaque pass, then the HZB-tested late pass when late occlusion is admitted. */
function addForwardOpaquePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  mainOptions: TypedScenePassOptions,
  scene: ForwardSceneTargets,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  const main = addTypedScenePass(graph, mainOptions);
  if (!main.ok) return main;
  const depthSample = graph.view(scene.depth.texture, {
    label: 'occlusion-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const late = addGpuLateOcclusion(graph, {
    gpuDriven,
    depth: depthSample.value,
    multisampled: scene.msaa,
    width: copySize.width,
    height: copySize.height,
    view: sceneViewImport(graph),
  });
  if (!late.ok) return late;
  if (late.value === undefined) return ok(undefined);
  const mainLate = addTypedScenePass(graph, {
    ...mainOptions,
    name: 'main-late',
    depthLoadOp: 'load',
    gpuDrivenPhase: 'late',
  });
  if (!mainLate.ok) return mainLate;
  return ok(undefined);
}

/** Admit the temporal lane, then produce scene data and target coverage for it. */
function addForwardSceneData(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  temporalDemand: ReturnType<typeof aggregateTemporalDemand>,
  depth: RenderPipelineTarget,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
): Result<RenderPipelineTarget | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const temporalAdmission = requireStandardTemporalLane({
    demand: temporalDemand,
    compute: topology.lane.compute,
    storageBuffer: topology.lane.storageBuffer,
    rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
  });
  if (!temporalAdmission.ok) return temporalAdmission;
  let temporal: RenderPipelineTarget | undefined;
  if (temporalDemand.targetCount === 1) {
    const created = createStandardSceneDataTarget(graph, topology.extent);
    if (!created.ok) return created;
    temporal = created.value.temporal;
    const producer = addStandardSceneDataPass(graph, temporal, depth, gpuDriven);
    if (!producer.ok) return producer;
  }
  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(graph, context.targetCoverage, gpuDriven);
    if (!coverage.ok) return coverage;
  }
  return ok(temporal);
}

/** Opaque/translucent scene-pass inputs every forward scene pass shares. */
type ForwardScenePassTemplate = {
  readonly environment: GraphEnvironment | undefined;
} & StandardForwardReceiverInputs;

/**
 * Sorted transmission draws the back faces of transmitting surfaces over
 * their own backdrop, then the translucent prefix up to the first
 * transmitting draw, after the farther sorted surfaces.
 */
function addSortedTransmissionPrefix(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  template: ForwardScenePassTemplate,
  demand: TransmissionDemand,
): Result<void, RenderGraphError> {
  const graph = context.graph;
  if (demand.needsBackPass === true) {
    const backdrop = addTransmissionBackdropPasses({
      graph,
      name: 'transmission-backdrop-backs',
      source: scene.resolved,
      demand,
      copySize: renderInternalCopySize(topology),
      surfaceSize: topology.surface,
      encodeRoughMip: context.encodeTransmissionMip,
      includeConsumerPasses: false,
    });
    if (!backdrop.ok) return backdrop;
    const backs = addTypedScenePass(graph, {
      ...template,
      name: 'transmission-backs',
      ...forwardSceneAttachments(scene),
      selector: TRANSMISSION_BACK_PASS_SELECTOR,
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode: 'transmission',
      transparentDepthWrite: true,
      transmissionBackdrop: backdrop.value.backdrop?.view,
    });
    if (!backs.ok) return backs;
  }
  const prefix = addTypedScenePass(graph, {
    ...template,
    name: 'transparent-before-transmission',
    ...forwardSceneAttachments(scene),
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    recordMode: 'translucent-before-transmission',
    transparentDepthWrite: true,
  });
  if (!prefix.ok) return prefix;
  return ok(undefined);
}

/** Shade the single-layer medium over the shared opaque backdrop and raw depth. */
function addForwardSingleLayerMedium(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  medium: ForwardMediumInputs,
  backdrop: GraphTextureView | undefined,
  receiver: StandardForwardReceiverInputs,
): Result<void, RenderGraphError> {
  const inputs = requireSingleLayerMediumInputs(medium.nearestTargets, backdrop);
  if (!inputs.ok) return inputs;
  const internalSize = renderInternalSize(topology);
  let rawDepthTarget: RenderPipelineTarget | undefined = medium.opaquePair?.depth;
  if (rawDepthTarget === undefined) {
    const rawDepth = addSingleLayerMediumRawDepthProducer({
      graph,
      sourceColor: scene.resolved,
      sourceDepth: scene.depth,
      size: internalSize,
    });
    if (!rawDepth.ok) return rawDepth;
    rawDepthTarget = rawDepth.value;
  }
  const surfacePair: RenderPipelineSurfaceMediumPair = {
    opaqueColor: medium.opaquePair?.color.view ?? inputs.value.backdrop,
    rawDepth: { status: 'available', view: rawDepthTarget.view },
  };
  return addSingleLayerMediumPasses({
    graph,
    size: internalSize,
    ...inputs.value.nearestTargets,
    color: scene.color,
    ...(scene.msaa ? { colorResolve: scene.resolved } : {}),
    depth: scene.depth,
    ...receiver,
    extraAccesses: [
      ...receiver.extraAccesses,
      ...(medium.targetCaptures === undefined
        ? []
        : [{ resource: medium.targetCaptures, usage: 'sampled-read' as const }]),
    ],
    surfacePair,
    ...(medium.gpuDriven === undefined ? {} : { gpuDriven: medium.gpuDriven }),
  });
}

/** Transmission routing: which backdrop copies and transmitting passes this frame admits. */

/** Inputs only the single-layer medium consumes. */
interface ForwardMediumInputs {
  readonly nearestTargets: SingleLayerMediumNearestTargets | undefined;
  readonly opaquePair: SingleLayerMediumMsaaPair | undefined;
  readonly targetCaptures: GraphTextureView | undefined;
  readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
}

/**
 * Analytic fog composites onto the opaque scene before transmission copies
 * and translucent draws. Every translucent writer then fogs itself at its own
 * depth, so blending composes depth-correctly.
 */
function addForwardTranslucentStages(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  medium: ForwardMediumInputs,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const fogged = addOpaqueFogPasses(graph, { topology, color: scene.resolved, depth: scene.depth });
  if (!fogged.ok) return fogged;
  const transmission = standardTransmissionRoute(topology, scene.color.sampleCount);
  const template = { environment, ...receiver };
  if (transmission.sorted) {
    const prefix = addSortedTransmissionPrefix(
      context,
      topology,
      scene,
      template,
      transmission.demand,
    );
    if (!prefix.ok) return prefix;
  }
  const backdrop = addTransmissionBackdropPasses({
    graph,
    source: scene.resolved,
    demand: transmission.backdropDemand,
    copySize: renderInternalCopySize(topology),
    surfaceSize: topology.surface,
    encodeRoughMip: context.encodeTransmissionMip,
    includeConsumerPasses: false,
  });
  if (!backdrop.ok) return backdrop;
  const backdropView = backdrop.value.backdrop?.view;
  if (topology.singleLayerMedium === true) {
    const mediumPasses = addForwardSingleLayerMedium(
      graph,
      topology,
      scene,
      medium,
      backdropView,
      receiver,
    );
    if (!mediumPasses.ok) return mediumPasses;
  }
  if (transmission.backdropActive && transmission.transmissionActive) {
    const transmissionPass = addTypedScenePass(graph, {
      ...template,
      name: 'transmission-forward',
      ...forwardSceneAttachments(scene),
      selector: FORWARD_PASS_SELECTOR,
      colorLoadOp: 'load',
      depthLoadOp: 'load',
      recordMode: transmission.sorted ? 'translucent' : 'transmission',
      transparentDepthWrite: true,
      // Inject the complete backdrop view so the Standard shader can select
      // the producer's optional roughness mip level. mipViews[0] is only the
      // copy destination view and intentionally exposes one level.
      transmissionBackdrop: backdropView,
    });
    if (!transmissionPass.ok) return transmissionPass;
  }
  if (!transmission.sorted) {
    const transparentPass = addStandardTransparentPasses(graph, {
      color: scene.color,
      ...(scene.msaa ? { resolve: scene.resolved } : {}),
      depth: scene.depth,
      size: renderInternalSize(topology),
      transparency: topology.transparency,
      template,
    });
    if (!transparentPass.ok) return transparentPass;
  }
  if (transmission.backdropActive) {
    const temporal = addTransmissionBackdropTemporalPass(graph, scene.resolved);
    if (!temporal.ok) return temporal;
  }
  return ok(undefined);
}

/** Lane facts derived once from the camera and surface. */
function forwardLaneRoute(topology: RenderPipelineTopology) {
  const clearOnly = topology.clearOnly === true;
  const camera = topology.camera;
  return {
    clearOnly,
    msaa: !clearOnly && camera.antialias === 'msaa' && topology.lane.multisample,
    hdr: !clearOnly && (camera.tonemap !== 'none' || camera.antialias === 'taa'),
    temporalDemand: aggregateTemporalDemand({
      taa: !clearOnly && camera.antialias === 'taa',
      motionBlur: !clearOnly && topology.temporal?.motionBlur === true,
    }),
  };
}

/** The opaque passes, the MSAA medium backdrop pair and the cloud composite over them. */
function addForwardOpaqueStage(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  mainOptions: TypedScenePassOptions,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  cloud: {
    readonly scene: RenderPipelineTarget | undefined;
    readonly shadow: RenderPipelineTarget | undefined;
    readonly featureTargets: readonly RenderPipelineFeatureTarget[];
  },
): Result<SingleLayerMediumMsaaPair | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const opaque = addForwardOpaquePasses(
    graph,
    mainOptions,
    scene,
    gpuDriven,
    renderInternalCopySize(topology),
  );
  if (!opaque.ok) return opaque;
  const opaquePair =
    topology.singleLayerMedium === true && scene.msaa
      ? addSingleLayerMediumMsaaPairProducer({
          graph,
          label: 'single-layer-medium-opaque-resolve',
          sourceColor: scene.color,
          sourceDepth: scene.depth,
          size: renderInternalSize(topology),
        })
      : ok(undefined);
  if (!opaquePair.ok) return opaquePair;
  if (cloud.scene !== undefined) {
    const compositeFeatures = contributeStandardCloudComposite(
      context,
      cloud.featureTargets,
      { input: scene.resolved, output: cloud.scene, cloudShadow: cloud.shadow },
      [],
    );
    if (!compositeFeatures.ok) return compositeFeatures;
  }
  return opaquePair;
}

/** The cloud composite replaces both scene color targets read by later stages. */
function sceneAfterCloudComposite(
  scene: ForwardSceneTargets,
  cloudScene: RenderPipelineTarget | undefined,
): ForwardSceneTargets {
  return cloudScene === undefined ? scene : { ...scene, color: cloudScene, resolved: cloudScene };
}

/** CloudLayer's resolved scene color (single-sample lanes only) and receiver shadow. */
function declareForwardCloudTargets(
  context: StandardPipelineBuildContext,
  scene: ForwardSceneTargets,
  route: ReturnType<typeof forwardLaneRoute>,
  internalSize: GraphTextureDescriptor['size'],
): Result<
  {
    readonly scene: RenderPipelineTarget | undefined;
    readonly shadow: RenderPipelineTarget | undefined;
  },
  RenderGraphError
> {
  const featureRasterWork =
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const cloudScene = createStandardCloudSceneTarget(context, featureRasterWork && !route.msaa, {
    format: scene.resolved.format,
    size: internalSize,
    domain: route.hdr ? 'linear-hdr' : 'linear-ldr',
  });
  if (!cloudScene.ok) return cloudScene;
  const cloudShadow = createStandardCloudShadowTarget(context, featureRasterWork);
  if (!cloudShadow.ok) return cloudShadow;
  return ok({ scene: cloudScene.value, shadow: cloudShadow.value });
}

function forwardMainPassOptions(
  scene: ForwardSceneTargets,
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  reflectionFallback: RenderPipelineTarget | undefined,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
): TypedScenePassOptions {
  return {
    environment,
    name: 'main',
    color: scene.color,
    ...(reflectionFallback === undefined
      ? {}
      : { colorTargets: [scene.color, reflectionFallback] }),
    depth: scene.depth,
    ...(scene.msaa ? { resolve: scene.resolved } : {}),
    ...receiver,
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    // Opaque, transmission and ordinary transparency are separate queue
    // segments. Keeping the opaque filter unconditional prevents an
    // ordinary transparent material from being drawn before the cloud pass.
    recordMode: 'opaque',
    gpuDrivenFilter: 'opaque',
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
  };
}

export function buildStandardForwardLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize = renderInternalSize(topology);
  const route = forwardLaneRoute(topology);
  const scene = declareForwardSceneTargets(
    context,
    topology,
    surface.value,
    route.msaa,
    internalSize,
  );
  if (!scene.ok) return scene;
  const mediumTargets = declareSingleLayerMediumTargets(
    context,
    topology,
    scene.value,
    internalSize,
  );
  if (!mediumTargets.ok) return mediumTargets;
  const reflectionFallback = declareReflectionFallback(graph, topology, scene.value, internalSize);
  if (!reflectionFallback.ok) return reflectionFallback;
  const shadows = addForwardShadows(context, topology, reuseAdjacentShadow);
  if (!shadows.ok) return shadows;
  const clusterBuffers = addForwardClusters(graph, lighting, route.clearOnly);
  if (!clusterBuffers.ok) return clusterBuffers;
  const atmosphere = addForwardBackground(graph, topology, scene.value.color);
  if (!atmosphere.ok) return atmosphere;
  const gpuDriven = projectForwardGpuDriven(
    context,
    topology,
    scene.value.color,
    reflectionFallback.value,
  );
  if (!gpuDriven.ok) return gpuDriven;
  const cloud = declareForwardCloudTargets(context, scene.value, route, internalSize);
  if (!cloud.ok) return cloud;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  // Produce the density cache and spatial receiver shadow before opaque
  // shading. The cloud composite is a later scene pass, so it cannot be
  // projected in this call without being overwritten by `main`.
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: scene.value.resolved,
    depth: scene.value.depth,
    cloudShadow: cloud.value.shadow,
  });
  if (!featureTargets.ok) return featureTargets;
  const receiver = standardForwardReceiverInputs({
    shadows: shadows.value,
    cloudShadow: cloud.value.shadow,
    clusterReads:
      clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value),
  });
  const mainOptions = forwardMainPassOptions(
    scene.value,
    atmosphere.value,
    receiver,
    reflectionFallback.value,
    gpuDriven.value,
  );
  const opaquePair = addForwardOpaqueStage(
    context,
    topology,
    scene.value,
    mainOptions,
    gpuDriven.value,
    {
      scene: cloud.value.scene,
      shadow: cloud.value.shadow,
      featureTargets: featureTargets.value,
    },
  );
  if (!opaquePair.ok) return opaquePair;
  const temporal = addForwardSceneData(
    context,
    topology,
    route.temporalDemand,
    scene.value.depth,
    gpuDriven.value,
  );
  if (!temporal.ok) return temporal;
  const later = sceneAfterCloudComposite(scene.value, cloud.value.scene);
  const translucent = addForwardTranslucentStages(
    context,
    topology,
    later,
    atmosphere.value,
    receiver,
    {
      nearestTargets: mediumTargets.value,
      opaquePair: opaquePair.value,
      targetCaptures: targetCaptures?.value,
      gpuDriven: gpuDriven.value,
    },
  );
  if (!translucent.ok) return translucent;
  // The local froxel volume composites after every translucent writer (see
  // addTranslucencyVolumetricFogPasses).
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    color: later.resolved,
    depth: later.depth,
    directionalShadow: shadows.value.directional?.view,
    spotShadow: shadows.value.spot.view,
    clusterBuffers: clusterBuffers.value,
    cloudShadow: cloud.value.shadow?.view,
  });
  if (!volume.ok) return volume;
  const observed = addForwardSceneObservations(
    context,
    topology,
    later,
    receiver,
    reflectionFallback.value,
  );
  if (!observed.ok) return observed;
  return presentForwardLane(context, topology, later, surface.value, temporal.value);
}

/**
 * Project the remaining generic post features after every scene producer has
 * finished. The forward lane may have replaced the scene target with the
 * cloud-resolved target; keep the MSAA resolve target paired with that final
 * color target so feature attachments observe the same surface that the
 * Standard observation reads.
 */
function addForwardSceneObservations(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  receiver: StandardForwardReceiverInputs,
  reflectionFallback: RenderPipelineTarget | undefined,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const features = contributeStandardSceneFeatures(
    context,
    {
      color: scene.color,
      colorResolve: scene.msaa ? scene.resolved.view : undefined,
      depth: scene.depth,
    },
    standardForwardReceiverFeatureAccesses(receiver),
  );
  if (!features.ok) return features;
  // Every non-clear lane keeps its linear scene target until the Output Transform.
  if (context.forwardOutput === undefined && topology.clearOnly !== true) {
    const observation = addTypedFrameObservationPass(graph, scene.resolved);
    if (!observation.ok) return observation;
  }
  if (reflectionFallback?.sampleCount === 1) {
    const fallbackObservation = addReflectionFallbackObservationPass(graph, reflectionFallback);
    if (!fallbackObservation.ok) return fallbackObservation;
  }
  return ok(undefined);
}

/** A custom forward output owns presentation; otherwise the shared Standard post chain does. */
function presentForwardLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  surface: StandardPostSurface,
  temporal: RenderPipelineTarget | undefined,
): ReturnType<RenderPipeline['build']> {
  if (context.forwardOutput !== undefined)
    return context.forwardOutput.build(context, topology, scene.resolved, scene.depth, surface);
  const post = addStandardPost(
    context,
    topology,
    scene.resolved,
    scene.depth,
    surface,
    temporal,
    undefined,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
  );
  if (!post.ok) return post;
  return ok(undefined);
}
