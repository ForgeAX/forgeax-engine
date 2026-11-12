import type { FrameReceipt, Renderer } from '@forgeax/engine-render';

const RECORD_LIMIT = 96;
const SUMMARY_LIMIT = 4;

function readySnapshot(renderer: Renderer) {
  try {
    const inspection = renderer.inspect({ fields: ['state', 'frame', 'pipelineLibrary'] });
    const pending = inspection.pipelineLibrary?.pending;
    return {
      status: 'available' as const,
      state: inspection.state,
      frame: {
        frameId: inspection.frame.frameId,
        deviceGeneration: inspection.frame.deviceGeneration,
        pendingCompletionCount: inspection.frame.pendingCompletionCount ?? null,
        pendingCompletions: inspection.frame.pendingCompletions?.slice(0, SUMMARY_LIMIT) ?? null,
      },
      pipelinePending: pending === undefined ? { status: 'unavailable' as const } : {
        status: 'available' as const,
        unidentified: pending.unidentified,
        count: pending.pipelines.length,
        pipelines: pending.pipelines.slice(0, SUMMARY_LIMIT).map((pipeline) => ({
          identity: pipeline.identity,
          kind: pipeline.kind,
          stage: pipeline.stage,
          elapsedMs: pipeline.elapsedMs,
        })),
      },
    };
  } catch {
    return { status: 'unavailable' as const };
  }
}

function readyClock() {
  try {
    return { status: 'available' as const, now: performance.now(), timeOrigin: performance.timeOrigin };
  } catch {
    return { status: 'unavailable' as const };
  }
}

function readyError(cause: unknown) {
  try {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function'))
      return { status: 'available' as const, message: String(cause).slice(0, 240) };
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (typeof code !== 'string' && typeof message !== 'string')
      return { status: 'unavailable' as const };
    return {
      status: 'available' as const,
      ...(typeof code === 'string' ? { code: code.slice(0, 80) } : {}),
      ...(typeof message === 'string' ? { message: message.slice(0, 240) } : {}),
    };
  } catch {
    return { status: 'unavailable' as const };
  }
}

export interface RecoveryFrameObservation {
  readonly event: 'submitted' | 'preparation-settled' | 'completion-settled' | 'unavailable';
  readonly generation: number;
  readonly attempt: number;
  readonly clock: ReturnType<typeof readyClock>;
  readonly receipt?: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly presentation: FrameReceipt['presentation'];
    readonly pendingReason?: Pick<NonNullable<FrameReceipt['presentationPendingReason']>,
      'code' | 'worldId' | 'entity' | 'submesh' | 'section' | 'preparationStage'>;
    readonly hasPreparation: boolean;
  };
  readonly outcome?: 'ok' | 'error' | 'rejected';
  readonly error?: ReturnType<typeof readyError>;
  readonly snapshot?: ReturnType<typeof readySnapshot>;
  readonly unavailable?: string;
}

export function createRecoveryFrameObserver(
  renderer: Renderer,
  emit: (event: RecoveryFrameObservation) => void,
  signal?: AbortSignal,
) {
  const generations = new Set<number>();
  let records = 0;
  const deliver = (event: RecoveryFrameObservation): void => {
    if (records >= RECORD_LIMIT) return;
    records += 1;
    try {
      emit(event);
    } catch {
      // A diagnostic consumer cannot replace an original draw failure.
      if (records >= RECORD_LIMIT) return;
      records += 1;
      try {
        emit({ ...event, event: 'unavailable', unavailable: 'diagnostic callback failed' });
      } catch {
        // The diagnostic channel itself is unavailable; no exception escapes.
      }
    }
  };
  return {
    begin(): () => void {
      let active = true;
      let attempt = 0;
      let generation = -1;
      const record = (event: Omit<RecoveryFrameObservation, 'generation' | 'attempt' | 'clock' | 'snapshot'>): void => {
        if (!active || records >= RECORD_LIMIT) return;
        if (records === RECORD_LIMIT - 1) {
          deliver({ event: 'unavailable', generation, attempt, clock: readyClock(), unavailable: 'diagnostic record limit reached' });
          return;
        }
        deliver({ ...event, generation, attempt, clock: readyClock(), snapshot: readySnapshot(renderer) });
      };
      const observe = (receipt: FrameReceipt, event: 'preparation-settled' | 'completion-settled', promise: FrameReceipt['completed']) => {
        void promise.then(
          (result) => {
            if (active) record({
              event, outcome: result.ok ? 'ok' : 'error', receipt: facts(receipt),
              ...(result.ok ? {} : { error: readyError(result.error) }),
            });
          },
          (cause: unknown) => {
            if (active) record({ event, outcome: 'rejected', error: readyError(cause), receipt: facts(receipt) });
          },
        ).catch(() => record({ event: 'unavailable', unavailable: 'receipt observation failed' }));
      };
      let unsubscribe: (() => void) | undefined;
      const stop = () => {
        if (!active) return;
        active = false;
        try {
          unsubscribe?.();
        } catch {
          deliver({ event: 'unavailable', generation, attempt, clock: readyClock(), unavailable: 'renderer unsubscription failed' });
        } finally {
          try {
            signal?.removeEventListener('abort', stop);
          } catch {
            deliver({ event: 'unavailable', generation, attempt, clock: readyClock(), unavailable: 'diagnostic scope cleanup failed' });
          }
        }
      };
      try {
        generation = renderer.currentDeviceGeneration?.() ?? renderer.inspect({ fields: ['frame'] }).frame.deviceGeneration;
        if (generations.has(generation) || signal?.aborted) return stop;
        generations.add(generation);
        unsubscribe = renderer.subscribe((event) => {
          if (!active || records >= RECORD_LIMIT || event.kind !== 'frame-submitted' || event.deviceGeneration !== generation) return;
          attempt += 1;
          try {
            const receipt = event.receipt;
            record({ event: 'submitted', receipt: facts(receipt) });
            if (receipt.preparationCompleted !== undefined)
              observe(receipt, 'preparation-settled', receipt.preparationCompleted);
            observe(receipt, 'completion-settled', receipt.completed);
          } catch {
            record({ event: 'unavailable', unavailable: 'submitted receipt observation failed' });
          }
        });
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
      } catch {
        record({ event: 'unavailable', unavailable: 'renderer subscription failed' });
        stop();
      }
      return stop;
    },
  };
}

function facts(receipt: FrameReceipt): NonNullable<RecoveryFrameObservation['receipt']> {
  const reason = receipt.presentationPendingReason;
  return {
    frameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    presentation: receipt.presentation,
    ...(reason === undefined ? {} : { pendingReason: {
      code: reason.code,
      ...(reason.worldId === undefined ? {} : { worldId: reason.worldId }),
      ...(reason.entity === undefined ? {} : { entity: reason.entity }),
      ...(reason.submesh === undefined ? {} : { submesh: reason.submesh }),
      ...(reason.section === undefined ? {} : { section: reason.section }),
      ...(reason.preparationStage === undefined ? {} : { preparationStage: reason.preparationStage }),
    } }),
    hasPreparation: receipt.preparationCompleted !== undefined,
  };
}
