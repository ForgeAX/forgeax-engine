import type { RendererState } from '../render-contract';

/** Lifecycle states that may accept a new frame operation. */
export function isRendererStateOperational(state: RendererState): boolean {
  return state === 'alive';
}

export const RECOVERY_TOTAL_DEADLINE_MS = 20_000;
export const RECOVERY_ADAPTER_DEADLINE_MS = 10_000;
export const RECOVERY_DEVICE_DEADLINE_MS = 10_000;

export const RECOVERY_PHASES = [
  'quiesce',
  'acquire-adapter',
  'acquire-device',
  'rehydrate',
  'compile-graph',
  'publish',
  'cleanup',
] as const;

export type RecoveryPhase = (typeof RECOVERY_PHASES)[number];
export type RecoveryGuidance = 'retry' | 'repair-owner' | 'rebuild-renderer';

const RENDERER_STATES = [
  'alive',
  'device-lost',
  'recovering',
  'faulted',
  'disposed',
] as const satisfies readonly RendererState[];

const ALLOWED_TRANSITIONS: Readonly<Record<RendererState, readonly RendererState[]>> = {
  alive: ['device-lost', 'faulted', 'disposed'],
  'device-lost': ['recovering', 'faulted', 'disposed'],
  recovering: ['alive', 'device-lost', 'faulted', 'disposed'],
  faulted: ['disposed'],
  disposed: [],
};

export interface RendererLifecycle {
  state(): RendererState;
  transition(next: RendererState): boolean;
  states(): readonly RendererState[];
}

export function createRendererLifecycle(initial: RendererState = 'alive'): RendererLifecycle {
  if (!RENDERER_STATES.includes(initial)) {
    throw new RangeError(`Unknown renderer lifecycle state: ${initial}`);
  }
  let current = initial;
  return {
    state: () => current,
    transition: (next) => {
      if (!ALLOWED_TRANSITIONS[current].includes(next)) return false;
      current = next;
      return true;
    },
    states: () => RENDERER_STATES,
  };
}

export interface RecoveryDeadline {
  readonly startedAt: number;
  readonly totalDeadlineMs: number;
  readonly adapterDeadlineMs: number;
  readonly deviceDeadlineMs: number;
  readonly deadlineAt: number;
  beginDeviceAcquisition(now: number): void;
  isValid(phase: RecoveryPhase, now: number): boolean;
  elapsed(now: number): number;
}

export function createRecoveryDeadline(startedAt: number): RecoveryDeadline {
  if (!Number.isFinite(startedAt)) throw new RangeError('Recovery deadline requires finite time.');
  const deadlineAt = startedAt + RECOVERY_TOTAL_DEADLINE_MS;
  let deviceAcquisitionStartedAt: number | undefined;
  return {
    startedAt,
    totalDeadlineMs: RECOVERY_TOTAL_DEADLINE_MS,
    adapterDeadlineMs: RECOVERY_ADAPTER_DEADLINE_MS,
    deviceDeadlineMs: RECOVERY_DEVICE_DEADLINE_MS,
    deadlineAt,
    beginDeviceAcquisition: (now) => {
      if (!Number.isFinite(now)) throw new RangeError('Device acquisition requires finite time.');
      deviceAcquisitionStartedAt ??= now;
    },
    isValid: (phase, now) => {
      const phaseDeadline =
        phase === 'acquire-adapter'
          ? startedAt + RECOVERY_ADAPTER_DEADLINE_MS
          : phase === 'acquire-device'
            ? Math.min(
                (deviceAcquisitionStartedAt ?? startedAt) + RECOVERY_DEVICE_DEADLINE_MS,
                deadlineAt,
              )
            : deadlineAt;
      return Number.isFinite(now) && now < phaseDeadline;
    },
    elapsed: (now) => Math.max(0, now - startedAt),
  };
}

export interface RecoveryContinuation {
  isValid(phase: RecoveryPhase, now: number): boolean;
  abandon(now: number): void;
  cleanupOnce(): void;
}

export function createRecoveryContinuation(
  deadline: RecoveryDeadline,
  cleanup: () => void,
): RecoveryContinuation {
  let valid = true;
  let cleaned = false;
  return {
    isValid: (phase, now) => {
      if (!valid || !deadline.isValid(phase, now)) {
        valid = false;
        return false;
      }
      return true;
    },
    abandon: (now) => {
      if (!deadline.isValid('cleanup', now)) valid = false;
      valid = false;
    },
    cleanupOnce: () => {
      if (cleaned) return;
      cleaned = true;
      cleanup();
    },
  };
}

export interface SingleFlight<T> {
  run(): Promise<T>;
  inFlight(): Promise<T> | undefined;
}

export function createSingleFlight<T>(factory: () => Promise<T>): SingleFlight<T> {
  let active: Promise<T> | undefined;
  return {
    run: () => {
      if (active !== undefined) return active;
      let promise: Promise<T>;
      try {
        promise = factory();
      } catch (cause) {
        promise = Promise.reject(cause);
      }
      active = promise;
      promise.then(
        () => {
          if (active === promise) active = undefined;
        },
        () => {
          if (active === promise) active = undefined;
        },
      );
      return promise;
    },
    inFlight: () => active,
  };
}
