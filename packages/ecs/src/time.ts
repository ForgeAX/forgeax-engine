import type { AssetReferenceOwner } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { TimeScaleInvalidError, TimeScaleLeaseReleasedError } from './errors';
import type { WorldMemoryOptions } from './memory-types';
import { defineResource } from './resource';

export interface TimeResource {
  readonly delta: number;
  readonly elapsed: number;
  /** Raw host time, unaffected by scale or catch-up caps. */
  readonly unscaledDelta: number;
  readonly unscaledElapsed: number;
  /** Effective scale sampled at the update boundary. */
  readonly scale: number;
  readonly maxDeltaSeconds: number;
}

export interface FixedTimeResource {
  readonly delta: number;
  readonly maxStepsPerUpdate: number;
  readonly tick: number;
  /** Seconds accumulated toward the next fixed update. */
  readonly overstep: number;
  /** How a frame that owes several fixed steps catches up (see {@link TimePolicy.fixedCatchUp}). */
  readonly catchUp: FixedCatchUp;
  /**
   * Simulated seconds of the most recent FixedUpdate run. Equals `delta`
   * except after a merged catch-up, where one run advanced several steps.
   * Presentation interpolation spans this interval.
   */
  readonly stepDelta: number;
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
  readonly effectiveScale: () => number;
}

export interface WorldClock {
  readonly time: TimeResource;
  readonly fixed: FixedTimeResource;
  readonly writer: ClockWriter;
  readonly acquireTimeScale: (scale: number) => Result<TimeScaleLease, TimeScaleInvalidError>;
}

/** An owned contribution. The smallest active scale wins; release is idempotent. */
export interface TimeScaleLease {
  readonly active: boolean;
  readonly scale: number;
  set(scale: number): Result<void, TimeScaleInvalidError | TimeScaleLeaseReleasedError>;
  release(): void;
}

/**
 * `substeps` runs FixedUpdate once per owed step. `merged` runs it once with
 * `FixedTime.delta` set to the owed steps' total (still capped by
 * maxStepsPerUpdate), trading integration precision for one schedule pass.
 */
export type FixedCatchUp = 'substeps' | 'merged';

export interface TimePolicy {
  readonly fixedDeltaSeconds?: number;
  readonly maxStepsPerUpdate?: number;
  readonly maxDeltaSeconds?: number;
  readonly fixedCatchUp?: FixedCatchUp;
}

export interface WorldOptions {
  readonly memory?: WorldMemoryOptions;
  readonly assets?: AssetReferenceOwner;
  readonly time?: TimePolicy;
  /** SAB-backed dense numeric columns for a SharedKernel-capable Engine Realm. */
  readonly storage?: 'local' | 'shared';
}

/** World-owned variable-rate clock resource key. */
export const Time = defineResource<TimeResource>('Time');
/** World-owned fixed-rate clock, policy, and catch-up metric resource key. */
export const FixedTime = defineResource<FixedTimeResource>('FixedTime');

export const DEFAULT_TIME_POLICY: Required<TimePolicy> = {
  fixedDeltaSeconds: 1 / 60,
  maxStepsPerUpdate: 4,
  maxDeltaSeconds: 0.1,
  fixedCatchUp: 'substeps',
};

function createTimeResource(policy: Required<TimePolicy>): TimeResource {
  return {
    delta: 0,
    elapsed: 0,
    unscaledDelta: 0,
    unscaledElapsed: 0,
    scale: 1,
    maxDeltaSeconds: policy.maxDeltaSeconds,
  };
}

function createFixedTimeResource(policy: Required<TimePolicy>): FixedTimeResource {
  return {
    delta: policy.fixedDeltaSeconds,
    maxStepsPerUpdate: policy.maxStepsPerUpdate,
    tick: 0,
    overstep: 0,
    catchUp: policy.fixedCatchUp === 'merged' ? 'merged' : 'substeps',
    stepDelta: policy.fixedDeltaSeconds,
    droppedSeconds: 0,
    droppedUpdates: 0,
  };
}

export function createWorldClock(policy: Required<TimePolicy>): WorldClock {
  const time = createTimeResource(policy) as MutableTimeResource;
  const fixed = createFixedTimeResource(policy) as MutableFixedTimeResource;
  const scales = new Map<symbol, number>();
  const effectiveScale = (): number => {
    let value = Infinity;
    for (const scale of scales.values()) value = Math.min(value, scale);
    return scales.size === 0 ? 1 : value;
  };
  const acquireTimeScale = (initial: number): Result<TimeScaleLease, TimeScaleInvalidError> => {
    if (!Number.isFinite(initial) || initial < 0) return err(new TimeScaleInvalidError(initial));
    const id = Symbol('TimeScaleLease');
    let active = true;
    let scale = initial;
    scales.set(id, scale);
    return ok(
      Object.freeze({
        get active() {
          return active;
        },
        get scale() {
          return scale;
        },
        set(next: number): Result<void, TimeScaleInvalidError | TimeScaleLeaseReleasedError> {
          if (!active) return err(new TimeScaleLeaseReleasedError());
          if (!Number.isFinite(next) || next < 0) return err(new TimeScaleInvalidError(next));
          scale = next;
          scales.set(id, next);
          return ok(undefined);
        },
        release() {
          if (active) {
            active = false;
            scales.delete(id);
          }
        },
      }),
    );
  };
  const timeView: TimeResource = Object.freeze({
    get delta() {
      return time.delta;
    },
    get elapsed() {
      return time.elapsed;
    },
    get unscaledDelta() {
      return time.unscaledDelta;
    },
    get unscaledElapsed() {
      return time.unscaledElapsed;
    },
    get scale() {
      return time.scale;
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
    get catchUp() {
      return fixed.catchUp;
    },
    get stepDelta() {
      return fixed.stepDelta;
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
    writer: { time, fixed, effectiveScale },
    acquireTimeScale,
  };
}
