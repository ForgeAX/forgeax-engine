export interface TimeResource {
  readonly delta: number;
  readonly elapsed: number;
  readonly maxDeltaSeconds: number;
}

export interface FixedTimeResource {
  readonly delta: number;
  readonly maxStepsPerUpdate: number;
  readonly tick: number;
  /** Seconds accumulated toward the next fixed update. */
  readonly overstep: number;
  readonly droppedSeconds: number;
  readonly droppedUpdates: number;
}

export type MutableTimeResource = { -readonly [K in keyof TimeResource]: TimeResource[K] };
export type MutableFixedTimeResource = {
  -readonly [K in keyof FixedTimeResource]: FixedTimeResource[K];
};

/** Scheduler-only mutable clock capability; World never exposes this publicly. */
export interface ClockWriter {
  readonly time: MutableTimeResource;
  readonly fixed: MutableFixedTimeResource;
}

export interface WorldClock {
  readonly time: TimeResource;
  readonly fixed: FixedTimeResource;
  readonly writer: ClockWriter;
}

interface ResourceToken<T> {
  readonly name: string;
  readonly __resourceType?: T;
}

export interface TimePolicy {
  readonly fixedDeltaSeconds?: number;
  readonly maxStepsPerUpdate?: number;
  readonly maxDeltaSeconds?: number;
}

export interface WorldOptions {
  readonly time?: TimePolicy;
  /** SAB-backed dense numeric columns for a SharedKernel-capable Engine Realm. */
  readonly storage?: 'local' | 'shared';
}

/** World-owned variable-rate clock resource key. */
export const Time = Object.freeze({ name: 'Time' }) as ResourceToken<TimeResource> & TimeResource;
/** World-owned fixed-rate clock, policy, and catch-up metric resource key. */
export const FixedTime = Object.freeze({ name: 'FixedTime' }) as ResourceToken<FixedTimeResource> &
  FixedTimeResource;

export const TIME_RESOURCE_KEY = Time.name;
export const FIXED_TIME_RESOURCE_KEY = FixedTime.name;

export const DEFAULT_TIME_POLICY: Required<TimePolicy> = {
  fixedDeltaSeconds: 1 / 60,
  maxStepsPerUpdate: 4,
  maxDeltaSeconds: 0.1,
};

export function createTimeResource(policy: Required<TimePolicy>): TimeResource {
  return { delta: 0, elapsed: 0, maxDeltaSeconds: policy.maxDeltaSeconds };
}

export function createFixedTimeResource(policy: Required<TimePolicy>): FixedTimeResource {
  return {
    delta: policy.fixedDeltaSeconds,
    maxStepsPerUpdate: policy.maxStepsPerUpdate,
    tick: 0,
    overstep: 0,
    droppedSeconds: 0,
    droppedUpdates: 0,
  };
}

export function createWorldClock(policy: Required<TimePolicy>): WorldClock {
  const time = createTimeResource(policy) as MutableTimeResource;
  const fixed = createFixedTimeResource(policy) as MutableFixedTimeResource;
  const timeView: TimeResource = Object.freeze({
    get delta() {
      return time.delta;
    },
    get elapsed() {
      return time.elapsed;
    },
    get maxDeltaSeconds() {
      return time.maxDeltaSeconds;
    },
  });
  const fixedView: FixedTimeResource = Object.freeze({
    get delta() {
      return fixed.delta;
    },
    get maxStepsPerUpdate() {
      return fixed.maxStepsPerUpdate;
    },
    get tick() {
      return fixed.tick;
    },
    get overstep() {
      return fixed.overstep;
    },
    get droppedSeconds() {
      return fixed.droppedSeconds;
    },
    get droppedUpdates() {
      return fixed.droppedUpdates;
    },
  });
  return {
    time: timeView,
    fixed: fixedView,
    writer: { time, fixed },
  };
}
