import type { World } from './world';

/** Generic synchronous execution boundary for the owning host's diagnostics. */
export interface ScheduleRunObserver {
  onWorkStart?(work: string): void;
  onWorkEnd?(work: string): void;
  onSystemStart?(schedule: string, system: string): void;
  onSystemEnd?(
    schedule: string,
    system: string,
    outcome: 'skipped' | 'failed-before-invoke' | 'invoked' | 'failed-invoke',
  ): void;
  onSystemFunctionStart?(schedule: string, system: string): void;
  onSystemFunctionEnd?(schedule: string, system: string): void;
  onCommandDrainStart?(schedule: string): void;
  onCommandDrainEnd?(schedule: string): void;
}

export interface ScheduleRunScope {
  functionStart(): void;
  functionEnd(): void;
  end(outcome: 'skipped' | 'failed-before-invoke' | 'invoked' | 'failed-invoke'): void;
}

export interface CommandDrainScope {
  end(): void;
}

export interface ScheduleWorkScope {
  end(): void;
}

interface ScheduleObservationOwner {
  readonly observers: Set<ScheduleRunObserver>;
  readonly work: Map<string, number>;
}

const owners = new WeakMap<World, ScheduleObservationOwner>();

function ownerOf(world: World): ScheduleObservationOwner {
  let owner = owners.get(world);
  if (owner === undefined) {
    owner = { observers: new Set(), work: new Map() };
    owners.set(world, owner);
  }
  return owner;
}

function deleteOwnerIfEmpty(world: World): void {
  const owner = owners.get(world);
  if (owner?.observers.size === 0 && owner.work.size === 0) owners.delete(world);
}

/** Declare an owner-named synchronous work boundary for host diagnostics. */
export function registerScheduleWork(world: World, work: string): () => void {
  const entries = ownerOf(world).work;
  entries.set(work, (entries.get(work) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const count = entries.get(work);
    if (count === undefined) return;
    if (count <= 1) entries.delete(work);
    else entries.set(work, count - 1);
    deleteOwnerIfEmpty(world);
  };
}

/** Names declared by installed systems, used by owners to snapshot phase catalogs. */
export function scheduleWorkNames(world: World): readonly string[] {
  return [...(owners.get(world)?.work.keys() ?? [])].sort();
}

/** Open an owner-named synchronous operation only while diagnostics observe this World. */
export function beginScheduleWork(world: World, work: string): ScheduleWorkScope | undefined {
  const current = owners.get(world)?.observers;
  if (current === undefined || current.size === 0) return undefined;
  const roster = [...current];
  for (const observer of roster) {
    try {
      observer.onWorkStart?.(work);
    } catch {
      // Diagnostics cannot change schedule execution.
    }
  }
  let active = true;
  return {
    end() {
      if (!active) return;
      active = false;
      for (let index = roster.length - 1; index >= 0; index--) {
        try {
          roster[index]?.onWorkEnd?.(work);
        } catch {
          // Diagnostics cannot change schedule execution.
        }
      }
    },
  };
}

/** Execute an owner-named synchronous operation when diagnostics are observing this World. */
export function runScheduleWork<T>(world: World, work: string, run: () => T): T {
  const scope = beginScheduleWork(world, work);
  try {
    return run();
  } finally {
    scope?.end();
  }
}

export function observeScheduleRuns(world: World, observer: ScheduleRunObserver): () => void {
  const current = ownerOf(world).observers;
  current.add(observer);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    current.delete(observer);
    deleteOwnerIfEmpty(world);
  };
}

export function hasScheduleRunObservers(world: World): boolean {
  const current = owners.get(world)?.observers;
  return current !== undefined && current.size > 0;
}

export function beginScheduleSystem(
  world: World,
  schedule: string,
  system: string,
): ScheduleRunScope | undefined {
  const current = owners.get(world)?.observers;
  if (current === undefined || current.size === 0) return undefined;
  // Pin this invocation's observers. Unsubscription/re-registration during a
  // callback affects only the next boundary and cannot break start/end pairs.
  const roster = [...current];
  for (const observer of roster) {
    try {
      observer.onSystemStart?.(schedule, system);
    } catch {
      // Diagnostics cannot change schedule execution.
    }
  }
  return {
    functionStart() {
      for (const observer of roster) {
        try {
          observer.onSystemFunctionStart?.(schedule, system);
        } catch {
          // Diagnostics cannot change schedule execution.
        }
      }
    },
    functionEnd() {
      for (let index = roster.length - 1; index >= 0; index--) {
        try {
          roster[index]?.onSystemFunctionEnd?.(schedule, system);
        } catch {
          // Diagnostics cannot change schedule execution.
        }
      }
    },
    end(outcome) {
      for (let index = roster.length - 1; index >= 0; index--) {
        try {
          roster[index]?.onSystemEnd?.(schedule, system, outcome);
        } catch {
          // Diagnostics cannot change schedule execution.
        }
      }
    },
  };
}

export function beginScheduleCommandDrain(
  world: World,
  schedule: string,
): CommandDrainScope | undefined {
  const current = owners.get(world)?.observers;
  if (current === undefined || current.size === 0) return undefined;
  const roster = [...current];
  for (const observer of roster) {
    try {
      observer.onCommandDrainStart?.(schedule);
    } catch {
      // Diagnostics cannot change schedule execution.
    }
  }
  return {
    end() {
      for (let index = roster.length - 1; index >= 0; index--) {
        try {
          roster[index]?.onCommandDrainEnd?.(schedule);
        } catch {
          // Diagnostics cannot change schedule execution.
        }
      }
    },
  };
}
