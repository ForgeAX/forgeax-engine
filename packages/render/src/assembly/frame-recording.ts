import type { RecorderSession } from '@forgeax/engine-profiler';
import type { CommandBuffer, RhiCommandEncoder, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { CubeCaptureWork } from '../capture/scheduler';
import { RendererOperationError } from '../errors/render';
import {
  type RenderFeatureFrameBatch,
  type RenderFeatureFrameInput,
  type RenderFeatureFrameResult,
  type RenderFeatureHost,
  runRenderFeatureFrame,
} from '../features/host';
import { MaterialUniformRecording } from '../record/material-uniforms';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot, CubeCameraSnapshot, RenderPhase } from '../render-contract';
import { recordSharedFeatureGraph } from './feature-frame-graph';
import type {
  RendererFrameStageResult,
  RendererFrameTransactionSteps,
} from './renderer-frame-transaction';

function beginSubmissionPhase(session: RecorderSession | undefined, phase: RenderPhase): boolean {
  if (session === undefined) return false;
  try {
    return session.beginPhase('render', phase).ok;
  } catch {
    return false;
  }
}

function endSubmissionPhase(session: RecorderSession | undefined): void {
  try {
    session?.endPhase();
  } catch {
    // Diagnostic failures cannot change submission or its resource fences.
  }
}

/** One prepared view pauses at the shared Renderer submission barrier. */
export interface RecordedView {
  /** A preparation barrier completes GPU work without publishing a scene picture. */
  readonly presentation?: import('../render-contract').FramePresentation;
  readonly encoder: RhiCommandEncoder;
  readonly device: RhiDevice;
  readonly beforeSubmit?: ((device: RhiDevice) => RhiError | undefined) | undefined;
  readonly isCurrent?: () => boolean;
  /** Physical submission, before any publication callback or generation rejection. */
  readonly onSubmittedWork?: (completed: Promise<void>) => void;
  readonly reportError: (error: RhiError) => void;
}
export interface FeatureFrameRequest {
  readonly kind: 'features';
  readonly host: RenderFeatureHost;
  readonly input: RenderFeatureFrameInput;
  readonly internals: RenderSystemInternals;
  readonly encoder: RhiCommandEncoder;
  readonly captures?: {
    readonly snapshots: readonly CubeCameraSnapshot[];
    readonly auxiliary: readonly CameraSnapshot[];
    readonly exclusive: boolean;
    readonly accept: (
      work: readonly CubeCaptureWork[],
      auxiliary: readonly CameraSnapshot[],
      sceneInputs: readonly import('../record/target-capture-graph').CubeCaptureGraphWork[],
    ) => void;
  };
  readonly accept: (result: RenderFeatureFrameResult) => void;
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
export type FrameRecording<T = boolean> = Generator<
  | RecordedView
  | FeatureFrameRequest
  | FrameRecordingCheckpoint
  | { readonly kind: 'scene-inputs'; readonly encoder: RhiCommandEncoder },
  T,
  RendererFrameStageResult<void>
>;

/** Submit the existing generation-fenced barrier while source or GPU work prepares.
 * No scene/capture/history state is published by a pending receipt. */
export function* recordPreparationBarrier(
  internals: RenderSystemInternals,
  encoder?: RhiCommandEncoder,
): FrameRecording {
  if (encoder === undefined) {
    const created = internals.device.createCommandEncoder({ label: 'render-preparation-pending' });
    if (!created.ok) {
      internals.errorRegistry.fire(created.error);
      return false;
    }
    encoder = created.value;
  }
  const generation = internals.deviceScope.generation;
  const pending = yield {
    presentation: 'pending',
    encoder,
    device: internals.device,
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

export type FramePreparationCheckpoint = {
  readonly kind: 'features-prepared' | 'recording-checkpoint';
};
const RECORDING_CHECKPOINT: FramePreparationCheckpoint = Object.freeze({
  kind: 'recording-checkpoint',
});
const RESUMED: RendererFrameStageResult<void> = Object.freeze({ ok: true, value: undefined });
export type FramePreparation<T = boolean> = Generator<FramePreparationCheckpoint, T, void>;

export function drainFramePreparation<T>(operation: FramePreparation<T>): T {
  let next = operation.next();
  while (!next.done) next = operation.next();
  return next.value;
}

type FrameRecordingStep = IteratorResult<
  | RecordedView
  | FeatureFrameRequest
  | FrameRecordingCheckpoint
  | { readonly kind: 'scene-inputs'; readonly encoder: RhiCommandEncoder },
  boolean
>;

/** Resume the same coordinator without exposing or copying its frame-owned state. */
export function* prepareFrameSubmission(
  recordings: readonly FrameRecording[],
  afterEncode?: (encoder: RhiCommandEncoder) => boolean,
  rendererInternals?: RenderSystemInternals,
  isCurrent?: () => boolean,
): FramePreparation {
  return yield* new FrameSubmission(recordings, afterEncode, rendererInternals, isCurrent).run();
}

/** One frame's shared encoder: admits every view, prepares Features once, submits once. */
class FrameSubmission {
  private readonly pending: FrameRecording[] = [];
  /** Views paused at their recording checkpoint; finalization closes them. */
  private readonly suspended = new Set<FrameRecording>();
  private readonly featureRequests: { recording: FrameRecording; request: FeatureFrameRequest }[] =
    [];
  private batch: RenderFeatureFrameBatch | undefined;
  private sceneInputsReady = true;
  private sharedGraph: ReturnType<typeof recordSharedFeatureGraph>;
  private work: RecordedView | undefined;
  private readonly currentChecks: (() => boolean)[] = [];
  private readonly submittedWork: ((completed: Promise<void>) => void)[] = [];
  private result: RendererFrameStageResult<void> = { ok: false, stage: 'execute' };
  private readonly failures: unknown[] = [];
  private completion: Promise<void> | undefined;
  private textureMips:
    | ReturnType<RenderSystemInternals['gpuStore']['prepareTextureMips']>
    | undefined;
  private canvasMips:
    | ReturnType<NonNullable<RenderSystemInternals['dynamicTextureStore']>['prepareMipmaps']>
    | undefined;
  private readonly framePassNames: string[] = [];

  constructor(
    private readonly recordings: readonly FrameRecording[],
    private readonly afterEncode: ((encoder: RhiCommandEncoder) => boolean) | undefined,
    private readonly rendererInternals: RenderSystemInternals | undefined,
    private readonly isCurrent: (() => boolean) | undefined,
  ) {
    if (rendererInternals !== undefined) rendererInternals.framePassNames = this.framePassNames;
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
        this.finalizeMips();
        this.finalizeRecordings();
        this.finalizeFeatureBatch();
        this.retireSharedGraph();
      } finally {
        // Held completions settle after every owner of this frame has settled.
        releaseHold?.();
      }
      this.throwFinalizationFailure();
    }
    return this.result.ok;
  }

  private holdCompletions(): () => void {
    const device =
      this.rendererInternals?.device ?? this.featureRequests[0]?.request.internals.device;
    return device?.queue.holdCompletions?.() ?? (() => {});
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
      throw new Error('A render view yielded more than one feature preparation request');
    this.pending.push(recording);
    const work = this.work;
    if (
      work !== undefined &&
      (work.encoder !== next.value.encoder || work.device !== next.value.device)
    )
      throw new Error('Renderer views must record into one encoder on one device');
    this.work = next.value;
    if (next.value.isCurrent !== undefined) this.currentChecks.push(next.value.isCurrent);
    if (next.value.onSubmittedWork !== undefined)
      this.submittedWork.push(next.value.onSubmittedWork);
    return true;
  }

  private *encodeAndSubmit(): FramePreparation {
    if (this.isCurrent?.() === false) return false;
    if (!(yield* this.startRecordings())) return false;
    const first = this.featureRequests[0]?.request;
    if (first !== undefined) {
      const batch = this.prepareFeatures(first);
      // All views and their prepared Feature batch still belong to this one
      // coordinator. No capture or shared/view graph is resumed before the fence.
      yield { kind: 'features-prepared' };
      if (this.isCurrent?.() === false) return false;
      if (!(yield* this.resumeFeatureViews(first, batch))) return false;
    }
    const work = this.work;
    if (work === undefined || this.afterEncode?.(work.encoder) === false) return false;
    return this.finishAndSubmit(work, this.rendererInternals ?? first?.internals);
  }

  /** Advance each view to its first barrier, separating Feature requests from encoded work. */
  private *startRecordings(): FramePreparation {
    for (const recording of this.recordings) {
      const next = yield* this.advance(recording, undefined);
      if (!next.done && 'kind' in next.value) {
        if (next.value.kind !== 'features')
          throw new Error('Scene inputs must follow Feature preparation');
        this.featureRequests.push({ recording, request: next.value });
      } else if (!this.admitWork(recording, next)) return false;
    }
    return true;
  }

  /** Run the complete Feature roster once and hand each view its result. */
  private prepareFeatures(first: FeatureFrameRequest): RenderFeatureFrameBatch {
    const featureRequests = this.featureRequests;
    if (
      featureRequests.some(
        ({ request }) =>
          request.host !== first.host ||
          request.encoder !== first.encoder ||
          request.input.frameNumber !== first.input.frameNumber ||
          request.internals.device !== first.internals.device,
      )
    )
      throw new Error('Renderer feature preparation requires one host, device and encoder');
    const inputs = featureRequests.map(({ request }) => request.input);
    for (const { request } of featureRequests)
      request.internals.framePassNames = this.framePassNames;
    first.internals.featureSceneInputs?.begin(first.input.frameNumber);
    const batch = runRenderFeatureFrame(first.host, inputs);
    this.batch = batch;
    for (const { request } of featureRequests) {
      const view = batch.views.get(request.input.identity);
      if (view === undefined) throw new Error('Renderer feature preparation omitted a view');
      request.accept(view);
    }
    return batch;
  }

  /** Route captures and scene inputs to one recorder, record shared work, then resume views. */
  private *resumeFeatureViews(
    first: FeatureFrameRequest,
    batch: RenderFeatureFrameBatch,
  ): FramePreparation {
    const featureRequests = this.featureRequests;
    const captures = featureRequests.find(({ request }) => request.captures !== undefined)?.request
      .captures;
    const captureWork =
      first.internals.rendererCaptureOwner?.prepare(captures?.snapshots ?? []) ?? [];
    const captureView =
      featureRequests.find(({ request }) => request.captures?.exclusive === true) ??
      featureRequests.find(({ request }) => request.input.render) ??
      featureRequests[0];
    const sceneInputs = first.internals.featureSceneInputs?.work ?? [];
    if (captureWork.length > 0 && captureView === undefined)
      throw new Error('Renderer capture work requires an admitted scene recorder');
    for (const entry of featureRequests)
      entry.request.captures?.accept(
        entry === captureView ? captureWork : [],
        entry === captureView
          ? (captures?.auxiliary.filter((camera) => camera.planarReflection === undefined) ?? [])
          : [],
        entry === captureView ? sceneInputs : [],
      );
    if (sceneInputs.length > 0) {
      if (captureView === undefined) throw new Error('Scene inputs require one scene recorder');
      if (!(yield* this.resumeSceneInputRecorder(captureView.recording))) return false;
    }
    if (this.sceneInputsReady)
      this.sharedGraph = recordSharedFeatureGraph(first.internals, first.encoder, batch.frame);
    for (const { recording } of featureRequests) {
      if (this.pending.includes(recording)) continue;
      if (!this.admitWork(recording, yield* this.advance(recording, RESUMED))) return false;
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
    const ready = yield* this.advance(recording, RESUMED);
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
    timingOwner: RenderSystemInternals | undefined,
  ): boolean {
    let profileSession: RecorderSession | undefined;
    try {
      profileSession = timingOwner?.profiler?.activeSession();
    } catch {
      // The shared barrier keeps the ordinary path when observation fails.
    }
    // Recorders are suspended here: these are shared CPU phases, not children
    // of a view's completed `record` span or the asynchronous queue completion.
    const presentationPhase = beginSubmissionPhase(profileSession, 'submission/presentation');
    try {
      timingOwner?.encodePresentation?.(work.encoder);
    } finally {
      if (presentationPhase) endSubmissionPhase(profileSession);
    }
    const capture = timingOwner?.gpuPassTimingCapture;
    const finishPhase = beginSubmissionPhase(profileSession, 'submission/finish');
    let finished: ReturnType<RhiCommandEncoder['finish']> | undefined;
    try {
      finished = this.finishEncoder(work, timingOwner, capture);
    } finally {
      if (finishPhase) endSubmissionPhase(profileSession);
    }
    if (finished === undefined) return false;
    if (!finished.ok) {
      work.reportError(finished.error);
      this.result = { ok: false, stage: 'finish' };
      return false;
    }
    const submitPhase = beginSubmissionPhase(profileSession, 'submission/submit');
    try {
      return this.submit(work, finished.value, timingOwner, capture);
    } finally {
      if (submitPhase) endSubmissionPhase(profileSession);
    }
  }

  /** Prepare mip uploads and the GPU timing tail, then finish the shared encoder. */
  private finishEncoder(
    work: RecordedView,
    timingOwner: RenderSystemInternals | undefined,
    capture: RenderSystemInternals['gpuPassTimingCapture'],
  ): ReturnType<RhiCommandEncoder['finish']> | undefined {
    const textureMips = timingOwner?.gpuStore?.prepareTextureMips();
    this.textureMips = textureMips;
    if (textureMips !== undefined && !textureMips.ok) {
      work.reportError(textureMips.error);
      this.result = { ok: false, stage: 'finish' };
      return undefined;
    }
    const canvasMips = timingOwner?.dynamicTextureStore?.prepareMipmaps(work.device);
    this.canvasMips = canvasMips;
    if (canvasMips !== undefined && !canvasMips.ok) {
      work.reportError(canvasMips.error);
      this.result = { ok: false, stage: 'finish' };
      return undefined;
    }
    if (capture !== undefined) {
      const tail = capture.encodeTail(work.encoder, timingOwner?.observationGraphGeneration);
      if (!tail.ok) capture.abort({ code: tail.error.code });
    }
    return work.encoder.finish();
  }

  private submit(
    work: RecordedView,
    commands: CommandBuffer,
    timingOwner: RenderSystemInternals | undefined,
    capture: RenderSystemInternals['gpuPassTimingCapture'],
  ): boolean {
    const injected = work.beforeSubmit?.(work.device);
    if (injected !== undefined) {
      work.reportError(injected);
      this.result = { ok: false, stage: 'submit' };
      return false;
    }
    if (this.isCurrent?.() === false || this.currentChecks.some((check) => !check())) {
      this.result = { ok: false, stage: 'submit' };
      return false;
    }
    const textureMips = this.textureMips;
    const mipBuffer = textureMips?.ok ? textureMips.value?.buffer : undefined;
    const buffers = mipBuffer === undefined ? [] : [mipBuffer];
    if (this.canvasMips?.ok) buffers.push(this.canvasMips.value.buffer);
    buffers.push(commands);
    const submitted = work.device.queue.submit(buffers);
    if (!submitted.ok) {
      work.reportError(submitted.error);
      this.result = { ok: false, stage: 'submit' };
      return false;
    }
    this.result = { ok: true, value: undefined };
    if (timingOwner !== undefined || this.submittedWork.length > 0)
      this.trackCompletion(work, timingOwner, capture);
    const observationOwner = this.rendererInternals ?? this.featureRequests[0]?.request.internals;
    if (observationOwner !== undefined)
      observationOwner.submittedPassNames = Object.freeze([...this.framePassNames]);
    if (this.sceneInputsReady) this.batch?.frame.onSubmitted();
    return true;
  }

  private trackCompletion(
    work: RecordedView,
    timingOwner: RenderSystemInternals | undefined,
    capture: RenderSystemInternals['gpuPassTimingCapture'],
  ): void {
    const completion = work.device.queue.onSubmittedWorkDone();
    this.completion = completion;
    // Every allocation gets the fence even if another observer throws.
    for (const track of this.submittedWork) this.capture(() => track(completion));
    if (timingOwner !== undefined) timingOwner.gpuPassTimingSubmittedWork = completion;
    capture?.markSubmitted(completion);
  }

  private finalizeMips(): void {
    const ok = this.result.ok;
    this.capture(() => {
      if (this.textureMips?.ok) this.textureMips.value?.complete(ok);
    });
    this.capture(() => {
      if (this.canvasMips?.ok) this.canvasMips.value.complete(ok);
    });
  }

  private finalizeRecordings(): void {
    for (const recording of this.pending) this.capture(() => recording.next(this.result));
    for (const recording of this.suspended) {
      if (this.pending.includes(recording)) continue;
      this.capture(() => recording.return(false));
    }
    this.suspended.clear();
    for (const { recording } of this.featureRequests) {
      if (this.pending.includes(recording)) continue;
      this.capture(() => recording.return(false));
    }
  }

  private finalizeFeatureBatch(): void {
    const first = this.featureRequests[0]?.request;
    if (first === undefined) return;
    const accepted = this.result.ok && this.sceneInputsReady;
    const completion = this.completion;
    this.capture(() => first.internals.featureSceneInputs?.complete(accepted, completion));
    this.capture(() => first.internals.rendererCaptureOwner?.complete(accepted, completion));
    if (accepted) this.acknowledgeFeatureBatch(first);
    else this.abortFeatureBatch(first);
    const batch = this.batch;
    if (accepted && batch !== undefined) {
      const resources = batch.preparedResourceBatches;
      const retire = () => {
        const retired = first.host.retirePreparedGraphics(resources);
        if (!retired.ok) first.internals.errorRegistry.fire(retired.error);
      };
      void completion?.then(retire, retire);
    }
  }

  private acknowledgeFeatureBatch(first: FeatureFrameRequest): void {
    const batch = this.batch;
    this.capture(() => batch?.onSubmitted());
    // Queue acceptance survives producer callback failures. Newly retired GPU
    // resources must still be marked submitted before any cleanup can see them.
    if (batch !== undefined)
      this.capture(() => first.host.markPreparedGraphicsSubmitted(batch.preparedResourceBatches));
  }

  private abortFeatureBatch(first: FeatureFrameRequest): void {
    const result = this.result;
    const stage = result.ok ? 'scene-input-pending' : result.stage;
    const batch = this.batch;
    this.capture(() => first.internals.gpuPassTimingCapture?.abort({ code: stage }));
    this.capture(() => batch?.onAborted());
    for (const resources of batch?.preparedResourceBatches ?? []) {
      this.capture(() => {
        const released = resources.release();
        if (!released.ok) first.internals.errorRegistry.fire(released.error);
      });
    }
  }

  private retireSharedGraph(): void {
    const graph = this.sharedGraph;
    if (graph === undefined) return;
    if (this.completion === undefined) void graph.retire();
    else
      void this.completion.then(
        () => graph.retire(),
        () => graph.retire(),
      );
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
      throw new RendererOperationError('frame-submit-rejected', {
        operation: 'draw',
        stage: 'submit',
        accepted: false,
      });
    }
  }
}

/** Encode every view, then finish and submit the one shared encoder exactly once. */
export function submitFrameRecordings(
  recordings: readonly FrameRecording[],
  afterEncode?: (encoder: RhiCommandEncoder) => boolean,
  rendererInternals?: RenderSystemInternals,
): boolean {
  return drainFramePreparation(prepareFrameSubmission(recordings, afterEncode, rendererInternals));
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
