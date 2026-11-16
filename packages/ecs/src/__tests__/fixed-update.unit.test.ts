import { describe, expect, it } from 'vitest';
import type { CommandBuffer } from '../commands';
import { defineComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { deferFixedStep } from '../fixed-step-barrier';
import { defineSystem } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { FixedTime, Time } from '../time';
import { World } from '../world';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

describe('fixed update loop', () => {
  it('retains one catch-up budget across multiple asynchronous substep completions', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.01, maxStepsPerUpdate: 2 } });
    const trace: string[] = [];
    const completions: (() => void)[] = [];
    const deferredSystem = defineSystem({
      name: 'defer',
      queries: [],
      fn: () => {
        trace.push(`begin:${world.getResource(FixedTime).tick}`);
        deferFixedStep(world, new Promise<void>((resolve) => completions.push(resolve)));
      },
    });
    world.addSystem(FixedUpdate, deferredSystem).unwrap();
    world
      .addSystem(
        FixedUpdate,
        defineSystem({
          name: 'complete',
          after: [deferredSystem],
          queries: [],
          fn: () => {
            trace.push(`end:${world.getResource(FixedTime).tick}`);
          },
        }),
      )
      .unwrap();
    world.update(0.055).unwrap();
    expect(trace).toEqual(['begin:1']);
    requiredFixtureValue(completions.shift())();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trace).toEqual(['begin:1', 'end:1', 'begin:2']);
    requiredFixtureValue(completions.shift())();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(trace).toEqual(['begin:1', 'end:1', 'begin:2', 'end:2']);
    expect(world.getResource(FixedTime)).toMatchObject({ tick: 2, droppedUpdates: 1 });
    expect(world.getResource(FixedTime).droppedSeconds).toBeCloseTo(0.03, 12);
    expect(world.getResource(FixedTime).overstep).toBeCloseTo(0.005, 12);
  });

  it('aborts retained command buffers when a deferred completion rejects', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.01 } });
    const Component = defineComponent('DeferredPayload', { values: { type: 'array<f32>' } });
    world.components.register(Component).unwrap();
    let reject!: (failure: unknown) => void;
    let commands: CommandBuffer | undefined;
    let spawned: EntityHandle | undefined;
    world
      .addSystem(
        FixedUpdate,
        defineSystem({
          name: 'defer',
          queries: [],
          fn: (_world, _queries, buffer) => {
            commands = buffer;
            spawned = buffer.spawn({
              component: Component,
              data: { values: new Float32Array([1, 2]) },
            });
            deferFixedStep(
              world,
              new Promise<void>((_resolve, fail) => {
                reject = fail;
              }),
            );
          },
        }),
      )
      .unwrap();
    world.update(0.01).unwrap();
    expect(commands?.status).toBe('open');
    reject(new Error('controlled solver rejection'));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(commands?.status).toBe('aborted');
    expect(world.update(0).ok).toBe(false);
    expect(world.get(requiredFixtureValue(spawned), Component).ok).toBe(false);
  });

  it('refuses fixed deferral outside a substep, including merged catch-up', () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.01, fixedCatchUp: 'merged' } });
    expect(() => deferFixedStep(world, Promise.resolve())).toThrow('FixedUpdate substep');
    world
      .addSystem(
        FixedUpdate,
        defineSystem({
          name: 'merged',
          queries: [],
          fn: () => {
            deferFixedStep(world, Promise.resolve());
          },
        }),
      )
      .unwrap();
    expect(world.update(0.01)).toMatchObject({ ok: false, error: { cause: expect.any(Error) } });
  });

  it('runs zero, one, and multiple fixed iterations while preserving remainder', () => {
    const world = new World();
    const ticks: number[] = [];
    const systemToken1 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: (_world) => ticks.push(_world.getResource(FixedTime).tick),
    });
    world.addSystem(FixedUpdate, systemToken1);

    expect(world.update(0.01).ok).toBe(true);
    expect(world.update(0.01).ok).toBe(true);
    expect(world.update(2 / 60).ok).toBe(true);
    expect(ticks).toEqual([1, 2, 3]);
    expect(world.getResource(FixedTime).tick).toBe(3);
    expect(world.getResource(FixedTime).overstep).toBeCloseTo(1 / 300, 12);
  });

  it('clamps before accumulating fixed time and records exact dropped metrics', () => {
    const world = new World();
    let fixedRuns = 0;
    const systemToken2 = defineSystem({ name: 'fixed', queries: [], fn: () => fixedRuns++ });
    world.addSystem(FixedUpdate, systemToken2);

    expect(world.update(5).ok).toBe(true);
    const time = world.getResource(Time);
    const fixed = world.getResource(FixedTime);
    expect(time.delta).toBe(0.1);
    expect(fixedRuns).toBe(4);
    expect(fixed.droppedUpdates).toBe(1);
    expect(fixed.droppedSeconds).toBeCloseTo(1 / 60, 12);
    expect(fixed.overstep).toBeCloseTo(1 / 60, 10);
  });

  it('does not replay discarded catch-up time on the next healthy frame', () => {
    const world = new World();
    let fixedRuns = 0;
    const systemToken3 = defineSystem({ name: 'fixed', queries: [], fn: () => fixedRuns++ });
    world.addSystem(FixedUpdate, systemToken3);

    expect(world.update(5).ok).toBe(true);
    const afterLargeFrame = world.getResource(FixedTime);
    const largeFrameTick = afterLargeFrame.tick;
    const largeFrameDroppedSeconds = afterLargeFrame.droppedSeconds;
    const largeFrameDroppedUpdates = afterLargeFrame.droppedUpdates;

    expect(world.update(1 / 60).ok).toBe(true);
    const afterHealthyFrame = world.getResource(FixedTime);
    expect(fixedRuns).toBe(5);
    expect(afterHealthyFrame.tick).toBe(largeFrameTick + 1);
    expect(afterHealthyFrame.droppedSeconds).toBe(largeFrameDroppedSeconds);
    expect(afterHealthyFrame.droppedUpdates).toBe(largeFrameDroppedUpdates);
  });

  it('runs Update before and after the intrinsic fixed node', () => {
    const world = new World();
    const trace: string[] = [];
    const systemToken4 = defineSystem({
      name: 'before-fixed',
      queries: [],
      before: [FixedUpdate],
      fn: () => trace.push('before'),
    });
    world.addSystem(Update, systemToken4);
    const systemToken5 = defineSystem({
      name: 'fixed',
      queries: [],
      fn: () => trace.push('fixed'),
    });
    world.addSystem(FixedUpdate, systemToken5);
    const systemToken6 = defineSystem({
      name: 'after-fixed',
      queries: [],
      after: [FixedUpdate],
      fn: () => trace.push('after'),
    });
    world.addSystem(Update, systemToken6);

    expect(world.update(1 / 60).ok).toBe(true);
    expect(trace).toEqual(['before', 'fixed', 'after']);
  });
});
