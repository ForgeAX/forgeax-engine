import type { GraphBuffer, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { addStandardAtmosphere } from '../environment/background';
import type { GraphEnvironment } from '../environment/ibl';
import { addTranslucencyVolumetricFogPasses } from '../pipeline/analytic-fog-pass';
import {
  FORWARD_SHADOW_COLOR_ENTRY,
  isForwardShadowColorEntry,
} from '../pipeline/forward-shadow-admission';
import { renderInternalSize } from '../pipeline/render-extent';
import { declareSingleLayerMediumTargets } from '../pipeline/single-layer-medium-passes';
import {
  prepareStandardWaterView,
  type StandardPipelineBuildContext,
  type WaterInfoGraphTargets,
} from '../pipeline/standard-build-context';
import {
  declareOrderedCloudPhase,
  type StandardCloudPhase,
} from '../pipeline/standard-cloud-stage';
import {
  addForwardOpaqueFogStage,
  addForwardOpaqueStage,
  addForwardSceneData,
  addForwardScreenProjection,
  addForwardSsao,
  addForwardSsrSource,
  addForwardTemporalInputs,
  addForwardTranslucentStages,
  addForwardWaterMsaaSurface,
  addForwardWaterStages,
  bindForwardSceneVelocity,
  declareForwardReflectionTargets,
  declareForwardSceneTargets,
  type ForwardReflectionTargets,
  type ForwardSceneTargets,
  forwardOpaqueMainOptions,
  forwardSceneAttachments,
  forwardTemporalDemand,
  forwardTemporalDepth,
  forwardUnfoggedOpaqueOptions,
  prepareForwardMotionTargets,
  prepareForwardShadowProjection,
  sceneAfterCloudComposite,
} from '../pipeline/standard-forward-lane';
import {
  type StandardForwardReceiverInputs,
  standardForwardReceiverInputs,
} from '../pipeline/standard-forward-receiver';
import {
  encodeStandardClusterMembership,
  importForwardShadowLightData,
  importStandardClusterBuffers,
  type StandardClusterGraphBuffers,
  shouldExecuteStandardClusterMembershipPass,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import { addStandardPost, type OrderedStandardPostInputs } from '../pipeline/standard-post';
import { standardTopology } from '../pipeline/standard-profile';
import {
  addCurrentStandardTranslucency,
  addStandardTransparentPasses,
} from '../pipeline/standard-transparency';
import {
  importRenderPipelineSurface,
  type RenderPipelineBuildError,
  type RenderPipelineFrame,
  type RenderPipelineGpuDrivenProjection,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import type { ShadowDepthLayers } from '../shadow-depth-layers';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import type { TypedScenePassOptions } from '../typed-render-graph-primitives';
import {
  addPlanarReflectionPass,
  addTypedShadowPasses,
  currentShadowViews,
} from '../typed-shadow-passes';
import { currentGpuRaster } from './current-gpu-raster';
import { currentOutputDither, type DisplayPorts, type ForwardOutput } from './display-ports';
import type { RenderFrameState } from './frame-snapshot';
import { addCurrentReflectionProbeFilters } from './reflection-probe-pmrem';
import type { _InternalRenderPipelineContext } from './render-context';
import { SceneColorDraws } from './scene-color-draws';

/** Ordered production for a Forward surface and its resolved scene color. Cluster storage belongs to
 * the current light owner, and all material-dependent phases read the issuing draw rows.
 * The view owns two scene attachments and imports the current display. */
export function buildForwardDisplay(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTopology,
  forwardOutput: ForwardOutput,
  lighting: StandardTopologyInputValue,
  ports: DisplayPorts,
  frameState: RenderFrameState,
  depthLayers: ShadowDepthLayers,
  retainIndirectBundles: boolean,
  capabilities: Pick<import('@forgeax/engine-rhi').RhiCaps, 'rgba16floatRenderable'>,
  post: OrderedStandardPostInputs,
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  const topology = forwardOutput === 'standard' ? standardTopology(input) : input;
  const endpoint = importRenderPipelineSurface(graph, topology);
  if (!endpoint.ok) return endpoint;
  const size = renderInternalSize(topology);
  const context = {
    graph,
    projectGpuDriven: () => ok(undefined),
    contributeFeatures: () => ok(undefined),
    readOutputDither: currentOutputDither,
    ...post,
    directFinalColor: true as const,
    ...(ports.samples === 1 ? { currentMaterialDepth: true as const } : {}),
    ...(forwardOutput === 'standard' ? {} : { forwardOutput }),
    capabilities,
    observationCaptureDomains: ports.captureDomains,
  };
  const scene = declareForwardSceneTargets(
    context,
    topology,
    endpoint.value,
    ports.samples > 1,
    size,
  );
  if (!scene.ok) return scene;
  const phases = bindForwardDisplayScenePhases(context, topology, scene.value, size);
  if (!phases.ok) return phases;
  const { clouds, reflections, formats } = phases.value;
  const probes = addCurrentReflectionProbeFilters(graph);
  if (!probes.ok) return probes;
  const water = prepareStandardWaterView(context, topology);
  if (!water.ok) return water;
  const shadows = addTypedShadowPasses(graph, topology, {
    currentViews: currentShadowViews(topology.shadow, true),
    currentReceiverDepth: ports.geometry === 'direct' ? undefined : false,
    depthLayers,
    reuseAdjacentShadow: true,
    ...(water.value === undefined
      ? {}
      : {
          waterInfoTargets: water.value.targets,
          surfaceFluidSimulation: water.value.fluid,
        }),
  });
  if (!shadows.ok) return shadows;
  const background = addForwardDisplayLighting(
    graph,
    topology,
    lighting,
    scene.value.color,
    ports,
    shadows.value,
    clouds?.shadow,
  );
  if (!background.ok) return background;
  const capture = addPlanarReflectionPass(graph, shadows.value, context.planarReflection);
  if (!capture.ok) return capture;
  const { environment, tables } = background.value;
  const projected =
    ports.geometry === 'direct'
      ? ok(undefined)
      : currentGpuRaster(
          graph,
          {
            format: ports.color,
            sampleCount: ports.samples,
            ...formats,
            lateOcclusion: ports.geometry === 'occlusion',
          },
          frameState,
          retainIndirectBundles,
        );
  if (!projected.ok) return projected;
  const output = recordForwardDisplayStages(context, topology, scene.value, endpoint.value, {
    forwardOutput,
    environment,
    ports,
    size,
    shadows: shadows.value,
    clouds,
    reflections,
    tables,
    lightData: tables?.kind === 'storage' ? tables.lightData : undefined,
    clusterReads:
      ports.textureLighting && tables !== null ? standardClusterReadAccesses(tables) : [],
    gpu: projected.value,
    waterInfoTargets: water.value?.targets,
  });
  return output.ok ? projected : output;
}

function bindForwardDisplayScenePhases(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  size: ReturnType<typeof renderInternalSize>,
) {
  const clouds = declareOrderedCloudPhase(context, scene.resolved, scene.depth, size);
  if (!clouds.ok) return clouds;
  const reflections = declareForwardReflectionTargets(context.graph, topology, scene, size);
  if (!reflections.ok) return reflections;
  const { reflectionFallback, reflectionResponse, reflectionSurface } = reflections.value;
  return ok({
    clouds: clouds.value,
    reflections: reflections.value,
    formats:
      reflectionFallback === undefined
        ? {}
        : {
            additionalColorFormats: [
              reflectionFallback.attachment.format,
              ...(reflectionResponse === undefined ? [] : [reflectionResponse.attachment.format]),
              ...(reflectionSurface === undefined ? [] : [reflectionSurface.attachment.format]),
            ],
          },
  });
}

function addForwardDisplayLighting(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
  color: RenderPipelineTarget,
  ports: DisplayPorts,
  shadows: Parameters<typeof standardForwardReceiverInputs>[0]['shadows'],
  cloudShadow: RenderPipelineTarget | undefined,
) {
  const tables =
    !ports.textureLighting && ports.volume === undefined
      ? ok(null)
      : importStandardClusterBuffers(graph, lighting, ports.clusterTextureExtent);
  if (!tables.ok) return tables;
  if (topology.lane.compute) {
    const membership = graph.addComputePass(
      'cluster-membership-producer',
      {
        accesses: [],
        executeIf: shouldExecuteStandardClusterMembershipPass,
        encodeDirect(pass, frame) {
          const lighting = (frame as _InternalRenderPipelineContext).standardLighting;
          if (lighting?.kind !== 'clustered')
            throw new Error('Forward light dispatch requires its current cluster grid');
          encodeStandardClusterMembership(pass, frame, lighting.prepared.layout.grid);
        },
      },
      'transfer',
    );
    if (!membership.ok) return membership;
  }
  const environment = addStandardAtmosphere(
    graph,
    topology,
    color,
    { directional: shadows.directional?.view, cloud: cloudShadow?.view },
    tables.value,
  );
  if (!environment.ok) return environment;
  return ok({ tables: tables.value, environment: environment.value });
}

function recordForwardDisplayStages(
  context: StandardPipelineBuildContext & OrderedStandardPostInputs,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  surface: Parameters<typeof addStandardPost>[4],
  input: {
    readonly forwardOutput: ForwardOutput;
    readonly environment: GraphEnvironment | undefined;
    readonly ports: DisplayPorts;
    readonly size: ReturnType<typeof renderInternalSize>;
    readonly shadows: Parameters<typeof standardForwardReceiverInputs>[0]['shadows'];
    readonly clouds: StandardCloudPhase | undefined;
    readonly reflections: ForwardReflectionTargets;
    readonly tables: StandardClusterGraphBuffers | null;
    readonly lightData: GraphBuffer | undefined;
    readonly clusterReads: ReturnType<typeof standardClusterReadAccesses>;
    readonly gpu: RenderPipelineGpuDrivenProjection | undefined;
    readonly waterInfoTargets: WaterInfoGraphTargets | undefined;
  },
) {
  const { depth, msaa } = scene;
  const {
    forwardOutput,
    environment,
    ports,
    size,
    shadows,
    clouds,
    reflections,
    lightData,
    clusterReads,
    gpu,
    waterInfoTargets,
  } = input;
  const demand = forwardDisplayTemporalDemand(context, topology, ports);
  const motion =
    demand === undefined
      ? ok(undefined)
      : prepareForwardMotionTargets(context, topology, demand, scene, size);
  if (!motion.ok) return motion;
  const needsScreenDepth =
    ports.forwardShadow !== undefined ||
    ports.forwardScreenLighting !== 0 ||
    ports.water !== undefined;
  const ao = addForwardSsao(
    context,
    topology,
    gpu,
    false,
    depth,
    motion.value?.temporalDepthRequired ?? false,
    needsScreenDepth ? undefined : 'prepass',
    motion.value?.prepassVelocity,
    motion.value?.msaaTemporal,
  );
  if (!ao.ok) return ao;
  const receivers = forwardDisplayReceivers(
    context,
    topology,
    depth,
    ports.shadowLightBytes,
    lightData,
    ao.value,
    {
      shadows,
      ssao: ao.value.ao,
      cloudShadow: clouds?.shadow,
      materialSceneDepth: !msaa,
      planarReflection: context.planarReflection,
      clusterReads,
    },
  );
  if (!receivers.ok) return receivers;
  const primed =
    ports.water === undefined
      ? usesPrimedForwardDepth(ports, motion.value)
      : ao.value.predepth === depth;
  const main = displayOpaqueOptions(
    scene,
    ports,
    receivers.value,
    environment,
    gpu,
    primed,
    reflections,
  );
  const atmosphere = environment?.atmosphere;
  const opaque = recordForwardDisplayOpaque(
    context,
    topology,
    scene,
    waterInfoTargets === undefined ? main : { ...main, waterInfoTargets },
    primed,
    clouds,
    atmosphere,
    ao.value,
  );
  if (!opaque.ok) return opaque;
  const waterMsaa = prepareForwardDisplayWaterMsaa(context, topology, scene, {
    atmosphere,
    clouds,
    unfogged: opaque.value.unfogged,
    fallback: reflections.reflectionFallback?.attachment,
    motion: motion.value,
    gpu,
  });
  if (!waterMsaa.ok) return waterMsaa;
  const temporal =
    forwardOutput === 'standard'
      ? recordForwardTemporalInputs(
          context,
          topology,
          scene,
          ao.value,
          gpu,
          demand,
          motion.value?.prepassVelocity,
          reflections,
          waterMsaa.value?.temporal,
          waterInfoTargets,
        )
      : ok(undefined);
  if (!temporal.ok) return temporal;
  return finishForwardDisplay(
    context,
    topology,
    sceneAfterCloudComposite(scene, clouds?.scene),
    surface,
    input,
    {
      atmosphere,
      opaque: opaque.value,
      receivers: receivers.value.transparent,
      temporal: temporal.value,
      waterMsaa: waterMsaa.value,
      sharedHzb: primed && !msaa && ao.value.hzbDepth === depth ? ao.value.hzb : undefined,
    },
  );
}

function prepareForwardDisplayWaterMsaa(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  input: {
    readonly atmosphere: GraphEnvironment['atmosphere'] | undefined;
    readonly clouds: StandardCloudPhase | undefined;
    readonly unfogged: TypedScenePassOptions | undefined;
    readonly fallback: RenderPipelineTarget | undefined;
    readonly motion:
      | Extract<ReturnType<typeof prepareForwardMotionTargets>, { ok: true }>['value']
      | undefined;
    readonly gpu: RenderPipelineGpuDrivenProjection | undefined;
  },
) {
  if (topology.water !== true) return ok(undefined);
  if (input.clouds?.scene === undefined) {
    const fogged = addForwardOpaqueFogStage(
      context.graph,
      topology,
      scene,
      input.unfogged,
      input.atmosphere,
    );
    if (!fogged.ok) return fogged;
  }
  return scene.msaa
    ? addForwardWaterMsaaSurface(
        context,
        topology,
        scene,
        input.fallback,
        input.motion?.msaaTemporal,
        input.gpu,
        input.motion?.needsMotion ?? false,
      )
    : ok(undefined);
}

function finishForwardDisplay(
  context: StandardPipelineBuildContext & OrderedStandardPostInputs,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  surface: Parameters<typeof addStandardPost>[4],
  input: Parameters<typeof recordForwardDisplayStages>[4],
  prepared: {
    readonly atmosphere: GraphEnvironment['atmosphere'] | undefined;
    readonly opaque: Extract<ReturnType<typeof recordForwardDisplayOpaque>, { ok: true }>['value'];
    readonly receivers: StandardForwardReceiverInputs;
    readonly temporal: Parameters<typeof addStandardPost>[5];
    readonly waterMsaa:
      | Extract<ReturnType<typeof addForwardWaterMsaaSurface>, { ok: true }>['value']
      | undefined;
    readonly sharedHzb: Extract<ReturnType<typeof addForwardSsao>, { ok: true }>['value']['hzb'];
  },
) {
  const { graph } = context;
  const { forwardOutput, environment, size, shadows, clouds, tables, gpu, waterInfoTargets } =
    input;
  const { atmosphere, opaque, receivers, temporal, waterMsaa, sharedHzb } = prepared;
  const receiver = {
    ...receivers,
    environment,
    ...(waterInfoTargets === undefined ? {} : { waterInfoTargets }),
  };
  const medium = {
    opaquePair: opaque.opaquePair,
    temporal: temporal?.sceneVelocity === undefined ? temporal?.sceneTemporal : undefined,
    gpuDriven: gpu,
  };
  const recorded =
    topology.water === true
      ? recordForwardDisplayWater(
          context,
          topology,
          scene,
          size,
          receiver,
          medium,
          temporal,
          waterMsaa,
          sharedHzb,
        )
      : recordForwardDisplayTranslucency(context, topology, scene, input, receiver, opaque, medium);
  if (!recorded.ok) return recorded;
  const later = recorded.value;
  const volume = addTranslucencyVolumetricFogPasses(graph, {
    topology,
    atmosphere,
    color: later.resolved,
    depth: later.depth,
    directionalShadow: shadows.directional?.view,
    spotShadow: shadows.spot?.view,
    clusterBuffers: tables,
    cloudShadow: clouds?.shadow?.view,
  });
  if (!volume.ok) return volume;
  if (forwardOutput !== 'standard')
    return forwardOutput.build(context, topology, later.resolved, later.depth, surface);
  if (topology.water !== true)
    return addStandardPost(context, topology, later.resolved, later.depth, surface, temporal);
  const velocity =
    temporal?.sceneVelocity === undefined
      ? ok(undefined)
      : bindForwardSceneVelocity(graph, later.depth);
  if (!velocity.ok) return velocity;
  return addStandardPost(context, topology, later.resolved, later.depth, surface, {
    ...temporal,
    sceneVelocity: velocity.value,
    waterInfoTargets,
    waterFoamSimulation: later.waterFoamSimulation,
  });
}

function recordForwardDisplayWater(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  size: ReturnType<typeof renderInternalSize>,
  receiver: StandardForwardReceiverInputs & { readonly environment: GraphEnvironment | undefined },
  medium: Parameters<typeof addDisplayTranslucency>[6],
  temporal: Parameters<typeof addStandardPost>[5],
  waterMsaa: Parameters<typeof addForwardWaterStages>[3],
  sharedHzb: Parameters<typeof addForwardWaterStages>[8],
) {
  const targets =
    topology.singleLayerMedium === true
      ? declareSingleLayerMediumTargets(context.graph, size, scene.color.sampleCount)
      : ok(undefined);
  if (!targets.ok) return targets;
  return addForwardWaterStages(
    context,
    topology,
    scene,
    waterMsaa,
    receiver.environment,
    receiver,
    {
      ...medium,
      nearestTargets: targets.value,
    },
    temporal?.sceneVelocity === undefined ? undefined : temporal.sceneTemporal,
    sharedHzb,
  );
}

function recordForwardDisplayTranslucency(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  input: Parameters<typeof recordForwardDisplayStages>[4],
  receiver: Parameters<typeof addDisplayTranslucency>[3],
  opaque: Extract<ReturnType<typeof recordForwardDisplayOpaque>, { ok: true }>['value'],
  medium: Parameters<typeof addDisplayTranslucency>[6],
) {
  if (input.clouds?.scene === undefined) {
    const fog = addForwardOpaqueFogStage(
      context.graph,
      topology,
      scene,
      opaque.unfogged,
      receiver.environment?.atmosphere,
    );
    if (!fog.ok) return fog;
  }
  const translucent = addDisplayTranslucency(
    context,
    scene,
    input.size,
    receiver,
    input.ports,
    topology,
    medium,
  );
  return translucent.ok ? ok(scene) : translucent;
}

function forwardDisplayTemporalDemand(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  ports: DisplayPorts,
) {
  return context.taaHistory !== undefined ||
    ports.standardPost?.motionBlur === true ||
    ports.reflection === 'forward-spatial'
    ? forwardTemporalDemand(topology)
    : undefined;
}

function usesPrimedForwardDepth(
  ports: DisplayPorts,
  motion:
    | Extract<ReturnType<typeof prepareForwardMotionTargets>, { ok: true }>['value']
    | undefined,
): boolean {
  return (
    ports.aoMethod !== undefined ||
    ports.forwardShadow !== undefined ||
    motion?.prepassVelocity !== undefined ||
    motion?.msaaTemporal !== undefined ||
    ports.reflection === 'forward-inline' ||
    ports.reflection === 'forward-spatial' ||
    ports.forwardScreenLighting !== 0
  );
}

function recordForwardDisplayOpaque(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  main: TypedScenePassOptions,
  primed: boolean,
  clouds: StandardCloudPhase | undefined,
  atmosphere: GraphEnvironment['atmosphere'] | undefined,
  prepass: Extract<ReturnType<typeof addForwardSsao>, { ok: true }>['value'],
) {
  const source = addForwardSsrSource(context, topology, prepass);
  if (!source.ok) return source;
  const inputs = source.value === undefined ? main : { ...main, ssrSource: source.value };
  const unfogged = forwardUnfoggedOpaqueOptions(topology, inputs, clouds?.scene, primed);
  const opaque = addForwardOpaqueStage(
    context,
    topology,
    scene,
    forwardOpaqueMainOptions(inputs, unfogged !== undefined, primed),
    clouds,
    atmosphere,
  );
  return opaque.ok ? ok({ unfogged, opaquePair: opaque.value }) : opaque;
}

function displayOpaqueOptions(
  scene: ForwardSceneTargets,
  ports: DisplayPorts,
  receivers: {
    readonly opaque: StandardForwardReceiverInputs;
    readonly fragment: string | undefined;
  },
  environment: GraphEnvironment | undefined,
  gpu: RenderPipelineGpuDrivenProjection | undefined,
  primed: boolean,
  reflections: ForwardReflectionTargets,
): TypedScenePassOptions {
  const { reflectionFallback, reflectionResponse, reflectionSurface } = reflections;
  const fragmentEntryPoint = receivers.fragment;
  return {
    ...receivers.opaque,
    environment,
    ...(fragmentEntryPoint === undefined
      ? {}
      : {
          fragmentEntryPoint,
          ...(isForwardShadowColorEntry(fragmentEntryPoint)
            ? { atmosphereReads: ports.perPixelSolar ? 'solar' : 'none' }
            : {}),
        }),
    name: 'main',
    ...forwardSceneAttachments(scene),
    ...(reflectionFallback === undefined
      ? {}
      : {
          colorTargets: [
            scene.color,
            reflectionFallback.attachment,
            ...(reflectionResponse === undefined ? [] : [reflectionResponse.attachment]),
            ...(reflectionSurface === undefined ? [] : [reflectionSurface.attachment]),
          ],
        }),
    colorLoadOp: environment === undefined ? 'clear' : 'load',
    depthLoadOp: 'load',
    colorStoreOp: 'store',
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'opaque',
    seededDepth: true,
    forwardDisplayDepth: primed ? 'primed-color' : 'color',
    ...(gpu === undefined ? {} : { gpuDriven: gpu }),
    standardOpaqueRows: true,
    gpuDrivenFilter: 'opaque',
  };
}

/** Prepare the current view's scene data before later color writers. */
function recordForwardTemporalInputs(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  scene: ForwardSceneTargets,
  prepass: Extract<ReturnType<typeof addForwardSsao>, { ok: true }>['value'],
  gpu: RenderPipelineGpuDrivenProjection | undefined,
  demand: ReturnType<typeof forwardTemporalDemand> | undefined,
  velocity: RenderPipelineTarget | undefined,
  reflections: ForwardReflectionTargets,
  waterTemporal: RenderPipelineTarget | undefined,
  waterInfoTargets: WaterInfoGraphTargets | undefined,
): Result<Parameters<typeof addStandardPost>[5], RenderPipelineBuildError> {
  if (demand === undefined) return ok(undefined);
  const depth = forwardTemporalDepth(scene, prepass);
  const direct =
    velocity !== undefined &&
    waterTemporal === undefined &&
    prepass.temporal === undefined &&
    reflections.reflectionResponse === undefined &&
    topology.singleLayerMedium !== true;
  const resolvedTemporal = waterTemporal ?? prepass.temporal;
  const temporal =
    resolvedTemporal === undefined
      ? addForwardSceneData(context, topology, demand, depth, gpu, velocity, direct)
      : ok(resolvedTemporal);
  if (!temporal.ok) return temporal;
  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(
      context.graph,
      context.targetCoverage,
      gpu,
      waterInfoTargets,
    );
    if (!coverage.ok) return coverage;
  }
  const reflected = addForwardTemporalInputs(context, topology, {
    scene: scene.resolved,
    fallback: reflections.reflectionFallback?.sampled,
    response: reflections.reflectionResponse?.sampled,
    surface: reflections.reflectionSurface?.sampled,
    depth,
    hzb: prepass.hzb,
    temporal: temporal.value,
  });
  if (!reflected.ok) return reflected;
  const sceneVelocity = direct ? bindForwardSceneVelocity(context.graph, depth) : ok(undefined);
  if (!sceneVelocity.ok) return sceneVelocity;
  return ok({
    sceneTemporal: temporal.value,
    sceneVelocity: sceneVelocity.value,
    opaqueGuide: reflected.value.opaqueGuide,
    secondaryReactivity: reflected.value.ssr,
    coverage: context.targetCoverage?.coverage,
    coverageDepth: context.targetCoverage?.depth,
    gpuDriven: gpu,
  });
}

/** Single-sample draws share a physical writer. Multisampled draws declare their resolve target. */
function addDisplayTranslucency(
  context: StandardPipelineBuildContext,
  scene: ForwardSceneTargets,
  size: ReturnType<typeof renderInternalSize>,
  receiver: StandardForwardReceiverInputs & { readonly environment: GraphEnvironment | undefined },
  ports: DisplayPorts,
  topology: RenderPipelineTopology,
  medium: Pick<
    Parameters<typeof addForwardTranslucentStages>[5],
    'opaquePair' | 'temporal' | 'gpuDriven'
  >,
) {
  const { graph } = context;
  if (topology.singleLayerMedium === true) {
    const nearest = declareSingleLayerMediumTargets(graph, size, scene.color.sampleCount);
    if (!nearest.ok) return nearest;
    return addForwardTranslucentStages(
      context,
      topology,
      scene,
      receiver.environment,
      receiver,
      {
        ...medium,
        nearestTargets: nearest.value,
      },
      undefined,
      true,
    );
  }
  if (scene.msaa)
    return addStandardTransparentPasses(graph, {
      ...forwardSceneAttachments(scene),
      size,
      template: { ...receiver, colorStoreOp: 'auto' },
      transparency: topology.transparency,
    });
  const writer = new SceneColorDraws(scene.color.view, scene.depth.view);
  const translucent = addCurrentStandardTranslucency(graph, {
    color: scene.color,
    depth: scene.depth,
    size,
    template: { ...receiver, writer, colorStoreOp: 'store' },
    transparency: undefined,
    currentTransparency: ports.weighted,
  });
  return translucent.ok ? writer.install(graph, 'forward-display-draws') : translucent;
}

/** Opaque receivers sample the depth-matched mask; later transparent draws sample their own shadows. */
function forwardDisplayReceivers(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  depth: RenderPipelineTarget,
  lightBytes: number,
  importedLightData: GraphBuffer | undefined,
  prepass: Extract<ReturnType<typeof addForwardSsao>, { ok: true }>['value'],
  inputs: Parameters<typeof standardForwardReceiverInputs>[0],
) {
  const { graph } = context;
  const screen = addForwardScreenProjection(context, topology, prepass, false);
  if (!screen.ok) return screen;
  const lightData =
    lightBytes === 0
      ? ok(undefined)
      : importedLightData === undefined
        ? importForwardShadowLightData(graph, lightBytes)
        : ok(importedLightData);
  if (!lightData.ok) return lightData;
  const mask = prepareForwardShadowProjection(
    graph,
    topology,
    depth,
    inputs.shadows,
    lightData.value,
    inputs.ssao,
    prepass.inlineAo,
  );
  if (!mask.ok) return mask;
  const transparent = standardForwardReceiverInputs({
    ...inputs,
    ssao: prepass.inlineAo === undefined ? (screen.value ?? inputs.ssao) : mask.value,
  });
  if (mask.value === undefined)
    return ok({
      transparent,
      opaque: transparent,
      fragment: screen.value === undefined ? undefined : 'fs_forward_screen',
    });
  const opaque = standardForwardReceiverInputs({ ...inputs, projectedDirectional: mask.value });
  return ok({ transparent, opaque, fragment: FORWARD_SHADOW_COLOR_ENTRY });
}
