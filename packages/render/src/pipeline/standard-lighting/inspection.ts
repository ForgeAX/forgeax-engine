import {
  type CompiledRenderGraph,
  type CompiledRenderGraphInfo,
  compiledRenderGraphPassDeclarations,
  compiledRenderGraphResourceDeclarations,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { type ClusterOccupancyReport, measureClusterOccupancy } from '../../cluster-binner';
import { getSsaoParameters, resolveSsaoQuality, ssaoUsesLighting } from '../../ssao-config';
import { lightSlotWorkOf } from './slot-work';
import type { StandardTopologyInputValue } from './topology';
import type { StandardClusterTransport } from './transport';

type AmbientOcclusionConfig = NonNullable<
  NonNullable<RenderPipelineAsset['config']>['ambientOcclusion']
>;

export type AmbientOcclusionViewFacts = Pick<CompiledRenderGraphInfo, 'passes' | 'resources'>;

/** Retain declarations the AO inspector consumes, without retaining the view allocation. */
export function bindAmbientOcclusionViewFacts<Frame extends RenderGraphFrame>(
  graph: CompiledRenderGraph<Frame>,
): AmbientOcclusionViewFacts {
  const passes = compiledRenderGraphPassDeclarations(graph).filter(
    (pass) =>
      pass.name.startsWith('ssao-') ||
      pass.name.startsWith('gtao-') ||
      (pass.name === 'forward-directional-shadow' &&
        pass.accesses.some(({ resource }) => resource === 'ssao-screen-parameters-0')),
  );
  const labels = new Set(['ssao-horizontal']);
  for (const pass of passes) {
    for (const { resource } of pass.accesses) labels.add(resource);
  }
  return {
    passes,
    resources: compiledRenderGraphResourceDeclarations(graph, [...labels]),
  };
}

export interface StandardAmbientOcclusionInspection {
  readonly requested: boolean;
  readonly status: 'off' | 'active' | 'requested-unavailable';
  readonly algorithm: 'ssao' | 'gtao';
  readonly requestedMethod: StandardAmbientOcclusionInspection['algorithm'];
  readonly effectiveMethod: StandardAmbientOcclusionInspection['algorithm'];
  readonly methodFallback?: 'forward-only-ssao';
  readonly levels: number;
  readonly historyFrames?: number | undefined;
  readonly execution: 'none' | 'fragment' | 'compute';
  readonly reason?: 'disabled' | 'requested-passes-not-in-active-graph';
  readonly producerId: 'forgeax::standard::surface-data';
  readonly input: {
    readonly normalSchema:
      | 'forgeax::scene-data::standard-gbuffer-normal-v2'
      | 'forgeax::scene-data::standard-surface-normal-v1'
      | 'standard-gbuffer/4'
      | 'depth-reconstruction';
    readonly normalSpace: 'world' | 'view';
    readonly normalEncoding:
      | 'xyz10-valid30-dfg31-roughness8-occlusion8'
      | 'octahedral-normal-x12-y12-roughness-u8'
      | 'xyz10'
      | 'depth-reconstructed';
    readonly normalFormat: 'rg32uint' | 'r32uint' | 'none';
    readonly depthSchema: 'forgeax::scene-data::standard-surface-depth-v1';
    readonly depthSpace: 'camera-device-depth';
    readonly depthEncoding: 'rhi-zero-to-one';
    readonly depthFormat: 'depth32float-stencil8';
    readonly coverage: 'opaque-alpha-mask';
    readonly extent?: { readonly width: number; readonly height: number };
    readonly bytes?: number;
    readonly additionalBytes?: number;
  };
  readonly numerical: {
    readonly radius: number;
    readonly bias: number;
    readonly intensity: number;
    readonly thickness: number;
    readonly distanceExponent: number;
    readonly distanceFallOff: number;
    readonly resolutionScale: number;
    readonly quality: number | 'low' | 'medium' | 'high';
    readonly sampleBudget: number;
    readonly rawIntensityApplication: 'ssao-output' | 'gtao-spatial' | 'none';
    readonly filter: 'quad-normal' | 'gtao-depth-plane' | 'none';
  };
  readonly output: {
    readonly rawFormat: 'rgba8unorm' | 'r8unorm';
    readonly filteredFormat: 'r8unorm' | 'rgba8unorm';
    readonly channel?: 'a';
    readonly extent?: { readonly width: number; readonly height: number };
    readonly rawBytes?: number;
    readonly filteredBytes?: number;
    readonly horizontalBytes?: number;
    readonly clusterRegionBytes: number;
  };
  readonly work: {
    readonly rawPixels: number;
    readonly filterTapBudget: number;
    readonly depthCandidateBudget: number;
  };
  readonly passes: readonly string[];
  readonly graphGeneration?: number;
  readonly deviceGeneration: number;
  readonly failure?: {
    readonly stage: 'active-graph';
    readonly code: 'requested-passes-not-in-active-graph';
    readonly recovery: 'retry-or-rebuild-standard-pipeline';
  };
}

export interface StandardClusterTransportInspection {
  readonly renderPath: 'forward' | 'deferred';
  readonly transport: StandardClusterTransport['kind'];
  readonly producer: StandardClusterTransport['producer'];
  readonly requested: StandardClusterTransport['requestedLightCount'];
  readonly admitted: StandardClusterTransport['admittedLightCount'];
  /** Local lights over the limit that the Cluster does not shade (`requested - admitted`). */
  readonly droppedLocalLights: number;
  /**
   * Per-cluster entry cap K applied when the light index list overflowed:
   * each cluster kept its first K lights. `null` when every entry fit.
   */
  readonly clusterEntryCapK: number | null;
  /** Cluster entries dropped under `clusterEntryCapK`. */
  readonly droppedClusterEntries: number;
  readonly shadowed: number;
  readonly maxLights: number;
  readonly indexCount: StandardClusterTransport['membershipEntryCount'];
  readonly occupied: StandardClusterTransport['occupiedClusterCount'];
  readonly clusterGridBytes: number;
  readonly lightIndexListBytes: number;
  readonly lightDataBytes: number;
  readonly lightBoundsBytes: number;
  readonly grid: StandardClusterTransport['layout']['grid'];
  /**
   * Lights per cluster cell: the conservative cell box (what the CPU sizes)
   * and the exact froxel test (what the GPU producer keeps). Present when the
   * prepared frame carries its camera.
   */
  readonly lightsPerCluster?: ClusterOccupancyReport;
  readonly ambientOcclusion: StandardAmbientOcclusionInspection;
}

export interface StandardNoLocalLightingInspection {
  readonly renderPath: 'forward' | 'deferred';
  readonly transport: 'not-required';
  readonly producer: 'none';
  readonly requested: 0;
  readonly admitted: 0;
  readonly droppedLocalLights: 0;
  readonly clusterEntryCapK: null;
  readonly droppedClusterEntries: 0;
  readonly shadowed: 0;
  readonly maxLights: number;
  readonly indexCount: 0;
  readonly occupied: 0;
  readonly clusterGridBytes: 0;
  readonly lightIndexListBytes: 0;
  readonly lightDataBytes: 0;
  readonly lightBoundsBytes: 0;
  readonly grid: StandardTopologyInputValue['prepared']['layout']['grid'];
  readonly ambientOcclusion: StandardAmbientOcclusionInspection;
}

export type StandardLightingInspection =
  | StandardClusterTransportInspection
  | StandardNoLocalLightingInspection;

type SubmittedAmbientOcclusion = {
  readonly config: AmbientOcclusionConfig | undefined;
  readonly graph: AmbientOcclusionViewFacts | undefined;
  readonly installedGraphGeneration?: number | undefined;
  readonly deviceGeneration: number;
  readonly gtaoHistoryFrames?: number | undefined;
};

type TransportInspection = Omit<StandardClusterTransportInspection, 'ambientOcclusion'>;
type PreparedLighting = StandardTopologyInputValue['prepared'];

function captureClusterInspection(
  transport: StandardClusterTransport,
  prepared: PreparedLighting,
): () => TransportInspection;
function captureClusterInspection(
  transport: StandardClusterTransport,
  prepared: PreparedLighting,
  readAO: () => StandardAmbientOcclusionInspection,
): () => StandardClusterTransportInspection;
function captureClusterInspection(
  transport: StandardClusterTransport,
  prepared: PreparedLighting,
  readAO?: () => StandardAmbientOcclusionInspection,
): () => TransportInspection {
  const {
    kind,
    producer,
    requestedLightCount,
    admittedLightCount,
    membershipEntryCount,
    occupiedClusterCount,
    clusterGridBytes,
    lightIndexListBytes,
    lightDataBytes,
    lightBoundsBytes,
  } = transport;
  const { x, y, z } = transport.layout.grid;
  const {
    renderPath,
    maxLights,
    clusterEntryCapK,
    droppedClusterEntries,
    boundsColumn,
    membershipLightCount,
  } = prepared;
  const detached = boundsColumn === undefined ? prepared.lightBounds : undefined;
  const near = prepared.camera?.near,
    far = prepared.camera?.far;
  const shadowed = lightSlotWorkOf(prepared).shadowSlots.length;
  let inspection: TransportInspection | undefined;
  return () => {
    if (inspection !== undefined) return inspection;
    const grid = Object.freeze({ x, y, z });
    const facts: TransportInspection = {
      renderPath,
      transport: kind,
      producer,
      requested: requestedLightCount,
      admitted: admittedLightCount,
      droppedLocalLights: requestedLightCount - admittedLightCount,
      clusterEntryCapK: clusterEntryCapK ?? null,
      droppedClusterEntries,
      shadowed,
      maxLights,
      indexCount: membershipEntryCount,
      occupied: occupiedClusterCount,
      clusterGridBytes,
      lightIndexListBytes,
      lightDataBytes,
      lightBoundsBytes,
      grid,
    };
    if (near !== undefined && far !== undefined) {
      let occupancy: ClusterOccupancyReport | undefined;
      Object.defineProperty(facts, 'lightsPerCluster', {
        enumerable: true,
        get: () =>
          (occupancy ??= measureClusterOccupancy(
            membershipLightCount,
            boundsColumn?.materialize() ?? (detached as Int32Array),
            grid,
            near,
            far,
          )),
      });
    }
    if (readAO !== undefined)
      Object.defineProperty(facts, 'ambientOcclusion', { enumerable: true, get: readAO });
    inspection = Object.freeze(facts);
    return inspection;
  };
}

export function inspectStandardClusterTransport(
  transport: StandardClusterTransport,
  prepared: PreparedLighting,
): TransportInspection {
  return captureClusterInspection(transport, prepared)();
}

/** Keep only submitted scalars and the owned producer bounds. Inspector reads can outlive
 * camera reuse or scene unload without retaining a frame's lights, CPU runs or scratch. */
export function captureStandardLighting(
  input: StandardTopologyInputValue,
  ao: SubmittedAmbientOcclusion = { config: undefined, graph: undefined, deviceGeneration: 0 },
): () => StandardLightingInspection {
  const { renderPath, maxLights } = input.prepared;
  let ambientOcclusion: StandardAmbientOcclusionInspection | undefined;
  const readAO = () =>
    (ambientOcclusion ??= inspectStandardAmbientOcclusion({ renderPath, ...ao }));
  if (input.kind === 'clustered')
    return captureClusterInspection(input.transport, input.prepared, readAO);
  const { x, y, z } = input.prepared.layout.grid;
  let inspection: StandardNoLocalLightingInspection | undefined;
  return () =>
    (inspection ??= Object.freeze({
      renderPath,
      transport: 'not-required',
      producer: 'none',
      requested: 0,
      admitted: 0,
      droppedLocalLights: 0,
      clusterEntryCapK: null,
      droppedClusterEntries: 0,
      shadowed: 0,
      maxLights,
      indexCount: 0,
      occupied: 0,
      clusterGridBytes: 0,
      lightIndexListBytes: 0,
      lightDataBytes: 0,
      lightBoundsBytes: 0,
      grid: Object.freeze({ x, y, z }),
      get ambientOcclusion() {
        return readAO();
      },
    }));
}

export function inspectStandardLighting(
  input: StandardTopologyInputValue,
  ao?: SubmittedAmbientOcclusion,
): StandardLightingInspection {
  return captureStandardLighting(input, ao)();
}

function graphResource(
  graph: AmbientOcclusionViewFacts | undefined,
  name: string | undefined,
): CompiledRenderGraphInfo['resources'][number] | undefined {
  return name === undefined
    ? undefined
    : graph?.resources.find((resource) => resource.label === name);
}

function sumKnownBytes(
  resources: readonly (CompiledRenderGraphInfo['resources'][number] | undefined)[],
): number | undefined {
  const present = resources.filter(
    (resource): resource is CompiledRenderGraphInfo['resources'][number] => resource !== undefined,
  );
  if (
    present.length !== resources.length ||
    present.some((resource) => resource.byteSize === undefined)
  )
    return undefined;
  return present.reduce((sum, resource) => sum + (resource.byteSize ?? 0), 0);
}

function ambientOcclusionGraphResources(graph: AmbientOcclusionViewFacts | undefined) {
  const fused = graph?.passes.find(
    (pass) =>
      pass.name === 'forward-directional-shadow' &&
      pass.accesses.some(
        (access) =>
          access.usage === 'uniform-read' && access.resource === 'ssao-screen-parameters-0',
      ),
  );
  const calc =
    fused ??
    graph?.passes.find((pass) =>
      ['ssao-calc', 'gtao-calc', 'gtao-calc-compute'].includes(pass.name),
    );
  const blur = graph?.passes.find(
    (pass) => pass.name === 'gtao-resolve' || pass.name === 'ssao-blur',
  );
  const sampled = calc?.accesses.filter((access) => access.usage === 'sampled-read') ?? [];
  const sampledResources = sampled.map((access) => graphResource(graph, access.resource));
  const normal = sampledResources.find(
    (resource) => resource?.format === 'r32uint' || resource?.format === 'rg32uint',
  );
  const depth = sampledResources.find((resource) => resource?.format?.startsWith('depth') === true);
  const rawName = calc?.accesses.find(
    (access) => access.usage === 'storage-write' || access.usage === 'color-attachment',
  )?.resource;
  const filteredName = blur?.accesses.find(
    (access) => access.usage === 'color-attachment',
  )?.resource;
  const raw = graphResource(graph, rawName);
  const filtered = graphResource(graph, filteredName) ?? raw;
  const horizontal = graphResource(graph, 'ssao-horizontal');
  return { calc, normal, depth, raw, filtered, horizontal, fused };
}

function ambientOcclusionWorkBudget(
  effective: ReturnType<typeof getSsaoParameters>['method'],
  parameters: ReturnType<typeof getSsaoParameters>,
  config: AmbientOcclusionConfig | undefined,
) {
  const { permutation } = resolveSsaoQuality(config);
  const sampleBudget =
    effective === 'gtao'
      ? ([4, 6, 8, 12, 20][permutation] ?? 8)
      : (permutation === 4 ? 6 : 3) * Math.max(1, Math.min(3, permutation));
  const depthCandidatesPerPixel =
    sampleBudget * 2 * (effective === 'gtao' ? parameters.gtao.numAngles : 1);
  const filterTaps =
    effective === 'gtao'
      ? parameters.gtao.spatialFilter
        ? parameters.gtao.filterWidth ** 2
        : 0
      : permutation === 1 || permutation === 2
        ? 3
        : 0;
  return { sampleBudget, depthCandidatesPerPixel, filterTaps };
}

function collectAmbientOcclusionFacts(input: {
  readonly config: AmbientOcclusionConfig | undefined;
  readonly graph: AmbientOcclusionViewFacts | undefined;
  readonly renderPath: 'forward' | 'deferred';
}) {
  const requested = input.config?.enabled === true;
  const parameters = getSsaoParameters(requested ? input.config : undefined);
  const { calc, normal, depth, raw, filtered, horizontal, fused } = ambientOcclusionGraphResources(
    input.graph,
  );
  const effective =
    input.renderPath === 'forward' && parameters.method === 'gtao' ? 'ssao' : parameters.method;
  const active = ssaoUsesLighting(input.config) && calc !== undefined;
  const inputExtent = normal?.extent ?? depth?.extent;
  const outputExtent = filtered?.extent;
  const rawPixels = (raw?.extent?.width ?? 0) * (raw?.extent?.height ?? 0);
  const { sampleBudget, depthCandidatesPerPixel, filterTaps } = ambientOcclusionWorkBudget(
    effective,
    parameters,
    input.config,
  );
  const passNames = (input.graph?.passes ?? [])
    .filter(
      ({ name }) => name === fused?.name || name.startsWith('ssao-') || name.startsWith('gtao-'),
    )
    .map(({ name }) => name);
  const levels =
    active && effective === 'ssao'
      ? 1 + Number(passNames.includes('ssao-half')) + Number(passNames.includes('ssao-quarter'))
      : Number(active);
  const status: StandardAmbientOcclusionInspection['status'] = !ssaoUsesLighting(input.config)
    ? 'off'
    : active
      ? 'active'
      : 'requested-unavailable';
  const unavailable = status === 'requested-unavailable';
  const normalDepthBytes = sumKnownBytes(normal === undefined ? [depth] : [normal, depth]);
  const additionalInputBytes = input.renderPath === 'forward' ? normalDepthBytes : 0;
  return {
    input,
    requested,
    parameters,
    effective,
    levels,
    filterTaps,
    calc,
    fused,
    active,
    normal,
    raw,
    filtered,
    horizontal,
    inputExtent,
    outputExtent,
    rawPixels,
    sampleBudget,
    depthCandidatesPerPixel,
    passNames,
    status,
    unavailable,
    normalDepthBytes,
    additionalInputBytes,
  };
}

function ambientOcclusionInputInspection(facts: ReturnType<typeof collectAmbientOcclusionFacts>) {
  const compact = facts.normal?.label === 'gbuffer-a';
  return Object.freeze({
    normalSchema:
      facts.calc !== undefined && facts.normal === undefined
        ? ('depth-reconstruction' as const)
        : facts.normal?.format === 'rg32uint'
          ? ('forgeax::scene-data::standard-gbuffer-normal-v2' as const)
          : compact
            ? ('standard-gbuffer/4' as const)
            : ('forgeax::scene-data::standard-surface-normal-v1' as const),
    normalSpace:
      facts.calc !== undefined && facts.normal === undefined
        ? ('view' as const)
        : ('world' as const),
    normalEncoding:
      facts.calc !== undefined && facts.normal === undefined
        ? ('depth-reconstructed' as const)
        : facts.normal?.format === 'rg32uint'
          ? ('xyz10-valid30-dfg31-roughness8-occlusion8' as const)
          : compact
            ? ('xyz10' as const)
            : ('octahedral-normal-x12-y12-roughness-u8' as const),
    normalFormat:
      facts.calc !== undefined && facts.normal === undefined
        ? ('none' as const)
        : facts.normal?.format === 'rg32uint'
          ? ('rg32uint' as const)
          : ('r32uint' as const),
    depthSchema: 'forgeax::scene-data::standard-surface-depth-v1' as const,
    depthSpace: 'camera-device-depth' as const,
    depthEncoding: 'rhi-zero-to-one' as const,
    depthFormat: 'depth32float-stencil8' as const,
    coverage: 'opaque-alpha-mask' as const,
    ...(facts.inputExtent === undefined
      ? {}
      : {
          extent: Object.freeze({
            width: facts.inputExtent.width,
            height: facts.inputExtent.height,
          }),
        }),
    ...(facts.normalDepthBytes === undefined ? {} : { bytes: facts.normalDepthBytes }),
    ...(facts.additionalInputBytes === undefined
      ? {}
      : { additionalBytes: facts.additionalInputBytes }),
  });
}

function ambientOcclusionOutputInspection(facts: ReturnType<typeof collectAmbientOcclusionFacts>) {
  return Object.freeze({
    rawFormat: facts.raw?.format === 'rgba8unorm' ? ('rgba8unorm' as const) : ('r8unorm' as const),
    filteredFormat: facts.fused === undefined ? ('r8unorm' as const) : ('rgba8unorm' as const),
    ...(facts.fused === undefined ? {} : { channel: 'a' as const }),
    ...(facts.outputExtent === undefined
      ? {}
      : {
          extent: Object.freeze({
            width: facts.outputExtent.width,
            height: facts.outputExtent.height,
          }),
        }),
    ...(facts.raw?.byteSize === undefined ? {} : { rawBytes: facts.raw.byteSize }),
    ...(facts.filtered?.byteSize === undefined ? {} : { filteredBytes: facts.filtered.byteSize }),
    ...(facts.horizontal?.byteSize === undefined
      ? {}
      : { horizontalBytes: facts.horizontal.byteSize }),
    clusterRegionBytes: 0,
  });
}

function inspectStandardAmbientOcclusion(input: {
  readonly config: AmbientOcclusionConfig | undefined;
  readonly graph: AmbientOcclusionViewFacts | undefined;
  readonly installedGraphGeneration?: number | undefined;
  readonly renderPath: 'forward' | 'deferred';
  readonly gtaoHistoryFrames?: number | undefined;
  readonly deviceGeneration: number;
}): StandardAmbientOcclusionInspection {
  const facts = collectAmbientOcclusionFacts(input);
  const { parameters, requested, status, active, calc, sampleBudget, unavailable } = facts;
  return Object.freeze({
    requested,
    status,
    algorithm: facts.effective,
    requestedMethod: parameters.method,
    effectiveMethod: facts.effective,
    ...(facts.effective !== parameters.method
      ? { methodFallback: 'forward-only-ssao' as const }
      : {}),
    levels: facts.levels,
    ...(facts.passNames.includes('gtao-temporal')
      ? { historyFrames: input.gtaoHistoryFrames ?? 0 }
      : {}),
    execution: !active ? 'none' : calc?.name === 'gtao-calc-compute' ? 'compute' : 'fragment',
    ...(!requested
      ? { reason: 'disabled' as const }
      : unavailable
        ? { reason: 'requested-passes-not-in-active-graph' as const }
        : {}),
    producerId: 'forgeax::standard::surface-data',
    input: ambientOcclusionInputInspection(facts),
    numerical: Object.freeze({
      radius: parameters.radius,
      bias: parameters.bias,
      intensity: parameters.intensity,
      thickness: parameters.thickness,
      distanceExponent: parameters.distanceExponent,
      distanceFallOff: parameters.distanceFallOff,
      resolutionScale: parameters.resolutionScale,
      quality: parameters.quality,
      sampleBudget,
      rawIntensityApplication:
        facts.effective === 'gtao'
          ? parameters.gtao.spatialFilter
            ? ('gtao-spatial' as const)
            : ('none' as const)
          : ('ssao-output' as const),
      filter:
        facts.filterTaps === 0
          ? ('none' as const)
          : facts.effective === 'gtao'
            ? ('gtao-depth-plane' as const)
            : ('quad-normal' as const),
    }),
    output: ambientOcclusionOutputInspection(facts),
    work: Object.freeze({
      rawPixels: active ? facts.rawPixels : 0,
      filterTapBudget: active ? facts.rawPixels * facts.filterTaps : 0,
      depthCandidateBudget: active ? facts.rawPixels * facts.depthCandidatesPerPixel : 0,
    }),
    passes: Object.freeze(facts.passNames),
    ...(input.installedGraphGeneration === undefined
      ? {}
      : { graphGeneration: input.installedGraphGeneration }),
    deviceGeneration: input.deviceGeneration,
    ...(unavailable
      ? {
          failure: Object.freeze({
            stage: 'active-graph' as const,
            code: 'requested-passes-not-in-active-graph' as const,
            recovery: 'retry-or-rebuild-standard-pipeline' as const,
          }),
        }
      : {}),
  });
}
