import type { World } from '@forgeax/engine-ecs';
import { scheduleWorkNames } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';

export function renderSystemPhase(schedule: string, system: string): string {
  return `ecs/system/${JSON.stringify([schedule, system])}`;
}

export function renderSystemInvocationPhase(schedule: string, system: string): string {
  return `ecs/system-invocation/${JSON.stringify([schedule, system])}`;
}

export function renderCommandDrainPhase(schedule: string): string {
  return `ecs/command-drain/${JSON.stringify([schedule])}`;
}

export function renderWorkPhase(work: string): string {
  return `ecs/work/${JSON.stringify([work])}`;
}

export function renderSchedulePhaseCatalog(world: World): readonly string[] {
  const phases = new Set<string>();
  for (const work of scheduleWorkNames(world)) phases.add(renderWorkPhase(work));
  for (const schedule of world.scheduleData()) {
    phases.add(renderCommandDrainPhase(schedule.name));
    for (const system of schedule.systems) {
      phases.add(renderSystemPhase(schedule.name, system.name));
      phases.add(renderSystemInvocationPhase(schedule.name, system.name));
    }
  }
  return [...phases].sort();
}

export function observeRenderScheduleRuns(world: World, session: RecorderSession): () => void {
  const open: boolean[] = [];
  const begin = (phase: string) => {
    try {
      open.push(session.beginPhase('render', phase).ok);
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
      // The observer stack still unwinds; instrumentation cannot stop Render.
    }
  };
  return world.observeScheduleRuns({
    onSystemStart(schedule, system) {
      begin(renderSystemPhase(schedule, system));
    },
    onSystemFunctionStart(schedule, system) {
      begin(renderSystemInvocationPhase(schedule, system));
    },
    onSystemFunctionEnd() {
      end();
    },
    onSystemEnd(schedule, system, outcome) {
      end();
      if (outcome === 'invoked') return;
      try {
        session.recordSkip({
          source: 'render',
          phase: renderSystemPhase(schedule, system),
          reason: `system-${outcome}`,
        });
      } catch {
        // Diagnostics cannot change Render execution.
      }
    },
    onCommandDrainStart(schedule) {
      begin(renderCommandDrainPhase(schedule));
    },
    onCommandDrainEnd() {
      end();
    },
    onWorkStart(work) {
      begin(renderWorkPhase(work));
    },
    onWorkEnd() {
      end();
    },
  });
}

export function runProfiledRenderSchedule<T>(
  world: World,
  session: RecorderSession | undefined,
  run: () => T,
): T {
  if (session === undefined || session.detail !== 'nested') return run();
  const release = observeRenderScheduleRuns(world, session);
  try {
    return run();
  } finally {
    release();
  }
}
