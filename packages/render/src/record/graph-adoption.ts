import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import type { RenderError } from '../errors/render';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { retirePendingStandardOutputGpu } from '../pipeline/standard-output/resources';
import type { RendererError } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';
import { renderSubmission, renderWorldFor } from '../world/render-world';
import { recordContext } from '../world/view-record-context';
import { frameGraphChangedDependencies, frameGraphChangedValues } from './frame-graph-identity';
import type { InstalledFrameGraph, RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import {
  commitFeatureCandidate,
  type MutableRenderFeatureGraphInspection,
  mutableFeatureGraphInspection,
  type RenderFeatureGraphCandidate,
  type RenderFeaturePlanRevisionState,
  recordGraphDeviceGeneration,
  recordRenderFeatureCandidateEvent,
  reportRenderFeatureGraphError,
  retire,
  trackGraphGeneration,
} from './typed-frame-graph';

type Graph = CompiledRenderGraph<RenderPipelineFrame>;

/** Why a view kept its last-known-good graph (`retained`) or has none (`rejected`). */
export type GraphRejectCode =
  | 'feature-validation-failed'
  | 'topology-failed'
  | 'ao-unavailable'
  | 'post-chain-pending'
  | 'graph-inputs-failed'
  | 'graph-build-failed'
  | 'graph-compile-failed';

/** Codes whose failure also drops the Standard output GPU state staged for the graph. */
const GRAPH_BUILD_REJECT_CODES: ReadonlySet<GraphRejectCode> = new Set([
  'graph-inputs-failed',
  'graph-build-failed',
  'graph-compile-failed',
]);

export const FEATURE_GRAPH_COUNTERS = [
  'signatureValidationCalls',
  'signatureValidationBytes',
  'signatureValidationChars',
  'signatureValidationCpuMs',
  'signatureValidationCacheHits',
  'signatureValidationCacheMisses',
  'reuseHits',
  'rebuildAttempts',
  'compileAttempts',
  'compileSuccesses',
  'compileFailures',
  'validationFailures',
  'buildFailures',
  'unsubmittedGraphReuses',
  'compileCpuMs',
  'buildCpuMs',
] as const satisfies readonly (keyof MutableRenderFeatureGraphInspection)[];

/** Feature graph metrics one compile adds; adoption folds them into the owner's inspection. */
export type FeatureGraphMetricsDelta = Record<(typeof FEATURE_GRAPH_COUNTERS)[number], number> & {
  /** The next plan revision, only when the validated plan set changed. */
  planRevision: RenderFeaturePlanRevisionState | undefined;
  lastTopologyKey: string | undefined;
  /** A build reached compile; adoption records which topology inputs changed. */
  compileCause:
    | { readonly installedTopologyKey: string | undefined; readonly key: string }
    | undefined;
};

/** The one error a compile reports, and the owner it reports through. */
export type GraphEffectError =
  | { readonly route: 'feature'; readonly error: RenderError }
  | { readonly route: 'registry'; readonly error: RendererError };

/**
 * Data form of every side effect the compile path used to perform in place.
 * The barrel resolution, the Feature candidate event (settle on success,
 * reject otherwise) and the Standard output retirement derive from the kind.
 */
export interface GraphEffects {
  readonly metrics: FeatureGraphMetricsDelta;
  /** Applied on `reused`, `promoted` and `compiled`. */
  readonly lightingSignature: string;
  /** Applied on `reused`, `promoted` and `compiled`. */
  readonly cloudHistoryActive: boolean;
  readonly featureCandidate: RenderFeatureGraphCandidate | undefined;
  /** The post chain is still compiling: a settled candidate is abandoned rather than committed. */
  readonly postPending: boolean;
  /** A stashed unsubmitted graph whose key or device generation no longer matches. */
  readonly retireStash: InstalledFrameGraph | undefined;
  /** GPU-driven view buffers the adopted graph now imports. */
  readonly gpuReplacement: PreparedGpuDrivenFrame | undefined;
  readonly error: GraphEffectError | undefined;
  /** An allocated candidate rejected before adoption; report it while live, then retire it. */
  readonly rejectedGraph?: Graph;
}

export type ViewGraphCompileOutcome =
  | {
      readonly frame: number;
      readonly kind: 'reused';
      readonly graph: Graph;
      readonly effects: GraphEffects;
    }
  | {
      readonly frame: number;
      readonly kind: 'promoted';
      readonly graph: Graph;
      readonly stash: InstalledFrameGraph;
      readonly effects: GraphEffects;
    }
  | {
      readonly frame: number;
      readonly kind: 'compiled';
      readonly graph: Graph;
      readonly installed: InstalledFrameGraph;
      readonly effects: GraphEffects;
    }
  | {
      readonly frame: number;
      readonly kind: 'retained';
      readonly graph: Graph;
      readonly reason: GraphRejectCode;
      readonly effects: GraphEffects;
    }
  | {
      readonly frame: number;
      readonly kind: 'rejected';
      readonly code: GraphRejectCode;
      readonly effects: GraphEffects;
    }
  | { readonly frame: number; readonly kind: 'failed'; readonly cause: unknown };

function recordCompileCauses(
  featureMetrics: MutableRenderFeatureGraphInspection,
  frame: number,
  installedTopologyKey: string | undefined,
  key: string,
): void {
  const changedDependencies = frameGraphChangedDependencies(installedTopologyKey, key);
  const primaryCause = changedDependencies[0] ?? 'cold';
  featureMetrics.compilePrimaryCauses[primaryCause] =
    (featureMetrics.compilePrimaryCauses[primaryCause] ?? 0) + 1;
  for (const dependency of changedDependencies) {
    featureMetrics.compileChangedDependencies[dependency] =
      (featureMetrics.compileChangedDependencies[dependency] ?? 0) + 1;
  }
  // Bounded detached evidence of what changed; compiles are already rare and costly.
  featureMetrics.recentCompileChanges.push({
    frame,
    changes: frameGraphChangedValues(installedTopologyKey, key, changedDependencies),
  });
  if (featureMetrics.recentCompileChanges.length > 32) featureMetrics.recentCompileChanges.shift();
}

function applyFeatureGraphMetrics(
  featureMetrics: MutableRenderFeatureGraphInspection,
  delta: FeatureGraphMetricsDelta,
  frame: number,
): void {
  for (const counter of FEATURE_GRAPH_COUNTERS) featureMetrics[counter] += delta[counter];
  if (delta.planRevision !== undefined) {
    featureMetrics.lastPlanSignature = delta.planRevision.entries
      .map((entry) => `${entry.featureIdentity}:${entry.signature}`)
      .join('|');
    featureMetrics.planRevisionState = delta.planRevision;
  }
  if (delta.lastTopologyKey !== undefined) featureMetrics.lastTopologyKey = delta.lastTopologyKey;
  if (delta.compileCause !== undefined) {
    recordCompileCauses(
      featureMetrics,
      frame,
      delta.compileCause.installedTopologyKey,
      delta.compileCause.key,
    );
  }
}

function fireGraphEffectError(
  internals: RenderSystemInternals,
  error: GraphEffectError | undefined,
): void {
  if (error === undefined) return;
  if (error.route === 'feature') reportRenderFeatureGraphError(internals, error.error);
  else internals.errorRegistry.fire(error.error);
}

/**
 * A second build in the same transaction supersedes only the unsubmitted
 * candidate; rollback must still reach the last accepted projection.
 */
function stageCompiledFrameGraphCandidate(frameState: RenderFrameState, graph: Graph): void {
  const superseded = frameState.compiledFrameGraphCandidate;
  frameState.compiledFrameGraphCandidate = {
    graph,
    previous: superseded?.previous ?? {
      installed: frameState.compiledFrameGraph,
      graphGeneration: frameState.graphGeneration ?? 0,
      compiledGeneration: frameState.compiledFrameGraphGeneration ?? 0,
      lightingSignature: frameState.standardLightingGraphSignature ?? '',
    },
  };
  if (superseded !== undefined && superseded.graph !== graph) retire(frameState, superseded.graph);
}

// View buffer replacement is safe to retire once the compiled graph owns
// the new imports. Shadow cache publication remains submit-transactional
// and is committed only by executeCompiledFrameGraph's onSubmitted hook.
function commitGpuDrivenResourceReplacement(gpuDriven: PreparedGpuDrivenFrame | undefined): void {
  if (gpuDriven?._commitGpuResourceReplacement !== undefined) {
    gpuDriven._commitGpuResourceReplacement();
  } else {
    // Synthetic/internal prepared projections predating the split own no
    // shadow cache; retain their original graph-promotion callback.
    gpuDriven?._commitResourceReplacement();
  }
}

/** Stage a promoted or freshly compiled graph as this frame's transactional candidate. */
function installAdoptedGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  graph: Graph,
  installed: InstalledFrameGraph,
  effects: GraphEffects,
  fresh: boolean,
): void {
  // Register the generation before publishing it. The owner observes the
  // overlap while the previous graph is still live, even if a queue fence
  // retires that graph before the next public inspect() call.
  trackGraphGeneration(frameState, graph);
  stageCompiledFrameGraphCandidate(frameState, graph);
  frameState.compiledFrameGraphGeneration += 1;
  frameState.graphGeneration += 1;
  frameState.compiledFrameGraph =
    installed.targets.graphGeneration === frameState.graphGeneration
      ? installed
      : {
          ...installed,
          targets: { ...installed.targets, graphGeneration: frameState.graphGeneration },
        };
  commitGpuDrivenResourceReplacement(effects.gpuReplacement);
  if (fresh) recordGraphDeviceGeneration(internals, graph);
}

/** Publish a candidate whose post chain is complete; abandon one still waiting on post pipelines. */
function settleFeatureCandidate(internals: RenderSystemInternals, effects: GraphEffects): void {
  const candidate = effects.featureCandidate;
  if (candidate === undefined) return;
  if (effects.postPending) recordRenderFeatureCandidateEvent(internals, candidate, 'abandoned');
  else commitFeatureCandidate(internals, candidate);
}

/**
 * Apply one compile outcome to the view's frame state and feature owners, in
 * the order the in-place compile path used to perform them. A `failed`
 * outcome rethrows its cause into the view's own record recovery.
 */
export function adoptViewGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  outcome: ViewGraphCompileOutcome,
): Graph | null {
  frameState.featureGraphReceipt = undefined;
  const featureMetrics = mutableFeatureGraphInspection(internals);
  featureMetrics.ensureCalls += 1;
  if (outcome.kind === 'failed') {
    frameState.barrelDistortionGraphResolution = 'retained';
    throw outcome.cause;
  }
  const effects = outcome.effects;
  applyFeatureGraphMetrics(featureMetrics, effects.metrics, outcome.frame);
  if (effects.retireStash !== undefined || outcome.kind === 'promoted') {
    frameState.unsubmittedCompiledFrameGraph = undefined;
  }
  if (effects.retireStash !== undefined) retire(frameState, effects.retireStash.graph);
  if (outcome.kind === 'retained' || outcome.kind === 'rejected') {
    const rejectedGraph = effects.rejectedGraph;
    if (rejectedGraph !== undefined) {
      trackGraphGeneration(frameState, rejectedGraph);
      recordGraphDeviceGeneration(internals, rejectedGraph);
    }
    try {
      fireGraphEffectError(internals, effects.error);
    } finally {
      if (rejectedGraph !== undefined) retire(frameState, rejectedGraph);
    }
    if (GRAPH_BUILD_REJECT_CODES.has(outcome.kind === 'retained' ? outcome.reason : outcome.code)) {
      retirePendingStandardOutputGpu(frameState);
    }
    frameState.barrelDistortionGraphResolution = 'retained';
    if (effects.featureCandidate !== undefined) {
      recordRenderFeatureCandidateEvent(internals, effects.featureCandidate, 'rejected');
    }
    return outcome.kind === 'retained' ? outcome.graph : null;
  }
  if (outcome.kind === 'promoted') {
    installAdoptedGraph(internals, frameState, outcome.graph, outcome.stash, effects, false);
  } else if (outcome.kind === 'compiled') {
    installAdoptedGraph(internals, frameState, outcome.graph, outcome.installed, effects, true);
  }
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.standardLightingGraphSignature = effects.lightingSignature;
  settleFeatureCandidate(internals, effects);
  if (!effects.postPending && effects.featureCandidate !== undefined) {
    frameState.featureGraphReceipt = {
      kind: 'compiled',
      graph: outcome.graph,
      frame: renderSubmission(renderWorldFor(internals)).frame,
      generation: recordContext(internals).deviceScope?.generation ?? 0,
      view: internals.viewEntity,
      plans: effects.featureCandidate.plans,
    };
  }
  frameState.pendingCloudHistoryActive = effects.cloudHistoryActive;
  // The selected candidate owner retires the previous graph only after submit.
  return outcome.graph;
}
