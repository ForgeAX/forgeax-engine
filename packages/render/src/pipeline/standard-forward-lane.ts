import {
  type GraphBuffer,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  type RenderGraphError,
  RenderGraphError as RenderGraphFailure,
} from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import { addProjectedDecalChannels, type ProjectedDecalChannels } from '../decals/graph';
import { addStandardAtmosphere } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import type { GraphAtmosphere } from '../environment/luts';
import { MOTION_BLUR_FEATURE_IDENTITY } from '../features/motion-blur/motion-blur-feature';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
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
import { ssaoUsesLighting } from '../ssao-config';
import { FORWARD_PASS_SELECTOR, TRANSMISSION_BACK_PASS_SELECTOR } from '../systems/pass-selector';
import {
  addDefaultDepthPrepass,
  addDefaultDepthVelocity,
  addDefaultVelocityTemporalProjection,
  createDefaultVelocityTarget,
  type SceneVelocityInputs,
} from '../temporal/default-gbuffer-velocity';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
} from '../temporal/scene-data';
import {
  addStandardSceneDataPass,
  addStandardSceneSurfaceDataPass,
  aggregateTemporalDemand,
  bindStandardSceneDataTarget,
  createStandardSceneDataTarget,
  createStandardSceneSurfaceDepthTarget,
  requireStandardTemporalLane,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import { addTransmissionBackdropPasses, standardTransmissionRoute } from '../transmission/backdrop';
import type { TransmissionDemand } from '../transmission/projection';
import { addTsrOpaqueGuide } from '../tsr/opaque';
import type { TemporalSecondaryReactivity } from '../typed-render-graph-primitives';
import {
  addReflectionFallbackObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  type TypedScenePassOptions,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses, type TypedShadowTargets } from '../typed-shadow-passes';
import { addWaterFluidGraph } from '../water/fluid-graph';
import { addWaterSlwPasses } from '../water/slw-graph';
import {
  addOpaqueFogPasses,
  addTranslucencyVolumetricFogPasses,
  forwardOpaqueFogSplit,
} from './analytic-fog-pass';
import { addForwardDirectionalShadow, type ForwardInlineSsao } from './forward-directional-shadow';
import { addForwardScreenData } from './forward-screen-data';
import { FORWARD_SHADOW_COLOR_ENTRY, isForwardShadowColorEntry } from './forward-shadow-admission';
import { sceneViewImport } from './gpu-occlusion';
import { addMsaaNearestDepthResolve } from './msaa-depth-resolve';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumMsaaPairProducer,
  addSingleLayerMediumMsaaSurfaceProducer,
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  declareSingleLayerMediumTargets,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumMsaaPair,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import {
  contributeStandardAfterDepthFeatures,
  type StandardPipelineBuildContext,
  standardWaterInfoGraphTargets,
} from './standard-build-context';
import {
  contributeStandardCloudComposite,
  declareStandardCloudPhase,
  type StandardCloudPhase,
} from './standard-cloud-stage';
import {
  type StandardForwardReceiverInputs,
  standardForwardReceiverFeatureAccesses,
  standardForwardReceiverInputs,
} from './standard-forward-receiver';
import { addForwardSsr } from './standard-forward-ssr';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  type StandardClusterGraphBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import type { StandardClusterTextureExtent } from './standard-lighting/texture';
import type { StandardTopologyInputValue } from './standard-lighting/topology';
import {
  addStandardPost,
  contributeStandardSceneFeatures,
  type StandardPostSurface,
} from './standard-post';
import { addScreenSsaoParameters, addStandardScreenSsao } from './standard-screen-ssao';
import {
  addCurrentStandardTranslucency,
  addStandardTransparentPasses,
} from './standard-transparency';
import { type ReadViewHzb, viewHzb } from './standard-view-hzb';

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

/** The lane's scene attachments, fixed once declared. */
export interface ForwardSceneTargets {
  /** Rasterized scene color: the 4x target under MSAA, else `resolved`. */
  readonly color: RenderPipelineTarget;
  /** Single-sample scene color every later stage reads. */
  readonly resolved: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
  readonly msaa: boolean;
  readonly waterFoamSimulation?: GraphTextureView;
}

/** Color/depth/resolve attachments every forward scene pass shares. */
export function forwardSceneAttachments(scene: ForwardSceneTargets) {
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
export function declareForwardSceneTargets(
  context: Pick<StandardPipelineBuildContext, 'graph' | 'forwardOutput' | 'currentMaterialDepth'>,
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
    topology.clearOnly === true && context.forwardOutput?.samplesClearColor !== true
      ? encodedSceneColor(graph, topology, surface)
      : createRenderPipelineTarget(graph, 'scene-color', {
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
  return ok({
    color: color.value,
    resolved: resolved.value,
    depth: context.currentMaterialDepth
      ? { ...depth.value, currentMaterialDepthExtent: renderInternalCopySize(topology) }
      : depth.value,
    msaa,
  });
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

interface ForwardReflectionTarget {
  readonly attachment: RenderPipelineTarget;
  readonly sampled: RenderPipelineTarget;
}

/** All Forward reflection MRTs resolve through the existing per-target graph contract. */
function declareForwardReflectionTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: 'reflection-fallback' | 'reflection-response' | 'reflection-surface',
  enabled: boolean,
  scene: ForwardSceneTargets,
  internalSize: GraphTextureDescriptor['size'],
): Result<ForwardReflectionTarget | undefined, RenderGraphError> {
  if (!enabled) return ok(undefined);
  const sampled = target(graph, `${name}-linear-hdr`, {
    format: 'rgba16float',
    size: internalSize,
    sampleCount: 1,
    domain: 'linear-hdr',
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!sampled.ok) return sampled;
  const color = scene.msaa
    ? target(graph, `${name}-linear-hdr-msaa`, {
        format: 'rgba16float',
        size: internalSize,
        sampleCount: 4,
        domain: 'linear-hdr',
      })
    : sampled;
  if (!color.ok) return color;
  const attachment = scene.msaa
    ? { ...color.value, resolveTarget: sampled.value.view }
    : color.value;
  return ok({ attachment, sampled: sampled.value });
}

function addForwardShadows(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  reuseAdjacentShadow: boolean,
): Result<TypedShadowTargets, RenderPipelineBuildError> {
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
    staticLayers: context.gpuDrivenShadowDepthLayers,
    depthLayers: context.shadowDepthLayers,
    reuseAdjacentShadow: reuseAdjacentShadow,
  });
}

/** Clustered lighting imports its buffers and builds light membership; other inputs need none. */
function addForwardClusters(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  clearOnly: boolean,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  if (clearOnly && !(topology.atmosphere === true && topology.atmosphereBackgroundOnly !== true))
    return ok(null);
  const buffers = importStandardClusterBuffers(
    graph,
    lighting,
    forwardClusterTextureExtent(topology, lighting),
  );
  if (!buffers.ok || buffers.value === null) return buffers;
  const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  return buffers;
}

export function forwardClusterTextureExtent(
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
): StandardClusterTextureExtent | undefined {
  // Both transports address the atlas in the Cluster uniform. These are the
  // dimensions of one tile, as used by the producer and sampled by the shader.
  const screen =
    forwardScreenDemand(topology) && topology.forwardDirectionalShadow?.mode !== 'screen'
      ? renderInternalCopySize(topology)
      : undefined;
  const atmosphere =
    lighting.kind === 'clustered' &&
    lighting.transport.kind === 'cpu-texture' &&
    topology.atmosphere === true &&
    topology.atmosphereBackgroundOnly !== true;
  if (screen === undefined && !atmosphere) return undefined;
  return {
    ...(screen === undefined ? {} : { screen }),
    ...(atmosphere ? { atmosphere: true } : {}),
  };
}

interface ForwardSsaoProjection {
  /** Exact scene attachment rasterized by the primary depth producer. */
  readonly predepth?: RenderPipelineTarget;
  /** Single-sample screen depth, produced only when a consumer actually reads it. */
  readonly screenDepth?: RenderPipelineTarget | undefined;
  readonly temporal?: RenderPipelineTarget | undefined;
  readonly decals?: ProjectedDecalChannels | undefined;
  readonly hzb?: ReadViewHzb | undefined;
  readonly hzbDepth?: RenderPipelineTarget | undefined;
  readonly ao: RenderPipelineTarget | undefined;
  readonly inlineAo?: ForwardInlineSsao | undefined;
}

function forwardScreenDemand(topology: RenderPipelineTopology): boolean {
  return (
    topology.forwardContactShadows === true ||
    topology.forwardCapsuleShadows === true ||
    (topology.projectedDecals?.length ?? 0) > 0
  );
}

function addForwardSurfaceDecals(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  sceneDepth: RenderPipelineTarget,
  size: { width: number; height: number },
) {
  const decals = topology.projectedDecals ?? [];
  if (decals.length === 0) return ok(undefined);
  const depth = context.graph.view(sceneDepth.texture, {
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depth.ok) return depth;
  return addProjectedDecalChannels(context.graph, decals, { depth: depth.value, size });
}

function addForwardDepthVelocity(
  graph: StandardPipelineBuildContext['graph'],
  depth: RenderPipelineTarget,
  velocity: RenderPipelineTarget,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
) {
  const staticDepth = addDefaultDepthPrepass(graph, depth, gpuDriven !== undefined);
  if (!staticDepth.ok) return staticDepth;
  return addDefaultDepthVelocity(graph, depth, velocity, gpuDriven, 'forward');
}

function addForwardCenterDepth(
  context: StandardPipelineBuildContext,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  sceneDepth: RenderPipelineTarget,
  dimensions: { readonly width: number; readonly height: number },
  required: boolean,
  velocity?: RenderPipelineTarget,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const multisampled = sceneDepth.sampleCount > 1;
  let screenDepth = multisampled ? undefined : sceneDepth;
  if (multisampled && required) {
    const created = createStandardSceneSurfaceDepthTarget(context.graph, dimensions);
    if (!created.ok) return created;
    screenDepth = created.value;
    const semantic =
      velocity === undefined
        ? addStandardSceneSurfaceDataPass(
            context.graph,
            screenDepth,
            gpuDriven,
            'standard-scene-surface-center',
          )
        : addForwardDepthVelocity(context.graph, screenDepth, velocity, gpuDriven);
    if (!semantic.ok) return semantic;
  }
  return ok(screenDepth);
}

function addForwardSurfaceData(
  context: StandardPipelineBuildContext,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  sceneDepth: RenderPipelineTarget,
  aoEnabled: boolean,
  displayDepth: 'prepass' | undefined,
  velocity: RenderPipelineTarget | undefined,
  msaaTemporal: RenderPipelineTarget | undefined,
  multisampled: boolean,
): Result<void, RenderGraphError> {
  if (msaaTemporal !== undefined) {
    const written = addStandardSceneDataPass(
      context.graph,
      msaaTemporal,
      sceneDepth,
      gpuDriven,
      'opaque',
      undefined,
      undefined,
      true,
    );
    return written.ok ? ok(undefined) : written;
  }
  if (multisampled || velocity === undefined) {
    const produced = addStandardSceneSurfaceDataPass(
      context.graph,
      sceneDepth,
      gpuDriven,
      'standard-scene-surface-data',
      aoEnabled ? undefined : displayDepth,
    );
    return produced.ok ? ok(undefined) : produced;
  }
  const motion = addForwardDepthVelocity(context.graph, sceneDepth, velocity, gpuDriven);
  return motion.ok ? ok(undefined) : motion;
}

function addForwardResolvedScreenDepth(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  sceneDepth: RenderPipelineTarget,
  dimensions: { readonly width: number; readonly height: number },
  temporalDepthRequired: boolean,
  screenDepthRequired: boolean,
  aoEnabled: boolean,
  nativeHzb: boolean,
  multisampled: boolean,
  velocity: RenderPipelineTarget | undefined,
  resolveTemporal: RenderPipelineTarget | undefined,
  needsSceneDataDepth: boolean,
): Result<
  {
    readonly screenDepth: RenderPipelineTarget | undefined;
    readonly temporal: RenderPipelineTarget | undefined;
  },
  RenderGraphError
> {
  const canResolveDepth = topology.lane.storageBuffer;
  const centered = addForwardCenterDepth(
    context,
    gpuDriven,
    sceneDepth,
    dimensions,
    temporalDepthRequired ||
      (!canResolveDepth &&
        (screenDepthRequired || (aoEnabled && !nativeHzb) || topology.inlineSsr === true)),
    multisampled ? velocity : undefined,
  );
  if (!centered.ok) return centered;
  const needsResolve =
    multisampled &&
    centered.value === undefined &&
    (screenDepthRequired || (!nativeHzb && (aoEnabled || topology.inlineSsr === true)));
  const resolved = needsResolve
    ? addMsaaNearestDepthResolve(
        context.graph,
        sceneDepth,
        dimensions,
        'forward-screen-depth-resolve',
        {
          temporal: resolveTemporal,
          ...(needsSceneDataDepth ? { format: 'depth32float-stencil8' as const } : {}),
        },
      )
    : ok(undefined);
  if (!resolved.ok) return resolved;
  return ok({
    screenDepth: resolved.value?.depth ?? centered.value,
    temporal: resolved.value?.temporal,
  });
}

function forwardNeedsEarlyDepth(
  topology: RenderPipelineTopology,
  aoEnabled: boolean,
  screenDepthRequired: boolean,
  inputs: {
    readonly temporalDepthRequired: boolean;
    readonly velocity: RenderPipelineTarget | undefined;
    readonly msaaTemporal: RenderPipelineTarget | undefined;
    readonly displayDepth: 'prepass' | undefined;
  },
): boolean {
  return (
    aoEnabled ||
    screenDepthRequired ||
    topology.forwardDirectionalShadow?.mode === 'screen' ||
    topology.inlineSsr === true ||
    topology.materialSceneDepth === true ||
    topology.water === true ||
    inputs.temporalDepthRequired ||
    inputs.velocity !== undefined ||
    inputs.msaaTemporal !== undefined ||
    // The display lane has its own per-frame depth-write admission.
    inputs.displayDepth !== undefined
  );
}

/** Primary depth is the scene attachment; semantic consumers get only their required outputs. */
export function addForwardSsao(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  clearOnly: boolean,
  sceneDepth: RenderPipelineTarget,
  temporalDepthRequired: boolean,
  displayDepth?: 'prepass',
  velocity?: RenderPipelineTarget,
  msaaTemporal?: RenderPipelineTarget,
): Result<ForwardSsaoProjection, RenderGraphError> {
  if (clearOnly) return ok({ ao: undefined });
  const aoEnabled = ssaoUsesLighting(topology.config?.ambientOcclusion);
  const needsSceneDataDepth =
    topology.sceneDataBindings?.some(
      (binding) => binding.schema === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
    ) === true;
  const receiver = topology.forwardDirectionalShadow;
  const resolveTemporal = topology.water === true ? undefined : msaaTemporal;
  const screenDepthRequired =
    resolveTemporal !== undefined ||
    needsSceneDataDepth ||
    forwardScreenDemand(topology) ||
    (topology.inlineSsr !== true && topology.ssr?.status === 'admitted') ||
    (aoEnabled && !(receiver?.mode === 'screen' && receiver.ambientOcclusion === true));
  if (
    !forwardNeedsEarlyDepth(topology, aoEnabled, screenDepthRequired, {
      temporalDepthRequired,
      velocity,
      msaaTemporal,
      displayDepth,
    })
  )
    return ok({ ao: undefined });
  const nativeHzb = topology.lane.compute && topology.lane.storageTexture !== false;
  const dimensions = renderInternalCopySize(topology);
  const multisampled = sceneDepth.sampleCount > 1;
  const surfaceData = addForwardSurfaceData(
    context,
    gpuDriven,
    sceneDepth,
    aoEnabled,
    displayDepth,
    velocity,
    msaaTemporal,
    multisampled,
  );
  if (!surfaceData.ok) return surfaceData;
  const resolved = addForwardResolvedScreenDepth(
    context,
    topology,
    gpuDriven,
    sceneDepth,
    dimensions,
    temporalDepthRequired,
    screenDepthRequired,
    aoEnabled,
    nativeHzb,
    multisampled,
    velocity,
    resolveTemporal,
    needsSceneDataDepth,
  );
  if (!resolved.ok) return resolved;
  const { screenDepth } = resolved.value;
  const decals = addForwardSurfaceDecals(context, topology, screenDepth ?? sceneDepth, dimensions);
  if (!decals.ok) return decals;
  const lighting = addForwardAoAndHzb(context, topology, sceneDepth, screenDepth, dimensions);
  if (!lighting.ok) return lighting;
  return ok({
    ...lighting.value,
    predepth: sceneDepth,
    screenDepth,
    temporal: resolved.value.temporal,
    ...(decals.value === undefined ? {} : { decals: decals.value }),
  });
}

function addForwardAoAndHzb(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  sceneDepth: RenderPipelineTarget,
  screenDepth: RenderPipelineTarget | undefined,
  size: { readonly width: number; readonly height: number },
): Result<Pick<ForwardSsaoProjection, 'ao' | 'inlineAo' | 'hzb' | 'hzbDepth'>, RenderGraphError> {
  const aoEnabled = ssaoUsesLighting(topology.config?.ambientOcclusion);
  const ssr = topology.inlineSsr === true || topology.ssr?.status === 'admitted';
  if (!aoEnabled && !ssr) return ok({ ao: undefined });
  const hzbDepth = screenDepth ?? sceneDepth;
  const depth = context.graph.view(hzbDepth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!depth.ok) return depth;
  const hzb = viewHzb(
    context,
    topology,
    depth.value,
    size,
    ssr ? undefined : 1,
    undefined,
    hzbDepth.sampleCount > 1,
  );
  if (!aoEnabled) return ok({ ao: undefined, hzb, hzbDepth });
  const receiver = topology.forwardDirectionalShadow;
  if (receiver?.mode === 'screen' && receiver.ambientOcclusion) {
    const pyramid = hzb();
    if (!pyramid.ok) return pyramid;
    const parameters = addScreenSsaoParameters(context, topology, size, 0);
    if (!parameters.ok) return parameters;
    return ok({
      ao: undefined,
      inlineAo: { parameters: parameters.value, hzb: pyramid.value.levels[0] as GraphTextureView },
      hzb,
      hzbDepth,
    });
  }
  const ao = addStandardScreenSsao(context, topology, { depth: hzbDepth, size, hzb });
  return ao.ok ? ok({ ao: ao.value, hzb, hzbDepth }) : ao;
}

function projectForwardGpuDriven(
  context: StandardPipelineBuildContext,
  color: RenderPipelineTarget,
  reflectionFallback: RenderPipelineTarget | undefined,
  reflectionResponse: RenderPipelineTarget | undefined,
  reflectionSurface: RenderPipelineTarget | undefined,
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  return context.projectGpuDriven({
    format: color.format,
    sampleCount: color.sampleCount,
    ...(reflectionFallback === undefined
      ? {}
      : {
          additionalColorFormats: [
            reflectionFallback.format,
            ...(reflectionResponse === undefined ? [] : [reflectionResponse.format]),
            ...(reflectionSurface === undefined ? [] : [reflectionSurface.format]),
          ],
        }),
  });
}

/** Admit the temporal lane, then produce scene data and target coverage for it. */
export function addForwardSceneData(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  temporalDemand: ReturnType<typeof aggregateTemporalDemand>,
  depth: RenderPipelineTarget,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  velocity?: RenderPipelineTarget,
  directVelocity = false,
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
  if (directVelocity) {
    temporal = velocity;
  } else if (velocity !== undefined) {
    const sampled = graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
    if (!sampled.ok) return sampled;
    const view = sceneViewImport(graph)();
    if (!view.ok) return view;
    const projected = addDefaultVelocityTemporalProjection(
      graph,
      velocity,
      { depth: sampled.value, view: view.value },
      renderInternalSize(topology),
      'standard-scene-temporal',
    );
    if (!projected.ok) return projected;
    temporal = projected.value;
  } else if (temporal === undefined && temporalDemand.targetCount === 1) {
    const created = createStandardSceneDataTarget(graph, topology.extent);
    if (!created.ok) return created;
    temporal = created.value.temporal;
    const producer = addStandardSceneDataPass(
      graph,
      temporal,
      depth,
      gpuDriven,
      'opaque',
      standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
      context.getWaterMeshGraphAccesses?.(),
    );
    if (!producer.ok) return producer;
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
  const inputs = requireSingleLayerMediumInputs(
    medium.nearestTargets,
    medium.opaquePair?.color.view ?? backdrop,
  );
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
    opaqueColor: inputs.value.backdrop,
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
    surfacePair,
    ...(medium.temporal === undefined ? {} : { temporal: medium.temporal }),
    ...(medium.gpuDriven === undefined ? {} : { gpuDriven: medium.gpuDriven }),
  });
}

/** Transmission routing: which backdrop copies and transmitting passes this frame admits. */

/** Inputs only the single-layer medium consumes. */
interface ForwardMediumInputs {
  readonly temporal?: RenderPipelineTarget | undefined;
  readonly nearestTargets: SingleLayerMediumNearestTargets | undefined;
  readonly opaquePair: SingleLayerMediumMsaaPair | undefined;
  readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
}

export function addForwardOpaqueFogStage(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  unfoggedOpaque: TypedScenePassOptions | undefined,
  atmosphere?: GraphEnvironment['atmosphere'],
): Result<void, RenderGraphError> {
  if (atmosphere === undefined) return ok(undefined);
  const fogged = addOpaqueFogPasses(graph, {
    topology,
    color: scene.color,
    depth: scene.depth,
    ...(scene.msaa ? { resolve: scene.resolved } : {}),
    atmosphere,
  });
  if (!fogged.ok) return fogged;
  if (unfoggedOpaque !== undefined) {
    const unfogged = addTypedScenePass(graph, unfoggedOpaque);
    if (!unfogged.ok) return unfogged;
  }
  return ok(undefined);
}

/**
 * Analytic fog composites onto the opaque scene before transmission copies
 * and translucent draws. Every translucent writer then fogs itself at its own
 * depth, so blending composes depth-correctly.
 */
export function addForwardTranslucentStages(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  medium: ForwardMediumInputs,
  unfoggedOpaque: TypedScenePassOptions | undefined,
  opaquePrepared = false,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const fogged = opaquePrepared
    ? ok(undefined)
    : addForwardOpaqueFogStage(graph, topology, scene, unfoggedOpaque, environment?.atmosphere);
  if (!fogged.ok) return fogged;
  const template = {
    environment,
    ...receiver,
    colorStoreOp: scene.msaa ? ('auto' as const) : ('store' as const),
  };
  if (context.currentTransmission)
    return addCurrentStandardTranslucency(graph, {
      color: scene.color,
      depth: scene.depth,
      size: renderInternalSize(topology),
      transparency: topology.transparency,
      currentTransparency: context.currentTransparency,
      template,
    });
  const transmission = standardTransmissionRoute(topology);
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
    demand: medium.opaquePair === undefined ? transmission.backdropDemand : transmission.demand,
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
      retainMsaaComposite: scene.msaa && context.hasFeatureWork?.(undefined, 'scene') !== false,
      depth: scene.depth,
      size: renderInternalSize(topology),
      transparency: topology.transparency,
      currentTransparency: context.currentTransparency,
      template,
    });
    if (!transparentPass.ok) return transparentPass;
  }
  return ok(undefined);
}

export function addForwardWaterMsaaSurface(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  fallback: RenderPipelineTarget | undefined,
  sourceTemporal: RenderPipelineTarget | undefined,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  temporalRequired: boolean,
): ReturnType<typeof addSingleLayerMediumMsaaSurfaceProducer> {
  if (sourceTemporal === undefined && temporalRequired) {
    const temporal = createForwardMsaaTemporal(context.graph, topology);
    if (!temporal.ok) return temporal;
    const written = addStandardSceneDataPass(
      context.graph,
      temporal.value,
      scene.depth,
      gpuDriven,
      'opaque',
      standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
      context.getWaterMeshGraphAccesses?.(),
    );
    if (!written.ok) return written;
    sourceTemporal = temporal.value;
  }
  return addSingleLayerMediumMsaaSurfaceProducer({
    graph: context.graph,
    sourceColor: scene.color,
    sourceDepth: scene.depth,
    ...(sourceTemporal === undefined ? {} : { sourceTemporal }),
    size: renderInternalSize(topology),
    ...(fallback === undefined ? {} : { sourceFallback: fallback }),
  });
}

function createForwardMsaaTemporal(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<RenderPipelineTarget, RenderGraphError> {
  return target(
    graph,
    topology.water === true ? 'water-opaque-temporal-msaa' : 'scene-temporal-msaa',
    {
      format: 'rgba16float',
      size: renderInternalSize(topology),
      sampleCount: 4,
    },
  );
}

export function addForwardWaterStages(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  source: Extract<ReturnType<typeof addForwardWaterMsaaSurface>, { ok: true }>['value'] | undefined,
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  medium: ForwardMediumInputs,
  sceneVelocity: RenderPipelineTarget | undefined,
  sharedHzb: ReadViewHzb | undefined,
): Result<ForwardSceneTargets, RenderPipelineBuildError> {
  const view = sceneViewImport(context.graph)();
  if (!view.ok) return view;
  const underwater = topology.waterView?.kind === 'available' && topology.waterView.underwater;
  const translucent = (targets: ForwardSceneTargets) =>
    addForwardTranslucentStages(
      context,
      topology,
      targets,
      environment,
      receiver,
      medium,
      undefined,
      true,
    );
  const size = renderInternalCopySize(topology);
  const hzb =
    topology.inlineSsr && !underwater && sharedHzb !== undefined ? sharedHzb() : ok(undefined);
  if (!hzb.ok) return hzb;
  const slw = addWaterSlwPasses({
    graph: context.graph,
    topology,
    context,
    color: scene.resolved,
    forward: true,
    depth: source?.depth ?? scene.depth,
    ...(hzb.value === undefined ? {} : { depthPyramid: hzb.value }),
    ...(source === undefined
      ? {}
      : { refractionColor: source.color, opaqueRawDepth: source.rawDepth }),
    ...(sceneVelocity === undefined
      ? medium.temporal === undefined
        ? {}
        : { opaqueTemporal: medium.temporal }
      : { sceneVelocity }),
    receiver,
    view: view.value,
    foamSimulation: { kind: 'no-simulation' },
    ...size,
    beforeSceneColorCopy: () => {
      if (underwater) {
        const transparent = translucent(scene);
        if (!transparent.ok) return transparent;
      }
      return source?.resolveColor() ?? ok(undefined);
    },
  });
  if (!slw.ok) return slw;
  const resolved: ForwardSceneTargets = {
    color: scene.resolved,
    resolved: scene.resolved,
    depth: slw.value.depth,
    msaa: false,
    waterFoamSimulation: slw.value.foamSimulation,
  };
  if (!underwater) {
    const transparent = translucent(resolved);
    if (!transparent.ok) return transparent;
  }
  return ok(resolved);
}

/** Lane facts derived once from the camera and surface. */
export function forwardTemporalDemand(topology: RenderPipelineTopology) {
  const draws = topology.clearOnly !== true;
  return aggregateTemporalDemand({
    taa: draws && isTemporalAntialias(topology.camera.antialias),
    motionBlur: draws && topology.temporal?.motionBlur === true,
    ssr: draws && !topology.inlineSsr && topology.ssr?.status === 'admitted',
  });
}

function forwardLaneRoute(topology: RenderPipelineTopology) {
  const clearOnly = topology.clearOnly === true;
  const camera = topology.camera;
  return {
    clearOnly,
    msaa: !clearOnly && isMultisampleAntialias(camera.antialias) && topology.lane.multisample,
    hdr:
      !clearOnly &&
      (camera.tonemap !== 'none' ||
        isTemporalAntialias(camera.antialias) ||
        topology.inlineSsr === true),
    temporalDemand: forwardTemporalDemand(topology),
  };
}

/** The opaque passes, the MSAA medium backdrop pair and the cloud composite over them. */
export function addForwardOpaqueStage(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  mainOptions: TypedScenePassOptions,
  cloud: StandardCloudPhase | undefined,
  atmosphere: GraphEnvironment['atmosphere'] | undefined,
): Result<SingleLayerMediumMsaaPair | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInputs = context.getWaterMeshGraphAccesses?.() ?? [];
  if (waterInputs.length > 0) {
    const {
      gpuDriven: _gpu,
      gpuDrivenFilter: _filter,
      forwardDisplayDepth: _display,
      ...direct
    } = mainOptions;
    const prepass = addTypedScenePass(graph, {
      ...direct,
      name: 'main-depth',
      recordMode: 'opaque-depth',
      extraAccesses: direct.extraAccesses?.filter(
        (access) => !waterInputs.some((input) => input.resource === access.resource),
      ),
    });
    if (!prepass.ok) return prepass;
    const afterDepth = contributeStandardAfterDepthFeatures(context, scene.color, scene.depth);
    if (!afterDepth.ok) return afterDepth;
    mainOptions = { ...mainOptions, depthLoadOp: 'load', opaqueDepthPrimed: true };
  }
  const opaque = addTypedScenePass(graph, mainOptions);
  if (!opaque.ok) return opaque;
  const opaquePair = addForwardMediumOpaquePair(graph, topology, scene);
  if (!opaquePair.ok) return opaquePair;
  const composite = addForwardCloudComposite(context, topology, scene, cloud, atmosphere);
  return composite.ok ? opaquePair : composite;
}

export function addForwardMediumOpaquePair(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
) {
  return topology.singleLayerMedium === true && scene.msaa
    ? addSingleLayerMediumMsaaPairProducer({
        graph,
        label: 'single-layer-medium-opaque-resolve',
        sourceColor: scene.color,
        sourceDepth: scene.depth,
        size: renderInternalSize(topology),
      })
    : ok(undefined);
}

export function addForwardCloudComposite(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  cloud: StandardCloudPhase | undefined,
  atmosphere: GraphEnvironment['atmosphere'] | undefined,
): Result<void, RenderPipelineBuildError> {
  if (cloud?.scene === undefined) return ok(undefined);
  // Clouds receive camera-to-cloud air independently. Fog only the opaque background here.
  if (atmosphere !== undefined) {
    const fogged = addOpaqueFogPasses(context.graph, {
      topology,
      atmosphere,
      color: scene.resolved,
      depth: scene.depth,
    });
    if (!fogged.ok) return fogged;
  }
  return contributeStandardCloudComposite(
    context,
    cloud.featureTargets,
    {
      input: scene.resolved,
      depth: scene.depth,
      depthSize: renderInternalCopySize(topology),
      output: cloud.scene,
      cloudShadow: cloud.shadow,
    },
    [],
    renderInternalSize(topology),
    atmosphere,
  );
}

/** The cloud composite replaces both scene color targets read by later stages. */
export function sceneAfterCloudComposite(
  scene: ForwardSceneTargets,
  cloudScene: RenderPipelineTarget | undefined,
): ForwardSceneTargets {
  return cloudScene === undefined ? scene : { ...scene, color: cloudScene, resolved: cloudScene };
}

/**
 * Three `Material.fog = false` for opaque draws. Opaque fog is one fullscreen
 * depth pass with no per-pixel material fact, so fog:false opaque draws leave
 * `main` and record directly after that pass, depth-tested against the fogged
 * scene: in front they overwrite fogged pixels; behind they lose the depth test.
 * Built only when the frame has such a material and analytic fog; a CloudLayer
 * composite (drawn before fog) keeps them in `main`, fogged.
 */
export function forwardUnfoggedOpaqueOptions(
  topology: RenderPipelineTopology,
  mainOptions: TypedScenePassOptions,
  cloudScene: RenderPipelineTarget | undefined,
  seeded: boolean,
): TypedScenePassOptions | undefined {
  if (!forwardOpaqueFogSplit(topology) || cloudScene !== undefined) return undefined;
  const {
    gpuDriven: _gpu,
    gpuDrivenFilter: _filter,
    forwardDisplayDepth: _display,
    ...direct
  } = mainOptions;
  return {
    ...direct,
    name: 'main-unfogged',
    depthLoadOp: 'load',
    recordMode: 'opaque-unfogged',
    seededDepth: seeded,
  };
}

/** `main` records only fogged opaque when an unfogged split exists, and keeps a seeded depth. */
export function forwardOpaqueMainOptions(
  allOpaque: TypedScenePassOptions,
  split: boolean,
  seeded: boolean,
): TypedScenePassOptions {
  return {
    ...allOpaque,
    ...(split ? { recordMode: 'opaque-fogged' as const } : {}),
    ...(seeded ? { depthLoadOp: 'load' as const, seededDepth: true } : {}),
  };
}

function forwardMainPassOptions(
  scene: ForwardSceneTargets,
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  reflectionFallback: RenderPipelineTarget | undefined,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  reflectionResponse: RenderPipelineTarget | undefined,
  reflectionSurface: RenderPipelineTarget | undefined,
  fragmentEntryPoint: string | undefined,
  perPixelSolar: boolean,
): TypedScenePassOptions {
  return {
    environment,
    name: 'main',
    standardOpaqueRows: true,
    colorStoreOp: scene.msaa ? 'auto' : 'store',
    ...(fragmentEntryPoint === undefined ? {} : { fragmentEntryPoint }),
    ...(isForwardShadowColorEntry(fragmentEntryPoint)
      ? { atmosphereReads: perPixelSolar ? 'solar' : 'none' }
      : {}),
    color: scene.color,
    ...(reflectionFallback === undefined
      ? {}
      : {
          colorTargets: [
            scene.color,
            reflectionFallback,
            ...(reflectionResponse === undefined ? [] : [reflectionResponse]),
            ...(reflectionSurface === undefined ? [] : [reflectionSurface]),
          ],
        }),
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

export interface ForwardReflectionTargets {
  readonly reflectionFallback: ForwardReflectionTarget | undefined;
  readonly reflectionResponse: ForwardReflectionTarget | undefined;
  readonly reflectionSurface: ForwardReflectionTarget | undefined;
}

interface ForwardScenePreparation extends ForwardReflectionTargets {
  readonly surface: StandardPostSurface;
  readonly internalSize: GraphTextureDescriptor['size'];
  readonly route: ReturnType<typeof forwardLaneRoute>;
  readonly scene: ForwardSceneTargets;
  readonly mediumTargets: SingleLayerMediumNearestTargets | undefined;
}

function prepareForwardScene(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
): Result<ForwardScenePreparation, RenderGraphError> {
  const surface = importRenderPipelineSurface(context.graph, topology);
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
  const mediumTargets =
    topology.singleLayerMedium === true
      ? declareSingleLayerMediumTargets(context.graph, internalSize, scene.value.color.sampleCount)
      : ok(undefined);
  if (!mediumTargets.ok) return mediumTargets;
  const reflection = declareForwardReflectionTargets(
    context.graph,
    topology,
    scene.value,
    internalSize,
  );
  if (!reflection.ok) return reflection;
  return ok({
    surface: surface.value,
    internalSize,
    route,
    scene: scene.value,
    mediumTargets: mediumTargets.value,
    ...reflection.value,
  });
}

export function declareForwardReflectionTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  internalSize: GraphTextureDescriptor['size'],
): Result<ForwardReflectionTargets, RenderGraphError> {
  const reflectionFallback = declareForwardReflectionTarget(
    graph,
    'reflection-fallback',
    topology.reflectionFallback?.enabled === true && !topology.inlineSsr,
    scene,
    internalSize,
  );
  if (!reflectionFallback.ok) return reflectionFallback;
  const response = declareForwardReflectionTarget(
    graph,
    'reflection-response',
    topology.ssr?.status === 'admitted' && !topology.inlineSsr,
    scene,
    internalSize,
  );
  if (!response.ok) return response;
  const reflectionSurface = declareForwardReflectionTarget(
    graph,
    'reflection-surface',
    response.value !== undefined,
    scene,
    internalSize,
  );
  if (!reflectionSurface.ok) return reflectionSurface;
  const ports = {
    reflectionFallback: reflectionFallback.value,
    reflectionResponse: response.value,
    reflectionSurface: reflectionSurface.value,
  };
  const initialized = initializeForwardReflectionTargets(graph, ports);
  return initialized.ok ? ok(ports) : initialized;
}

/** Clear the compatible reflection attachments together, including their MSAA resolves. */
function initializeForwardReflectionTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  ports: ForwardReflectionTargets,
) {
  const attached = [
    ports.reflectionFallback,
    ports.reflectionResponse,
    ports.reflectionSurface,
  ].flatMap((slot) => (slot === undefined ? [] : [slot.attachment]));
  if (attached.length === 0) return ok(undefined);
  return graph.addRasterPass('forward-reflection-clear', {
    accesses: attached.flatMap(({ view, resolveTarget }) => [
      { resource: view, usage: 'color-attachment' as const },
      ...(resolveTarget === undefined
        ? []
        : [{ resource: resolveTarget, usage: 'color-attachment' as const }]),
    ]),
    colorAttachments: attached.map(({ view, resolveTarget }) => ({
      view,
      ...(resolveTarget === undefined ? {} : { resolveTarget }),
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    })),
    encodeDirect: () => {},
  });
}

export function addForwardScreenProjection(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  ssao: ForwardSsaoProjection,
  clearOnly: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (clearOnly || !forwardScreenDemand(topology)) return ok(undefined);
  if (topology.forwardDirectionalShadow?.mode === 'screen') return ok(undefined);
  if (ssao.screenDepth === undefined)
    throw new Error('Forward screen lighting requires single-sample depth');
  return addForwardScreenData(context.graph, {
    size: renderInternalCopySize(topology),
    depth: ssao.screenDepth,
    contact: topology.forwardContactShadows === true,
    capsules: topology.forwardCapsuleShadows === true,
    decals: ssao.decals,
    ao: ssao.ao,
  });
}

function addForwardLightingInputs(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  input: {
    readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
    readonly clusterBuffers: StandardClusterGraphBuffers | null;
    readonly clearOnly: boolean;
    readonly sceneDepth: RenderPipelineTarget;
    readonly temporalDepthRequired: boolean;
    readonly velocity?: RenderPipelineTarget | undefined;
    readonly msaaTemporal?: RenderPipelineTarget | undefined;
    readonly shadows: TypedShadowTargets;
  },
) {
  const { gpuDriven, clusterBuffers, clearOnly, sceneDepth, temporalDepthRequired, shadows } =
    input;
  const prepass = addForwardSsao(
    context,
    topology,
    gpuDriven,
    clearOnly,
    sceneDepth,
    temporalDepthRequired,
    undefined,
    input.velocity,
    input.msaaTemporal,
  );
  if (!prepass.ok) return prepass;
  const screen = addForwardScreenProjection(context, topology, prepass.value, clearOnly);
  if (!screen.ok) return screen;
  const sun = prepareForwardShadowProjection(
    context.graph,
    topology,
    sceneDepth,
    shadows,
    clusterBuffers?.kind === 'storage' ? clusterBuffers.lightData : undefined,
    prepass.value.ao,
    prepass.value.inlineAo,
  );
  if (!sun.ok) return sun;
  const colorEntry =
    sun.value !== undefined
      ? FORWARD_SHADOW_COLOR_ENTRY
      : screen.value !== undefined
        ? 'fs_forward_screen'
        : undefined;
  return ok({ prepass, screen: screen.value, sun: sun.value, colorEntry });
}

export function prepareForwardShadowProjection(
  graph: StandardPipelineBuildContext['graph'],
  topology: RenderPipelineTopology,
  depth: RenderPipelineTarget,
  shadows: TypedShadowTargets,
  lightData: GraphBuffer | undefined,
  ao: RenderPipelineTarget | undefined,
  inlineAo?: ForwardInlineSsao,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const admission = topology.forwardDirectionalShadow;
  if (admission?.mode !== 'screen') return ok(undefined);
  const directional = admission.directional === false ? undefined : shadows.directional;
  const point = admission.punctual?.point ? shadows.point : undefined;
  const spot = admission.punctual?.spot ? shadows.spot : undefined;
  if (
    (admission.directional !== false && !admission.contact && directional === undefined) ||
    (admission.punctual !== undefined &&
      (lightData === undefined ||
        (admission.punctual.point && point === undefined) ||
        (admission.punctual.spot && spot === undefined)))
  )
    return err(
      new RenderGraphFailure({
        code: 'graph-preparation-invalid',
        expected: 'Cluster rows and the depth targets of all admitted punctual shadow lights',
        hint: 'Resolve the Forward receiver against the same prepared lights and atlases.',
      }),
    );
  return addForwardDirectionalShadow(graph, {
    admission,
    ao,
    inlineAo,
    depth,
    directional,
    point,
    spot,
    sunSize: topology.shadow.directional === 'disabled' ? 1 : topology.shadow.directional.mapSize,
    spotSize: topology.shadow.spotMapSize,
    lightData: admission.punctual === undefined ? undefined : lightData,
  });
}

export function addForwardTemporalInputs(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  inputs: Parameters<typeof addForwardSsr>[2],
) {
  const opaqueGuide = addTsrOpaqueGuide(context.graph, topology, inputs.scene);
  if (!opaqueGuide.ok) return opaqueGuide;
  const ssr = topology.inlineSsr ? ok(undefined) : addForwardSsr(context, topology, inputs);
  if (!ssr.ok) return ssr;
  return ok({ opaqueGuide: opaqueGuide.value, ssr: ssr.value });
}

export function addForwardSsrSource(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  prepass: ForwardSsaoProjection,
) {
  const color = context.ssrSceneColorHistory;
  if (!topology.inlineSsr || color === undefined || prepass.hzb === undefined) return ok(undefined);
  const hzb = prepass.hzb();
  if (!hzb.ok) return hzb;
  return ok({ hiZ: hzb.value.pyramid, color: color.view });
}

/** Single-sample temporal geometry shares the existing Forward prepass depth under MSAA. */
export function forwardTemporalDepth(
  scene: ForwardSceneTargets,
  prepass: ForwardSsaoProjection,
): RenderPipelineTarget {
  return (scene.msaa ? prepass.screenDepth : undefined) ?? scene.depth;
}

export function bindForwardSceneVelocity(
  graph: StandardPipelineBuildContext['graph'],
  depth: RenderPipelineTarget,
): Result<SceneVelocityInputs, RenderGraphError> {
  const view = sceneViewImport(graph)();
  if (!view.ok) return view;
  const depthView = graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
  return depthView.ok ? ok({ depth: depthView.value, view: view.value }) : depthView;
}

export function prepareForwardMotionTargets(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  demand: ReturnType<typeof aggregateTemporalDemand>,
  scene: ForwardSceneTargets,
  internalSize: GraphTextureDescriptor['size'],
) {
  const { graph } = context;
  const needsMotion = demand.targetCount === 1;
  const canSeedMotion =
    needsMotion && topology.materialSceneDepth !== true && context.forwardOutput === undefined;
  const multisampledMotion =
    canSeedMotion && scene.msaa && (topology.water === true || topology.lane.storageBuffer);
  const prepassVelocity =
    canSeedMotion && !multisampledMotion
      ? createDefaultVelocityTarget(graph, internalSize, false)
      : ok(undefined);
  if (!prepassVelocity.ok) return prepassVelocity;
  const msaaTemporal = multisampledMotion
    ? createForwardMsaaTemporal(graph, topology)
    : ok(undefined);
  if (!msaaTemporal.ok) return msaaTemporal;
  return ok({
    needsMotion,
    prepassVelocity: prepassVelocity.value,
    msaaTemporal: msaaTemporal.value,
    temporalDepthRequired: scene.msaa && needsMotion && !multisampledMotion,
  });
}

export function buildStandardForwardLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const environmentFeatures = context.contributeFeatures({
    targets: [],
    namedTargets: {},
    passNames: [],
    placement: 'environment',
  });
  if (!environmentFeatures.ok) return environmentFeatures;
  const prepared = prepareForwardScene(context, topology);
  if (!prepared.ok) return prepared;
  const {
    surface,
    internalSize,
    route,
    scene,
    mediumTargets,
    reflectionFallback,
    reflectionResponse,
    reflectionSurface,
  } = prepared.value;
  const shadows = addForwardShadows(context, topology, reuseAdjacentShadow);
  if (!shadows.ok) return shadows;
  const clusterBuffers = addForwardClusters(graph, topology, lighting, route.clearOnly);
  if (!clusterBuffers.ok) return clusterBuffers;
  const cloud = declareStandardCloudPhase(
    context,
    scene.resolved,
    scene.depth,
    { size: internalSize, domain: route.hdr ? 'linear-hdr' : 'linear-ldr' },
    !route.msaa,
  );
  if (!cloud.ok) return cloud;
  const atmosphere = addStandardAtmosphere(
    graph,
    topology,
    scene.color,
    { directional: shadows.value.directional?.view, cloud: cloud.value.shadow?.view },
    clusterBuffers.value,
  );
  if (!atmosphere.ok) return atmosphere;
  const gpuDriven = projectForwardGpuDriven(
    context,
    scene.color,
    reflectionFallback?.attachment,
    reflectionResponse?.attachment,
    reflectionSurface?.attachment,
  );
  if (!gpuDriven.ok) return gpuDriven;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value, shadows.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  const waterInfo = context.contributeFeatures({
    targets: cloud.value.featureTargets,
    placement: 'scene',
    include: ['water-info-producer', 'water-gpu-mesh', 'water-advanced-producer'],
  });
  if (!waterInfo.ok) return waterInfo;
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const motion = prepareForwardMotionTargets(
    context,
    topology,
    route.temporalDemand,
    scene,
    internalSize,
  );
  if (!motion.ok) return motion;
  const { needsMotion, prepassVelocity, msaaTemporal, temporalDepthRequired } = motion.value;
  const inputs = addForwardLightingInputs(context, topology, {
    gpuDriven: gpuDriven.value,
    velocity: prepassVelocity,
    msaaTemporal: msaaTemporal,
    clusterBuffers: clusterBuffers.value,
    clearOnly: route.clearOnly,
    sceneDepth: scene.depth,
    temporalDepthRequired,
    shadows: shadows.value,
  });
  if (!inputs.ok) return inputs;
  const { prepass: ssao, screen: forwardScreen, sun: sunShadow, colorEntry } = inputs.value;
  const createForwardReceiverInputs = (projected?: RenderPipelineTarget) => {
    const receiver: StandardForwardReceiverInputs & {
      readonly waterInfoTargets?: typeof waterInfoTargets;
    } = {
      ...standardForwardReceiverInputs({
        materialSceneDepth: topology.materialSceneDepth,
        shadows: shadows.value,
        projectedDirectional: projected,
        cloudShadow: cloud.value.shadow,
        ssao:
          topology.forwardDirectionalShadow?.mode === 'screen' &&
          topology.forwardDirectionalShadow.ambientOcclusion
            ? sunShadow
            : (forwardScreen ?? ssao.value.ao),
        planarReflection: targetCaptures?.value,
        clusterReads: [
          ...(clusterBuffers.value === null
            ? []
            : standardClusterReadAccesses(clusterBuffers.value)),
          ...(context.getWaterMeshGraphAccesses?.() ?? []),
        ],
      }),
      ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    };
    return receiver;
  };
  const receiver = createForwardReceiverInputs();
  const allOpaqueOptions = forwardMainPassOptions(
    scene,
    atmosphere.value,
    sunShadow === undefined ? receiver : createForwardReceiverInputs(sunShadow),
    reflectionFallback?.attachment,
    gpuDriven.value,
    reflectionResponse?.attachment,
    reflectionSurface?.attachment,
    colorEntry,
    topology.perPixelAtmosphereTransmittance !== false,
  );
  const resolveForwardOpaqueOptions = () => {
    const opaqueOptions =
      waterInfoTargets.size === 0 ? allOpaqueOptions : { ...allOpaqueOptions, waterInfoTargets };
    return opaqueOptions;
  };
  const opaqueOptions = resolveForwardOpaqueOptions();
  // A compatible surface-data prepass already wrote the exact main depth.
  const prepareForwardOpaqueStages = () => {
    const seeded = ssao.value.predepth === scene.depth;
    const source = addForwardSsrSource(context, topology, ssao.value);
    if (!source.ok) return source;
    const allOpaque =
      source.value === undefined ? opaqueOptions : { ...opaqueOptions, ssrSource: source.value };
    const unfoggedOpaque = forwardUnfoggedOpaqueOptions(
      topology,
      allOpaque,
      cloud.value.scene,
      seeded,
    );
    let mainOptions = forwardOpaqueMainOptions(allOpaque, unfoggedOpaque !== undefined, seeded);
    if (topology.atmosphere !== true) {
      // Depth/lighting/capture producers run first. The ordinary background
      // then shares the scene attachments immediately before opaque shading.
      const background = addTypedSkyboxPass(graph, scene.color, {
        target: scene.depth,
        loadOp: seeded ? 'load' : 'clear',
      });
      if (!background.ok) return background;
      mainOptions = { ...mainOptions, depthLoadOp: 'load' };
    }
    const opaquePair = addForwardOpaqueStage(
      context,
      topology,
      scene,
      mainOptions,
      cloud.value,
      atmosphere.value?.atmosphere,
    );
    if (!opaquePair.ok) return opaquePair;
    const waterRequested = topology.water === true;
    const addRequestedWaterOpaqueFog = () => {
      if (waterRequested && cloud.value.scene === undefined) {
        const fogged = addForwardOpaqueFogStage(
          graph,
          topology,
          scene,
          unfoggedOpaque,
          atmosphere.value?.atmosphere,
        );
        if (!fogged.ok) return fogged;
      }
      return undefined;
    };
    const opaqueFogFailure = addRequestedWaterOpaqueFog();
    if (opaqueFogFailure !== undefined) return opaqueFogFailure;
    const resolveForwardWaterMsaaSurface = () => {
      const waterMsaa =
        waterRequested && scene.msaa
          ? addForwardWaterMsaaSurface(
              context,
              topology,
              scene,
              reflectionFallback?.attachment,
              msaaTemporal,
              gpuDriven.value,
              needsMotion,
            )
          : ok(undefined);
      return waterMsaa;
    };
    const waterMsaa = resolveForwardWaterMsaaSurface();
    if (!waterMsaa.ok) return waterMsaa;
    return ok({
      seeded,
      unfoggedOpaque,
      opaquePair: opaquePair.value,
      waterRequested,
      waterMsaa: waterMsaa.value,
    });
  };
  const prepareForwardTemporalStages = () => {
    const opaque = prepareForwardOpaqueStages();
    if (!opaque.ok) return opaque;
    const { seeded, unfoggedOpaque, opaquePair, waterRequested, waterMsaa } = opaque.value;
    const temporalDepth = forwardTemporalDepth(scene, ssao.value);
    // The main AA stages already decode packed velocity and reconstruct camera
    // motion from depth. Material/feature consumers can still require SceneData.
    const resolveSurfaceTemporal = waterMsaa?.temporal ?? ssao.value.temporal;
    const directVelocity =
      prepassVelocity !== undefined &&
      resolveSurfaceTemporal === undefined &&
      topology.singleLayerMedium !== true &&
      (topology.inlineSsr === true || topology.ssr?.status !== 'admitted') &&
      topology.sceneDataBindings?.some(
        (binding) =>
          binding.schema === SCENE_DATA_TEMPORAL_V1_SCHEMA &&
          binding.owners.some((owner) => owner.featureIdentity !== MOTION_BLUR_FEATURE_IDENTITY),
      ) !== true;
    const temporal =
      resolveSurfaceTemporal === undefined
        ? addForwardSceneData(
            context,
            topology,
            route.temporalDemand,
            temporalDepth,
            gpuDriven.value,
            prepassVelocity,
            directVelocity,
          )
        : ok(resolveSurfaceTemporal);
    if (!temporal.ok) return temporal;
    if (context.targetCoverage !== undefined) {
      const coverage = addTargetCoveragePass(
        graph,
        context.targetCoverage,
        gpuDriven.value,
        waterInfoTargets,
      );
      if (!coverage.ok) return coverage;
    }
    const temporalInputs = addForwardTemporalInputs(context, topology, {
      scene: scene.resolved,
      fallback: reflectionFallback?.sampled,
      response: reflectionResponse?.sampled,
      depth: forwardTemporalDepth(scene, ssao.value),
      surface: reflectionSurface?.sampled,
      hzb: ssao.value.hzb,
      temporal: temporal.value,
    });
    if (!temporalInputs.ok) return temporalInputs;
    const medium = {
      nearestTargets: mediumTargets,
      opaquePair,
      gpuDriven: gpuDriven.value,
      temporal: directVelocity ? undefined : temporal.value,
    };
    return ok({
      seeded,
      unfoggedOpaque,
      opaquePair,
      waterRequested,
      waterMsaa,
      temporal,
      temporalInputs,
      directVelocity,
      medium,
      later: sceneAfterCloudComposite(scene, cloud.value.scene),
    });
  };
  const finishForwardScene = () => {
    const temporalStage = prepareForwardTemporalStages();
    if (!temporalStage.ok) return temporalStage;
    const {
      seeded,
      unfoggedOpaque,
      waterRequested,
      waterMsaa,
      temporal,
      temporalInputs,
      directVelocity,
      medium,
    } = temporalStage.value;
    let later = temporalStage.value.later;
    const beforeMedium = addForwardBeforeMediumFeatures(
      context,
      topology,
      later,
      receiver,
      atmosphere.value?.atmosphere,
      temporal.value,
      forwardTemporalDepth(scene, ssao.value),
    );
    if (!beforeMedium.ok) return beforeMedium;
    const water = waterRequested
      ? addForwardWaterStages(
          context,
          topology,
          later,
          waterMsaa,
          atmosphere.value,
          receiver,
          medium,
          directVelocity ? temporal.value : undefined,
          seeded && !scene.msaa && ssao.value.hzbDepth === scene.depth ? ssao.value.hzb : undefined,
        )
      : ok(later);
    if (!water.ok) return water;
    later = water.value;
    const resolveForwardTranslucentStages = () => {
      const translucent = !waterRequested
        ? addForwardTranslucentStages(
            context,
            topology,
            later,
            atmosphere.value,
            receiver,
            medium,
            unfoggedOpaque,
            cloud.value.scene !== undefined,
          )
        : ok(undefined);
      return translucent;
    };
    const translucent = resolveForwardTranslucentStages();
    if (!translucent.ok) return translucent;
    // The local froxel volume composites after every translucent writer (see
    // addTranslucencyVolumetricFogPasses).
    const volume = addTranslucencyVolumetricFogPasses(graph, {
      topology,
      color: later.resolved,
      depth: later.depth,
      directionalShadow: shadows.value.directional?.view,
      spotShadow: shadows.value.spot?.view,
      clusterBuffers: clusterBuffers.value,
      cloudShadow: cloud.value.shadow?.view,
    });
    if (!volume.ok) return volume;
    const observed = addForwardSceneObservations(
      context,
      topology,
      later,
      receiver,
      waterMsaa?.fallback ?? reflectionFallback?.sampled,
      forwardTemporalDepth(scene, ssao.value),
    );
    if (!observed.ok) return observed;
    const temporalDepth = waterRequested ? later.depth : forwardTemporalDepth(scene, ssao.value);
    const sceneVelocity = directVelocity
      ? bindForwardSceneVelocity(graph, temporalDepth)
      : ok(undefined);
    if (!sceneVelocity.ok) return sceneVelocity;
    return presentForwardLane(
      context,
      topology,
      later,
      surface,
      temporal.value,
      temporalInputs.value.ssr,
      temporalInputs.value.opaqueGuide,
      sceneVelocity.value,
      gpuDriven.value,
    );
  };
  return finishForwardScene();
}

function addForwardBeforeMediumFeatures(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  receiver: StandardForwardReceiverInputs,
  atmosphere: GraphAtmosphere | undefined,
  temporal: RenderPipelineTarget | undefined,
  sceneDataDepth: RenderPipelineTarget,
): Result<void, RenderPipelineBuildError> {
  return contributeStandardSceneFeatures(
    context,
    {
      color: scene.color,
      colorResolve: scene.msaa ? scene.resolved.view : undefined,
      depth: scene.depth,
      temporal: isTemporalAntialias(topology.camera.antialias) ? temporal : undefined,
    },
    standardForwardReceiverFeatureAccesses(receiver),
    atmosphere,
    [
      bindStandardSceneDataTarget(
        sceneDataDepth,
        topology,
        SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      ),
    ],
    'before-medium',
  );
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
  sceneDataDepth: RenderPipelineTarget,
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
    undefined,
    [
      bindStandardSceneDataTarget(
        sceneDataDepth,
        topology,
        SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
      ),
    ],
  );
  if (!features.ok) return features;
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
  ssr: TemporalSecondaryReactivity | undefined,
  opaqueGuide: RenderPipelineTarget | undefined,
  sceneVelocity: SceneVelocityInputs | undefined,
  gpuDriven?: RenderPipelineGpuDrivenProjection,
): ReturnType<RenderPipeline['build']> {
  if (context.forwardOutput !== undefined)
    return context.forwardOutput.build(context, topology, scene.resolved, scene.depth, surface);
  const post = addStandardPost(context, topology, scene.resolved, scene.depth, surface, {
    sceneTemporal: temporal,
    sceneVelocity,
    secondaryReactivity: ssr,
    coverage: context.targetCoverage?.coverage,
    coverageDepth: context.targetCoverage?.depth,
    opaqueGuide,
    waterInfoTargets: standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
    gpuDriven,
    waterFoamSimulation: scene.waterFoamSimulation,
  });
  if (!post.ok) return post;
  return ok(undefined);
}
