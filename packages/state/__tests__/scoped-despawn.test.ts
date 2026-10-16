// @forgeax/engine-state -- scoped-despawn unit tests (M3 / m3w1)
//
// Covers: ScopedTo component registration, despawnOnExit/despawnOnEnter add
// correct component values, AC-11 duplicate add fail-fast, AC-12 enum schema
// metadata, component name prefix convention.
//
// Decision anchors:
// - m3w2 scoped-component.ts: per-token __scopedTo__${name} component via defineComponent
// - plan-strategy D-1: value field uses 'enum' (u32 index into token.variants)
// - requirements F-7/F-8: despawnOnExit/despawnOnEnter free functions
// - requirements AC-11: duplicate add throws ComponentAlreadyPresentError
// - requirements AC-12: schema fields use 'enum' type

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { defineState } from '../src/define-state';
import { registerStatesPlugin } from '../src/register-plugin';

// We import from scoped-component.ts which is NOT yet written.
// These imports will fail at compile time until m3w2 is implemented — that is
// the TDD red phase.
import { despawnOnExit, despawnOnEnter } from '../src/scoped-component';

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);
const GameMode = defineState('GameMode', ['menu', 'playing'] as const);

function makeWorld(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

function resolveWorldComponent(world: World, name: string) {
  const component = world.components.resolve(name);
  if (component === undefined) throw new Error(`Component ${name} is not registered`);
  return component;
}

describe('ScopedTo component registration', () => {
  it('registers a component named __scopedTo__<token.name> for each registered StateToken', () => {
    // registerStatesPlugin acquires the scoped component lease
    const world = makeWorld();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const ModeScoped = resolveWorldComponent(world, '__scopedTo__GameMode');

    expect(LevelScoped).toBeDefined();
    expect(LevelScoped!.name).toBe('__scopedTo__LevelId');
    expect(ModeScoped).toBeDefined();
    expect(ModeScoped!.name).toBe('__scopedTo__GameMode');
  });

  it('AC-12: schema fields use enum type for value and mode', () => {
    const world = makeWorld(); // acquires the scoped component lease

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');

    expect(componentSchema(LevelScoped).value).toBe('enum');
    expect(componentSchema(LevelScoped).mode).toBe('enum');
  });

  it('component has exactly two fields: value and mode', () => {
    const world = makeWorld(); // acquires the scoped component lease

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');

    const keys = Object.keys(componentSchema(LevelScoped));
    expect(keys).toHaveLength(2);
    expect(keys).toContain('value');
    expect(keys).toContain('mode');
  });
});

describe('despawnOnExit', () => {
  it('adds __scopedTo__<token.name> component with mode=0 (exit) and correct value index', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'tutorial');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const scoped = world.get(entity, LevelScoped).unwrap();
    // mode = 0 (exit enum value), value = 1 (tutorial index in LevelId.variants)
    expect(scoped.mode).toBe(0);
    expect(scoped.value).toBe(1);
  });

  it('works with first variant value (index 0)', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'main-menu');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const scoped = world.get(entity, LevelScoped).unwrap();
    expect(scoped.mode).toBe(0);
    expect(scoped.value).toBe(0);
  });

  it('works with last variant value', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'street-a');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const scoped = world.get(entity, LevelScoped).unwrap();
    expect(scoped.mode).toBe(0);
    expect(scoped.value).toBe(2);
  });

  it('works with a single-variant token', () => {
    const SingleState = defineState('SingleState', ['on'] as const);
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, SingleState, 'on');

    const SingleScoped = resolveWorldComponent(world, '__scopedTo__SingleState');
    const scoped = world.get(entity, SingleScoped).unwrap();
    expect(scoped.mode).toBe(0);
    expect(scoped.value).toBe(0);
  });
});

describe('despawnOnEnter', () => {
  it('adds __scopedTo__<token.name> component with mode=1 (enter) and correct value index', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnEnter(world, entity, LevelId, 'tutorial');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const scoped = world.get(entity, LevelScoped).unwrap();
    // mode = 1 (enter enum value), value = 1 (tutorial index)
    expect(scoped.mode).toBe(1);
    expect(scoped.value).toBe(1);
  });

  it('works with first variant value (index 0)', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnEnter(world, entity, LevelId, 'main-menu');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const scoped = world.get(entity, LevelScoped).unwrap();
    expect(scoped.mode).toBe(1);
    expect(scoped.value).toBe(0);
  });
});

describe('AC-11: duplicate add fail-fast', () => {
  it('throws ComponentAlreadyPresentError when despawnOnExit called twice on same entity', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    // First call succeeds
    despawnOnExit(world, entity, LevelId, 'tutorial');

    // Second call with same token should throw
    expect(() => {
      despawnOnExit(world, entity, LevelId, 'street-a');
    }).toThrow();

    try {
      despawnOnExit(world, entity, LevelId, 'street-a');
    } catch (err) {
      expect((err as Record<string, unknown>).name).toBe('ComponentAlreadyPresentError');
      expect((err as Record<string, unknown>).code).toBe('component-already-present');
    }
  });

  it('throws ComponentAlreadyPresentError when despawnOnExit then despawnOnEnter on same entity', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'tutorial');

    expect(() => {
      despawnOnEnter(world, entity, LevelId, 'main-menu');
    }).toThrow();

    try {
      despawnOnEnter(world, entity, LevelId, 'main-menu');
    } catch (err) {
      expect((err as Record<string, unknown>).name).toBe('ComponentAlreadyPresentError');
      expect((err as Record<string, unknown>).code).toBe('component-already-present');
    }
  });

  it('allows add on different entity (same token, different entity)', () => {
    const world = makeWorld();
    const e1 = world.spawn().unwrap();
    const e2 = world.spawn().unwrap();

    // Both entities get the ScopedTo component — different entities, fine
    despawnOnExit(world, e1, LevelId, 'tutorial');
    despawnOnExit(world, e2, LevelId, 'street-a');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const s1 = world.get(e1, LevelScoped).unwrap();
    const s2 = world.get(e2, LevelScoped).unwrap();
    expect(s1.value).toBe(1); // 'tutorial'
    expect(s2.value).toBe(2); // 'street-a'
  });
});

describe('per-token component independence', () => {
  it('adds scoped components with distinct names for different tokens', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'tutorial');
    despawnOnExit(world, entity, GameMode, 'playing');

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const ModeScoped = resolveWorldComponent(world, '__scopedTo__GameMode');

    const levelData = world.get(entity, LevelScoped).unwrap();
    expect(levelData.value).toBe(1); // tutorial
    expect(levelData.mode).toBe(0);

    const modeData = world.get(entity, ModeScoped).unwrap();
    expect(modeData.value).toBe(1); // playing
    expect(modeData.mode).toBe(0);
  });
});
