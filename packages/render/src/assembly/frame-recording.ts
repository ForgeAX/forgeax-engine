import type { RecorderSession } from '@forgeax/engine-profiler';
import type { RhiCommandEncoder, RhiDevice, RhiError } from '@forgeax/engine-rhi';
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
export type FrameRecording<T = boolean> = Generator<
  | RecordedView
  | FeatureFrameRequest
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

export type FramePreparationCheckpoint = { readonly kind: 'features-prepared' };
export type FramePreparation<T = boolean> = Generator<FramePreparationCheckpoint, T, void>;

export function drainFramePreparation<T>(operation: FramePreparation<T>): T {
  let next = operation.next();
  while (!next.done) next = operation.next();
  return next.value;
}

/** Resume the same coordinator without exposing or copying its frame-owned state. */
export function* prepareFrameSubmission(
  recordings: readonly FrameRecording[],
  afterEncode?: (encoder: RhiCommandEncoder) => boolean,
  rendererInternals?: RenderSystemInternals,
  isCurrent?: () => boolean,
): FramePreparation {
  const pending: FrameRecording[] = [];
  const featureRequests: { recording: FrameRecording; request: FeatureFrameRequest }[] = [];
  let batch: RenderFeatureFrameBatch | undefined;
  let sceneInputsReady = true;
  let sharedGraph: ReturnType<typeof recordSharedFeatureGraph>;
  let work: RecordedView | undefined;
  const currentChecks: (() => boolean)[] = [];
  const submittedWork: ((completed: Promise<void>) => void)[] = [];
  let result: RendererFrameStageResult<void> = { ok: false, stage: 'execute' };
  const failures: unknown[] = [];
  let completion: Promise<void> | undefined;
  let textureMips: ReturnType<RenderSystemInternals['gpuStore']['prepareTextureMips']> | undefined;
  let canvasMips:
    | ReturnType<NonNullable<RenderSystemInternals['dynamicTextureStore']>['prepareMipmaps']>
    | undefined;
  const framePassNames: string[] = [];
  if (rendererInternals !== undefined) rendererInternals.framePassNames = framePassNames;
  const admitWork = (
    recording: FrameRecording,
    next: IteratorResult<
      | RecordedView
      | FeatureFrameRequest
      | { readonly kind: 'scene-inputs'; readonly encoder: RhiCommandEncoder },
      boolean
    >,
  ) => {
    if (next.done) return next.value;
    if ('kind' in next.value)
      throw new Error('A render view yielded more than one feature preparation request');
    pending.push(recording);
    if (
      work !== undefined &&
      (work.encoder !== next.value.encoder || work.device !== next.value.device)
    )
      throw new Error('Renderer views must record into one encoder on one device');
    work = next.value;
    if (work.isCurrent !== undefined) currentChecks.push(work.isCurrent);
    if (work.onSubmittedWork !== undefined) submittedWork.push(work.onSubmittedWork);
    return true;
  };
  const encodeAndSubmit = function* (): FramePreparation {
    if (isCurrent?.() === false) return false;
    for (const recording of recordings) {
      const next = recording.next();
      if (!next.done && 'kind' in next.value) {
        if (next.value.kind !== 'features')
          throw new Error('Scene inputs must follow Feature preparation');
        featureRequests.push({ recording, request: next.value });
      } else if (!admitWork(recording, next)) return false;
    }
    const first = featureRequests[0]?.request;
    if (first !== undefined) {
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
      for (const { request } of featureRequests) request.internals.framePassNames = framePassNames;
      first.internals.featureSceneInputs?.begin(first.input.frameNumber);
      batch = runRenderFeatureFrame(first.host, inputs);
      for (const { request } of featureRequests) {
        const view = batch.views.get(request.input.identity);
        if (view === undefined) throw new Error('Renderer feature preparation omitted a view');
        request.accept(view);
      }
      // All views and their prepared Feature batch still belong to this one
      // coordinator. No capture or shared/view graph is resumed before the fence.
      yield { kind: 'features-prepared' };
      if (isCurrent?.() === false) return false;
      const captureOwner = first.internals.rendererCaptureOwner;
      const captures = featureRequests.find(({ request }) => request.captures !== undefined)
        ?.request.captures;
      const captureWork = captureOwner?.prepare(captures?.snapshots ?? []) ?? [];
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
        const ready = captureView.recording.next({ ok: true, value: undefined });
        if (!ready.done && !('kind' in ready.value) && ready.value.presentation === 'pending') {
          // Native scene/shadow PSOs can still be preparing. This view already
          // reached its completion barrier, so submit that work and abort the
          // dependent Feature batch without publishing an unwritten scene input.
          sceneInputsReady = false;
          if (!admitWork(captureView.recording, ready)) return false;
        } else if (ready.done || !('kind' in ready.value) || ready.value.kind !== 'scene-inputs') {
          throw new Error('Scene input capture did not reach the shared Feature barrier');
        }
      }
      if (sceneInputsReady)
        sharedGraph = recordSharedFeatureGraph(first.internals, first.encoder, batch.frame);
      for (const { recording } of featureRequests) {
        if (pending.includes(recording)) continue;
        if (!admitWork(recording, recording.next({ ok: true, value: undefined }))) return false;
      }
    }
    if (work === undefined || afterEncode?.(work.encoder) === false) return false;
    const timingOwner = rendererInternals ?? first?.internals;
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
    let finished: ReturnType<RhiCommandEncoder['finish']>;
    try {
      textureMips = timingOwner?.gpuStore?.prepareTextureMips();
      if (textureMips !== undefined && !textureMips.ok) {
        work.reportError(textureMips.error);
        result = { ok: false, stage: 'finish' };
        return false;
      }
      canvasMips = timingOwner?.dynamicTextureStore?.prepareMipmaps(work.device);
      if (canvasMips !== undefined && !canvasMips.ok) {
        work.reportError(canvasMips.error);
        result = { ok: false, stage: 'finish' };
        return false;
      }
      if (capture !== undefined) {
        const tail = capture.encodeTail(work.encoder, timingOwner?.observationGraphGeneration);
        if (!tail.ok) capture.abort({ code: tail.error.code });
      }
      finished = work.encoder.finish();
    } finally {
      if (finishPhase) endSubmissionPhase(profileSession);
    }
    if (!finished.ok) {
      work.reportError(finished.error);
      result = { ok: false, stage: 'finish' };
      return false;
    }
    const submitPhase = beginSubmissionPhase(profileSession, 'submission/submit');
    try {
      const injected = work.beforeSubmit?.(work.device);
      if (injected !== undefined) {
        work.reportError(injected);
        result = { ok: false, stage: 'submit' };
        return false;
      }
      if (isCurrent?.() === false || currentChecks.some((check) => !check())) {
        result = { ok: false, stage: 'submit' };
        return false;
      }
      const mipBuffer = textureMips?.ok ? textureMips.value?.buffer : undefined;
      const buffers = mipBuffer === undefined ? [] : [mipBuffer];
      if (canvasMips?.ok) buffers.push(canvasMips.value.buffer);
      buffers.push(finished.value);
      const submitted = work.device.queue.submit(buffers);
      if (!submitted.ok) {
        work.reportError(submitted.error);
        result = { ok: false, stage: 'submit' };
        return false;
      }
      result = { ok: true, value: undefined };
      if (timingOwner !== undefined || submittedWork.length > 0) {
        completion = work.device.queue.onSubmittedWorkDone();
        // Every allocation gets the fence even if another observer throws.
        for (const track of submittedWork) {
          try {
            track(completion);
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (timingOwner !== undefined) timingOwner.gpuPassTimingSubmittedWork = completion;
        capture?.markSubmitted(completion);
      }
      const observationOwner = rendererInternals ?? first?.internals;
      if (observationOwner !== undefined)
        observationOwner.submittedPassNames = Object.freeze([...framePassNames]);
      if (sceneInputsReady) batch?.frame.onSubmitted();
      return true;
    } finally {
      if (submitPhase) endSubmissionPhase(profileSession);
    }
  };
  const uniforms = new MaterialUniformRecording();
  const operation = encodeAndSubmit();
  try {
    try {
      let next = uniforms.run(() => operation.next());
      while (!next.done) {
        yield next.value;
        next = uniforms.run(() => operation.next());
      }
    } catch (cause) {
      failures.push(cause);
    }
  } finally {
    try {
      uniforms.run(() => operation.return(false));
    } catch (cause) {
      failures.push(cause);
    }
    try {
      uniforms.complete();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      if (textureMips?.ok) textureMips.value?.complete(result.ok);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      if (canvasMips?.ok) canvasMips.value.complete(result.ok);
    } catch (cause) {
      failures.push(cause);
    }
    for (const recording of pending) {
      try {
        recording.next(result);
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const { recording } of featureRequests) {
      if (pending.includes(recording)) continue;
      try {
        recording.return(false);
      } catch (cause) {
        failures.push(cause);
      }
    }
    const first = featureRequests[0]?.request;
    if (first !== undefined) {
      const finalize = (action: () => void) => {
        try {
          action();
        } catch (cause) {
          failures.push(cause);
        }
      };
      finalize(() =>
        first.internals.featureSceneInputs?.complete(result.ok && sceneInputsReady, completion),
      );
      finalize(() =>
        first.internals.rendererCaptureOwner?.complete(result.ok && sceneInputsReady, completion),
      );
      if (result.ok && sceneInputsReady) {
        finalize(() => batch?.onSubmitted());
        // Queue acceptance survives producer callback failures. Newly retired GPU
        // resources must still be marked submitted before any cleanup can see them.
        if (batch !== undefined) {
          const accepted = batch;
          finalize(() =>
            first.host.markPreparedGraphicsSubmitted(accepted.preparedResourceBatches),
          );
        }
      } else {
        const stage = result.ok ? 'scene-input-pending' : result.stage;
        finalize(() => first.internals.gpuPassTimingCapture?.abort({ code: stage }));
        finalize(() => batch?.onAborted());
        for (const resources of batch?.preparedResourceBatches ?? []) {
          finalize(() => {
            const released = resources.release();
            if (!released.ok) first.internals.errorRegistry.fire(released.error);
          });
        }
      }
      if (result.ok && sceneInputsReady && batch !== undefined) {
        const resources = batch.preparedResourceBatches;
        const retire = () => {
          const retired = first.host.retirePreparedGraphics(resources);
          if (!retired.ok) first.internals.errorRegistry.fire(retired.error);
        };
        void completion?.then(retire, retire);
      }
    }
    if (sharedGraph !== undefined) {
      const graph = sharedGraph;
      if (completion === undefined) void graph.retire();
      else
        void completion.then(
          () => graph.retire(),
          () => graph.retire(),
        );
    }
    // biome-ignore lint/correctness/noUnsafeFinally: Iterator cancellation must surface collected cleanup failures.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      // biome-ignore lint/correctness/noUnsafeFinally: Aggregate original and sibling cleanup failures before cancellation exits.
      throw new AggregateError(failures, 'Renderer view finalization failed');
    }
    if (!result.ok && result.stage === 'submit') {
      // biome-ignore lint/correctness/noUnsafeFinally: Reject physical submit failures on every iterator exit.
      throw new RendererOperationError('frame-submit-rejected', {
        operation: 'draw',
        stage: 'submit',
        accepted: false,
      });
    }
  }
  return result.ok;
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
