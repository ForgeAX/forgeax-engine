import type { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { FORWARD_SHADOW_COLOR_ENTRY } from '../pipeline/forward-shadow-admission';
import { renderInternalSize } from '../pipeline/render-extent';
import {
  addForwardSsao,
  declareForwardSceneTargets,
  prepareForwardShadowProjection,
} from '../pipeline/standard-forward-lane';
import { finishPremultipliedForwardOutput } from '../pipeline/standard-forward-output';
import { standardForwardReceiverInputs } from '../pipeline/standard-forward-receiver';
import {
  encodeStandardClusterMembership,
  importForwardShadowLightData,
  importStandardClusterBuffers,
  shouldExecuteStandardClusterMembershipPass,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import { addStandardPost } from '../pipeline/standard-post';
import { standardTopology } from '../pipeline/standard-profile';
import { addCurrentStandardTranslucency } from '../pipeline/standard-transparency';
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
import { addTypedScenePass } from '../typed-render-graph-primitives';
import { addTypedShadowPasses, currentShadowViews } from '../typed-shadow-passes';
import { currentGpuRaster } from './current-gpu-raster';
import { currentOutputDither, type DisplayPorts, type ForwardOutput } from './display-ports';
import type { RenderFrameState } from './frame-snapshot';
import { addCurrentReflectionProbeFilters } from './reflection-probe-pmrem';
import type { _InternalRenderPipelineContext } from './render-context';
import { SceneColorDraws } from './scene-color-draws';

/** Ordered production for a single-sample Forward surface. Cluster storage belongs to
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
): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError> {
  const topology = forwardOutput === 'standard' ? standardTopology(input) : input;
  const observeDisplay = ports.observedTarget !== undefined;
  const endpoint = importRenderPipelineSurface(graph, topology);
  if (!endpoint.ok) return endpoint;
  const size = renderInternalSize(topology);
  const context = {
    graph,
    projectGpuDriven: () => ok(undefined),
    contributeFeatures: () => ok(undefined),
    readOutputDither: currentOutputDither,
    currentMaterialDepth: true as const,
    ...(forwardOutput === 'standard' ? {} : { forwardOutput }),
    capabilities,
    observationCaptureDomains: ports.captureDomains,
  };
  const scene = declareForwardSceneTargets(context, topology, endpoint.value, false, size);
  if (!scene.ok) return scene;
  const { color, depth } = scene.value;
  const probes = addCurrentReflectionProbeFilters(graph);
  if (!probes.ok) return probes;
  const shadows = addTypedShadowPasses(graph, topology, {
    currentViews: currentShadowViews(topology.shadow, true),
    currentReceiverDepth: ports.geometry === 'direct' ? undefined : false,
    depthLayers,
    reuseAdjacentShadow: true,
  });
  if (!shadows.ok) return shadows;
  const tables =
    ports.textureLighting === undefined
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
  const projected =
    ports.geometry === 'direct'
      ? ok(undefined)
      : currentGpuRaster(
          graph,
          { format: ports.color, sampleCount: 1, lateOcclusion: ports.geometry === 'occlusion' },
          frameState,
          retainIndirectBundles,
        );
  if (!projected.ok) return projected;
  const gpu = projected.value;
  const needsShadowDepth = ports.forwardShadow !== undefined;
  const ao = addForwardSsao(
    context,
    topology,
    gpu,
    false,
    depth,
    false,
    needsShadowDepth ? undefined : 'prepass',
  );
  if (!ao.ok) return ao;
  const receivers = forwardDisplayReceivers(graph, topology, depth, ports.shadowLightBytes, {
    shadows: shadows.value,
    ssao: ao.value.ao,
    cloudShadow: undefined,
    materialSceneDepth: true,
    clusterReads: tables.value === null ? [] : standardClusterReadAccesses(tables.value),
  });
  if (!receivers.ok) return receivers;
  // The first color raster clears the current background and issues any sky
  // before geometry. Its depth attachment loads only when an early writer ran.
  const opaque = addTypedScenePass(graph, {
    ...receivers.value.opaque,
    fragmentEntryPoint: receivers.value.fragment,
    name: 'main',
    color,
    depth,
    colorLoadOp: 'clear',
    depthLoadOp: 'load',
    colorStoreOp: 'store',
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'opaque',
    seededDepth: true,
    forwardDisplayDepth:
      ports.aoMethod === undefined && !needsShadowDepth ? 'color' : 'primed-color',
    ...(gpu === undefined ? {} : { gpuDriven: gpu }),
    standardOpaqueRows: true,
    gpuDrivenFilter: 'opaque',
  });
  if (!opaque.ok) return opaque;
  const writer = new SceneColorDraws(color.view, depth.view);
  const translucent = addCurrentStandardTranslucency(graph, {
    color,
    depth,
    size,
    template: { ...receivers.value.transparent, writer, colorStoreOp: 'store' },
    transparency: undefined,
    currentTransparency: ports.weighted,
  });
  if (!translucent.ok) return translucent;
  const ordered = writer.install(graph, 'forward-display-draws');
  if (!ordered.ok) return ordered;
  const output =
    forwardOutput === 'standard'
      ? addStandardPost(context, topology, color, depth, endpoint.value)
      : finishPremultipliedForwardOutput(
          graph,
          color,
          endpoint.value.storage,
          forwardOutput.targetName,
          true,
          observeDisplay,
        );
  return output.ok ? projected : output;
}

/** Opaque receivers sample the depth-matched mask; later transparent draws sample their own shadows. */
function forwardDisplayReceivers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  depth: RenderPipelineTarget,
  lightBytes: number,
  inputs: Parameters<typeof standardForwardReceiverInputs>[0],
) {
  const transparent = standardForwardReceiverInputs(inputs);
  const lightData = lightBytes === 0 ? undefined : importForwardShadowLightData(graph, lightBytes);
  if (lightData !== undefined && !lightData.ok) return lightData;
  const mask = prepareForwardShadowProjection(
    graph,
    topology,
    depth,
    inputs.shadows,
    lightData?.value,
    inputs.ssao,
  );
  if (!mask.ok) return mask;
  if (mask.value === undefined)
    return ok({ transparent, opaque: transparent, fragment: undefined });
  const opaque = standardForwardReceiverInputs({ ...inputs, projectedDirectional: mask.value });
  return ok({ transparent, opaque, fragment: FORWARD_SHADOW_COLOR_ENTRY });
}
