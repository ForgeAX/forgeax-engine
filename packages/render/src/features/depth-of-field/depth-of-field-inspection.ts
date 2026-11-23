import {
  type CompiledRenderGraphInfo,
  compiledRenderGraphGeneration,
  compiledRenderGraphHasPass,
  compiledRenderGraphResourceDeclarations,
} from '@forgeax/engine-render-graph';
import { mipDimension, textureFormatBlock } from '@forgeax/engine-types';
import type { DepthOfFieldInspection } from '../../inspection-types';
import type { InstalledFrameGraph } from '../../record/frame-snapshot';
import { depthOfFieldPassNames, depthOfFieldTopology } from './depth-of-field-feature';
import {
  DEFAULT_DEPTH_OF_FIELD_PARAMS,
  type DepthOfFieldParams,
  type DepthOfFieldRequestFailure,
} from './depth-of-field-params';

function resourceBytes(resource: CompiledRenderGraphInfo['resources'][number]): number {
  if (resource.byteSize !== undefined) return resource.byteSize;
  const descriptor = resource.descriptor;
  if (descriptor.kind !== 'texture') return 0;
  if (descriptor.format !== 'rgba16float' && descriptor.format !== 'rgba8unorm') return 0;
  const texelBytes = textureFormatBlock(descriptor.format).bytesPerBlock;
  let bytes = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level += 1) {
    bytes +=
      mipDimension(descriptor.width, level) *
      mipDimension(descriptor.height, level) *
      descriptor.depthOrArrayLayers *
      texelBytes;
  }
  return bytes * descriptor.sampleCount;
}

function textureExtent(
  resources: CompiledRenderGraphInfo['resources'],
  label: string,
): { readonly width: number; readonly height: number } | undefined {
  const resource = resources.find(
    (candidate) => candidate.kind === 'texture' && candidate.label === label,
  );
  if (resource?.descriptor.kind !== 'texture') return undefined;
  return Object.freeze({ width: resource.descriptor.width, height: resource.descriptor.height });
}

export interface DepthOfFieldGraphInspection {
  readonly blurSide?: DepthOfFieldParams['blurSide'];
  readonly status: 'empty' | 'active' | 'invalid';
  readonly outputExtent: { readonly width: number; readonly height: number };
  readonly workExtent: { readonly width: number; readonly height: number };
  readonly passCount: number;
  readonly textureBytes: number;
  readonly graphGeneration: number;
}

interface DepthOfFieldAcceptedState {
  readonly params: DepthOfFieldParams;
  readonly graph: DepthOfFieldGraphInspection;
  readonly deviceGeneration: number;
}

const emptyExtent = Object.freeze({ width: 0, height: 0 });
const OFF_PARAMS = Object.freeze({ ...DEFAULT_DEPTH_OF_FIELD_PARAMS, maxRadiusPixels: 0 });

function emptyDepthOfFieldGraph(graphGeneration: number): DepthOfFieldGraphInspection {
  return {
    status: 'empty',
    outputExtent: emptyExtent,
    workExtent: emptyExtent,
    passCount: 0,
    textureBytes: 0,
    graphGeneration,
  };
}

/** Bind only the DoF passes and attachments. Optical parameters remain frame inputs. */
export function inspectDepthOfFieldGraph(
  graph: InstalledFrameGraph['graph'],
  topology: NonNullable<ReturnType<typeof depthOfFieldTopology>>,
): DepthOfFieldGraphInspection {
  const expectedPasses = depthOfFieldPassNames(topology);
  const completePasses = expectedPasses.every((name) => compiledRenderGraphHasPass(graph, name));
  const dofResources = compiledRenderGraphResourceDeclarations(graph, 'dof-').filter(
    (resource) => resource.kind === 'texture',
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
  const completeResources =
    dofResources.length === expectedResourceLabels.length &&
    expectedResourceLabels.every((label) => resourceLabels.has(label)) &&
    dofResources.every((resource) => resourceBytes(resource) > 0);
  const outputExtent = textureExtent(dofResources, 'dof-composite') ?? emptyExtent;
  const workExtent =
    textureExtent(dofResources, topology.useNear ? 'dof-near' : 'dof-far') ?? emptyExtent;
  return {
    blurSide: topology.blurSide,
    status: completePasses && completeResources ? 'active' : 'invalid',
    outputExtent,
    workExtent,
    passCount: completePasses ? expectedPasses.length : 0,
    textureBytes: completeResources
      ? dofResources.reduce((bytes, resource) => bytes + resourceBytes(resource), 0)
      : 0,
    graphGeneration: compiledRenderGraphGeneration(graph),
  };
}

/** Match the bound aperture shape even when the latest requested candidate was rejected. */
export function depthOfFieldGraphForParams(
  installed: InstalledFrameGraph | null,
  params: DepthOfFieldParams | undefined,
): DepthOfFieldGraphInspection {
  if (installed == null) return emptyDepthOfFieldGraph(0);
  if (
    params !== undefined &&
    params.maxRadiusPixels > 0 &&
    installed.depthOfField?.blurSide === params.blurSide
  )
    return installed.depthOfField;
  const shape = depthOfFieldTopology(params);
  return shape === undefined
    ? emptyDepthOfFieldGraph(compiledRenderGraphGeneration(installed.graph))
    : inspectDepthOfFieldGraph(installed.graph, shape);
}

export function projectDepthOfFieldInspection(input: {
  readonly params?: DepthOfFieldParams;
  readonly graph?: DepthOfFieldGraphInspection;
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
  const acceptedGraph = accepted?.graph;
  const acceptedValid =
    accepted !== undefined &&
    accepted.deviceGeneration === input.deviceGeneration &&
    acceptedTopology !== undefined &&
    acceptedGraph?.status === 'active';
  const candidateGraph = input.graph ?? emptyDepthOfFieldGraph(0);
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
