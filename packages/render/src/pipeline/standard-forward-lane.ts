import {
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  type RenderGraphError,
  RenderGraphError as RenderGraphFailure,
} from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { isTemporalAntialias } from '../components/camera';
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
import { addOpaqueFogPasses, addTranslucencyVolumetricFogPasses } from './analytic-fog-pass';
import { addForwardScreenData } from './forward-screen-data';
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
import {
  resolveStandardGtaoExecution,
  type StandardPipelineBuildContext,
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
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  clearOnly: boolean,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  if (clearOnly) return ok(null);
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
  const config = topology.config?.ssao;
  if (lighting.kind !== 'clustered' || lighting.transport.kind !== 'cpu-texture') return undefined;
  const ao = config?.enabled === true;
  const screenDemand = forwardScreenDemand(topology);
  if (!ao && !screenDemand) return undefined;
  const dimensions = renderInternalCopySize(topology);
  const resolutionScale = ao ? getSsaoParameters(config).resolutionScale : 1;
  return {
    width: ao ? Math.max(1, Math.round(dimensions.width * resolutionScale)) : 0,
    height: ao ? Math.max(1, Math.round(dimensions.height * resolutionScale)) : 0,
    ...(screenDemand ? { screen: dimensions } : {}),
  };
}

interface ForwardSsaoProjection {
  readonly occlusionResolved?: boolean;
  readonly decals?: ProjectedDecalChannels | undefined;
  readonly ao: RenderPipelineTarget | undefined;
  readonly surface: StandardSceneSurfaceDataTargets | undefined;
}

function forwardScreenDemand(topology: RenderPipelineTopology): boolean {
  return (
    topology.forwardContactShadows === true ||
    topology.forwardCapsuleShadows === true ||
    (topology.projectedDecals?.length ?? 0) > 0
  );
}

function forwardSurfaceDemand(topology: RenderPipelineTopology): boolean {
  return (
    topology.forwardContactShadows === true ||
    topology.forwardCapsuleShadows === true ||
    (topology.projectedDecals?.length ?? 0) > 0 ||
    topology.sceneDataBindings?.some(
      (binding) =>
        binding.schema === SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA ||
        binding.schema === SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
    ) === true
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
  targets: StandardSceneSurfaceDataTargets,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  size: { readonly width: number; readonly height: number },
): Result<boolean, RenderGraphError> {
  const graph = context.graph;
  const early = addStandardSceneSurfaceDataPass(graph, targets, gpuDriven);
  if (!early.ok) return early;
  if (gpuDriven?.addLateOcclusion === undefined) return ok(false);
  const depth = graph.view(targets.depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!depth.ok) return depth;
  const late = addGpuLateOcclusion(graph, {
    gpuDriven,
    depth: depth.value,
    multisampled: false,
    ...size,
    view: sceneViewImport(graph),
  });
  if (!late.ok) return late;
  const completed = addTypedScenePass(graph, {
    name: 'standard-scene-surface-data-late',
    gpuDriven,
    gpuDrivenFilter: 'opaque',
    gpuDrivenPhase: 'late',
    color: targets.normal,
    depth: targets.depth,
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'forward',
    fragmentEntryPoint: 'fs_ao_input',
    colorLoadOp: 'load',
    depthLoadOp: 'load',
  });
  return completed.ok ? ok(true) : completed;
}

function addForwardSsao(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  gpuDriven: RenderPipelineGpuDrivenProjection | undefined,
  clusters: StandardClusterGraphBuffers | null,
  clearOnly: boolean,
): Result<ForwardSsaoProjection, RenderGraphError> {
  const config = topology.config?.ssao;
  const aoEnabled = config?.enabled === true;
  const surfaceDemand = forwardSurfaceDemand(topology);
  const ssr = topology.ssr?.status === 'admitted';
  if (!surfaceDemand && !ssr && (!aoEnabled || clearOnly))
    return ok({ ao: undefined, surface: undefined });
  const dimensions = renderInternalCopySize(topology);
  const surface = createStandardSceneSurfaceDataTargets(context.graph, dimensions);
  if (!surface.ok) return surface;
  const produced = addForwardSurfacePasses(context, surface.value, gpuDriven, dimensions);
  if (!produced.ok) return produced;
  const projected = addForwardSurfaceDecals(context, topology, surface.value, dimensions);
  if (!projected.ok) return projected;
  const { surface: finalSurface, decals } = projected.value;
  if (!aoEnabled || clearOnly)
    return ok({ ao: undefined, ...projected.value, occlusionResolved: produced.value });
  const parameters = getSsaoParameters(config);
  const aoSize = {
    width: Math.max(1, Math.round(dimensions.width * parameters.resolutionScale)),
    height: Math.max(1, Math.round(dimensions.height * parameters.resolutionScale)),
  };
  const execution = resolveStandardGtaoExecution(
    parameters.algorithm,
    topology.lane.compute,
    context.gtaoExecutionOverride,
  );
  if (!execution.ok) return execution;
  const raw = target(context.graph, 'ssao-raw', {
    format: 'rgba8unorm',
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
  const passes = addTypedSsaoPasses(context.graph, {
    normal: finalSurface.normal,
    depth: finalSurface.depth,
    raw: raw.value,
    blurred: blurred.value,
    execution: execution.value,
  });
  if (!passes.ok) return passes;
  if (!topology.lane.storageBuffer) {
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
  return ok({
    ao: blurred.value,
    occlusionResolved: produced.value,
    surface: finalSurface,
    ...(decals === undefined ? {} : { decals }),
  });
}

/** The atmosphere sky when enabled, else the skybox; returns the atmosphere environment. */
function addForwardBackground(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  color: RenderPipelineTarget,
): Result<GraphEnvironment | undefined, RenderGraphError> {
  if (topology.atmosphere === true && topology.atmosphereBackgroundOnly === true) {
    return addAtmosphereBackground(graph, color, {}, 'sky');
  }
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
  unfoggedOpaque: TypedScenePassOptions | undefined,
): Result<void, RenderPipelineBuildError> {
  const graph = context.graph;
  const fogged = addOpaqueFogPasses(graph, { topology, color: scene.resolved, depth: scene.depth });
  if (!fogged.ok) return fogged;
  if (unfoggedOpaque !== undefined) {
    const unfogged = addTypedScenePass(graph, unfoggedOpaque);
    if (!unfogged.ok) return unfogged;
  }
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
  },
): Result<SingleLayerMediumMsaaPair | undefined, RenderPipelineBuildError> {
  const graph = context.graph;
  const opaque = addForwardOpaquePasses(
    graph,
    mainOptions,
    scene,
    gpuDriven,
    renderInternalCopySize(topology),
    cloud.occlusionResolved,
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
): TypedScenePassOptions | undefined {
  if (topology.unfoggedOpaque !== true || topology.analyticFog !== true) return undefined;
  if (cloudScene !== undefined) return undefined;
  const { gpuDriven: _gpu, gpuDrivenFilter: _filter, ...direct } = mainOptions;
  return { ...direct, name: 'main-unfogged', depthLoadOp: 'load', recordMode: 'opaque-unfogged' };
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

/** SSR temporal geometry shares the independent single-sample Surface depth. */
function forwardTemporalDepth(
  scene: ForwardSceneTargets,
  topology: RenderPipelineTopology,
  surface: StandardSceneSurfaceDataTargets | undefined,
): RenderPipelineTarget {
  return scene.msaa && topology.ssr?.status === 'admitted'
    ? (surface?.depth ?? scene.depth)
    : scene.depth;
}

export function buildStandardForwardLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  reuseAdjacentShadow = false,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
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
  const atmosphere = addForwardBackground(graph, topology, scene.color);
  if (!atmosphere.ok) return atmosphere;
  const gpuDriven = projectForwardGpuDriven(
    context,
    topology,
    scene.color,
    reflectionFallback?.attachment,
    reflectionResponse?.attachment,
  );
  if (!gpuDriven.ok) return gpuDriven;
  const cloud = declareForwardCloudTargets(context, scene, route, internalSize);
  if (!cloud.ok) return cloud;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  // Produce the density cache and spatial receiver shadow before opaque
  // shading. The cloud composite is a later scene pass, so it cannot be
  // projected in this call without being overwritten by `main`.
  const featureTargets = contributeStandardCloudPreOpaque(context, {
    color: scene.resolved,
    depth: scene.depth,
    cloudShadow: cloud.value.shadow,
  });
  if (!featureTargets.ok) return featureTargets;
  const ssao = addForwardSsao(
    context,
    topology,
    gpuDriven.value,
    clusterBuffers.value,
    route.clearOnly,
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
  const receiver = standardForwardReceiverInputs({
    shadows: shadows.value,
    cloudShadow: cloud.value.shadow,
    ssao: nativeForwardScreenInput(clusterBuffers.value, forwardScreen, ssao.value.ao),
    planarReflection: targetCaptures?.value,
    clusterReads:
      clusterBuffers.value === null ? [] : standardClusterReadAccesses(clusterBuffers.value),
  });
  const allOpaqueOptions = forwardMainPassOptions(
    scene,
    atmosphere.value,
    receiver,
    reflectionFallback?.attachment,
    gpuDriven.value,
    reflectionResponse?.attachment,
    forwardScreen !== undefined,
  );
  const unfoggedOpaque = forwardUnfoggedOpaqueOptions(
    topology,
    allOpaqueOptions,
    cloud.value.scene,
  );
  const mainOptions: TypedScenePassOptions =
    unfoggedOpaque === undefined
      ? allOpaqueOptions
      : { ...allOpaqueOptions, recordMode: 'opaque-fogged' };
  const opaquePair = addForwardOpaqueStage(context, topology, scene, mainOptions, gpuDriven.value, {
    scene: cloud.value.scene,
    shadow: cloud.value.shadow,
    featureTargets: featureTargets.value,
    occlusionResolved: ssao.value.occlusionResolved === true,
  });
  if (!opaquePair.ok) return opaquePair;
  const temporal = addForwardSceneData(
    context,
    topology,
    route.temporalDemand,
    forwardTemporalDepth(scene, topology, ssao.value.surface),
    gpuDriven.value,
  );
  if (!temporal.ok) return temporal;
  const temporalInputs = addForwardTemporalInputs(context, topology, {
    scene: scene.resolved,
    fallback: reflectionFallback?.sampled,
    response: reflectionResponse?.sampled,
    surface: ssao.value.surface,
    temporal: temporal.value,
  });
  if (!temporalInputs.ok) return temporalInputs;
  const later = sceneAfterCloudComposite(scene, cloud.value.scene);
  const translucent = addForwardTranslucentStages(
    context,
    topology,
    later,
    atmosphere.value,
    receiver,
    {
      nearestTargets: mediumTargets,
      opaquePair: opaquePair.value,
      targetCaptures: targetCaptures?.value,
      gpuDriven: gpuDriven.value,
    },
    unfoggedOpaque,
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
    reflectionFallback?.sampled,
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
  opaqueGuide?: RenderPipelineTarget,
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
    ssr,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
    opaqueGuide,
  );
  if (!post.ok) return post;
  return ok(undefined);
}
