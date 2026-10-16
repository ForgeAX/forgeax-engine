import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { DepthOfFieldInspection } from '../../inspection-types';
import { depthOfFieldPassNames, depthOfFieldTopology } from './depth-of-field-feature';
import {
  DEFAULT_DEPTH_OF_FIELD_PARAMS,
  type DepthOfFieldParams,
  type DepthOfFieldRequestFailure,
} from './depth-of-field-params';

const DOF_FORMAT_BYTES: Readonly<Record<string, number>> = Object.freeze({
  rgba16float: 8,
  rgba8unorm: 4,
});

function resourceBytes(resource: CompiledRenderGraphInfo['resources'][number]): number {
  if (resource.byteSize !== undefined) return resource.byteSize;
  const descriptor = resource.descriptor;
  if (descriptor.kind !== 'texture') return 0;
  const texelBytes = DOF_FORMAT_BYTES[descriptor.format] ?? 0;
  if (texelBytes === 0) return 0;
  let bytes = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    bytes +=
      Math.max(1, descriptor.width >> level) *
      Math.max(1, descriptor.height >> level) *
      descriptor.depthOrArrayLayers *
      texelBytes;
  }
  return bytes * descriptor.sampleCount;
}

function textureExtent(
  graph: CompiledRenderGraphInfo,
  label: string,
): { readonly width: number; readonly height: number } | undefined {
  const resource = graph.resources.find(
    (candidate) => candidate.kind === 'texture' && candidate.label === label,
  );
  if (resource?.descriptor.kind !== 'texture') return undefined;
  return { width: resource.descriptor.width, height: resource.descriptor.height };
}

export interface DepthOfFieldGraphInspection {
  readonly status: 'empty' | 'active' | 'invalid';
  readonly outputExtent: { readonly width: number; readonly height: number };
  readonly workExtent: { readonly width: number; readonly height: number };
  readonly passCount: number;
  readonly textureBytes: number;
  readonly graphGeneration: number;
}

export interface DepthOfFieldAcceptedState {
  readonly params: DepthOfFieldParams;
  readonly graph: CompiledRenderGraphInfo;
  readonly deviceGeneration: number;
}

const emptyExtent = Object.freeze({ width: 0, height: 0 });
const OFF_PARAMS = Object.freeze({ ...DEFAULT_DEPTH_OF_FIELD_PARAMS, maxRadiusPixels: 0 });

/** Inspect only the compiled graph facts owned by the DoF feature. */
export function inspectDepthOfFieldGraph(
  graph: CompiledRenderGraphInfo | undefined,
  params: DepthOfFieldParams | undefined,
): DepthOfFieldGraphInspection {
  const topology = depthOfFieldTopology(params);
  if (graph === undefined || topology === undefined) {
    return {
      status: 'empty',
      outputExtent: emptyExtent,
      workExtent: emptyExtent,
      passCount: 0,
      textureBytes: 0,
      graphGeneration: graph?.generation ?? 0,
    };
  }
  const expectedPasses = new Set(depthOfFieldPassNames(topology));
  const passes = graph.passes.filter((pass) => expectedPasses.has(pass.name));
  const dofResources = graph.resources.filter(
    (resource) => resource.kind === 'texture' && resource.label.startsWith('dof-'),
  );
  const expectedResourceLabels = [
    'dof-coc',
    ...(topology.useNear
      ? ['dof-near', 'dof-prefilter-near', 'dof-prefilter-near-metadata', 'dof-background']
      : []),
    ...(topology.useFar ? ['dof-far', 'dof-prefilter-far', 'dof-prefilter-far-metadata'] : []),
    'dof-composite',
  ];
  const resourceLabels = new Set(dofResources.map((resource) => resource.label));
  const completePasses =
    passes.length === expectedPasses.size && passes.every((pass) => expectedPasses.has(pass.name));
  const completeResources =
    dofResources.length === expectedResourceLabels.length &&
    expectedResourceLabels.every((label) => resourceLabels.has(label)) &&
    dofResources.every((resource) => resourceBytes(resource) > 0);
  const outputExtent = textureExtent(graph, 'dof-composite') ?? emptyExtent;
  const workExtent = textureExtent(graph, topology.useNear ? 'dof-near' : 'dof-far') ?? emptyExtent;
  return {
    status: completePasses && completeResources ? 'active' : 'invalid',
    outputExtent,
    workExtent,
    passCount: completePasses ? passes.length : 0,
    textureBytes: completeResources
      ? dofResources.reduce((bytes, resource) => bytes + resourceBytes(resource), 0)
      : 0,
    graphGeneration: graph.generation,
  };
}

export function projectDepthOfFieldInspection(input: {
  readonly params?: DepthOfFieldParams;
  readonly graph?: CompiledRenderGraphInfo;
  readonly deviceGeneration: number;
  readonly error?: DepthOfFieldRequestFailure | undefined;
  /** Explicit submit-bound state supplied by Renderer.inspect(). */
  readonly accepted?: DepthOfFieldAcceptedState | undefined;
  readonly lastSubmitFailed?: boolean | undefined;
}): DepthOfFieldInspection {
  const params = input.params ?? OFF_PARAMS;
  const topology = input.error === undefined ? depthOfFieldTopology(input.params) : undefined;
  const requested = {
    focusDistance: params.focusDistance,
    fStop: params.fStop,
    sensorHeight: params.sensorHeight,
    maxRadiusPixels: params.maxRadiusPixels,
    quality: params.quality,
    blurSide: params.blurSide,
  } as const;
  const enabled = input.error !== undefined || topology !== undefined;
  const transactionBound = 'accepted' in input;
  const accepted = input.accepted;
  const acceptedTopology = depthOfFieldTopology(accepted?.params);
  const acceptedGraph =
    accepted === undefined ? undefined : inspectDepthOfFieldGraph(accepted.graph, accepted.params);
  const acceptedValid =
    accepted !== undefined &&
    accepted.deviceGeneration === input.deviceGeneration &&
    acceptedTopology !== undefined &&
    acceptedGraph?.status === 'active';
  const candidateGraph = inspectDepthOfFieldGraph(input.graph, input.params);
  // Renderer.inspect() is transaction-bound: a compiled candidate is useful
  // for diagnosis, but it is not the effective graph until submit succeeds.
  // Direct callers that omit `accepted` retain the original structural
  // projection semantics used by graph-only tests and tools.
  const graph = transactionBound
    ? acceptedValid
      ? (acceptedGraph ?? candidateGraph)
      : candidateGraph
    : candidateGraph;
  const status: DepthOfFieldInspection['status'] =
    input.error?.code === 'depth-of-field-orthographic-unsupported'
      ? 'unsupported'
      : input.error !== undefined
        ? 'invalid'
        : !enabled
          ? 'off'
          : transactionBound
            ? acceptedValid && !input.lastSubmitFailed && requestedEqual(requested, accepted.params)
              ? 'active'
              : input.lastSubmitFailed
                ? 'invalid'
                : candidateGraph.status === 'invalid'
                  ? 'invalid'
                  : 'reset'
            : graph.status === 'active'
              ? 'active'
              : graph.status === 'invalid'
                ? 'invalid'
                : 'reset';
  const effective = acceptedValid
    ? {
        focusDistance: accepted.params.focusDistance,
        fStop: accepted.params.fStop,
        sensorHeight: accepted.params.sensorHeight,
        maxRadiusPixels: accepted.params.maxRadiusPixels,
        quality: accepted.params.quality,
        blurSide: accepted.params.blurSide,
      }
    : status === 'active'
      ? requested
      : undefined;
  const effectiveParams = acceptedValid
    ? accepted.params
    : status === 'active'
      ? params
      : undefined;
  return Object.freeze({
    enabled,
    status,
    requested,
    ...(effective === undefined ? {} : { effective }),
    focalLength: effectiveParams?.focalLength ?? params.focalLength,
    outputExtent: graph.outputExtent,
    workExtent: graph.workExtent,
    tapCount:
      effectiveParams !== undefined
        ? effectiveParams.quality === 'low'
          ? 16
          : effectiveParams.quality === 'medium'
            ? 32
            : 64
        : 0,
    passCount: graph.passCount,
    textureBytes: graph.textureBytes,
    transparentPolicy: 'opaque-depth-approximation',
    graphGeneration: graph.graphGeneration,
    deviceGeneration: input.deviceGeneration,
    lastKnownGood: acceptedValid || status === 'active',
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.error?.code === 'depth-of-field-orthographic-unsupported'
      ? { fallbackReason: 'orthographic-unsupported' as const }
      : input.error !== undefined
        ? { fallbackReason: 'invalid-params' as const }
        : status === 'off'
          ? { fallbackReason: 'zero-radius' as const }
          : status === 'reset'
            ? { fallbackReason: 'shader-not-ready' as const }
            : status === 'invalid'
              ? { fallbackReason: 'candidate-failed' as const }
              : {}),
  });
}

function requestedEqual(
  requested: DepthOfFieldInspection['requested'],
  params: DepthOfFieldParams,
): boolean {
  return (
    requested.focusDistance === params.focusDistance &&
    requested.fStop === params.fStop &&
    requested.sensorHeight === params.sensorHeight &&
    requested.maxRadiusPixels === params.maxRadiusPixels &&
    requested.quality === params.quality &&
    requested.blurSide === params.blurSide
  );
}
