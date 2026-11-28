import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import type { ViewFeatureWork } from '../features/view-feature-work';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { retirePendingStandardOutputGpu } from '../pipeline/standard-output/resources';
import type { RendererError } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';
import { renderSubmission, renderWorldFor } from '../world/render-world';
import { recordContext } from '../world/view-record-context';
import { type FrameGraphIdentity, frameGraphCompileAttribution } from './frame-graph-identity';
import {
  type InstalledFrameGraph,
  type RenderFrameState,
  viewGraphDeviceIsCurrent,
} from './frame-snapshot';
import { trackGraphGeneration } from './graph-allocation-owner';
import type { RenderSystemInternals } from './render-context';
import {
  commitFeatureCandidate,
  type MutableRenderFeatureGraphInspection,
  mutableFeatureGraphInspection,
  type RenderFeatureGraphCandidate,
  type RenderFeaturePlanRevisionState,
  recordRenderFeatureCandidateEvent,
  reportRenderFeatureGraphError,
  retire,
} from './typed-frame-graph';

type Graph = CompiledRenderGraph<RenderPipelineFrame>;

/** Failed compiler allocations remain exact original-owner retirement responsibilities. */
export function retireRejectedSourceGraph(
  frameState: RenderFrameState,
  graph: Graph,
): Promise<Result<void, unknown>> {
  trackGraphGeneration(frameState, graph);
  retire(frameState, graph);
  return graph.retire();
}

export interface PreparedViewGraph {
  readonly installed: InstalledFrameGraph;
  accept(): Result<void, RhiError>;
  isCurrent(): boolean;
  retire(): Promise<Result<void, unknown>>;
}

/** Register one real compiled graph before exposing callbacks or yielding its Source task. */
export function holdPreparedViewGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  installed: InstalledFrameGraph,
): PreparedViewGraph {
  const context = recordContext(internals),
    scope = context.deviceScope;
  const previous = frameState.compiledFrameGraph;
  const graph = installed.graph;
  trackGraphGeneration(frameState, graph);
  let accepted = false;
  let retirement: Promise<Result<void, unknown>> | undefined;
  const ownerCurrent = () =>
    recordContext(internals) === context &&
    context.deviceScope === scope &&
    viewGraphDeviceIsCurrent(installed, scope) &&
    !installed.nativeResources.isRetired();
  const current = () =>
    accepted &&
    retirement === undefined &&
    ownerCurrent() &&
    (frameState.compiledFrameGraph === installed ||
      frameState.unsubmittedCompiledFrameGraph === installed);
  return Object.freeze({
    installed,
    isCurrent: current,
    accept: () => {
      if (
        accepted ||
        retirement !== undefined ||
        !ownerCurrent() ||
        renderSubmission(renderWorldFor(internals)).open ||
        frameState.compiledFrameGraph !== previous ||
        frameState.compiledFrameGraphCandidate !== undefined
      )
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'one idle original View graph owner',
            hint: 'recompile the current Source demand outside recording',
          }),
        );
      const stash = frameState.unsubmittedCompiledFrameGraph;
      if (previous !== installed) frameState.unsubmittedCompiledFrameGraph = installed;
      accepted = true;
      if (stash !== undefined && stash.graph !== graph) retire(frameState, stash.graph);
      return current()
        ? ok(undefined)
        : err(
            new RhiError({
              code: 'rhi-descriptor-invalid',
              expected: 'the original prepared graph remains owned',
              hint: 'reprepare the invalidated Source graph',
            }),
          );
    },
    retire: () => {
      if (retirement !== undefined) return retirement;
      retirement = Promise.resolve().then(async () => {
        // Ordinary adoption transfers this graph to its existing View owner.
        if (
          frameState.compiledFrameGraph?.graph === graph ||
          frameState.compiledFrameGraphCandidate?.installed.graph === graph
        )
          return ok(undefined);
        if (frameState.unsubmittedCompiledFrameGraph?.graph === graph)
          frameState.unsubmittedCompiledFrameGraph = undefined;
        retire(frameState, graph);
        return graph.retire();
      });
      return retirement;
    },
  });
}

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
  lastTopologyKey: FrameGraphIdentity | undefined;
  /** A build reached compile; adoption records which topology inputs changed. */
  compileCause:
    | {
        readonly installedTopologyKey: FrameGraphIdentity | undefined;
        readonly key: FrameGraphIdentity;
      }
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
  /** App request whose inputs produced this compile outcome. */
  readonly configurationRevision?: number | undefined;
  readonly forwardDisplayReceiver?: InstalledFrameGraph['forwardDirectionalShadow'];
  /** Applied on `reused`, `promoted` and `compiled`. */
  readonly cloudHistoryFormat?: import('../cloud/reconstruction/history').CloudTransportFormat;
  readonly featureCandidate: RenderFeatureGraphCandidate | undefined;
  readonly featureWork: ViewFeatureWork;
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

/** The ordered recorder hands over the binding it already selected. */
export type OrderedDisplayOutcome = {
  readonly frame: number;
  readonly kind: 'ordered-display';
  readonly installed: InstalledFrameGraph;
  readonly configurationRevision: number | undefined;
  readonly forwardDisplayReceiver: InstalledFrameGraph['forwardDirectionalShadow'];
  readonly featureCandidate: RenderFeatureGraphCandidate | undefined;
  readonly featureWork: ViewFeatureWork;
  readonly metrics: FeatureGraphMetricsDelta | undefined;
} & (
  | { readonly operation: 'reuse' }
  | { readonly operation: 'promote'; readonly gpuReplacement: PreparedGpuDrivenFrame | undefined }
  | {
      readonly operation: 'bind';
      readonly gpuReplacement: PreparedGpuDrivenFrame | undefined;
      readonly retireStash: InstalledFrameGraph | undefined;
      readonly buildCpuMs: number;
      readonly bindingCpuMs: number;
    }
);

export type ViewGraphCompileOutcome =
  | OrderedDisplayOutcome
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
  installedTopologyKey: FrameGraphIdentity | undefined,
  key: FrameGraphIdentity,
): void {
  const { dependencies, changes } = frameGraphCompileAttribution(installedTopologyKey, key);
  const primaryCause = dependencies[0] ?? 'cold';
  featureMetrics.compilePrimaryCauses[primaryCause] =
    (featureMetrics.compilePrimaryCauses[primaryCause] ?? 0) + 1;
  for (const dependency of dependencies) {
    featureMetrics.compileChangedDependencies[dependency] =
      (featureMetrics.compileChangedDependencies[dependency] ?? 0) + 1;
  }
  featureMetrics.recentCompileChanges.push({ frame, changes });
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
function stageCompiledFrameGraphCandidate(
  frameState: RenderFrameState,
  installed: InstalledFrameGraph,
): void {
  const superseded = frameState.compiledFrameGraphCandidate;
  frameState.compiledFrameGraphCandidate = {
    installed,
    previous: superseded?.previous ?? {
      installed: frameState.compiledFrameGraph,
      graphGeneration: frameState.graphGeneration ?? 0,
    },
  };
  if (superseded !== undefined && superseded.installed.graph !== installed.graph)
    retire(frameState, superseded.installed.graph);
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
  frameState: RenderFrameState,
  installed: InstalledFrameGraph,
  gpuReplacement: PreparedGpuDrivenFrame | undefined,
): void {
  // Register the generation before publishing it. The owner observes the
  // overlap while the previous graph is still live, even if a queue fence
  // retires that graph before the next public inspect() call.
  const { graph } = installed;
  trackGraphGeneration(frameState, graph);
  stageCompiledFrameGraphCandidate(frameState, installed);
  frameState.graphGeneration += 1;
  frameState.compiledFrameGraph = installed;
  commitGpuDrivenResourceReplacement(gpuReplacement);
}

function installedDisplay(frameState: RenderFrameState, graph: Graph): InstalledFrameGraph | null {
  const installed = frameState.compiledFrameGraph;
  return installed?.graph === graph ? installed : null;
}

/** Publish the plans used by encoding once their post chain is ready. */
function settleFeatureCandidate(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  graph: Graph,
  candidate: RenderFeatureGraphCandidate | undefined,
  work: ViewFeatureWork,
  postPending: boolean,
): void {
  if (candidate === undefined) return;
  if (postPending) {
    recordRenderFeatureCandidateEvent(internals, candidate, 'abandoned');
    return;
  }
  commitFeatureCandidate(internals, frameState, candidate, work);
  frameState.featureGraphReceipt = {
    kind: 'compiled',
    graph,
    frame: renderSubmission(renderWorldFor(internals)).frame,
    generation: recordContext(internals).deviceScope?.generation ?? 0,
    view: internals.viewEntity,
    plans: work.plans,
  };
}

/** Move the chosen ordered binding into the existing submission transaction. */
export function adoptOrderedDisplay(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  display: OrderedDisplayOutcome,
): InstalledFrameGraph {
  const { installed, operation, featureCandidate } = display;
  frameState.featureGraphReceipt = undefined;
  const inspection = mutableFeatureGraphInspection(internals);
  inspection.ensureCalls += 1;
  if (display.metrics !== undefined)
    applyFeatureGraphMetrics(inspection, display.metrics, display.frame);
  inspection.lastTopologyKey = installed.topologyKey;
  if (operation === 'reuse') {
    inspection.reuseHits += 1;
  } else {
    if (operation === 'bind') {
      const retired = display.retireStash;
      if (retired !== undefined) {
        frameState.unsubmittedCompiledFrameGraph = undefined;
        retire(frameState, retired.graph);
      }
      inspection.rebuildAttempts += 1;
      inspection.compileAttempts += 1;
      inspection.compileSuccesses += 1;
      inspection.buildCpuMs += display.buildCpuMs;
      inspection.compileCpuMs += display.bindingCpuMs;
      recordCompileCauses(
        inspection,
        display.frame,
        frameState.compiledFrameGraph?.topologyKey,
        installed.topologyKey,
      );
    } else {
      frameState.unsubmittedCompiledFrameGraph = undefined;
      inspection.unsubmittedGraphReuses += 1;
    }
    installAdoptedGraph(frameState, installed, display.gpuReplacement);
  }
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.forwardDisplayReceiver = display.forwardDisplayReceiver;
  settleFeatureCandidate(
    internals,
    frameState,
    installed.graph,
    featureCandidate,
    display.featureWork,
    false,
  );
  setPendingCloudHistory(frameState, installed.displayPorts?.cloud?.format);
  return installed;
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
): InstalledFrameGraph | null {
  if (outcome.kind === 'ordered-display')
    return adoptOrderedDisplay(internals, frameState, outcome);
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
    return outcome.kind === 'retained' ? installedDisplay(frameState, outcome.graph) : null;
  }
  if (outcome.kind === 'promoted') {
    installAdoptedGraph(frameState, outcome.stash, effects.gpuReplacement);
  } else if (outcome.kind === 'compiled') {
    installAdoptedGraph(frameState, outcome.installed, effects.gpuReplacement);
  }
  frameState.barrelDistortionGraphResolution = 'accepted';
  frameState.forwardDisplayReceiver = effects.forwardDisplayReceiver;
  settleFeatureCandidate(
    internals,
    frameState,
    outcome.graph,
    effects.featureCandidate,
    effects.featureWork,
    effects.postPending,
  );
  setPendingCloudHistory(frameState, effects.cloudHistoryFormat);
  // The selected candidate owner retires the previous graph only after submit.
  return installedDisplay(frameState, outcome.graph);
}

function setPendingCloudHistory(
  frameState: RenderFrameState,
  format: GraphEffects['cloudHistoryFormat'],
): void {
  frameState.pendingCloudHistoryActive = format !== undefined;
  if (format === undefined) delete frameState.pendingCloudHistoryFormat;
  else frameState.pendingCloudHistoryFormat = format;
}
