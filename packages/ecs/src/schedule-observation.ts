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

export interface CommandDrainScope {
  end(): void;
}

export interface ScheduleWorkScope {
  end(): void;
}

export const scheduleObservers = Symbol('scheduleObservers');

const workNames = new WeakMap<World, Map<string, number>>();

/** Declare an owner-named synchronous work boundary for host diagnostics. */
export function registerScheduleWork(world: World, work: string): () => void {
  let entries = workNames.get(world);
  if (entries === undefined) {
    entries = new Map();
    workNames.set(world, entries);
  }
  entries.set(work, (entries.get(work) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const count = entries.get(work);
    if (count === undefined) return;
    if (count <= 1) entries.delete(work);
    else entries.set(work, count - 1);
    if (entries.size === 0) workNames.delete(world);
  };
}

/** Names declared by installed systems, used by owners to snapshot phase catalogs. */
export function scheduleWorkNames(world: World): readonly string[] {
  return [...(workNames.get(world)?.keys() ?? [])].sort();
}

function notify(
  roster: readonly Subscription[],
  reverse: boolean,
  invoke: (observer: ScheduleRunObserver) => void,
): void {
  for (let offset = 0; offset < roster.length; offset++) {
    try {
      const index = reverse ? roster.length - 1 - offset : offset;
      invoke((roster[index] as Subscription).observer);
    } catch {
      // Diagnostics cannot change schedule execution.
    }
  }
}

/** Open an owner-named synchronous operation only while diagnostics observe this World. */
export function beginScheduleWork(world: World, work: string): ScheduleWorkScope | undefined {
  const roster = world[scheduleObservers]?.members;
  if (roster === undefined) return undefined;
  notify(roster, false, (observer) => observer.onWorkStart?.(work));
  let active = true;
  return {
    end() {
      if (!active) return;
      active = false;
      notify(roster, true, (observer) => observer.onWorkEnd?.(work));
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
  const current = world[scheduleObservers]?.members ?? [];
  const existing = current.find((member) => member.observer === observer);
  if (existing !== undefined) return existing.release;
  const subscription: Subscription = {
    observer,
    release() {
      const members = world[scheduleObservers]?.members;
      if (members === undefined || !members.includes(subscription)) return;
      world[scheduleObservers] =
        members.length === 1
          ? undefined
          : new ScheduleObservers(members.filter((member) => member !== subscription));
    },
  };
  world[scheduleObservers] = new ScheduleObservers([...current, subscription]);
  return subscription.release;
}

interface Subscription {
  readonly observer: ScheduleRunObserver;
  release(): void;
}

export function hasScheduleRunObservers(world: World): boolean {
  return world[scheduleObservers] !== undefined;
}

/** Registration publishes a roster. Each system borrows it through completion,
 * including when a callback replaces the world's subscription mid-invocation. */
export class ScheduleObservers {
  constructor(readonly members: readonly Subscription[]) {}

  start(schedule: string, system: string): void {
    for (const { observer } of this.members) {
      try {
        observer.onSystemStart?.(schedule, system);
      } catch {
        // Diagnostics cannot change schedule execution.
      }
    }
  }

  functionStart(schedule: string, system: string): void {
    for (const { observer } of this.members) {
      try {
        observer.onSystemFunctionStart?.(schedule, system);
      } catch {
        // Diagnostics cannot change schedule execution.
      }
    }
  }

  functionEnd(schedule: string, system: string): void {
    for (let index = this.members.length - 1; index >= 0; index--) {
      try {
        this.members[index]?.observer.onSystemFunctionEnd?.(schedule, system);
      } catch {
        // Diagnostics cannot change schedule execution.
      }
    }
  }

  end(
    schedule: string,
    system: string,
    outcome: Parameters<NonNullable<ScheduleRunObserver['onSystemEnd']>>[2],
  ): void {
    for (let index = this.members.length - 1; index >= 0; index--) {
      try {
        this.members[index]?.observer.onSystemEnd?.(schedule, system, outcome);
      } catch {
        // Diagnostics cannot change schedule execution.
      }
    }
  }
}

export function beginScheduleCommandDrain(
  world: World,
  schedule: string,
): CommandDrainScope | undefined {
  const roster = world[scheduleObservers]?.members;
  if (roster === undefined) return undefined;
  notify(roster, false, (observer) => observer.onCommandDrainStart?.(schedule));
  return {
    end() {
      notify(roster, true, (observer) => observer.onCommandDrainEnd?.(schedule));
    },
  };
}
