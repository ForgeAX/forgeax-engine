/**
 * Nominal label for one of the World-owned schedules.
 *
 * Worlds expose the built-in tokens below. A token is both a registration
 * scope and, for FixedUpdate, the intrinsic Update ordering anchor.
 */
export interface ScheduleToken {
  readonly name: string;
}

export type ScheduleName = 'Update' | 'FixedUpdate';

function createScheduleToken(name: ScheduleName): ScheduleToken {
  // The Engine Worker loads its runtime and an execution bootstrap as separate
  // Vite bundles. Keep the two built-in tokens physically shared across those
  // bundles so a plugin's `Update` reference still addresses the owning World
  // schedule instead of becoming an accidental cross-scope edge.
  const registry = globalThis as typeof globalThis & {
    readonly [key: symbol]: ScheduleToken | undefined;
  };
  const key = Symbol.for(`forgeax.ecs.schedule-token.${name}`);
  const existing = registry[key];
  if (existing !== undefined) return existing;
  const token = Object.freeze({ name });
  Object.defineProperty(registry, key, {
    configurable: false,
    enumerable: false,
    value: token,
    writable: false,
  });
  return token;
}

/** Variable-rate World schedule. */
export const Update = createScheduleToken('Update');
/** Fixed-rate World schedule and the intrinsic Update ordering anchor. */
export const FixedUpdate = createScheduleToken('FixedUpdate');
export function isScheduleToken(value: unknown): value is ScheduleToken {
  return value === Update || value === FixedUpdate;
}
