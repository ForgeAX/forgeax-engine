import { createWorldContext, defineComponent, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AnimationPlayer,
  animationPlugin,
  bindComponentProperty,
  bindObjectProperty,
  defineAnimationGraph,
  deriveAnimationTargetId,
  subscribeAnimationDiagnostics,
} from '../index';

const id = deriveAnimationTargetId(['Properties']);
const track = (binding: string, output: Float32Array | string[]): AnimationClip => ({
  kind: 'animation-clip',
  duration: 1,
  channels: [
    {
      targetId: id,
      property: 'property',
      binding,
      sampler:
        output instanceof Float32Array
          ? { input: new Float32Array([0]), output, interpolation: 'LINEAR' }
          : { input: new Float32Array([0]), output, interpolation: 'STEP' },
    },
  ],
});
async function setup(clips: AnimationClip[], weights = clips.map(() => 1)) {
  const world = new World();
  const context = await createWorldContext(world, [animationPlugin()]);
  const player = world
    .spawn({
      component: AnimationPlayer,
      data: {
        clips: clips.map((clip) => world.allocSharedRef('AnimationClip', clip)),
        times: clips.map(() => 0),
        speeds: clips.map(() => 0),
        weights,
      },
    })
    .unwrap();
  return { world, context, player };
}

describe('compiled property bindings and recovery', () => {
  it('normalizes sign-opposed quaternions and chooses the strongest discrete slot', async () => {
    const { world, player, context } = await setup(
      [
        track('q', new Float32Array([0, 0, 1, 0])),
        track('q', new Float32Array([0, 0, -1, 0])),
        track('label', ['weak']),
        track('label', ['strong']),
      ],
      [1, 3, 1, 3],
    );
    const object = { q: new Float32Array([0, 0, 0, 1]), label: '' };
    bindObjectProperty(world, player, id, 'q', { object, path: ['q'], quaternion: true }).unwrap();
    bindObjectProperty(world, player, id, 'label', { object, path: ['label'] }).unwrap();
    world.update(0).unwrap();
    expect([...object.q]).toEqual([0, 0, 1, 0]);
    expect(object.label).toBe('strong');
    await context.fiber.restart();
  });

  it('isolates identical player and target IDs between Worlds and releases plugin bindings', async () => {
    const a = await setup([track('n', new Float32Array([2]))]);
    const b = await setup([track('n', new Float32Array([8]))]);
    const first = { n: 0 };
    const second = { n: 0 };
    bindObjectProperty(a.world, a.player, id, 'n', { object: first, path: ['n'] }).unwrap();
    bindObjectProperty(b.world, b.player, id, 'n', { object: second, path: ['n'] }).unwrap();
    a.world.update(0).unwrap();
    b.world.update(0).unwrap();
    expect([first.n, second.n]).toEqual([2, 8]);
    await a.context.fiber.restart();
    // Restart releases old bindings: the same explicit name can be bound again.
    expect(bindObjectProperty(a.world, a.player, id, 'n', { object: first, path: ['n'] }).ok).toBe(
      true,
    );
    await a.context.fiber.restart();
    await b.context.fiber.restart();
  });

  it('rejects unsafe paths and readonly leaves and diagnoses a stale array without poisoning siblings', async () => {
    const { world, player, context } = await setup([
      track('array', new Float32Array([3, 4])),
      track('n', new Float32Array([6])),
    ]);
    const object = { array: [0, 0], n: 0 };
    expect(
      bindObjectProperty(world, player, id, 'bad', { object, path: ['__proto__', 'n'] }).ok,
    ).toBe(false);
    expect(
      bindObjectProperty(world, player, id, 'bad', { object: Object.create({ n: 1 }), path: ['n'] })
        .ok,
    ).toBe(false);
    expect(
      bindObjectProperty(world, player, id, 'bad', { object: Object.freeze({ n: 1 }), path: ['n'] })
        .ok,
    ).toBe(false);
    expect(
      bindObjectProperty(world, player, id, 'bad', {
        object: { array: Object.freeze([0, 0]) },
        path: ['array'],
      }).ok,
    ).toBe(false);
    const old = object.array;
    bindObjectProperty(world, player, id, 'array', { object, path: ['array'] }).unwrap();
    bindObjectProperty(world, player, id, 'n', { object, path: ['n'] }).unwrap();
    expect(bindObjectProperty(world, player, id, 'n', { object, path: ['n'] }).ok).toBe(false);
    object.array = [1, 1];
    const causes: string[] = [];
    const unsubscribe = subscribeAnimationDiagnostics((_world, diagnostic) => {
      if (diagnostic.detail.cause !== undefined) causes.push(diagnostic.detail.cause);
    });
    try {
      world.update(0).unwrap();
    } finally {
      unsubscribe();
    }
    expect(old).toEqual([0, 0]);
    expect(object.array).toEqual([1, 1]);
    expect(object.n).toBe(6);
    expect(causes).toContain('animation-property-target-stale');
    await context.fiber.restart();
  });

  it('turns a throwing object setter into a channel diagnostic and retains valid playback', async () => {
    const { world, player, context } = await setup([
      track('bad', new Float32Array([4])),
      track('n', new Float32Array([6])),
    ]);
    const object = {
      n: 0,
      get bad() {
        return 0;
      },
      set bad(_value: number) {
        throw new Error('removed native target');
      },
    };
    bindObjectProperty(world, player, id, 'bad', { object, path: ['bad'] }).unwrap();
    bindObjectProperty(world, player, id, 'n', { object, path: ['n'] }).unwrap();
    world.update(0).unwrap();
    expect(object.n).toBe(6);
    await context.fiber.restart();
  });
  it('consumes graph-derived property slots with pause and reverse speed', async () => {
    const world = new World();
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: id,
          property: 'property',
          binding: 'n',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 10]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    const context = await createWorldContext(world, [animationPlugin(() => clip)]);
    const graph = defineAnimationGraph((builder) => builder.clip('test/property-clock')).unwrap();
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          graph: world.allocSharedRef('AnimationGraph', graph),
          nodeSpeeds: [1],
          looping: false,
        },
      })
      .unwrap();
    const object = { n: 0 };
    bindObjectProperty(world, player, id, 'n', { object, path: ['n'] }).unwrap();
    world.update(0.1).unwrap();
    world.update(0.1).unwrap();
    expect(object.n).toBeCloseTo(2);
    world.set(player, AnimationPlayer, { paused: true }).unwrap();
    world.update(0.1).unwrap();
    expect(object.n).toBeCloseTo(2);
    world.set(player, AnimationPlayer, { paused: false, nodeSpeeds: [-1] }).unwrap();
    world.update(0.1).unwrap();
    expect(object.n).toBeCloseTo(1);
    await context.fiber.restart();
  });
  it('rejects a resized native array before writing any elements', async () => {
    const { world, player, context } = await setup([track('v', new Float32Array([3, 4]))]);
    const object = { v: [0, 0] };
    bindObjectProperty(world, player, id, 'v', { object, path: ['v'] }).unwrap();
    object.v.push(9);
    world.update(0).unwrap();
    expect(object.v).toEqual([0, 0, 9]);
    await context.fiber.restart();
  });

  it('rejects a resized component array before replacing its values', async () => {
    const { world, player, context } = await setup([track('v', new Float32Array([3, 4]))]);
    const Controls = defineComponent('VariablePropertyValues', { values: 'array<f32>' });
    const entity = world.spawn({ component: Controls, data: { values: [0, 0] } }).unwrap();
    bindComponentProperty(world, player, id, 'v', {
      entity,
      component: Controls,
      field: 'values',
    }).unwrap();
    world.set(entity, Controls, { values: [1, 1, 9] }).unwrap();
    world.update(0).unwrap();
    expect([...world.get(entity, Controls).unwrap().values]).toEqual([1, 1, 9]);
    await context.fiber.restart();
  });
});
