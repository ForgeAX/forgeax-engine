import { describe, expect, it } from 'vitest';
import {
  beginScheduleWork,
  defineComponent,
  defineSystem,
  defineSystemSet,
  registerScheduleWork,
  scheduleWorkNames,
  Update,
  World,
} from '../index.js';

describe('schedule work observation', () => {
  it('declares names and pairs observed system, invocation, work, and drain boundaries', () => {
    const world = new World();
    const releaseWork = registerScheduleWork(world, 'water/test/query');
    const events: string[] = [];
    world.addSystem(
      Update,
      defineSystem({
        name: 'observed',
        commands: 'deferred',
        queries: [],
        fn: () => {
          const scope = beginScheduleWork(world, 'water/test/query');
          try {
            events.push('work');
          } finally {
            scope?.end();
          }
        },
      }),
    );

    const releaseObserver = world.observeScheduleRuns({
      onSystemStart: (schedule, system) => events.push(`system+ ${schedule}/${system}`),
      onSystemFunctionStart: (schedule, system) => events.push(`invoke+ ${schedule}/${system}`),
      onSystemFunctionEnd: (schedule, system) => events.push(`invoke- ${schedule}/${system}`),
      onSystemEnd: (schedule, system, outcome) =>
        events.push(`system- ${schedule}/${system} ${outcome}`),
      onWorkStart: (work) => events.push(`work+ ${work}`),
      onWorkEnd: (work) => events.push(`work- ${work}`),
      onCommandDrainStart: (schedule) => events.push(`drain+ ${schedule}`),
      onCommandDrainEnd: (schedule) => events.push(`drain- ${schedule}`),
    });

    expect(scheduleWorkNames(world)).toEqual(['water/test/query']);
    expect(world.update().ok).toBe(true);
    expect(events).toEqual([
      'system+ Update/observed',
      'invoke+ Update/observed',
      'work+ water/test/query',
      'work',
      'work- water/test/query',
      'invoke- Update/observed',
      'system- Update/observed invoked',
      'drain+ Update',
      'drain- Update',
    ]);

    releaseObserver();
    releaseWork();
    expect(scheduleWorkNames(world)).toEqual([]);
  });

  it('observes a predecessor drain before a set-gated dependent system is skipped', () => {
    const world = new World();
    const Value = defineComponent('schedule-observation-deferred-value', { value: 'f32' });
    const events: string[] = [];
    const drainVisibleRows: number[] = [];
    const gatedSet = defineSystemSet({
      name: 'schedule-observation-gated-set',
      runIf: () => false,
    });
    const producer = defineSystem({
      name: 'deferred-producer',
      queries: [],
      fn: (_world, _queries, commands) => {
        commands.spawn({ component: Value, data: { value: 7 } });
      },
    });
    world.addSystem(Update, producer).unwrap();
    world
      .addSystems(Update, gatedSet, [
        defineSystem({
          name: 'gated-dependent',
          commands: 'none',
          after: [producer],
          queries: [],
          fn: () => {
            throw new Error('the set condition must skip this function');
          },
        }),
      ])
      .unwrap();
    world.observeScheduleRuns({
      onSystemStart: (_schedule, system) => events.push(`system+:${system}`),
      onSystemEnd: (_schedule, system, outcome) => events.push(`system-:${system}:${outcome}`),
      onCommandDrainStart: () => events.push('drain+'),
      onCommandDrainEnd: () => {
        const rows = world.query({ read: [Value] }).unwrap();
        let count = 0;
        rows.forEach(() => {
          count += 1;
        });
        drainVisibleRows.push(count);
        events.push('drain-');
      },
    });

    expect(world.update(0).ok).toBe(true);
    expect(drainVisibleRows[0]).toBe(1);
    expect(events.indexOf('drain-')).toBeLessThan(
      events.indexOf('system-:gated-dependent:skipped'),
    );
    expect(events).toContain('system-:gated-dependent:skipped');
  });

  it('isolates observer failures from World execution', () => {
    const world = new World();
    let invoked = false;
    world.addSystem(
      Update,
      defineSystem({ name: 'still-runs', queries: [], fn: () => (invoked = true) }),
    );
    world.observeScheduleRuns({
      onSystemStart: () => {
        throw new Error('observer failure');
      },
      onSystemFunctionEnd: () => {
        throw new Error('observer failure');
      },
    });

    expect(world.update().ok).toBe(true);
    expect(invoked).toBe(true);
  });

  it('pins one observer through unsubscription and uses a re-registered observer next time', () => {
    const world = new World();
    world.addSystem(Update, defineSystem({ name: 'stable-system', queries: [], fn: () => {} }));
    const events: string[] = [];
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    let swapped = false;
    releaseFirst = world.observeScheduleRuns({
      onSystemStart: () => {
        events.push('first:start');
        if (swapped) return;
        swapped = true;
        releaseFirst();
        releaseSecond = world.observeScheduleRuns({
          onSystemStart: () => events.push('second:start'),
          onSystemEnd: (_schedule, _system, outcome) => events.push(`second:end:${outcome}`),
        });
      },
      onSystemEnd: (_schedule, _system, outcome) => events.push(`first:end:${outcome}`),
    });

    expect(world.update().ok).toBe(true);
    expect(events).toEqual(['first:start', 'first:end:invoked']);
    expect(world.update().ok).toBe(true);
    expect(events).toEqual([
      'first:start',
      'first:end:invoked',
      'second:start',
      'second:end:invoked',
    ]);
    releaseSecond();
  });

  it('distinguishes condition skips, failures before invoke, and failed invokes', () => {
    const observe = (world: World) => {
      const events: string[] = [];
      world.observeScheduleRuns({
        onSystemStart: (_schedule, system) => events.push(`system+:${system}`),
        onSystemFunctionStart: (_schedule, system) => events.push(`invoke+:${system}`),
        onSystemFunctionEnd: (_schedule, system) => events.push(`invoke-:${system}`),
        onSystemEnd: (_schedule, system, outcome) => events.push(`system-:${system}:${outcome}`),
      });
      return events;
    };

    const skippedWorld = new World();
    skippedWorld.addSystem(
      Update,
      defineSystem({
        name: 'skip',
        queries: [],
        runIf: () => false,
        fn: () => {
          throw new Error('skipped function must not run');
        },
      }),
    );
    const skipped = observe(skippedWorld);
    expect(skippedWorld.update().ok).toBe(true);
    expect(skipped).toEqual(['system+:skip', 'system-:skip:skipped']);

    const failedBeforeWorld = new World();
    failedBeforeWorld.addSystem(
      Update,
      defineSystem({
        name: 'condition-fails',
        queries: [],
        runIf: () => {
          throw new Error('run condition failed');
        },
        fn: () => {
          throw new Error('function must not run');
        },
      }),
    );
    const failedBefore = observe(failedBeforeWorld);
    expect(failedBeforeWorld.update().ok).toBe(false);
    expect(failedBefore).toEqual([
      'system+:condition-fails',
      'system-:condition-fails:failed-before-invoke',
    ]);

    const failedInvokeWorld = new World();
    failedInvokeWorld.addSystem(
      Update,
      defineSystem({
        name: 'invoke-fails',
        queries: [],
        fn: () => {
          throw new Error('invoke failed');
        },
      }),
    );
    const failedInvoke = observe(failedInvokeWorld);
    expect(failedInvokeWorld.update().ok).toBe(false);
    expect(failedInvoke).toEqual([
      'system+:invoke-fails',
      'invoke+:invoke-fails',
      'invoke-:invoke-fails',
      'system-:invoke-fails:failed-invoke',
    ]);
  });

  it('measures only the system function body inside the wider invocation lifecycle', () => {
    const world = new World();
    let now = 0;
    let functionStart = -1;
    let functionEnd = -1;
    world.addSystem(
      Update,
      defineSystem({
        name: 'timed-function',
        commands: 'deferred',
        queries: [],
        fn: () => {
          now += 7;
        },
      }),
    );
    world.observeScheduleRuns({
      onSystemStart: () => {
        now += 5;
      },
      onSystemFunctionStart: () => {
        functionStart = now;
      },
      onSystemFunctionEnd: () => {
        functionEnd = now;
      },
      onSystemEnd: () => {
        now += 11;
      },
    });

    expect(world.update().ok).toBe(true);
    expect(functionEnd - functionStart).toBe(7);
    expect(now).toBe(23);
  });
});
