import { Time, Update, type World } from '@forgeax/engine-ecs';

const COUNTDOWN_KEY = 'Countdown';
const ENTITY_TIMER_COMPONENT = 'PrintOnCompletionTimer';

interface Timer {
  duration: number;
  accumulator: number;
  repeating: boolean;
  finished: boolean;
}

export interface TimerState {
  countdownFired: number;
  countdownPercent: number[];
  entityTimerFired: boolean;
}

export function buildTimersWorld(world: World): { getState: () => TimerState } {
  // Resource: Countdown with two timers (scaled for smoke: 0.2s repeating + 2s once)
  world.insertResource<Timer[]>(COUNTDOWN_KEY, [
    { duration: 0.2, accumulator: 0, repeating: true, finished: false },
    { duration: 2.0, accumulator: 0, repeating: false, finished: false },
  ]);

  // Entity timer as a component stored in a resource
  const entityTimer: Timer = { duration: 0.5, accumulator: 0, repeating: false, finished: false };
  world.insertResource<Timer>(ENTITY_TIMER_COMPONENT, entityTimer);

  const state: TimerState = { countdownFired: 0, countdownPercent: [], entityTimerFired: false };

  world.addSystem(Update, {
    name: 'countdown',
    queries: [],
    fn: (_world) => {
      const time = _world.getResource(Time);
      const timers = _world.getResource<Timer[]>(COUNTDOWN_KEY);
      if (!timers || !time) return;

      const percentTrigger = timers[0]!;
      const mainTimer = timers[1]!;

      mainTimer.accumulator += time.delta;
      if (mainTimer.accumulator >= mainTimer.duration && !mainTimer.finished) {
        mainTimer.finished = true;
      }

      percentTrigger.accumulator += time.delta;
      if (percentTrigger.accumulator >= percentTrigger.duration) {
        percentTrigger.accumulator -= percentTrigger.duration;
        if (!mainTimer.finished) {
          const fraction = Math.min(mainTimer.accumulator / mainTimer.duration, 1);
          state.countdownPercent.push(Math.round(fraction * 100));
        }
        state.countdownFired += 1;
      }
    },
  });

  world.addSystem(Update, {
    name: 'print-when-completed',
    queries: [],
    fn: (_world) => {
      const time = _world.getResource(Time);
      const timer = _world.getResource<Timer>(ENTITY_TIMER_COMPONENT);
      if (!timer || !time) return;

      if (timer.finished) return;
      timer.accumulator += time.delta;
      if (timer.accumulator >= timer.duration) {
        timer.finished = true;
        state.entityTimerFired = true;
      }
    },
  });

  return { getState: () => state };
}