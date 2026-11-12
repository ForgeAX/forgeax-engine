import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { type ClusterOccupancyReport, measureClusterOccupancy } from '../../cluster-binner';
import { GTAO_SAMPLE_COUNTS, getSsaoParameters, SSAO_SAMPLE_COUNTS } from '../../ssao-config';
import type { StandardTopologyInputValue } from './topology';
import type { StandardClusterTransport } from './transport';

type AmbientOcclusionConfig = NonNullable<NonNullable<RenderPipelineAsset['config']>['ssao']>;

export interface StandardAmbientOcclusionInspection {
  readonly requested: boolean;
  readonly status: 'off' | 'active' | 'requested-unavailable';
  readonly algorithm: 'ssao' | 'gtao';
  readonly execution: 'none' | 'fragment' | 'compute';
  readonly reason?: 'disabled' | 'requested-passes-not-in-active-graph';
  readonly producerId: 'forgeax::standard::surface-data';
  readonly input: {
    readonly normalSchema: 'forgeax::scene-data::standard-surface-normal-v1';
    readonly normalSpace: 'world';
    readonly normalEncoding: 'octahedral-normal-x12-y12-roughness-u8';
    readonly normalFormat: 'r32uint';
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
    readonly quality: 'low' | 'medium' | 'high';
    readonly sampleBudget: number;
    readonly directLightingStrength: number;
    readonly rawIntensityApplication: 'once-before-filter';
    readonly filter: '5x5-depth-normal-bilateral';
  };
  readonly output: {
    readonly rawFormat: 'rgba8unorm';
    readonly filteredFormat: 'r8unorm';
    readonly extent?: { readonly width: number; readonly height: number };
    readonly rawBytes?: number;
    readonly filteredBytes?: number;
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

export function inspectStandardClusterTransport(
  transport: StandardClusterTransport,
  prepared: StandardTopologyInputValue['prepared'],
): Omit<StandardClusterTransportInspection, 'ambientOcclusion'> {
  const base = Object.freeze({
    renderPath: prepared.renderPath,
    transport: transport.kind,
    producer: transport.producer,
    requested: transport.requestedLightCount,
    admitted: transport.admittedLightCount,
    shadowed: prepared.local.filter((light) => light.shadowed === true).length,
    maxLights: prepared.maxLights,
    indexCount: transport.membershipEntryCount,
    occupied: transport.occupiedClusterCount,
    clusterGridBytes: transport.clusterGridBytes,
    lightIndexListBytes: transport.lightIndexListBytes,
    lightDataBytes: transport.lightDataBytes,
    lightBoundsBytes: transport.lightBoundsBytes,
    // The inspection boundary is JSON-safe and detached from the mutable
    // layout object carried by a per-frame prepared result.
    grid: Object.freeze({ ...transport.layout.grid }),
  });
  const camera = prepared.camera;
  if (camera === undefined) return base;
  // Inspection is assembled for every submitted frame; the occupancy walk
  // only runs when a reader asks for it (memoized enumerable getter, so
  // JSON serialization still includes it).
  let report: ClusterOccupancyReport | undefined;
  return Object.freeze(
    Object.defineProperty({ ...base }, 'lightsPerCluster', {
      enumerable: true,
      get: () =>
        (report ??= measureClusterOccupancy(
          prepared.local.length,
          prepared.lightBounds,
          transport.layout.grid,
          camera.near,
          camera.far,
        )),
    }),
  );
}

export function inspectStandardLighting(
  input: StandardTopologyInputValue,
  ao: {
    readonly config: AmbientOcclusionConfig | undefined;
    readonly graph: CompiledRenderGraphInfo | undefined;
    readonly installedGraphGeneration?: number | undefined;
    readonly deviceGeneration: number;
    readonly clusterAoExtent?: { readonly width: number; readonly height: number } | undefined;
  } = { config: undefined, graph: undefined, deviceGeneration: 0 },
): StandardLightingInspection {
  const ambientOcclusion = inspectStandardAmbientOcclusion({
    renderPath: input.prepared.renderPath,
    ...ao,
  });
  if (input.kind === 'no-local-lights') {
    return Object.freeze({
      renderPath: input.prepared.renderPath,
      transport: 'not-required' as const,
      producer: 'none' as const,
      requested: 0 as const,
      admitted: 0 as const,
      shadowed: 0 as const,
      maxLights: input.prepared.maxLights,
      indexCount: 0 as const,
      occupied: 0 as const,
      clusterGridBytes: 0 as const,
      lightIndexListBytes: 0 as const,
      lightDataBytes: 0 as const,
      lightBoundsBytes: 0 as const,
      grid: Object.freeze({ ...input.prepared.layout.grid }),
      ambientOcclusion,
    });
  }
  // Copy descriptors, not values: spreading would evaluate the lazy
  // lightsPerCluster getter on every submitted frame.
  const transport = inspectStandardClusterTransport(input.transport, input.prepared);
  return Object.freeze(
    Object.defineProperties(
      { ambientOcclusion },
      Object.getOwnPropertyDescriptors(transport),
    ) as StandardClusterTransportInspection,
  );
}

function graphResource(
  graph: CompiledRenderGraphInfo | undefined,
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

function collectAmbientOcclusionFacts(input: {
  readonly config: AmbientOcclusionConfig | undefined;
  readonly graph: CompiledRenderGraphInfo | undefined;
  readonly renderPath: 'forward' | 'deferred';
  readonly clusterAoExtent?: { readonly width: number; readonly height: number } | undefined;
}) {
  const requested = input.config?.enabled === true;
  const parameters = getSsaoParameters(requested ? input.config : undefined);
  const calc = input.graph?.passes.find(
    (pass) => pass.name === 'ssao-calc' || pass.name === 'gtao-calc-compute',
  );
  const blur = input.graph?.passes.find((pass) => pass.name === 'ssao-blur');
  const active = requested && calc !== undefined && blur !== undefined;
  const normalName = calc?.accesses.find((access) => access.usage === 'sampled-read')?.resource;
  const depthName = calc?.accesses.find(
    (access) => access.usage === 'sampled-read' && access.resource !== normalName,
  )?.resource;
  const rawName = calc?.accesses.find(
    (access) => access.usage === 'storage-write' || access.usage === 'color-attachment',
  )?.resource;
  const filteredName = blur?.accesses.find(
    (access) => access.usage === 'color-attachment',
  )?.resource;
  const normal = graphResource(input.graph, normalName);
  const depth = graphResource(input.graph, depthName);
  const raw = graphResource(input.graph, rawName);
  const filtered = graphResource(input.graph, filteredName);
  const inputExtent = normal?.extent;
  const outputExtent = raw?.extent;
  const rawPixels = (outputExtent?.width ?? 0) * (outputExtent?.height ?? 0);
  const sampleBudget = (parameters.algorithm === 'gtao' ? GTAO_SAMPLE_COUNTS : SSAO_SAMPLE_COUNTS)[
    parameters.quality
  ];
  // Match the production GTAO adapter: three slices below 30 samples, five
  // at 30+, with two depth candidates per radial step.
  const slices = sampleBudget >= 30 ? 5 : 3;
  const depthCandidatesPerPixel =
    parameters.algorithm === 'gtao' ? slices * Math.ceil(sampleBudget / slices) * 2 : sampleBudget;
  // Forward keeps the surface-data prepass to seed `main` with AO off; it is
  // AO work only when AO is requested.
  const passNames = (input.graph?.passes ?? [])
    .filter(
      (pass) =>
        (requested && pass.name === 'standard-scene-surface-data') ||
        ['ssao-calc', 'gtao-calc-compute', 'ssao-blur', 'ssao-cluster-pack'].includes(pass.name),
    )
    .map((pass) => pass.name);
  const status: StandardAmbientOcclusionInspection['status'] = !requested
    ? 'off'
    : active
      ? 'active'
      : 'requested-unavailable';
  const unavailable = status === 'requested-unavailable';
  const normalDepthBytes = sumKnownBytes([normal, depth]);
  const additionalInputBytes = input.renderPath === 'forward' ? normalDepthBytes : 0;
  const clusterRegionBytes =
    !active || input.clusterAoExtent === undefined
      ? 0
      : Math.ceil(input.clusterAoExtent.width / 4) * input.clusterAoExtent.height * 16;
  return {
    input,
    requested,
    parameters,
    calc,
    active,
    normal,
    raw,
    filtered,
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
    clusterRegionBytes,
  };
}

function ambientOcclusionInputInspection(facts: ReturnType<typeof collectAmbientOcclusionFacts>) {
  return Object.freeze({
    normalSchema: 'forgeax::scene-data::standard-surface-normal-v1' as const,
    normalSpace: 'world' as const,
    normalEncoding: 'octahedral-normal-x12-y12-roughness-u8' as const,
    normalFormat: 'r32uint' as const,
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
    rawFormat: 'rgba8unorm' as const,
    filteredFormat: 'r8unorm' as const,
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
    clusterRegionBytes: facts.clusterRegionBytes,
  });
}

function inspectStandardAmbientOcclusion(input: {
  readonly config: AmbientOcclusionConfig | undefined;
  readonly graph: CompiledRenderGraphInfo | undefined;
  readonly installedGraphGeneration?: number | undefined;
  readonly renderPath: 'forward' | 'deferred';
  readonly deviceGeneration: number;
  readonly clusterAoExtent?: { readonly width: number; readonly height: number } | undefined;
}): StandardAmbientOcclusionInspection {
  const facts = collectAmbientOcclusionFacts(input);
  const { parameters, requested, status, active, calc, sampleBudget, unavailable } = facts;
  return Object.freeze({
    requested,
    status,
    algorithm: parameters.algorithm,
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
      directLightingStrength: parameters.directLightingStrength,
      rawIntensityApplication: 'once-before-filter' as const,
      filter: '5x5-depth-normal-bilateral' as const,
    }),
    output: ambientOcclusionOutputInspection(facts),
    work: Object.freeze({
      rawPixels: active ? facts.rawPixels : 0,
      filterTapBudget: active ? facts.rawPixels * 25 : 0,
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
