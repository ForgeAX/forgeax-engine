import type { RendererOperationError } from '../errors/render';
import type { FrameReceipt, RenderInspection } from '../render-contract';

export interface PendingFrameCompletion {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly presentation: FrameReceipt['presentation'];
  readonly stages: ReturnType<typeof observeFrameCompletionStages>;
}

/** Copy only the eight newest receipts without releasing their continuations. */
export function inspectFrameCompletionContinuations(
  frameId: number,
  deviceGeneration: number,
  continuations: ReadonlyMap<ContinuationTerminator, PendingFrameCompletion>,
): RenderInspection['frame'] {
  const pendingCompletions: PendingFrameCompletion[] = [];
  for (const completion of continuations.values()) {
    if (pendingCompletions.length === 8) pendingCompletions.shift();
    pendingCompletions.push(completion);
  }
  return Object.freeze({
    frameId,
    deviceGeneration,
    pendingCompletionCount: continuations.size,
    pendingCompletions: Object.freeze(
      pendingCompletions.map(({ stages, ...identity }) =>
        Object.freeze({ ...identity, ...stages() }),
      ),
    ),
  });
}

/** Observe the original fences without replacing or resolving either Promise. */
export function observeFrameCompletionStages(
  queue: Promise<unknown>,
  reflection: Promise<unknown> | undefined,
): () => Readonly<{
  queue: 'pending' | 'fulfilled' | 'rejected';
  reflection: 'pending' | 'fulfilled' | 'rejected' | 'not-required';
}> {
  let queueState: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let reflectionState: 'pending' | 'fulfilled' | 'rejected' | 'not-required' =
    reflection === undefined ? 'not-required' : 'pending';
  void queue.then(
    () => {
      queueState = 'fulfilled';
    },
    () => {
      queueState = 'rejected';
    },
  );
  void reflection?.then(
    () => {
      reflectionState = 'fulfilled';
    },
    () => {
      reflectionState = 'rejected';
    },
  );
  return () => Object.freeze({ queue: queueState, reflection: reflectionState });
}

export type RendererFrameStage = 'build' | 'execute' | 'finish' | 'submit';

export interface RendererFrameStageFailure {
  readonly stage: RendererFrameStage;
}

export type RendererFrameStageResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly stage: RendererFrameStage };

export interface RendererFrameTransactionSteps<T> {
  readonly build: () => RendererFrameStageResult<T>;
  readonly execute: (candidate: T) => RendererFrameStageResult<void>;
  readonly finish: (candidate: T) => RendererFrameStageResult<void>;
  readonly submit: (candidate: T) => RendererFrameStageResult<void>;
  readonly commit: (candidate: T) => void;
  readonly abort?: (failure: RendererFrameStageFailure) => void;
  readonly generationFence?: RendererGenerationFence;
}

export interface RendererGenerationFence {
  readonly capturedGeneration: number;
  readonly currentGeneration: () => number;
}

export type ContinuationKind = 'readback' | 'query' | 'mapAsync' | 'queue-completion';

export type ContinuationTerminationReason =
  | {
      readonly code: 'device-lost' | 'disposed' | 'stale-generation';
      readonly detail?: unknown;
    }
  | {
      readonly code: 'internal-fault';
      readonly detail: RendererOperationError<'device-operation-failed'>;
    };

export interface ContinuationTerminator {
  terminate(reason: ContinuationTerminationReason): boolean;
  promise(): Promise<ContinuationTerminationReason>;
  isTerminated(): boolean;
  guard(kind: ContinuationKind): boolean;
}

export type FrameCompletionResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Preserve producer Result failures while fencing a fulfilled GPU completion
 * against disposal or device-generation loss.
 */
export function guardFrameCompletion<T, E>(
  completion: PromiseLike<FrameCompletionResult<T, E>>,
  isCurrent: () => boolean,
  staleError: () => E,
  rejectedError: (cause: unknown) => E,
): Promise<FrameCompletionResult<T, E>> {
  return Promise.resolve(completion).then(
    (result) => {
      if (!result.ok) return result;
      return isCurrent() ? result : { ok: false, error: staleError() };
    },
    (cause) => ({ ok: false, error: rejectedError(cause) }),
  );
}

export function createContinuationTerminator(): ContinuationTerminator {
  let termination: ContinuationTerminationReason | undefined;
  let resolveTermination: ((reason: ContinuationTerminationReason) => void) | undefined;
  const terminated = new Promise<ContinuationTerminationReason>((resolve) => {
    resolveTermination = resolve;
  });
  return {
    terminate: (reason) => {
      if (termination !== undefined) return false;
      termination = Object.freeze({ ...reason });
      resolveTermination?.(termination);
      return true;
    },
    promise: () => terminated,
    isTerminated: () => termination !== undefined,
    guard: () => termination === undefined,
  };
}

/**
 * Run the four renderer stages behind one commit barrier. A stage can expose
 * only a structured failure; the candidate is never published until submit
 * has returned success, so a failed frame cannot advance last-known-good state.
 */
export function executeRendererFrameTransaction<T>(
  steps: RendererFrameTransactionSteps<T>,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RendererFrameStageFailure } {
  const fail = (
    stage: RendererFrameStage,
  ): { readonly ok: false; readonly error: RendererFrameStageFailure } => {
    const error = { stage } as const;
    steps.abort?.(error);
    return { ok: false, error };
  };

  const built = steps.build();
  if (!built.ok) return fail('build');
  const executed = steps.execute(built.value);
  if (!executed.ok) return fail('execute');
  const finished = steps.finish(built.value);
  if (!finished.ok) return fail('finish');
  if (
    steps.generationFence !== undefined &&
    steps.generationFence.currentGeneration() !== steps.generationFence.capturedGeneration
  ) {
    return fail('submit');
  }
  const submitted = steps.submit(built.value);
  if (!submitted.ok) return fail('submit');
  steps.commit(built.value);
  return { ok: true, value: built.value };
}

export interface AutoExposureFrameTransactionOptions {
  readonly failAt?: RendererFrameStage;
}

export type AutoExposureFrameTransactionResult =
  | {
      readonly ok: true;
      readonly state: AutoExposureState;
      readonly commitCount: 1;
    }
  | {
      readonly ok: false;
      readonly error: RendererFrameStageFailure;
      readonly state: AutoExposureState;
      readonly commitCount: 0;
    };

/**
 * Adapt the auto-exposure candidate to the renderer's single submit barrier.
 * This helper deliberately has no encoder or history state of its own.
 */
export function executeAutoExposureFrameTransaction(
  state: AutoExposureState,
  candidate: AutoExposureCandidate,
  options: AutoExposureFrameTransactionOptions = {},
): AutoExposureFrameTransactionResult {
  let committed = false;
  const prepared = prepareAutoExposureCandidate(state, candidate);
  const transaction = executeRendererFrameTransaction<AutoExposureCandidate>({
    build: () =>
      prepared.ok && options.failAt !== 'build'
        ? { ok: true, value: prepared.value }
        : { ok: false, stage: 'build' },
    execute: (_value) =>
      options.failAt === 'execute'
        ? { ok: false, stage: 'execute' }
        : { ok: true, value: undefined },
    finish: (_value) =>
      options.failAt === 'finish' ? { ok: false, stage: 'finish' } : { ok: true, value: undefined },
    submit: (_value) =>
      options.failAt === 'submit' ? { ok: false, stage: 'submit' } : { ok: true, value: undefined },
    commit: (_value) => {
      committed = true;
    },
  });
  if (!transaction.ok || !committed) {
    return {
      ok: false,
      error: transaction.ok ? { stage: 'submit' } : transaction.error,
      state,
      commitCount: 0,
    };
  }
  return { ok: true, state: commitAutoExposureCandidate(state, candidate), commitCount: 1 };
}

import {
  type AutoExposureCandidate,
  type AutoExposureState,
  commitAutoExposureCandidate,
  prepareAutoExposureCandidate,
} from '../pipeline/standard-output/auto-exposure/state';
