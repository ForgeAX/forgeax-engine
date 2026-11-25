import { ok } from '@forgeax/engine-types';
import { platformError } from './errors.js';
import type { PlatformClock } from './index.js';

/** Best-effort milliseconds for local timings. The wall-clock fallback can move backwards. */
export function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** Normalize a native clock once at its owner boundary, without wall-clock fallback. */
export function createPlatformClock(
  read: () => number,
  unit: 'milliseconds' | 'microseconds',
): PlatformClock {
  let previous: number | undefined;
  return {
    now() {
      let current: number;
      try {
        current = read() / (unit === 'microseconds' ? 1000 : 1);
      } catch (cause) {
        return platformError('platform-operation-failed', { operation: 'clock.now', cause });
      }
      if (
        !Number.isFinite(current) ||
        current < 0 ||
        (previous !== undefined && current < previous)
      ) {
        return platformError('platform-clock-invalid', { previous, current });
      }
      previous = current;
      return ok(current);
    },
  };
}
