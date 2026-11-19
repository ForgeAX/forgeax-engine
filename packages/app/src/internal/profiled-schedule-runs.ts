import type { World } from '@forgeax/engine-ecs';
import { scheduleWorkNames } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';

export function appSystemPhase(schedule: string, system: string): string {
  return `ecs/system/${JSON.stringify([schedule, system])}`;
}

export function appSystemInvocationPhase(schedule: string, system: string): string {
  return `ecs/system-invocation/${JSON.stringify([schedule, system])}`;
}

export function appCommandDrainPhase(schedule: string): string {
  return `ecs/command-drain/${JSON.stringify([schedule])}`;
}

export function appWorkPhase(work: string): string {
  return `ecs/work/${JSON.stringify([work])}`;
}

export function appSchedulePhaseCatalog(worlds: Iterable<World>): readonly string[] {
  const phases = new Set<string>();
  for (const world of worlds) {
    for (const work of scheduleWorkNames(world)) phases.add(appWorkPhase(work));
    for (const schedule of world.scheduleData()) {
      phases.add(appCommandDrainPhase(schedule.name));
      for (const system of schedule.systems) {
        phases.add(appSystemPhase(schedule.name, system.name));
        phases.add(appSystemInvocationPhase(schedule.name, system.name));
      }
    }
  }
  return [...phases].sort();
}

export function observeAppScheduleRuns(world: World, session: RecorderSession): () => void {
  const open: boolean[] = [];
  const begin = (phase: string) => {
    try {
      open.push(session.beginPhase('app', phase).ok);
    } catch {
      open.push(false);
    }
  };
  const end = () => {
    const opened = open.pop();
    if (opened !== true) return;
    try {
      session.endPhase();
    } catch {
      // The observer stack still unwinds; instrumentation cannot stop App.
    }
  };
  return world.observeScheduleRuns({
    onSystemStart(schedule, system) {
      begin(appSystemPhase(schedule, system));
    },
    onSystemEnd(schedule, system, outcome) {
      end();
      if (outcome === 'invoked') return;
      try {
        session.recordSkip({
          source: 'app',
          phase: appSystemPhase(schedule, system),
          reason: `system-${outcome}`,
        });
      } catch {
        // Diagnostics cannot change App execution.
      }
    },
    onSystemFunctionStart(schedule, system) {
      begin(appSystemInvocationPhase(schedule, system));
    },
    onSystemFunctionEnd() {
      end();
    },
    onCommandDrainStart(schedule) {
      begin(appCommandDrainPhase(schedule));
    },
    onCommandDrainEnd() {
      end();
    },
    onWorkStart(work) {
      begin(appWorkPhase(work));
    },
    onWorkEnd() {
      end();
    },
  });
}
