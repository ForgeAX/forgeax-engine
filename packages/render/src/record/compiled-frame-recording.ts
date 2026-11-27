import {
  type CompiledRenderGraph,
  compiledRenderGraphGeneration,
  type RenderGraphFrame,
  type RenderGraphPassInstrumentation,
} from '@forgeax/engine-render-graph';
import { type RhiCommandEncoder, RhiError } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { sharedFeatureGraphPublication } from '../assembly/feature-frame-graph';
import type { RecordedView } from '../assembly/frame-recording';
import type { RendererFrameStageResult } from '../assembly/renderer-frame-transaction';
import { captureEditorAssistanceView } from '../features/editor-assistance/feature';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../features/host';
import { renderFeatureViewIdentity } from '../features/view';
import { acceptGtaoHistory, beginGtaoHistory } from '../pipeline/gtao-history';
import { discardStandardOutputStates } from '../pipeline/standard-output/resources';
import type { RenderPipelineFrame } from '../render-pipeline';
import { hasPendingTemporalGpuSubmit } from '../temporal/gpu';
import { recordViewFeatureGraph } from '../world/feature-systems';
import {
  abortGraphSubmission,
  commitGraphSubmission,
  type GraphSubmission,
} from '../world/graph-submission-systems';
import { renderSubmission, renderWorldFor } from '../world/render-world';
import { recordContext } from '../world/view-record-context';
import { getTextureIdentity, type RenderFrameState } from './frame-snapshot';
import {
  createRenderGraphPassInstrumentation,
  renderGraphPassInstrumentationActive,
} from './frame-targets';
import { createTimingInstrumentation } from './gpu-pass-timing-instrumentation';
import type { GpuTimingCapture } from './gpu-timing';
import { executeGraphTargetReplay } from './graph-target-pass-replay';
import {
  encodeGraphTargetCapture,
  encodeReflectionFallbackReadback,
} from './graph-target-readback';
import { flushMeshDrawUploads } from './mesh-ssbo';
import { deriveMotionBlurExecutionReceipt } from './motion-blur-receipt';
import type { _InternalRenderPipelineContext, RenderSystemInternals } from './render-context';
import type { RenderFeatureGraphRuntimeState } from './typed-frame-graph';

const featureGraphStates = new WeakMap<RenderSystemInternals, RenderFeatureGraphRuntimeState>();

const graphDeviceGenerations = new WeakMap<object, number>();

export function getRenderFeatureGraphState(
  internals: RenderSystemInternals,
): RenderFeatureGraphRuntimeState {
  const existing = featureGraphStates.get(internals);
  if (existing !== undefined) return existing;
  const created: RenderFeatureGraphRuntimeState = {
    plans: [],
    fullscreenEffects: new Map(),
    postProcessIdentities: [],
  };
  featureGraphStates.set(internals, created);
  return created;
}

export function recordedGraphDeviceGeneration(graph: CompiledRenderGraph<RenderPipelineFrame>) {
  return graphDeviceGenerations.get(graph);
}

export function recordGraphDeviceGeneration(
  internals: RenderSystemInternals,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  const deviceGeneration = recordContext(internals).deviceScope?.generation;
  if (deviceGeneration !== undefined) graphDeviceGenerations.set(graph, deviceGeneration);
}

/**
 * Direct harness: one submission whose RenderRecord opens the encoder the
 * compiled graph records into.
 */
export interface CompiledFrameHooks {
  readonly afterGraphExecute?: () => Result<void, RhiError>;
  readonly generationFence?: import('../assembly/renderer-frame-transaction').RendererGenerationFence;
  readonly gi?: import('./frame-diffuse-gi').FrameDiffuseGi;
  readonly onSubmitted?: () => void;
  readonly onSubmittedWork?: (completed: Promise<void>) => void;
}

export interface EncodedFrameGraph {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly submission: GraphSubmission;
  readonly work: RecordedView;
}

export type FrameGraphEncodeOutcome =
  | { readonly kind: 'encoded'; readonly value: EncodedFrameGraph }
  | { readonly kind: 'rejected'; readonly stage: 'execute' | 'finish' };

function combinePassInstrumentation<Frame extends RenderGraphFrame>(
  base: RenderGraphPassInstrumentation<Frame> | undefined,
  extra: RenderGraphPassInstrumentation<Frame> | undefined,
): RenderGraphPassInstrumentation<Frame> | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return {
    begin(pass, frame) {
      const baseScope = base.begin(pass, frame);
      const extraScope = extra.begin(pass, frame);
      if (baseScope === undefined && extraScope === undefined) return undefined;
      return {
        ...baseScope,
        ...extraScope,
        endPass() {
          try {
            extraScope?.endPass?.();
          } catch {
            // Diagnostics cannot replace a graph pass result.
          }
          try {
            baseScope?.endPass?.();
          } catch {
            // Diagnostics cannot replace a graph pass result.
          }
        },
      };
    },
  };
}

/** Encode and resolve readbacks into the open frame encoder; never submits or suspends. */
export function recordCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  frame: RenderPipelineFrame,
  encoder: RhiCommandEncoder,
  runPass?: import('@forgeax/engine-render-graph').RenderGraphPassRunner,
  frameHooks?: CompiledFrameHooks,
  readbackLayers?: readonly import('../assembly/render-target-host').RenderTargetLayerWrite[],
  onSubmitted?: (completed: Promise<unknown>) => void,
  timingCapture?: GpuTimingCapture,
): FrameGraphEncodeOutcome {
  const resolvedFrameHooks = frameHooks;
  beginGtaoHistory(frameState);
  const graph = frameState.compiledFrameGraph?.graph ?? null;
  if (graph === null) {
    timingCapture?.discard();
    discardStandardOutputStates(frameState);
    return { kind: 'rejected', stage: 'execute' };
  }
  const acceptedFeaturePlans = getRenderFeatureGraphState(internals).plans;
  const editor = captureEditorAssistanceView(
    recordContext(internals).featureHost,
    internals.rendererFrameNumber ?? frameState.frameNumber,
    renderFeatureViewIdentity(frame.camera),
    frame.camera?.outline,
  );
  let pendingAtomicPasses: Set<string> | undefined;
  const featureExecutions: RenderFeaturePlanExecution[] = [];
  for (const planned of acceptedFeaturePlans) {
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    if (execution !== undefined) featureExecutions.push(execution);
    if (planned.plan.submission === 'atomic') {
      pendingAtomicPasses ??= new Set();
      for (const pass of planned.plan.passes) pendingAtomicPasses.add(pass.name);
    }
  }
  const executionFrame = {
    ...frame,
    nativePassNames: internals.framePassNames,
    ...(editor === undefined ? {} : { editorAssistance: editor }),
    sharedFeatureGraph: sharedFeatureGraphPublication(internals.featureHost),
    featureExecutions,
  };
  const motionBlurExecution = deriveMotionBlurExecutionReceipt(
    internals,
    frameState,
    acceptedFeaturePlans,
  );
  frameState.stagedMotionBlurExecution = { receipt: motionBlurExecution };
  const legacyTimingInstrumentation =
    timingCapture === undefined ? undefined : createTimingInstrumentation(timingCapture);
  const graphGeneration = compiledRenderGraphGeneration(graph);
  internals.observationGraphGeneration = graphGeneration;
  const passTimingCapture = internals.gpuPassTimingCapture;
  const profileInstrumentation = !renderGraphPassInstrumentationActive(internals)
    ? undefined
    : createRenderGraphPassInstrumentation({ internals, graph });
  const graphInstrumentation =
    passTimingCapture === undefined
      ? combinePassInstrumentation(legacyTimingInstrumentation, profileInstrumentation)
      : profileInstrumentation;
  const deviceScope = recordContext(internals).deviceScope;
  const graphDeviceGeneration = graphDeviceGenerations.get(graph);
  if (
    graphDeviceGeneration !== undefined &&
    deviceScope !== undefined &&
    graphDeviceGeneration !== deviceScope.generation
  ) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the compiled frame graph belongs to the active device generation',
        hint: 'discard the stale graph and rebuild it from the retained logical frame plan',
        detail: {
          error: {
            code: 'stale-frame-graph-generation',
            message: `graph=${graphDeviceGeneration}; current=${deviceScope.generation}`,
          },
        },
      }),
    );
    return { kind: 'rejected', stage: 'execute' };
  }
  const capturedGeneration = deviceScope?.generation;
  const submission: GraphSubmission = {
    frame: renderSubmission(renderWorldFor(internals)).frame,
    graph,
    timing: timingCapture,
    passTiming: passTimingCapture,
    gi: 'gi' in (resolvedFrameHooks ?? {}) ? resolvedFrameHooks?.gi : undefined,
    onAccepted: () => {
      acceptGtaoHistory(frameState);
      resolvedFrameHooks?.onSubmitted?.();
    },
    submitted: false,
    rejectedStage: undefined,
    settled: false,
  };
  frameState.graphSubmission = submission;

  const execute = () => {
    const graphCapture = frameState.graphTargetCapture;
    const replayPassNames = graphCapture?.replayPassNames;
    const unsupportedCaptureKind =
      graphCapture !== undefined &&
      graphCapture.kind !== undefined &&
      graphCapture.kind !== 'target-copy' &&
      graphCapture.kind !== 'pass-replay';
    if (unsupportedCaptureKind || replayPassNames !== undefined) {
      if (graphCapture === undefined) return { ok: false, stage: 'execute' };
      const availablePassNames = graph.inspect().passes.map((pass) => pass.name);
      const replay = executeGraphTargetReplay({
        capture: graphCapture,
        replayPassNames,
        unsupportedCaptureKind,
        availablePassNames,
        graphTargetAccess: frameState.compiledFrameGraph?.targets,
        getTextureIdentity,
        runPass,
        executeInitial: () =>
          graph.execute(executionFrame, runPass, graphInstrumentation, pendingAtomicPasses),
        executeReplay: (replayRunner) =>
          graph.execute(
            { ...executionFrame, nativePassNames: undefined },
            replayRunner,
            undefined,
            pendingAtomicPasses,
          ),
        reportFailure: (reason, passNames) => {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected:
                'the requested graph target replay pass selection is valid and executes once',
              hint: 'inspect replayPassNames against the compiled graph pass roster',
              detail: {
                error: {
                  code: 'graph-target-capture-failed',
                  message: JSON.stringify({
                    target: graphCapture.kind === 'pass-replay' ? undefined : graphCapture.name,
                    replayPassNames,
                    availablePassNames: passNames,
                    reason,
                  }),
                },
              },
            }),
          );
        },
      });
      if (!replay.ok) {
        if (replay.stage === 'initial') {
          passTimingCapture?.abort({ code: replay.error.code });
          internals.errorRegistry.fire(replay.error);
        } else if (replay.stage === 'replay') {
          internals.errorRegistry.fire(replay.error);
        }
        return { ok: false, stage: 'execute' };
      }
    } else {
      const executed = graph.execute(
        executionFrame,
        runPass,
        graphInstrumentation,
        pendingAtomicPasses,
      );
      if (!executed.ok) {
        passTimingCapture?.abort({ code: executed.error.code });
        internals.errorRegistry.fire(executed.error);
        return { ok: false, stage: 'execute' };
      }
    }
    if (pendingAtomicPasses !== undefined)
      for (const plan of acceptedFeaturePlans) {
        if (plan.plan.submission !== 'atomic') continue;
        const projected = getRenderFeaturePlanExecutionProjection(plan)?.passes;
        let byName: Map<string, NonNullable<typeof projected>[number]> | undefined;
        let missing: string[] | undefined;
        for (let i = 0; i < plan.plan.passes.length; i++) {
          const pass = plan.plan.passes[i] as (typeof plan.plan.passes)[number];
          let actual = projected?.[i];
          if (projected !== undefined && actual?.name !== pass.name) {
            byName ??= new Map(projected.map((candidate) => [candidate.name, candidate]));
            actual = byName.get(pass.name);
          }
          if (
            pendingAtomicPasses.has(pass.name) ||
            actual?.enabled === false ||
            ((pass.kind === 'raster' || pass.kind === 'shadow-caster') &&
              pass.draws.length > 0 &&
              (actual?.graphics?.draws.every((draw) => draw.enabled === false) ?? true))
          ) {
            missing ??= [];
            missing.push(pass.name);
          }
        }
        if (missing !== undefined) {
          internals.errorRegistry.fire(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'all passes of an atomic Feature work encode before submission',
              hint: 'restore the omitted producer work and retry the entire frame',
              detail: {
                error: {
                  code: 'atomic-feature-work-incomplete',
                  message: JSON.stringify({
                    featureIdentity: plan.featureIdentity,
                    scope: plan.scope,
                    missing,
                  }),
                },
              },
            }),
          );
          return { ok: false, stage: 'execute' };
        }
      }
    if (internals.observationFrameId !== undefined)
      internals.observationCaptureOwner?.recordGraph(internals.observationFrameId, graphGeneration);
    const afterGraphExecute = resolvedFrameHooks?.afterGraphExecute;
    if (afterGraphExecute !== undefined) {
      const recorded = afterGraphExecute();
      if (!recorded.ok) {
        internals.errorRegistry.fire(recorded.error);
        return { ok: false, stage: 'execute' };
      }
    }
    return { ok: true, value: undefined };
  };
  const finish = () => {
    const drawStorage = (frame as _InternalRenderPipelineContext).pipelineState.meshStorageBuffer;
    if (drawStorage !== undefined) flushMeshDrawUploads(internals.device.queue, drawStorage);
    const graphCapture = frameState.graphTargetCapture;
    frameState.graphTargetCapture = undefined;
    if (graphCapture !== undefined && graphCapture.kind !== 'pass-replay')
      encodeGraphTargetCapture(internals, frameState, encoder, graphCapture);
    encodeReflectionFallbackReadback(frameState, encoder);
    recordContext(internals).encodeRenderTargetReadbacks?.(encoder, readbackLayers);
    const stagedGpuState = frameState.temporalGpuState;
    if (stagedGpuState !== undefined && !hasPendingTemporalGpuSubmit(stagedGpuState)) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'an admitted temporal producer stages a history write before submit',
          hint: 'retry the frame after the TAA or CloudLayer history pass has encoded successfully',
        }),
      );
      return { ok: false, stage: 'finish' };
    }
    const resolved = timingCapture?.resolve(encoder);
    if (resolved !== undefined && !resolved.ok) {
      timingCapture?.discard();
      return { ok: false, stage: 'finish' };
    }
    recordViewFeatureGraph(renderWorldFor(internals), frameState.featureGraphReceipt, graph);
    return { ok: true, value: undefined };
  };
  const names = executionFrame.nativePassNames;
  const namesStart = names?.length ?? 0;
  frameState.currentOcclusionDepth?.begin();
  frameState.currentTransmissionTargets?.begin();
  frameState.weightedTransparencyTargets?.begin();
  frameState.ordinaryMaterialDepth?.begin();
  let executed: ReturnType<typeof execute>;
  try {
    executed = execute();
  } finally {
    frameState.shadowRasterRows?.finishFrame();
    frameState.currentOcclusionDepth?.finish();
    frameState.currentTransmissionTargets?.finish();
    frameState.weightedTransparencyTargets?.finish();
    frameState.ordinaryMaterialDepth?.finish();
  }
  if (!executed.ok) {
    if (names !== undefined) names.length = namesStart;
    submission.rejectedStage = 'execute';
    return { kind: 'rejected', stage: 'execute' };
  }
  const finished = finish();
  if (!finished.ok) {
    submission.rejectedStage = 'finish';
    return { kind: 'rejected', stage: 'finish' };
  }
  const fences =
    capturedGeneration === undefined && resolvedFrameHooks?.generationFence === undefined
      ? {}
      : {
          generationFence: {
            capturedGeneration: 0,
            // Read the owner at submit time. Recovery publishes a replacement
            // scope synchronously between finish and submit; retaining the
            // entry scope here would make that race invisible to the fence.
            currentGeneration: () => {
              const content = resolvedFrameHooks?.generationFence;
              return (capturedGeneration === undefined ||
                recordContext(internals).deviceScope?.generation === capturedGeneration) &&
                (content === undefined ||
                  content.currentGeneration() === content.capturedGeneration)
                ? 0
                : -1;
            },
          },
        };
  const work: RecordedView = {
    beforeSubmit: internals.beforeSubmit,
    ...(fences.generationFence === undefined
      ? {}
      : {
          rejectionCause: () => resolvedFrameHooks?.generationFence?.rejectionCause?.(),
          isCurrent: () =>
            fences.generationFence.currentGeneration() ===
            fences.generationFence.capturedGeneration,
        }),
    ...(onSubmitted === undefined && resolvedFrameHooks?.onSubmittedWork === undefined
      ? {}
      : {
          onSubmittedWork: (done: Promise<void>) => {
            const failures: unknown[] = [];
            try {
              onSubmitted?.(done);
            } catch (cause) {
              failures.push(cause);
            }
            try {
              resolvedFrameHooks?.onSubmittedWork?.(done);
            } catch (cause) {
              failures.push(cause);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
              throw new AggregateError(failures, 'Graph submitted-work observers failed');
          },
        }),
    reportError: (error) => internals.errorRegistry.fire(error),
  };
  return { kind: 'encoded', value: { internals, frameState, submission, work } };
}

/** Settle the encoded graph from the one physical submission outcome. */
export function settleEncodedFrameGraph(
  encoded: EncodedFrameGraph,
  result: RendererFrameStageResult<void>,
): boolean {
  const accepted = result.ok && encoded.work.isCurrent?.() !== false;
  if (accepted) encoded.submission.submitted = true;
  else encoded.submission.rejectedStage = result.ok ? 'submit' : result.stage;
  if (encoded.internals.viewEntity === undefined) {
    if (accepted) commitGraphSubmission(encoded.internals, encoded.submission);
    else abortGraphSubmission(encoded.frameState, encoded.submission);
    encoded.frameState.graphSubmission = undefined;
  }
  return accepted;
}
