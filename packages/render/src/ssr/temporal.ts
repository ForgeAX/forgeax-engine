import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  TemporalFrameBeginInput,
  TemporalFrameCandidate,
  TemporalFrameConsumerId,
  TemporalFrameCoordinator,
  TemporalFrameError,
  TemporalFramePhases,
  TemporalFrameReceipt,
  TemporalFrameStage,
} from '../temporal/frame-coordinator';
import type {
  SsrHistoryCandidate,
  SsrHistoryError,
  SsrHistoryFailureStage,
  SsrHistoryInspection,
  SsrHistoryOwner,
  SsrHistoryResetReason,
} from './history';

export interface SsrTemporalCandidate<T> {
  readonly temporal: TemporalFrameCandidate<T>;
  readonly history: SsrHistoryCandidate;
}
export interface SsrTemporalExecutionError {
  readonly code: 'ssr-temporal-stage-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<{ readonly stage: TemporalFrameStage; readonly cause: unknown }>;
}
export interface SsrTemporalInspection {
  readonly sharedEpoch: number;
  readonly consumerIds: readonly TemporalFrameConsumerId[];
  readonly coordinatorAttempt: 'none' | 'active' | 'committed' | 'aborted';
  readonly history: SsrHistoryInspection;
}
export type SsrTemporalError = TemporalFrameError | SsrHistoryError | SsrTemporalExecutionError;

function stageFromError(cause: unknown): TemporalFrameStage {
  if (typeof cause === 'object' && cause !== null && 'stage' in cause) {
    const stage = (cause as { readonly stage?: unknown }).stage;
    if (stage === 'build' || stage === 'encode' || stage === 'finish' || stage === 'submit') {
      return stage;
    }
  }
  return 'submit';
}
function coordinatorInput<T>(input: TemporalFrameBeginInput<T>): TemporalFrameBeginInput<T> {
  const consumerIds = input.consumerIds?.includes('ssr')
    ? input.consumerIds
    : [...(input.consumerIds ?? []), 'ssr' as const];
  return { ...input, temporalDemand: true, consumerIds };
}
function resetCoordinator<T>(
  coordinator: TemporalFrameCoordinator<T>,
  reason: SsrHistoryResetReason,
): void {
  switch (reason) {
    case 'first-enable':
    case 'disable':
      return;
    case 'resize':
      coordinator.reset('resize');
      return;
    case 'camera-cut':
      coordinator.reset('cut');
      return;
    case 'history-version':
      coordinator.reset('camera-switch');
      return;
    case 'coverage-loss':
      coordinator.reset('detach');
      return;
    case 'reflection-generation':
    case 'device-recovery':
      coordinator.reset('device-generation');
      return;
  }
}

/** Stages SSR history beside the shared renderer transaction without owning submit or epochs. */
export class SsrTemporalConsumer<T = unknown> {
  constructor(
    private readonly coordinator: TemporalFrameCoordinator<T>,
    readonly history: SsrHistoryOwner,
  ) {}
  begin(
    input: TemporalFrameBeginInput<T>,
  ): Result<SsrTemporalCandidate<T>, TemporalFrameError | SsrHistoryError> {
    const history = this.history.beginFrame();
    if (!history.ok) return history;
    const temporal = this.coordinator.begin(coordinatorInput(input));
    if (!temporal.ok) {
      this.history.abortFrame(history.value, 'build');
      return temporal;
    }
    return ok({ temporal: temporal.value, history: history.value });
  }
  commit(
    candidate: SsrTemporalCandidate<T>,
  ): Result<TemporalFrameReceipt<T>, TemporalFrameError | SsrHistoryError> {
    const committed = this.coordinator.commit(candidate.temporal);
    if (!committed.ok) {
      this.history.abortFrame(candidate.history, 'submit');
      return committed;
    }
    const history = this.history.commitFrame(candidate.history);
    if (!history.ok) return history;
    return committed;
  }
  abort(candidate: SsrTemporalCandidate<T>, stage: SsrHistoryFailureStage): void {
    this.history.abortFrame(candidate.history, stage);
    this.coordinator.abort(candidate.temporal, stage);
  }
  run(
    input: TemporalFrameBeginInput<T>,
    phases: TemporalFramePhases<T>,
  ): Result<TemporalFrameReceipt<T>, SsrTemporalError> {
    const started = this.begin(input);
    if (!started.ok) return started;
    const candidate = started.value;
    try {
      const built = phases.build();
      phases.encode(built);
      phases.finish();
      phases.submit();
    } catch (cause) {
      const stage = stageFromError(cause);
      this.abort(candidate, stage);
      return err({
        code: 'ssr-temporal-stage-failed',
        expected: `SSR temporal ${stage} succeeds before commit`,
        hint: 'inspect the owned stage failure and retry without promoting the candidate',
        detail: { stage, cause },
      });
    }
    return this.commit(candidate);
  }
  reset(reason: SsrHistoryResetReason): void {
    this.history.reset(reason);
    resetCoordinator(this.coordinator, reason);
  }
  retireAfterFence(
    queue: Parameters<SsrHistoryOwner['retireAfterFence']>[0],
    onFailure: Parameters<SsrHistoryOwner['retireAfterFence']>[1],
  ): void {
    this.history.retireAfterFence(queue, onFailure);
  }
  inspect(): SsrTemporalInspection {
    const temporal = this.coordinator.inspect();
    return Object.freeze({
      sharedEpoch: temporal.epoch,
      consumerIds: temporal.consumerIds,
      coordinatorAttempt: temporal.attempt,
      history: this.history.inspect(),
    });
  }
}
export function createSsrTemporalConsumer<T>(
  coordinator: TemporalFrameCoordinator<T>,
  history: SsrHistoryOwner,
): SsrTemporalConsumer<T> {
  return new SsrTemporalConsumer(coordinator, history);
}
