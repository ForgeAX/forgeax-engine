import {
  appendCompiledRenderGraphPassNames,
  type CompiledRenderGraph,
  compiledRenderGraphGeneration,
} from '@forgeax/engine-render-graph';
import { recordFeatureGraphConformanceEvent } from '../features/feature-graph-conformance-trace';
import { featureScopeKey } from '../features/frame-plan';
import { getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import { viewFeaturesOf } from '../features/view-feature-work';
import type { RenderPipelineFrame } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';
import type { RenderFeatureGraphCandidate } from './typed-frame-graph';

export function traceFeaturePlans(
  internals: RenderSystemInternals,
  recordFrameNumber: number,
  stage: 'typed-plan-input' | 'typed-plan-validated',
  plans: readonly RenderFeaturePlannedFrame[],
  candidate?: RenderFeatureGraphCandidate,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const plan = plans.find((entry) => entry.featureIdentity === trace.featureIdentity);
  const execution = plan === undefined ? undefined : getRenderFeaturePlanExecutionProjection(plan);
  const passes = execution?.passes ?? [];
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber,
    featureIdentity: trace.featureIdentity,
    stage,
    details: {
      ...(stage === 'typed-plan-input'
        ? {
            source: candidate === undefined ? 'accepted-feature-host-state' : 'frame-candidate',
            candidatePresent: candidate !== undefined,
          }
        : {}),
      targetPlanPresent: plan !== undefined,
      planCount: plans.length,
      scope: plan === undefined ? null : featureScopeKey(plan.scope),
      generation: plan?.generation ?? null,
      placement: plan?.placement ?? 'post',
      signature: plan?.signature ?? null,
      passNames: passes.map((pass) => pass.name),
      resolvedDispatchCount: passes.reduce(
        (count, pass) => count + (pass.resolvedGpuCompute?.dispatches.length ?? 0),
        0,
      ),
    },
  });
}

function traceGraphPasses(
  internals: RenderSystemInternals,
  recordFrameNumber: number,
  path: string,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
  targetFeaturePlanPresent: boolean,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const passNames: string[] = [];
  appendCompiledRenderGraphPassNames(graph, passNames);
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'graph-passes',
    details: {
      path,
      passNames,
      graphGeneration: compiledRenderGraphGeneration(graph),
      targetFeaturePlanPresent,
    },
  });
}

function traceCandidateLifecycle(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  disposition: string,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const plan = candidate?.plans.find((row) => row.featureIdentity === trace.featureIdentity);
  const execution = plan === undefined ? undefined : getRenderFeaturePlanExecutionProjection(plan);
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber: frameState.frameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'candidate-lifecycle',
    details: {
      disposition,
      candidatePresent: candidate !== undefined,
      targetPlanPresent: plan !== undefined,
      scope: plan === undefined ? null : featureScopeKey(plan.scope),
      passNames: execution?.passes.map((pass) => pass.name) ?? [],
    },
  });
}

export function traceGraphDecision(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  path: string,
  candidate: RenderFeatureGraphCandidate | undefined,
  graph?: CompiledRenderGraph<RenderPipelineFrame> | null,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  const passNames: string[] = [];
  if (graph) appendCompiledRenderGraphPassNames(graph, passNames);
  const plans = candidate?.plans ?? viewFeaturesOf(frameState).work.plans;
  const targetPlanPresent = plans.some((plan) => plan.featureIdentity === trace.featureIdentity);
  recordFeatureGraphConformanceEvent(trace, {
    recordFrameNumber: frameState.frameNumber,
    featureIdentity: trace.featureIdentity,
    stage: 'graph-decision',
    details: {
      path,
      candidatePresent: candidate !== undefined,
      targetPlanPresent,
      graphGeneration: graph ? compiledRenderGraphGeneration(graph) : null,
      passNames,
    },
  });
}

export function traceCompiledFeatureGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  candidate: RenderFeatureGraphCandidate | undefined,
  plans: readonly RenderFeaturePlannedFrame[],
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const trace = recordContext(internals).featureGraphConformanceTrace;
  if (trace === undefined) return;
  traceCandidateLifecycle(internals, frameState, candidate, 'compiled-pending-adoption');
  traceGraphDecision(internals, frameState, 'render-graph-compiled', candidate, graph);
  traceGraphPasses(
    internals,
    frameState.frameNumber,
    'compiled',
    graph,
    plans.some((plan) => plan.featureIdentity === trace.featureIdentity),
  );
}
