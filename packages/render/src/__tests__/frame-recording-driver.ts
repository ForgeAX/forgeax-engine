// Low-level stage fixtures use production encode/submit kernels. Renderer acceptance drives World systems directly.

import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RhiCommandEncoder, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  drainFramePreparation,
  type FramePreparation,
  type FramePreparationCheckpoint,
  type RecordedView,
} from '../assembly/frame-recording';
import type {
  RendererFrameStageResult,
  RendererFrameTransactionSteps,
} from '../assembly/renderer-frame-transaction';
import type { ExtractedCloudLayer } from '../cloud/extract';
import { RendererOperationError } from '../errors/render';
import type { FogFrame } from '../extract/environment';
import type { RenderFeatureFrameBatch } from '../features/host';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  type CubeCaptureFrameInput,
  compileDirectPreparedGraph,
  createFrameRecordingAttempt,
  encodePreparedFrameCaptures,
  encodePreparedViewGraph,
  type FrameRecordingInput,
  type GpuDrivenRecordInput,
  type PreparedFrameGraph,
  prepareFrameGraphInputs,
  rejectFeaturePlan,
  releaseFrameRecordingAttempt,
  resolveQueuedFrameTemporal,
  sealCompiledViewGraph,
  settlePreparedViewGraph,
  stageFrameCaptureCompletion,
  stageFrameRecordingResources,
  type ViewGraphSealOutcome,
} from '../record/frame';
import type {
  BindGroupCounts,
  DispatchCounts,
  RenderFrameState,
  ValidatedRenderable,
} from '../record/frame-snapshot';
import type { RenderableDrawReceipt } from '../record/gpu-draw-receipts';
import type { GpuTimingCapture } from '../record/gpu-timing';
import type { ViewGraphCompileOutcome } from '../record/graph-adoption';
import { MaterialUniformRecording } from '../record/material-uniforms';
import type { RecordProfileRunner, RenderSystemInternals } from '../record/render-context';
import {
  compileViewGraph,
  type GraphCompileInput,
  recordCompiledFrameGraph,
  settleEncodedFrameGraph,
} from '../record/typed-frame-graph';
import type { CameraSnapshot } from '../render-contract';
import type {
  DispatchList,
  ExtractedVolumetricFog,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import { recordFailureError } from '../render-system-record-attempt';
import type { FrameList } from '../scene/frame-list';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import { captureGraphOutcome, prepareCaptureGraphs } from '../world/capture-graph-systems';
import {
  encodeSharedFeatureGraph,
  sharedFeatureGraphEncoded,
  stageSharedFeatureGraph,
} from '../world/feature-graph-systems';
import { featureFrameOutcome } from '../world/feature-systems';
import {
  beginFrameSubmission,
  encodeFramePresentation,
  frameSubmitOutcome,
  submitEncodedFrame,
} from '../world/frame-submit-systems';
import {
  stagePreparedViewGraph,
  viewGraphEncodingOutcome,
  viewGraphSealOutcome,
} from '../world/graph-seal-systems';
import {
  awaitsRenderRecord,
  RENDER_GRAPH_COMPILE_SYSTEM,
  stageViewGraphCompile,
  ViewGraphCandidate,
  type ViewGraphCandidateSlot,
} from '../world/graph-systems';
import { closeFrameEncoder, frameEncoder, renderFrameEncoder } from '../world/record-systems';
import type { ViewLights } from '../world/render-lights';
import {
  publishRenderSubmission,
  renderSubmission,
  renderWorldFor,
  runRenderQueue,
  runRenderRecord,
} from '../world/render-world';
import type { ViewGraphCompileRequest } from '../world/view-graph-input';

export interface SharedWorkRequest {
  readonly kind: 'shared-work';
  readonly internals: RenderSystemInternals;
  /** Whether `render-capture-schedule` routed the frame's Feature scene inputs to this view. */
  readonly sceneInputs: boolean;
}
/**
 * A view may pause once its CPU preparation is done and before it acquires the
 * swap-chain texture. A cooperative driver yields the Worker task there, so an
 * older frame's queue completion can return its publication credit while this
 * frame records. Synchronous drains resume immediately.
 */
export type FrameRecordingCheckpoint = { readonly kind: 'checkpoint' };
export const FRAME_RECORDING_CHECKPOINT: FrameRecordingCheckpoint = Object.freeze({
  kind: 'checkpoint',
});
/**
 * A view staged its culled draws on its Render World entity. The shared
 * submission runs that World's RenderQueue once, after every view reached this
 * barrier and before any view prepares Features or records GPU work.
 */
export interface FrameRecordingQueue {
  readonly kind: 'queue';
  readonly world: World;
}
/**
 * A view staged its graph compile input on its Render World entity. The shared
 * submission runs that World's RenderRecord once, after every view reached
 * this barrier and before any view encodes; `render-graph-compile` writes the
 * outcome the view then adopts.
 */
export interface FrameRecordingCompile {
  readonly kind: 'compile';
  readonly world: World;
}
export type FrameRecording<T = boolean> = Generator<
  | RecordedView
  | SharedWorkRequest
  | FrameRecordingCheckpoint
  | FrameRecordingQueue
  | FrameRecordingCompile
  | { readonly kind: 'scene-inputs' },
  T,
  RendererFrameStageResult<void>
>;

/** Submit the existing generation-fenced barrier while source or GPU work prepares.
 * No scene/capture/history state is published by a pending receipt. */
export function* recordPreparationBarrier(internals: RenderSystemInternals): FrameRecording {
  const generation = internals.deviceScope.generation;
  const pending = yield {
    presentation: 'pending',
    beforeSubmit: internals.beforeSubmit,
    isCurrent: () => internals.deviceScope.generation === generation,
    reportError: (error: RhiError) => internals.errorRegistry.fire(error),
  };
  return pending.ok;
}

export function* recordFrameTransaction<T>(
  steps: Omit<RendererFrameTransactionSteps<T>, 'submit'>,
  work: RecordedView,
): FrameRecording<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  const built = steps.build();
  if (!built.ok) {
    steps.abort?.({ stage: 'build' });
    return { ok: false };
  }
  const executed = steps.execute(built.value);
  if (!executed.ok) {
    steps.abort?.({ stage: 'execute' });
    return { ok: false };
  }
  const finished = steps.finish(built.value);
  if (!finished.ok) {
    steps.abort?.({ stage: 'finish' });
    return { ok: false };
  }
  const fence = steps.generationFence;
  const submitted = yield {
    ...work,
    ...(fence === undefined
      ? {}
      : {
          isCurrent: () => fence.currentGeneration() === fence.capturedGeneration,
          rejectionCause: () => fence.rejectionCause?.(),
        }),
  };
  if (
    !submitted.ok ||
    (steps.generationFence !== undefined &&
      steps.generationFence.currentGeneration() !== steps.generationFence.capturedGeneration)
  ) {
    steps.abort?.({ stage: submitted.ok ? 'submit' : submitted.stage });
    return { ok: false };
  }
  steps.commit(built.value);
  return { ok: true, value: built.value };
}

const RECORDING_CHECKPOINT: FramePreparationCheckpoint = Object.freeze({
  kind: 'recording-checkpoint',
});
const RESUMED: RendererFrameStageResult<void> = Object.freeze({ ok: true, value: undefined });

type FrameRecordingStep = IteratorResult<
  | RecordedView
  | SharedWorkRequest
  | FrameRecordingCheckpoint
  | FrameRecordingQueue
  | FrameRecordingCompile
  | { readonly kind: 'scene-inputs' },
  boolean
>;

/** One submission's owners: its Render World and device, and the Renderer around it. */
export interface FrameSubmissionInput {
  /** The Render World whose RenderRecord opens the submission's encoder. */
  readonly world: World;
  /** The device every recording of the submission writes on. */
  readonly device: RhiDevice;
  /** Encode the composite after every view recorded; false rejects the frame. */
  readonly afterEncode?: ((encoder: RhiCommandEncoder) => boolean) | undefined;
  /** The Renderer owning the submission; it publishes the frame's `RenderSubmission`. */
  readonly rendererInternals?: RenderSystemInternals | undefined;
  /** Whether the submission still belongs to the live Renderer. */
  readonly isCurrent?: (() => boolean) | undefined;
  /**
   * The submission submits its encoder even when no view recorded work: a
   * composed or capture frame still clears and submits. Requires `rendererInternals`.
   */
  readonly shared?: boolean | undefined;
}

/** Resume the same coordinator without exposing or copying its frame-owned state. */
export function* prepareFrameSubmission(
  input: FrameSubmissionInput,
  recordings: readonly FrameRecording[],
): FramePreparation {
  return yield* new RecordingHarness(input, recordings).run();
}

/**
 * One frame's submission: runs RenderRecord to open the frame encoder, admits
 * every view, records shared work once, then finishes and submits that encoder once.
 */
class RecordingHarness {
  private readonly pending: FrameRecording[] = [];
  /** Views paused at their recording checkpoint; finalization closes them. */
  private readonly suspended = new Set<FrameRecording>();
  private readonly sharedRequests: { recording: FrameRecording; request: SharedWorkRequest }[] = [];
  /** Views without shared work paused at their compile barrier, in view order. */
  private readonly compiling: FrameRecording[] = [];
  /** Where each shared-work view stopped after its CPU prologue: its compile barrier or a final step. */
  private readonly sharedSteps = new Map<FrameRecording, FrameRecordingStep>();
  private sceneInputsReady = true;
  private work: RecordedView | undefined;
  private readonly currentChecks: RecordedView[] = [];
  private readonly submittedWork: ((completed: Promise<void>) => void)[] = [];
  private result: RendererFrameStageResult<void> = { ok: false, stage: 'execute' };
  private readonly failures: unknown[] = [];
  private completion: Promise<void> | undefined;
  /** The queue that accepted the frame's submission. */
  private submittedQueue: RhiDevice['queue'] | undefined;

  private readonly framePassNames: string[] = [];

  private readonly world: World;
  private readonly device: RhiDevice;
  private readonly afterEncode: FrameSubmissionInput['afterEncode'];
  private readonly rendererInternals: RenderSystemInternals | undefined;
  private readonly isCurrent: (() => boolean) | undefined;

  constructor(
    private readonly input: FrameSubmissionInput,
    private readonly recordings: readonly FrameRecording[],
  ) {
    this.world = input.world;
    this.device = input.device;
    this.afterEncode = input.afterEncode;
    this.rendererInternals = input.rendererInternals;
    this.isCurrent = input.isCurrent;
    if (this.rendererInternals !== undefined)
      this.rendererInternals.framePassNames = this.framePassNames;
  }

  *run(): FramePreparation {
    const uniforms = new MaterialUniformRecording();
    const operation = this.encodeAndSubmit();
    let releaseHold: (() => void) | undefined;
    try {
      try {
        let next = uniforms.run(() => operation.next());
        while (!next.done) {
          // A paused frame has captured live resources; completion-driven
          // releases wait until this frame submitted or was abandoned.
          releaseHold ??= this.holdCompletions();
          yield next.value;
          next = uniforms.run(() => operation.next());
        }
      } catch (cause) {
        this.failures.push(cause);
      }
    } finally {
      try {
        this.capture(() => uniforms.run(() => operation.return(false)));
        this.capture(() => uniforms.complete());
        // The accepted authority is published before any recording settles, so its commits read it.
        this.capture(() => this.publishSubmission());
        this.finalizeRecordings();
        this.abortFeatureTiming();
        closeFrameEncoder(this.world);
      } finally {
        // Held completions settle after every owner of this frame has settled.
        releaseHold?.();
      }
      this.throwFinalizationFailure();
    }
    return this.result.ok;
  }

  private holdCompletions(): () => void {
    return this.device.queue.holdCompletions?.() ?? (() => {});
  }

  /** Run one finalizer, collecting its failure so siblings still run. */
  private capture(action: () => void): void {
    try {
      action();
    } catch (cause) {
      this.failures.push(cause);
    }
  }

  private admitWork(recording: FrameRecording, next: FrameRecordingStep): boolean {
    if (next.done) return next.value;
    if ('kind' in next.value)
      throw new Error('A render view yielded more than one shared-work request');
    this.pending.push(recording);
    this.work = next.value;
    if (next.value.isCurrent !== undefined) this.currentChecks.push(next.value);
    if (next.value.onSubmittedWork !== undefined)
      this.submittedWork.push(next.value.onSubmittedWork);
    return true;
  }

  private *encodeAndSubmit(): FramePreparation {
    if (this.isCurrent?.() === false) return false;
    // Outside an open frame there is no Queue phase: Record runs before any view records.
    const framed = renderSubmission(this.world).open;
    if (!framed && !this.record()) return false;
    if (!(yield* this.startRecordings())) return false;
    const first = this.sharedRequests[0]?.request;
    const batch = first === undefined ? undefined : this.stageSharedFeatures(first);
    if (batch !== undefined) {
      // All views and their sealed Feature batch still belong to this one
      // coordinator. No capture or shared/view graph is resumed before the fence.
      yield { kind: 'features-prepared' };
      if (this.isCurrent?.() === false) return false;
      if (framed) yield* this.advanceSharedWorkToCompile();
    }
    // Every view reached its compile barrier: RenderRecord opens the encoder and compiles them.
    if (framed && !this.record()) return false;
    if (!(yield* this.resumeCompiled())) return false;
    if (first !== undefined && batch !== undefined) {
      if (!(yield* this.resumeSharedWork())) return false;
    }
    // A shared frame submits through its Renderer, after every view recorded.
    const work = this.sharedWork() ?? this.work;
    const encoder = this.openEncoder();
    if (work === undefined || encoder === undefined) return false;
    if (this.afterEncode?.(encoder) === false) return false;
    return this.finishAndSubmit(work, encoder, this.rendererInternals ?? first?.internals);
  }

  /**
   * Run RenderRecord. A failed encoder open fails the submission with its
   * closed outcome and reaches the Renderer's `onError` before any view
   * records, so the last-known-good frame state is what observers see.
   */
  private record(): boolean {
    const ran = runRenderRecord(this.world, {
      device: this.device,
      frameId: this.rendererInternals?.observationFrameId ?? renderSubmission(this.world).frame,
    });
    const state = renderFrameEncoder(this.world);
    if (ran.ok && state.kind === 'open') return true;
    let failure: unknown = new Error('RenderRecord opened no frame encoder');
    if (!ran.ok) failure = ran.error;
    else if (state.kind === 'failed') failure = state.error;
    this.failures.push(failure);
    this.rendererInternals?.errorRegistry.fire(recordFailureError(failure));
    return false;
  }

  private openEncoder(): RhiCommandEncoder | undefined {
    const state = renderFrameEncoder(this.world);
    return state.kind === 'open' ? state.encoder : undefined;
  }

  /** A shared frame submits through its Renderer, even when no view recorded work. */
  private sharedWork(): RecordedView | undefined {
    const internals = this.rendererInternals;
    if (this.input.shared !== true || internals === undefined) return undefined;
    return {
      beforeSubmit: internals.beforeSubmit,
      reportError: (error: RhiError) => internals.errorRegistry.fire(error),
    };
  }

  /**
   * Advance each view to its first barrier. Views that staged queue work wait
   * for the frame's one RenderQueue run; then shared-work requests and compile
   * barriers separate from encoded work in view order. A started view stays
   * suspended until it is classified, so an early rejection still closes it.
   */
  private *startRecordings(): FramePreparation {
    const steps: FrameRecordingStep[] = [];
    const queued = yield* this.advanceToQueue(steps);
    if (queued) {
      for (const [index, recording] of this.recordings.entries()) {
        const step = steps[index];
        if (step === undefined || step.done || !('kind' in step.value)) continue;
        if (step.value.kind !== 'queue') continue;
        steps[index] = yield* this.advance(recording, RESUMED);
        this.suspended.add(recording);
      }
    }
    return this.classifyStarted(steps);
  }

  /** Advance every view to its first barrier and run the one RenderQueue its queue barriers wait on. */
  private *advanceToQueue(steps: FrameRecordingStep[]): FramePreparation {
    let queue: World | undefined;
    for (const recording of this.recordings) {
      const next = yield* this.advance(recording, undefined);
      this.suspended.add(recording);
      steps.push(next);
      if (next.done || !('kind' in next.value) || next.value.kind !== 'queue') continue;
      if (queue !== undefined && queue !== next.value.world)
        throw new Error('Renderer views must queue into one Render World');
      queue = next.value.world;
    }
    if (queue === undefined) return false;
    if (queue !== this.world)
      throw new Error('Renderer views must queue into the submission Render World');
    runRenderQueue(queue);
    return true;
  }

  /** Separate shared-work requests from encoded work, in view order. */
  private classifyStarted(steps: readonly FrameRecordingStep[]): boolean {
    for (const [index, recording] of this.recordings.entries()) {
      const next = steps[index] as FrameRecordingStep;
      this.suspended.delete(recording);
      if (!next.done && 'kind' in next.value && next.value.kind === 'compile') {
        // A view paused at its compile barrier resumes after RenderRecord.
        this.suspended.add(recording);
        this.compiling.push(recording);
      } else if (!next.done && 'kind' in next.value) {
        if (next.value.kind !== 'shared-work')
          throw new Error('Scene inputs must follow the shared-work barrier');
        this.sharedRequests.push({ recording, request: next.value });
      } else if (!this.admitWork(recording, next)) return false;
    }
    return true;
  }

  /** The batch RenderPrepare sealed; every shared-work view read its result from it. */
  private stageSharedFeatures(first: SharedWorkRequest): RenderFeatureFrameBatch {
    for (const { request } of this.sharedRequests)
      request.internals.framePassNames = this.framePassNames;
    const outcome = featureFrameOutcome(renderWorldFor(first.internals));
    if (outcome?.kind !== 'sealed')
      throw new Error('Renderer shared work requires the Feature batch RenderPrepare sealed');
    stageSharedFeatureGraph(this.world, first.internals);
    return outcome.batch;
  }

  /**
   * Run each shared-work view's CPU prologue up to its compile barrier, or to
   * its final step (a pending preparation barrier encodes nothing). A view
   * yielding any other barrier first would run it before RenderRecord.
   */
  private *advanceSharedWorkToCompile(): FramePreparation<void> {
    for (const { recording } of this.sharedRequests) {
      const step = yield* this.advance(recording, RESUMED);
      this.sharedSteps.set(recording, step);
      if (!step.done && 'kind' in step.value && step.value.kind !== 'compile')
        throw new Error(`A shared-work view yielded ${step.value.kind} before its compile barrier`);
    }
  }

  /** Resume the views without shared work from their compile barrier, in view order. */
  private *resumeCompiled(): FramePreparation {
    for (const recording of this.compiling) {
      this.suspended.delete(recording);
      if (!this.admitWork(recording, yield* this.advance(recording, RESUMED))) return false;
    }
    return true;
  }

  /**
   * A shared-work view's next step: resumed past its compile barrier, or the
   * final step it already reached. Outside an open frame no prologue ran ahead.
   */
  private *resumeSharedStep(
    recording: FrameRecording,
  ): Generator<FramePreparationCheckpoint, FrameRecordingStep, void> {
    const step = this.sharedSteps.get(recording);
    if (step === undefined || (!step.done && 'kind' in step.value && step.value.kind === 'compile'))
      return yield* this.advance(recording, RESUMED);
    return step;
  }

  /** Record the scene inputs `render-capture-schedule` routed, the shared Feature graph, then resume views. */
  private *resumeSharedWork(): FramePreparation {
    if (renderSubmission(this.world).open) {
      this.sceneInputsReady = sharedFeatureGraphEncoded(this.world);
      for (const { recording } of this.sharedRequests) {
        if (this.pending.includes(recording)) continue;
        if (!this.admitWork(recording, yield* this.resumeSharedStep(recording))) return false;
      }
      return true;
    }
    const featureRequests = this.sharedRequests;
    const sceneRecorder = featureRequests.find(({ request }) => request.sceneInputs);
    if (sceneRecorder !== undefined) {
      if (!(yield* this.resumeSceneInputRecorder(sceneRecorder.recording))) return false;
    }
    const encoder = this.openEncoder();
    if (encoder === undefined) return false;
    if (this.sceneInputsReady) {
      const encoded = encodeSharedFeatureGraph(this.world, encoder);
      if (!encoded.ok) throw encoded.error;
    }
    for (const { recording } of featureRequests) {
      if (this.pending.includes(recording)) continue;
      if (!this.admitWork(recording, yield* this.resumeSharedStep(recording))) return false;
    }
    return true;
  }

  /** Resume one view, forwarding each of its recording checkpoints to the driver. */
  private *advance(
    recording: FrameRecording,
    input: RendererFrameStageResult<void> | undefined,
  ): Generator<FramePreparationCheckpoint, FrameRecordingStep, void> {
    let next = input === undefined ? recording.next() : recording.next(input);
    while (!next.done && 'kind' in next.value && next.value.kind === 'checkpoint') {
      this.suspended.add(recording);
      yield RECORDING_CHECKPOINT;
      this.suspended.delete(recording);
      next = recording.next(RESUMED);
    }
    return next;
  }

  private *resumeSceneInputRecorder(recording: FrameRecording): FramePreparation {
    const ready = yield* this.resumeSharedStep(recording);
    if (!ready.done && !('kind' in ready.value) && ready.value.presentation === 'pending') {
      // Native scene/shadow PSOs can still be preparing. This view already
      // reached its completion barrier, so submit that work and abort the
      // dependent Feature batch without publishing an unwritten scene input.
      this.sceneInputsReady = false;
      return this.admitWork(recording, ready);
    }
    if (ready.done || !('kind' in ready.value) || ready.value.kind !== 'scene-inputs')
      throw new Error('Scene input capture did not reach the shared Feature barrier');
    return true;
  }

  private finishAndSubmit(
    work: RecordedView,
    encoder: RhiCommandEncoder,
    timingOwner: RenderSystemInternals | undefined,
  ): boolean {
    beginFrameSubmission(this.world);
    const outcome = frameSubmitOutcome(this.world);
    encodeFramePresentation(
      this.world,
      {
        device: this.device,
        frameId: renderSubmission(this.world).frame,
        rendererInternals: timingOwner,
      },
      encoder,
    );
    const accepted = submitEncodedFrame(
      this.world,
      {
        device: this.device,
        frameId: renderSubmission(this.world).frame,
        rendererInternals: timingOwner,
        generation: timingOwner?.deviceScope?.generation ?? 0,
        shared: this.input.shared === true,
        isCurrent: this.isCurrent,
      },
      [
        {
          ...work,
          isCurrent: () => this.currentChecks.every((view) => view.isCurrent?.() !== false),
          rejectionCause: () =>
            this.currentChecks.find((view) => view.isCurrent?.() === false)?.rejectionCause?.(),
          onSubmittedWork: (completed) => {
            this.completion = completed;
            for (const track of this.submittedWork) this.capture(() => track(completed));
          },
        },
      ],
      outcome,
    );
    this.result = outcome.result;
    this.submittedQueue = accepted ? this.device.queue : undefined;
    this.completion = renderSubmission(this.world).completion;
    this.failures.push(...outcome.failures);
    return accepted;
  }

  /** Prepare mip uploads and the GPU timing tail, then finish the shared encoder. */

  private finalizeRecordings(): void {
    for (const recording of this.pending) this.capture(() => recording.next(this.result));
    for (const recording of this.suspended) {
      if (this.pending.includes(recording)) continue;
      this.capture(() => recording.return(false));
    }
    this.suspended.clear();
    for (const { recording } of this.sharedRequests) {
      if (this.pending.includes(recording)) continue;
      this.capture(() => recording.return(false));
    }
  }

  /** The frame's outcome for its Render World's Commit and Cleanup systems. */
  private publishSubmission(): void {
    if (this.rendererInternals === undefined) return;
    const queue = this.result.ok ? this.submittedQueue : undefined;
    publishRenderSubmission(renderWorldFor(this.rendererInternals), {
      accepted: queue !== undefined && this.sceneInputsReady,
      completion:
        queue === undefined ? undefined : (this.completion ?? queue.onSubmittedWorkDone()),
      creditCompletion: queue?.onSubmittedWorkDoneUnheld?.(),
      generation: this.rendererInternals.deviceScope?.generation ?? 0,
    });
  }

  /**
   * A Feature frame no submission accepted records no GPU timing. Its
   * settlement is `render-feature-commit`/`render-feature-abort`.
   */
  private abortFeatureTiming(): void {
    if (this.result.ok && this.sceneInputsReady) return;
    const owner = this.rendererInternals ?? this.sharedRequests[0]?.request.internals;
    if (owner === undefined || featureFrameOutcome(renderWorldFor(owner))?.kind !== 'sealed')
      return;
    const stage = this.result.ok ? 'scene-input-pending' : this.result.stage;
    this.capture(() => owner.gpuPassTimingCapture?.abort({ code: stage }));
  }

  /** Iterator cancellation must surface collected cleanup failures and rejected submits. */
  private throwFinalizationFailure(): void {
    if (this.failures.length === 1) throw this.failures[0];
    if (this.failures.length > 1) {
      // Aggregate original and sibling cleanup failures before cancellation exits.
      throw new AggregateError(this.failures, 'Renderer view finalization failed');
    }
    if (!this.result.ok && this.result.stage === 'submit') {
      // Reject physical submit failures on every iterator exit.
      const cause = frameSubmitOutcome(this.world).rejectionCause;
      throw new RendererOperationError('frame-submit-rejected', {
        operation: 'draw',
        stage: 'submit',
        accepted: false,
        ...(cause === undefined ? {} : { cause }),
      });
    }
  }
}

/** Encode every view, then finish and submit the one frame encoder exactly once. */
export function submitFrameRecordings(
  input: FrameSubmissionInput,
  recordings: readonly FrameRecording[],
): boolean {
  return drainFramePreparation(prepareFrameSubmission(input, recordings));
}

/** Profiling records active CPU segments, excluding other views at the barrier. */
export function* profileFrameRecording<T>(
  recording: FrameRecording<T>,
  run: <R>(action: () => R) => R,
): FrameRecording<T> {
  let next = run(() => recording.next());
  while (!next.done) {
    const submitted = yield next.value;
    next = run(() => recording.next(submitted));
  }
  return next.value;
}

export function recordFrame(...args: Parameters<typeof prepareFrameRecording>): boolean {
  const internals = args[0];
  return submitFrameRecordings({ world: renderWorldFor(internals), device: internals.device }, [
    prepareFrameRecording(...args),
  ]);
}

export function* prepareFrameRecording(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  cameras: CameraSnapshot[],
  lights: ViewLights,
  renderables: FrameList<RenderableSnapshot>,
  transparentDispatch: DispatchList,
  frameState: RenderFrameState,
  dispatchCounts: DispatchCounts,
  bindGroupCounts: BindGroupCounts,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  skybox: SkyboxSnapshot | undefined,
  postProcessParams: ReadonlyMap<string, Uint8Array>,
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): the
  // full worlds[] list passed to `renderer.draw`, indexed by
  // RenderableSnapshot.worldId so the record stage resolves each renderable's
  // mesh + material textures against the world it was extracted from (mirroring
  // the per-world extract stage). Optional + defaulting to `[world]` keeps the
  // pre-split single-world identity path (worldId always 0) byte-for-byte and
  // the existing unit-test callers (which pass a single mock world) valid.
  worlds: readonly RenderResourceScope[] = [world],
  profilePhase?: RecordProfileRunner,
  gpuDriven?: GpuDrivenRecordInput,
  renderReadLeases?: readonly RenderReadLease[],
  cubeCapture?: CubeCaptureFrameInput,
  environmentSignature = '',
  fogSignature = '',
  environmentReady = true,
  volumetricFog?: ExtractedVolumetricFog,
  timingCapture?: GpuTimingCapture,
  shadowCasterProjection?: PersistentShadowCasterProjection,
  shadowCasterWorldKeys?: readonly number[],
  onRenderableDraw?: (
    entry: Pick<ValidatedRenderable, 'source'>,
    submeshIndex?: number,
    receipt?: RenderableDrawReceipt,
  ) => void,
  analyticFog?: FogFrame,
  sampleTimeSeconds?: number,
  temporalReset = false,
  cloudLayer?: ExtractedCloudLayer,
  // Only Renderer passes the scalar from its private merged light record.
  // Raw/direct callers retain full capacity and their original getter reads.
  directionalShadowCascadeCount?: number,
  // Renderer extraction/receipt admission owns detached matrix inputs. Direct
  // helper calls retain their complete legacy observation and recording path.
  rendererRecording = false,
): FrameRecording {
  const input: FrameRecordingInput = {
    internals,
    world,
    cameras,
    lights,
    renderables,
    transparentDispatch,
    frameState,
    dispatchCounts,
    bindGroupCounts,
    skylight,
    skylightCount,
    skybox,
    postProcessParams,
    worlds,
    profilePhase,
    gpuDriven,
    renderReadLeases,
    cubeCapture,
    environmentSignature,
    fogSignature,
    environmentReady,
    volumetricFog,
    timingCapture,
    shadowCasterProjection,
    shadowCasterWorldKeys,
    onRenderableDraw,
    analyticFog,
    sampleTimeSeconds,
    temporalReset,
    cloudLayer,
    directionalShadowCascadeCount,
    rendererRecording,
  };
  const attempt = createFrameRecordingAttempt(volumetricFog);
  let graphEncoded = false;
  try {
    const prepared = prepareFrameGraphInputs(input, attempt);
    if (prepared.kind === 'rejected') return false;
    if (prepared.kind === 'pending') {
      attempt.submitted = yield* recordPreparationBarrier(internals);
      rejectFeaturePlan(prepared.featurePlan);
      return attempt.submitted;
    }
    const resumed = yield FRAME_RECORDING_CHECKPOINT;
    if (!resumed.ok) return false;
    const seal = yield* prepareViewGraphSeal(prepared);
    if (seal.kind === 'rejected') return false;
    if (seal.kind === 'failed') {
      internals.errorRegistry.fire(seal.error);
      return false;
    }
    const renderWorld = renderWorldFor(internals);
    const encoding =
      internals.viewEntity !== undefined && renderSubmission(renderWorld).open
        ? viewGraphEncodingOutcome(renderWorld, internals.viewEntity)
        : (() => {
            const captures = encodePreparedFrameCaptures(prepared, seal.value);
            return captures.kind === 'ready' ? encodePreparedViewGraph(prepared, seal) : captures;
          })();
    if (encoding.kind === 'pending') {
      const pending = yield* recordPreparationBarrier(internals);
      prepared.featureGraphCandidate?.onRejected?.();
      return pending;
    }
    if (encoding.kind === 'failed') throw encoding.cause;
    if (encoding.kind !== 'encoded') return false;
    graphEncoded = true;
    const result = yield encoding.value.kind === 'capture'
      ? encoding.value.work
      : encoding.value.encoded.work;
    return settlePreparedViewGraph(prepared, seal, encoding.value, result);
  } finally {
    stageFrameRecordingResources(internals, frameState, attempt);
    stageFrameCaptureCompletion(internals, frameState, attempt, cubeCapture, graphEncoded);
    releaseFrameRecordingAttempt(internals, frameState, attempt, lights, cubeCapture);
  }
}

type CompiledFrameGraphArgs = Parameters<typeof recordCompiledFrameGraph>;

export function executeCompiledFrameGraph(
  internals: CompiledFrameGraphArgs[0],
  frameState: CompiledFrameGraphArgs[1],
  frame: CompiledFrameGraphArgs[2],
  ...rest: CompiledFrameGraphArgs extends [unknown, unknown, unknown, unknown, ...infer R]
    ? R
    : never
): boolean {
  const world = renderWorldFor(internals);
  function* record(): FrameRecording {
    const encoded = recordCompiledFrameGraph(
      internals,
      frameState,
      frame,
      frameEncoder(world),
      ...rest,
    );
    if (encoded.kind === 'rejected') return false;
    const result = yield encoded.value.work;
    return settleEncodedFrameGraph(encoded.value, result);
  }
  return submitFrameRecordings({ world, device: internals.device }, [record()]);
}

export function* prepareViewGraphSeal(
  prepared: PreparedFrameGraph,
): FrameRecording<ViewGraphSealOutcome> {
  const { internals } = prepared;
  const world = renderWorldFor(internals);
  const entity = internals.viewEntity;
  if (entity === undefined || !awaitsRenderRecord(world)) {
    const {
      frameState,
      pipelineState,
      cubeCapture,
      cubeCaptureWork,
      graphShadowMapSize,
      terrainReceivers,
    } = prepared;
    const captures = prepareCaptureGraphs({
      internals,
      frameState,
      pipelineState,
      capture: cubeCapture,
      work: cubeCaptureWork,
      shadowMapSize: graphShadowMapSize,
      terrainReceivers,
    });
    prepared.attempt.ownsCaptureGraphs = captures !== undefined;
    return sealCompiledViewGraph(
      prepared,
      prepared.captureOnly ? undefined : compileDirectPreparedGraph(prepared),
      captures ?? captureGraphOutcome(internals),
      resolveQueuedFrameTemporal(prepared),
    );
  }
  stagePreparedViewGraph(prepared);
  yield { kind: 'compile', world };
  return viewGraphSealOutcome(world, entity);
}

function compileMissingError(): RendererOperationError<'graph-build-failed'> {
  return new RendererOperationError('graph-build-failed', {
    operation: 'draw',
    cause: {
      code: 'graph-compile-missing',
      expected: `${RENDER_GRAPH_COMPILE_SYSTEM} compiles the recorded view in RenderRecord`,
      hint: 'keep the RenderRecord graph systems registered',
      detail: { system: RENDER_GRAPH_COMPILE_SYSTEM },
    },
  });
}

export function* awaitRenderRecord(internals: RenderSystemInternals): FrameRecording<void> {
  const world = renderWorldFor(internals);
  if (internals.viewEntity !== undefined && awaitsRenderRecord(world))
    yield { kind: 'compile' as const, world };
}

export function* compileRecordedViewGraph(
  internals: RenderSystemInternals,
  direct: () => GraphCompileInput,
  request: ViewGraphCompileRequest,
): FrameRecording<Result<ViewGraphCompileOutcome, RendererOperationError<'graph-build-failed'>>> {
  const entity = internals.viewEntity;
  const world = renderWorldFor(internals);
  if (entity === undefined || !awaitsRenderRecord(world)) return ok(compileViewGraph(direct()));
  const frame = renderSubmission(world).frame;
  stageViewGraphCompile(world, entity, request);
  yield { kind: 'compile' as const, world };
  // The barrier's RenderRecord may have retired the entity's candidate with the view.
  const outcome = world.hasComponent(entity, ViewGraphCandidate)
    ? world
        .resolveUniqueRef<ViewGraphCandidateSlot>(
          world.get(entity, ViewGraphCandidate).unwrap().state,
        )
        .unwrap()
        .take(frame)
    : undefined;
  return outcome === undefined ? err(compileMissingError()) : ok(outcome);
}
