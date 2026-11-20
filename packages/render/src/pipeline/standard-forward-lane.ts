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
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/contracts';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import {
  addProjectedDecalChannels,
  addProjectedDecalNormalPass,
  type ProjectedDecalChannels,
} from '../decals/graph';
import { addAtmosphereBackground } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { PREDEPTH_FRAGMENT_ENTRY } from '../predepth-coverage';
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
import { FORWARD_PASS_SELECTOR, TRANSMISSION_BACK_PASS_SELECTOR } from '../systems/pass-selector';
import {
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../temporal/scene-data';
import {
  addStandardSceneDataPass,
  addStandardSceneSurfaceDataPass,
  aggregateTemporalDemand,
  bindStandardSceneDataTarget,
  createStandardSceneDataTarget,
  createStandardSceneSurfaceDataTargets,
  createStandardSceneSurfaceDepthTarget,
  requireStandardTemporalLane,
  type StandardSceneSurfaceDataTargets,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  standardTransmissionRoute,
} from '../transmission/backdrop';
import type { TransmissionDemand } from '../transmission/projection';
import { addTsrOpaqueGuide } from '../tsr/opaque';
import type { TemporalSecondaryReactivity } from '../typed-render-graph-primitives';
import {
  addReflectionFallbackObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
  type TypedScenePassOptions,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses, type TypedShadowTargets } from '../typed-shadow-passes';
import { addWaterFluidGraph } from '../water/fluid-graph';
import { addWaterSlwPasses } from '../water/slw-graph';
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addForwardScreenData } from './forward-screen-data';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { addMsaaNearestDepthResolve } from './msaa-depth-resolve';
import { renderInternalCopySize, renderInternalSize } from './render-extent';
import {
  addSingleLayerMediumMsaaPairProducer,
  addSingleLayerMediumMsaaSurfaceProducer,
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
  requireSingleLayerMediumInputs,
  type SingleLayerMediumMsaaPair,
  type SingleLayerMediumNearestTargets,
} from './single-layer-medium-passes';
import { addSsaoLinearDepthPass } from './ssao-scene-color';
import {
  contributeStandardAfterDepthFeatures,
  resolveStandardGtaoExecution,
  type StandardPipelineBuildContext,
  standardWaterInfoGraphTargets,
} from './standard-build-context';
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
import { addForwardSsr } from './standard-forward-ssr';
import {
  addStandardClusterAoPackPass,
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
  readonly waterFoamSimulation?: GraphTextureView;
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

interface ForwardReflectionTarget {
  readonly attachment: RenderPipelineTarget;
  readonly sampled: RenderPipelineTarget;
}

/** All Forward reflection MRTs resolve through the existing per-target graph contract. */
function declareForwardReflectionTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: 'reflection-fallback' | 'reflection-response',
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
  const initialized = graph.addRasterPass(`${name}-clear`, {
    accesses: [
      { resource: attachment.view, usage: 'color-attachment' },
      ...(scene.msaa ? [{ resource: sampled.value.view, usage: 'color-attachment' as const }] : []),
    ],
    colorAttachments: [
      {
        view: attachment.view,
        ...(attachment.resolveTarget === undefined
          ? {}
          : { resolveTarget: attachment.resolveTarget }),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encodeDirect: () => {},
  });
  return initialized.ok ? ok({ attachment, sampled: sampled.value }) : initialized;
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

function forwardClusterTextureExtent(
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
): StandardClusterTextureExtent | undefined {
  const config = topology.config?.ambientOcclusion;
  if (lighting.kind !== 'clustered' || lighting.transport.kind !== 'cpu-texture') return undefined;
  const ao = config?.enabled === true;
  const screenDemand = forwardScreenDemand(topology);
  const atmosphere = topology.atmosphere === true && topology.atmosphereBackgroundOnly !== true;
  if (!ao && !screenDemand && !atmosphere) return undefined;
  const dimensions = renderInternalCopySize(topology);
  const resolutionScale = ao ? getSsaoParameters(config).resolutionScale : 1;
  return {
    width: ao ? Math.max(1, Math.round(dimensions.width * resolutionScale)) : 0,
    height: ao ? Math.max(1, Math.round(dimensions.height * resolutionScale)) : 0,
    ...(screenDemand ? { screen: dimensions } : {}),
    ...(atmosphere ? { atmosphere: true } : {}),
  };
}

interface ForwardSsaoProjection {
  /** Exact scene attachment rasterized by the primary depth producer. */
  readonly predepth?: RenderPipelineTarget;
  /** Exact single-sample center coverage, only for consumers that require it. */
  readonly centerDepth?: RenderPipelineTarget | undefined;
  readonly occlusionResolved?: boolean;
  readonly decals?: ProjectedDecalChannels | undefined;
  readonly ao: RenderPipelineTarget | undefined;
  readonly linearDepth?: RenderPipelineTarget | undefined;
  readonly parameters?: GraphBuffer | undefined;
  readonly surface: StandardSceneSurfaceDataTargets | undefined;
  /** Depth of a depth-only prepass (no surface normal was produced). */
  readonly depth?: RenderPipelineTarget | undefined;
}

type ForwardSurfacePassTargets = Pick<StandardSceneSurfaceDataTargets, 'depth'> &
  Partial<Pick<StandardSceneSurfaceDataTargets, 'normal'>>;

function forwardScreenDemand(topology: RenderPipelineTopology): boolean {
  return (
    topology.forwardContactShadows === true ||
    topology.forwardCapsuleShadows === true ||
    (topology.projectedDecals?.length ?? 0) > 0
  );
}

/**
 * Whether the Forward prepass must also write the surface normal target. The
 * prepass is depth-only (UE Forward DepthPass PositionOnly) unless a normal
 * reader is on: contact or capsule shadows, projected decals, a scene-data
 * surface binding, SSR, or the compute GTAO entry. Fragment AO reconstructs
 * its normal from depth, so AO alone does not need the target.
 */
function forwardPrepassNeedsNormal(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
): boolean {
  return (
    forwardScreenDemand(topology) ||
    topology.sceneDataBindings?.some(
      (binding) => binding.schema === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
    ) === true ||
    topology.ssr?.status === 'admitted' ||
    context.gtaoExecutionOverride === 'compute'
  );
}

function addForwardSurfaceDecals(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  surface: StandardSceneSurfaceDataTargets,
  size: { width: number; height: number },
) {
  const topologyDecals = topology.projectedDecals ?? [];
  if (topologyDecals.length === 0) return ok({ surface, decals: undefined });
  const depth = context.graph.view(surface.depth.texture, {
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depth.ok) return depth;
  const decals = addProjectedDecalChannels(context.graph, topologyDecals, {
    depth: depth.value,
    normal: surface.normal,
    size,
  });
  if (!decals.ok) return decals;
  const normal = addProjectedDecalNormalPass(context.graph, surface.normal, decals.value, size);
  if (!normal.ok) return normal;
  return ok({ surface: { ...surface, normal: normal.value }, decals: decals.value });
}

/** Complete newly visible GPU surfaces before a pre-lighting consumer reads depth. */
function addForwardSurfacePasses(
  context: StandardPipelineBuildContext,
  targets: ForwardSurfacePassTargets,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  size: { readonly width: number; readonly height: number },
): Result<boolean, RenderGraphError> {
  const graph = context.graph;
  const early = addStandardSceneSurfaceDataPass(
    graph,
    targets,
    gpuDriven,
    'standard-scene-surface-data',
    PREDEPTH_FRAGMENT_ENTRY,
  );
  if (!early.ok) return early;
  if (gpuDriven?.addLateOcclusion === undefined) return ok(false);
  const depth = graph.view(targets.depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!depth.ok) return depth;
  const late = addGpuLateOcclusion(graph, {
    nativeInputs: context.nativeInputs,
    gpuDriven,
    depth: depth.value,
    multisampled: targets.depth.sampleCount > 1,
    ...size,
    view: sceneViewImport(graph),
  });
  if (!late.ok) return late;
  const completed = addTypedScenePass(graph, {
    name: 'standard-scene-surface-data-late',
    gpuDriven,
    gpuDrivenFilter: 'opaque',
    gpuDrivenPhase: 'late',
    ...(targets.normal === undefined ? { colorTargets: [] } : { color: targets.normal }),
    depth: targets.depth,
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'forward',
    fragmentEntryPoint: PREDEPTH_FRAGMENT_ENTRY,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
  });
  return completed.ok ? ok(true) : completed;
}

function forwardCenterDepthRequired(
  topology: RenderPipelineTopology,
  normalRequired: boolean,
  temporalDepthRequired: boolean,
): boolean {
  return (
    normalRequired ||
    temporalDepthRequired ||
    topology.sceneDataBindings?.some(
      (binding) => binding.schema === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
    ) === true
  );
}

function resolveForwardAoDepth(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  surface: StandardSceneSurfaceDataTargets | undefined,
  sceneDepth: RenderPipelineTarget,
  dimensions: { readonly width: number; readonly height: number },
  depth: RenderPipelineTarget | undefined,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (surface === undefined && sceneDepth.sampleCount > 1 && topology.lane.storageBuffer) {
    // Spiral's half-depth producer and composite select the nearest MSAA
    // sample directly. Other AO algorithms retain their single-sample input.
    const resolved =
      getSsaoParameters(topology.config?.ambientOcclusion).method === 'spiral-ssao'
        ? ok(sceneDepth)
        : addMsaaNearestDepthResolve(
            context.graph,
            sceneDepth,
            dimensions,
            'forward-ao-depth-resolve',
          );
    if (!resolved.ok) return resolved;
    depth = resolved.value;
  }
  return ok(depth);
}

function addForwardCenterDepth(
  context: StandardPipelineBuildContext,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  surface: StandardSceneSurfaceDataTargets | undefined,
  sceneDepth: RenderPipelineTarget,
  dimensions: { readonly width: number; readonly height: number },
  required: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  const multisampled = sceneDepth.sampleCount > 1;
  let centerDepth = multisampled ? undefined : sceneDepth;
  if (multisampled && required) {
    if (surface === undefined) {
      const created = createStandardSceneSurfaceDepthTarget(context.graph, dimensions);
      if (!created.ok) return created;
      centerDepth = created.value;
    } else centerDepth = surface.depth;
    // The primary pass already completed late visibility. This semantic pass
    // consumes the full visible set and must not build a second HZB/cull.
    const semantic = addStandardSceneSurfaceDataPass(
      context.graph,
      surface ?? { depth: centerDepth },
      gpuDriven,
      'standard-scene-surface-center',
    );
    if (!semantic.ok) return semantic;
  }
  return ok(centerDepth);
}

/** Primary depth is the scene attachment; semantic consumers get only their required outputs. */
function addForwardSsao(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  clusters: StandardClusterGraphBuffers | null,
  clearOnly: boolean,
  sceneDepth: RenderPipelineTarget,
  temporalDepthRequired: boolean,
): Result<ForwardSsaoProjection, RenderGraphError> {
  if (clearOnly) return ok({ ao: undefined, surface: undefined });
  const aoEnabled = topology.config?.ambientOcclusion?.enabled === true;
  const normalRequired = forwardPrepassNeedsNormal(context, topology);
  const centerRequired = forwardCenterDepthRequired(
    topology,
    normalRequired,
    temporalDepthRequired,
  );
  const dimensions = renderInternalCopySize(topology);
  const multisampled = sceneDepth.sampleCount > 1;
  let surface: StandardSceneSurfaceDataTargets | undefined;
  if (normalRequired) {
    const created = createStandardSceneSurfaceDataTargets(
      context.graph,
      dimensions,
      multisampled ? undefined : sceneDepth,
    );
    if (!created.ok) return created;
    surface = created.value;
  }
  const produced = addForwardSurfacePasses(
    context,
    !multisampled && surface !== undefined ? surface : { depth: sceneDepth },
    gpuDriven,
    dimensions,
  );
  if (!produced.ok) return produced;
  const centered = addForwardCenterDepth(
    context,
    gpuDriven,
    surface,
    sceneDepth,
    dimensions,
    centerRequired || (aoEnabled && !topology.lane.storageBuffer),
  );
  if (!centered.ok) return centered;
  const centerDepth = centered.value;
  let decals: ProjectedDecalChannels | undefined;
  if (surface !== undefined) {
    const projected = addForwardSurfaceDecals(context, topology, surface, dimensions);
    if (!projected.ok) return projected;
    surface = projected.value.surface;
    decals = projected.value.decals;
  }
  let depth = centerDepth;
  let ao: RenderPipelineTarget | undefined;
  let linearDepth: RenderPipelineTarget | undefined;
  let parameters: GraphBuffer | undefined;
  if (aoEnabled) {
    const resolved = resolveForwardAoDepth(
      context,
      topology,
      surface,
      sceneDepth,
      dimensions,
      depth,
    );
    if (!resolved.ok) return resolved;
    depth = resolved.value;
    // Lighting AO is a BasePass input. Scene-color AO is produced only after
    // the final scene writer, keeping its half/full-depth reads coherent.
    if (ssaoUsesLighting(topology.config?.ambientOcclusion)) {
      const input = surface ?? { depth: depth ?? sceneDepth };
      const added = addForwardAo(context, topology, clusters, input, dimensions);
      if (!added.ok) return added;
      ao = added.value.ao;
      linearDepth = added.value.linearDepth;
      parameters = added.value.parameters;
    }
  }
  return ok({
    ao,
    linearDepth,
    parameters,
    surface,
    depth,
    predepth: sceneDepth,
    centerDepth,
    occlusionResolved: produced.value,
    ...(decals === undefined ? {} : { decals }),
  });
}

/** Raw AO, its spatial filter and, on no-storage lanes, the Cluster AO pack. */
function addForwardAo(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  clusters: StandardClusterGraphBuffers | null,
  surface: ForwardSurfacePassTargets,
  dimensions: { readonly width: number; readonly height: number },
): Result<
  {
    readonly ao: RenderPipelineTarget;
    readonly linearDepth?: RenderPipelineTarget | undefined;
    readonly parameters?: GraphBuffer | undefined;
  },
  RenderGraphError
> {
  const parameters = getSsaoParameters(topology.config?.ambientOcclusion);
  const aoSize = {
    width: Math.max(1, Math.round(dimensions.width * parameters.resolutionScale)),
    height: Math.max(1, Math.round(dimensions.height * parameters.resolutionScale)),
  };
  const execution = resolveStandardGtaoExecution(
    parameters.method,
    topology.lane.compute,
    context.gtaoExecutionOverride,
  );
  if (!execution.ok) return execution;
  const raw = target(context.graph, 'ssao-raw', {
    format: parameters.method === 'spiral-ssao' ? 'r8unorm' : 'rgba8unorm',
    size: aoSize,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      (execution.value === 'compute' ? GPU_TEXTURE_USAGE_STORAGE_BINDING : 0),
  });
  if (!raw.ok) return raw;
  const blurred = target(context.graph, 'ssao-blurred', {
    format: 'r8unorm',
    size: aoSize,
    usage: GPU_TEXTURE_USAGE_COPY_SRC,
  });
  if (!blurred.ok) return blurred;
  let horizontal: RenderPipelineTarget | undefined;
  if (parameters.method === 'spiral-ssao') {
    const intermediate = target(context.graph, 'ssao-horizontal', {
      format: 'r8unorm',
      size: aoSize,
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
    });
    if (!intermediate.ok) return intermediate;
    horizontal = intermediate.value;
  }
  const linear =
    parameters.method === 'spiral-ssao'
      ? addSsaoLinearDepthPass(context.graph, surface.depth, aoSize)
      : ok(undefined);
  if (!linear.ok) return linear;
  const passes = addTypedSsaoPasses(context.graph, {
    normal: surface.normal,
    depth: surface.depth,
    raw: raw.value,
    blurred: blurred.value,
    execution: execution.value,
    horizontal,
    ...linear.value,
  });
  if (!passes.ok) return passes;
  if (!topology.lane.storageBuffer && ssaoUsesLighting(topology.config?.ambientOcclusion)) {
    if (clusters?.kind !== 'texture') {
      return err(
        new RenderGraphFailure({
          code: 'resource-descriptor-invalid',
          expected: 'no-storage Forward AO shares the admitted Cluster integer texture',
          hint: 'prepare the complete CPU texture Cluster transport before adding Forward AO',
          detail: {
            resourceLabel: 'standard-cluster-tables',
            field: 'AO transport',
            expected: 'rgba32uint Cluster texture with a reserved AO region',
            actual: clusters === null ? 'absent' : 'storage',
          },
        }),
      );
    }
    const packed = addStandardClusterAoPackPass(context.graph, clusters, blurred.value);
    if (!packed.ok) return packed;
  }
  return ok({ ao: blurred.value, ...linear.value });
}

/** Atmosphere production precedes the captures and receivers that consume its environment. */
function addForwardAtmosphere(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
  shadows: TypedShadowTargets,
  clusters: StandardClusterGraphBuffers | null,
  cloudShadow: RenderPipelineTarget | undefined,
): Result<GraphEnvironment | undefined, RenderGraphError> {
  if (topology.atmosphereBackgroundOnly === true) {
    return addAtmosphereBackground(graph, color, {}, { mode: 'sky' });
  }
  return addAtmosphereBackground(
    graph,
    color,
    { directional: shadows.directional?.view, cloud: cloudShadow?.view },
    { mode: 'full', clusters },
  );
}

function projectForwardGpuDriven(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
  reflectionFallback: RenderPipelineTarget | undefined,
  reflectionResponse: RenderPipelineTarget | undefined,
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  return context.projectGpuDriven({
    format: color.format,
    sampleCount: color.sampleCount,
    lateOcclusion: topology.opaque.lateOcclusion,
    ...(reflectionFallback === undefined
      ? {}
      : {
          additionalColorFormats: [
            reflectionFallback.format,
            ...(reflectionResponse === undefined ? [] : [reflectionResponse.format]),
          ],
        }),
  });
}

/** The early opaque pass, then the HZB-tested late pass when late occlusion is admitted. */
function addForwardOpaquePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  mainOptions: TypedScenePassOptions,
  scene: ForwardSceneTargets,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  copySize: { readonly width: number; readonly height: number },
  occlusionResolved: boolean,
  nativeInputs: StandardPipelineBuildContext['nativeInputs'],
): Result<void, RenderGraphError> {
  const main = addTypedScenePass(graph, mainOptions);
  if (!main.ok || occlusionResolved) return main;
  const depthSample = graph.view(scene.depth.texture, {
    label: 'occlusion-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const late = addGpuLateOcclusion(graph, {
    nativeInputs,
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
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
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
    const producer = addStandardSceneDataPass(
      graph,
      temporal,
      depth,
      gpuDriven,
      'opaque',
      waterInfoTargets,
      context.getWaterMeshGraphAccesses?.(),
    );
    if (!producer.ok) return producer;
  }
  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(
      graph,
      context.targetCoverage,
      gpuDriven,
      waterInfoTargets,
    );
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
  readonly targetCaptures: GraphTextureView | undefined;
  readonly gpuDriven: RenderPipelineGpuDrivenProjection | undefined;
}

function addForwardOpaqueFogStage(
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
function addForwardTranslucentStages(
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
  const transmission = standardTransmissionRoute(topology, scene.color.sampleCount);
  const template = {
    environment,
    ...receiver,
    colorStoreOp: scene.msaa ? ('auto' as const) : ('store' as const),
  };
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

function addForwardWaterMsaaSurface(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  fallback: RenderPipelineTarget | undefined,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  motionDemand: boolean,
): ReturnType<typeof addSingleLayerMediumMsaaSurfaceProducer> {
  const graph = context.graph;
  const size = renderInternalSize(topology);
  let sourceTemporal: RenderPipelineTarget | undefined;
  if (motionDemand) {
    const temporal = target(graph, 'water-opaque-temporal-msaa', {
      format: 'rgba16float',
      size,
      sampleCount: 4,
    });
    if (!temporal.ok) return temporal;
    const motion = addStandardSceneDataPass(
      graph,
      temporal.value,
      scene.depth,
      gpuDriven,
      'opaque',
      standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
      context.getWaterMeshGraphAccesses?.(),
    );
    if (!motion.ok) return motion;
    sourceTemporal = temporal.value;
  }
  return addSingleLayerMediumMsaaSurfaceProducer({
    graph,
    sourceColor: scene.color,
    sourceDepth: scene.depth,
    ...(sourceTemporal === undefined ? {} : { sourceTemporal }),
    size,
    ...(fallback === undefined ? {} : { sourceFallback: fallback }),
  });
}

function addForwardWaterMsaaStages(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  source: Extract<
    ReturnType<typeof addSingleLayerMediumMsaaSurfaceProducer>,
    { ok: true }
  >['value'],
  environment: GraphEnvironment | undefined,
  receiver: StandardForwardReceiverInputs,
  medium: ForwardMediumInputs,
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
  const slw = addWaterSlwPasses({
    graph: context.graph,
    topology,
    context,
    color: scene.resolved,
    depth: source.depth,
    refractionColor: source.color,
    opaqueRawDepth: source.rawDepth,
    ...(source.temporal === undefined ? {} : { opaqueTemporal: source.temporal }),
    receiver,
    view: view.value,
    foamSimulation: { kind: 'no-simulation' },
    ...size,
    beforeSceneColorCopy: () => {
      if (underwater) {
        const transparent = translucent(scene);
        if (!transparent.ok) return transparent;
      }
      return source.resolveColor();
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
function forwardLaneRoute(topology: RenderPipelineTopology) {
  const clearOnly = topology.clearOnly === true;
  const camera = topology.camera;
  return {
    clearOnly,
    msaa: !clearOnly && isMultisampleAntialias(camera.antialias) && topology.lane.multisample,
    hdr: !clearOnly && (camera.tonemap !== 'none' || isTemporalAntialias(camera.antialias)),
    temporalDemand: aggregateTemporalDemand({
      taa: !clearOnly && isTemporalAntialias(camera.antialias),
      motionBlur: !clearOnly && topology.temporal?.motionBlur === true,
      ssr: !clearOnly && topology.ssr?.status === 'admitted',
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
    readonly occlusionResolved: boolean;
    readonly atmosphere?: GraphEnvironment['atmosphere'];
  },
): Result<SingleLayerMediumMsaaPair | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const waterInputs = context.getWaterMeshGraphAccesses?.() ?? [];
  if (waterInputs.length > 0) {
    const { gpuDriven: _gpu, gpuDrivenFilter: _filter, ...direct } = mainOptions;
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
  const opaque = addForwardOpaquePasses(
    graph,
    mainOptions,
    scene,
    gpuDriven,
    renderInternalCopySize(topology),
    cloud.occlusionResolved,
    context.nativeInputs,
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
    // Clouds receive camera-to-cloud air independently; fog only the opaque background here.
    const fogged =
      cloud.atmosphere === undefined
        ? ok(undefined)
        : addOpaqueFogPasses(graph, {
            topology,
            atmosphere: cloud.atmosphere,
            color: scene.resolved,
            depth: scene.depth,
          });
    if (!fogged.ok) return fogged;
    const compositeFeatures = contributeStandardCloudComposite(
      context,
      cloud.featureTargets,
      { input: scene.resolved, output: cloud.scene, cloudShadow: cloud.shadow },
      [],
      renderInternalSize(topology),
      cloud.atmosphere,
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

/**
 * Three `Material.fog = false` for opaque draws. Opaque fog is one fullscreen
 * depth pass with no per-pixel material fact, so fog:false opaque draws leave
 * `main` and record directly after that pass, depth-tested against the fogged
 * scene: in front they overwrite fogged pixels; behind they lose the depth test.
 * Built only when the frame has such a material and analytic fog; a CloudLayer
 * composite (drawn before fog) keeps them in `main`, fogged.
 */
function forwardUnfoggedOpaqueOptions(
  topology: RenderPipelineTopology,
  mainOptions: TypedScenePassOptions,
  cloudScene: RenderPipelineTarget | undefined,
  seeded: boolean,
): TypedScenePassOptions | undefined {
  if (topology.atmosphere !== true || topology.atmosphereBackgroundOnly === true) return undefined;
  if (topology.unfoggedOpaque !== true || topology.analyticFog !== true) return undefined;
  if (cloudScene !== undefined) return undefined;
  const { gpuDriven: _gpu, gpuDrivenFilter: _filter, ...direct } = mainOptions;
  return {
    ...direct,
    name: 'main-unfogged',
    depthLoadOp: 'load',
    recordMode: 'opaque-unfogged',
    seededDepth: seeded,
  };
}

/** `main` records only fogged opaque when an unfogged split exists, and keeps a seeded depth. */
function forwardOpaqueMainOptions(
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
  screenReceiver: boolean,
): TypedScenePassOptions {
  return {
    environment,
    name: 'main',
    colorStoreOp: scene.msaa ? 'auto' : 'store',
    ...(screenReceiver ? { fragmentEntryPoint: 'fs_forward_screen' } : {}),
    color: scene.color,
    ...(reflectionFallback === undefined
      ? {}
      : {
          colorTargets: [
            scene.color,
            reflectionFallback,
            ...(reflectionResponse === undefined ? [] : [reflectionResponse]),
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

interface ForwardScenePreparation {
  readonly surface: StandardPostSurface;
  readonly internalSize: GraphTextureDescriptor['size'];
  readonly route: ReturnType<typeof forwardLaneRoute>;
  readonly scene: ForwardSceneTargets;
  readonly mediumTargets: SingleLayerMediumNearestTargets | undefined;
  readonly reflectionFallback: ForwardReflectionTarget | undefined;
  readonly reflectionResponse: ForwardReflectionTarget | undefined;
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
  const mediumTargets = declareSingleLayerMediumTargets(
    context,
    topology,
    scene.value,
    internalSize,
  );
  if (!mediumTargets.ok) return mediumTargets;
  const reflectionFallback = declareForwardReflectionTarget(
    context.graph,
    'reflection-fallback',
    topology.reflectionFallback?.enabled === true,
    scene.value,
    internalSize,
  );
  if (!reflectionFallback.ok) return reflectionFallback;
  const response = declareForwardReflectionTarget(
    context.graph,
    'reflection-response',
    topology.ssr?.status === 'admitted',
    scene.value,
    internalSize,
  );
  if (!response.ok) return response;
  return ok({
    surface: surface.value,
    internalSize,
    route,
    scene: scene.value,
    mediumTargets: mediumTargets.value,
    reflectionFallback: reflectionFallback.value,
    reflectionResponse: response.value,
  });
}

function nativeForwardScreenInput(
  clusters: StandardClusterGraphBuffers | null,
  screen: RenderPipelineTarget | undefined,
  ao: RenderPipelineTarget | undefined,
): RenderPipelineTarget | undefined {
  return clusters?.kind === 'texture' ? undefined : (screen ?? ao);
}

function addForwardScreenProjection(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  ssao: ForwardSsaoProjection,
  clusters: StandardClusterGraphBuffers | null,
  clearOnly: boolean,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (clearOnly || !forwardScreenDemand(topology)) return ok(undefined);
  if (ssao.surface === undefined)
    throw new Error('Forward screen lighting requires the complete scene surface');
  return addForwardScreenData(context.graph, {
    size: renderInternalCopySize(topology),
    surface: ssao.surface,
    contact: topology.forwardContactShadows === true,
    capsules: topology.forwardCapsuleShadows === true,
    decals: ssao.decals,
    ao: ssao.ao,
    clusters,
  });
}

function addForwardTemporalInputs(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  inputs: Parameters<typeof addForwardSsr>[2],
) {
  const opaqueGuide = addTsrOpaqueGuide(context.graph, topology, inputs.scene);
  if (!opaqueGuide.ok) return opaqueGuide;
  const ssr = addForwardSsr(context, topology, inputs);
  if (!ssr.ok) return ssr;
  return ok({ opaqueGuide: opaqueGuide.value, ssr: ssr.value });
}

/** Single-sample temporal geometry shares the existing Forward prepass depth under MSAA. */
function forwardTemporalDepth(
  scene: ForwardSceneTargets,
  prepass: ForwardSsaoProjection,
): RenderPipelineTarget {
  return (scene.msaa ? prepass.centerDepth : undefined) ?? scene.depth;
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
  } = prepared.value;
  const shadows = addForwardShadows(context, topology, reuseAdjacentShadow);
  if (!shadows.ok) return shadows;
  const clusterBuffers = addForwardClusters(graph, topology, lighting, route.clearOnly);
  if (!clusterBuffers.ok) return clusterBuffers;
  const cloud = declareForwardCloudTargets(context, scene, route, internalSize);
  if (!cloud.ok) return cloud;
  // Produce the Beer shadow before Atmosphere and opaque receivers sample it.
  // Cloud composition still follows opaque shading.
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: scene.resolved,
    depth: scene.depth,
    cloudShadow: cloud.value.shadow,
  });
  if (!featureTargets.ok) return featureTargets;
  const atmosphere =
    topology.atmosphere !== true
      ? ok(undefined)
      : addForwardAtmosphere(
          graph,
          topology,
          scene.color,
          shadows.value,
          clusterBuffers.value,
          cloud.value.shadow,
        );
  if (!atmosphere.ok) return atmosphere;
  const gpuDriven = projectForwardGpuDriven(
    context,
    topology,
    scene.color,
    reflectionFallback?.attachment,
    reflectionResponse?.attachment,
  );
  if (!gpuDriven.ok) return gpuDriven;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value, shadows.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  const waterInfo = context.contributeFeatures({
    targets: featureTargets.value,
    placement: 'scene',
    include: ['water-info-producer', 'water-gpu-mesh', 'water-advanced-producer'],
  });
  if (!waterInfo.ok) return waterInfo;
  const waterInfoTargets = standardWaterInfoGraphTargets(
    context,
    context.viewIdentity ?? 'camera:0',
  );
  const ssao = addForwardSsao(
    context,
    topology,
    gpuDriven.value,
    clusterBuffers.value,
    route.clearOnly,
    scene.depth,
    scene.msaa && route.temporalDemand.targetCount === 1,
  );
  if (!ssao.ok) return ssao;
  const screen = addForwardScreenProjection(
    context,
    topology,
    ssao.value,
    clusterBuffers.value,
    route.clearOnly,
  );
  if (!screen.ok) return screen;
  const forwardScreen = screen.value;
  const createForwardReceiverInputs = () => {
    const receiver: StandardForwardReceiverInputs & {
      readonly waterInfoTargets?: typeof waterInfoTargets;
    } = {
      ...standardForwardReceiverInputs({
        materialSceneDepth: topology.materialSceneDepth,
        shadows: shadows.value,
        cloudShadow: cloud.value.shadow,
        ssao: nativeForwardScreenInput(
          clusterBuffers.value,
          forwardScreen,
          ssaoUsesLighting(topology.config?.ambientOcclusion) ? ssao.value.ao : undefined,
        ),
        planarReflection: targetCaptures?.value,
        clusterReads:
          clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value),
      }),
      extraAccesses: [
        ...(clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value)),
        ...(context.getWaterMeshGraphAccesses?.() ?? []),
      ],
      ...(waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    };
    return receiver;
  };
  const receiver = createForwardReceiverInputs();
  const allOpaqueOptions = forwardMainPassOptions(
    scene,
    atmosphere.value,
    receiver,
    reflectionFallback?.attachment,
    gpuDriven.value,
    reflectionResponse?.attachment,
    forwardScreen !== undefined,
  );
  const resolveForwardOpaqueOptions = () => {
    const opaqueOptions =
      waterInfoTargets.size === 0 ? allOpaqueOptions : { ...allOpaqueOptions, waterInfoTargets };
    return opaqueOptions;
  };
  const opaqueOptions = resolveForwardOpaqueOptions();
  // A compatible surface-data prepass already wrote the exact main depth.
  const finishForwardScene = () => {
    const seeded = ssao.value.predepth === scene.depth;
    const unfoggedOpaque = forwardUnfoggedOpaqueOptions(
      topology,
      opaqueOptions,
      cloud.value.scene,
      seeded,
    );
    let mainOptions = forwardOpaqueMainOptions(opaqueOptions, unfoggedOpaque !== undefined, seeded);
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
      gpuDriven.value,
      {
        scene: cloud.value.scene,
        shadow: cloud.value.shadow,
        featureTargets: featureTargets.value,
        occlusionResolved: ssao.value.occlusionResolved === true,
        atmosphere: atmosphere.value?.atmosphere,
      },
    );
    if (!opaquePair.ok) return opaquePair;
    const waterMsaaRequested = topology.water === true && scene.msaa;
    const addRequestedWaterOpaqueFog = () => {
      if (waterMsaaRequested && cloud.value.scene === undefined) {
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
      const waterMsaa = waterMsaaRequested
        ? addForwardWaterMsaaSurface(
            context,
            topology,
            scene,
            reflectionFallback?.attachment,
            gpuDriven.value,
            route.temporalDemand.targetCount === 1,
          )
        : ok(undefined);
      return waterMsaa;
    };
    const waterMsaa = resolveForwardWaterMsaaSurface();
    if (!waterMsaa.ok) return waterMsaa;
    const resolveForwardTemporalData = () => {
      const temporal =
        waterMsaa.value === undefined
          ? addForwardSceneData(
              context,
              topology,
              route.temporalDemand,
              forwardTemporalDepth(scene, ssao.value),
              gpuDriven.value,
            )
          : ok(waterMsaa.value.temporal);
      return temporal;
    };
    const temporal = resolveForwardTemporalData();
    if (!temporal.ok) return temporal;
    const temporalInputs = addForwardTemporalInputs(context, topology, {
      scene: scene.resolved,
      fallback: reflectionFallback?.sampled,
      response: reflectionResponse?.sampled,
      surface: ssao.value.surface,
      temporal: temporal.value,
    });
    if (!temporalInputs.ok) return temporalInputs;
    let later = sceneAfterCloudComposite(scene, cloud.value.scene);
    const medium = {
      nearestTargets: mediumTargets,
      opaquePair: opaquePair.value,
      targetCaptures: targetCaptures?.value,
      gpuDriven: gpuDriven.value,
      temporal: temporal.value,
    };
    const water =
      waterMsaa.value === undefined
        ? undefined
        : addForwardWaterMsaaStages(
            context,
            topology,
            later,
            waterMsaa.value,
            atmosphere.value,
            receiver,
            medium,
          );
    if (water !== undefined && !water.ok) return water;
    if (water?.ok === true) later = water.value;
    const resolveForwardTranslucentStages = () => {
      const translucent =
        water === undefined
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
      waterMsaa.value?.fallback ?? reflectionFallback?.sampled,
      ssao.value.surface,
    );
    if (!observed.ok) return observed;
    return presentForwardLane(
      context,
      topology,
      later,
      surface,
      temporal.value,
      temporalInputs.value.ssr,
      temporalInputs.value.opaqueGuide,
      gpuDriven.value,
      ssao.value,
    );
  };
  return finishForwardScene();
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
  surfaceData: StandardSceneSurfaceDataTargets | undefined,
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
    surfaceData === undefined
      ? []
      : [
          bindStandardSceneDataTarget(surfaceData.normal, topology, surfaceData.normalSchema),
          bindStandardSceneDataTarget(surfaceData.depth, topology, surfaceData.depthSchema),
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
  gpuDriven?: RenderPipelineGpuDrivenProjection,
  ssao?: ForwardSsaoProjection,
): ReturnType<RenderPipeline['build']> {
  if (context.forwardOutput !== undefined)
    return context.forwardOutput.build(context, topology, scene.resolved, scene.depth, surface);
  let ao = ssao;
  if (
    ssao?.depth !== undefined &&
    topology.config?.ambientOcclusion?.enabled === true &&
    topology.config.ambientOcclusion.application === 'scene-color'
  ) {
    const added = addForwardAo(
      context,
      topology,
      null,
      ssao.surface ?? { depth: ssao.depth },
      renderInternalCopySize(topology),
    );
    if (!added.ok) return added;
    ao = { ...ssao, ...added.value };
  }
  const post = addStandardPost(
    context,
    topology,
    scene.resolved,
    scene.depth,
    surface,
    temporal,
    ssr,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
    opaqueGuide,
    standardWaterInfoGraphTargets(context, context.viewIdentity ?? 'camera:0'),
    gpuDriven,
    scene.waterFoamSimulation,
    ao?.ao === undefined || ao.depth === undefined
      ? undefined
      : {
          ao: ao.ao,
          depth: ao.depth,
          linearDepth: ao.linearDepth,
          parameters: ao.parameters,
        },
  );
  if (!post.ok) return post;
  return ok(undefined);
}
