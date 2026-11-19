import { describe, expect, it } from 'vitest';
import { createCommandBuffer, flushCommands } from '../commands';
import { componentDefinition, defineComponent } from '../component';
import { type EntityHandle, entityIndex } from '../entity-handle';
import { isEcsFault } from '../errors';
import { defineRelationship } from '../relationship-index';
import { defineSystem } from '../schedule';
import { Update } from '../schedule-token';
import { type ComponentData, World } from '../world';
import { worldInternal } from '../world-internal';

describe('structural input snapshots', () => {
  it('reuses initialized values while validating them again for a live addition', () => {
    const value = defineComponent('PreparedAddition', {
      number: { type: 'u32', default: 7 },
      bytes: 'array<u8>',
    });
    const world = new World();
    const entity = world.spawn().unwrap();
    const preflight = world[worldInternal].preflightComponentData;
    const admitted = preflight('command', entity, { component: value, data: {} }).unwrap();
    expect(admitted.data.number).toBe(7);
    expect(preflight('addComponent', entity, admitted).unwrap()).toBe(admitted);
    const { source } = defineRelationship({
      sourceName: 'PreparedParent',
      sourceField: 'parent',
      targetName: 'PreparedChildren',
      targetField: 'entities',
    });
    const parent = world.spawn().unwrap();
    const edge = preflight('command', entity, { component: source, data: { parent } }).unwrap();
    world.despawn(parent).unwrap();
    expect(preflight('addComponent', entity, edge)).toMatchObject({
      ok: false,
      error: { code: 'stale-entity' },
    });
  });

  it.each([
    'spawn',
    'commands',
  ] as const)('%s retains an admitted tag when a later getter changes the caller entry', (operation) => {
    const tag = defineComponent(`StableTag-${operation}`, {});
    const trigger = defineComponent(`StableTagTrigger-${operation}`, { value: 'u32' });
    const replacement = defineComponent(`StableTagReplacement-${operation}`, { value: 'u32' });
    const earlier: ComponentData = { component: tag, data: {} };
    const later = {
      component: trigger,
      data: {
        get value() {
          earlier.component = replacement;
          earlier.data = { value: 7 };
          return 1;
        },
      },
    };
    const world = new World();
    let entity: EntityHandle;
    if (operation === 'spawn') entity = world.spawn(earlier, later).unwrap();
    else {
      const buffer = createCommandBuffer(world);
      entity = buffer.spawn(earlier, later);
      flushCommands(buffer, world);
    }
    expect(world.hasComponent(entity, tag)).toBe(true);
    expect(world.hasComponent(entity, replacement)).toBe(false);
    expect(world.get(entity, trigger).unwrap().value).toBe(1);
  });

  it('shares immutable tag admission while rejecting unknown caller fields', () => {
    const tag = defineComponent('CanonicalTagInput', {});
    const first = new World()[worldInternal].preflightComponentData('spawn', null, {
      component: tag,
      data: {},
    });
    const second = new World()[worldInternal].preflightComponentData('spawn', null, {
      component: tag,
      data: {},
    });
    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    if (!first.ok) throw first.error;
    expect(first.value).toMatchObject({ component: tag, data: {} });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.data)).toBe(true);
    let reads = 0;
    const rejected = new World().spawn({
      component: tag,
      data: {
        get unknown() {
          reads++;
          return 1;
        },
      },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'spawn-data-unknown-field' } });
    expect(reads).toBe(0);
  });

  it('normalizes a frozen pre-cache v3 tag definition once without changing its existing facts', () => {
    const tag = defineComponent('LegacyCanonicalTagInput', {});
    const { emptyInput: originalCache, ...legacy } = componentDefinition(tag);
    expect(originalCache).toBeDefined();
    const frozenLegacy = Object.freeze(legacy);
    const registry = Reflect.get(globalThis, Symbol.for('forgeax.ecs.componentRegistry.v3')) as {
      definitions: WeakMap<object, object>;
    };
    registry.definitions.set(tag, frozenLegacy);
    const world = new World();
    const first = world[worldInternal].preflightComponentData('spawn', null, {
      component: tag,
      data: {},
    });
    const normalized = componentDefinition(tag);
    expect(normalized).not.toBe(frozenLegacy);
    expect(normalized.id).toBe(legacy.id);
    expect(normalized.schema).toBe(legacy.schema);
    expect(normalized.plan).toBe(legacy.plan);
    expect(Object.isFrozen(frozenLegacy)).toBe(true);
    expect('emptyInput' in frozenLegacy).toBe(false);
    expect(
      world[worldInternal].preflightComponentData('spawn', null, { component: tag, data: {} }),
    ).toBe(first);
    expect(componentDefinition(tag)).toBe(normalized);
    expect(world.spawn({ component: tag, data: {} }).ok).toBe(true);
  });

  it.each([
    'abort',
    'commit',
  ] as const)('respects a release hook that calls %s on its buffer', (terminal) => {
    const owned = defineComponent(`TerminalSnapshotOwned-${terminal}`, {
      handle: 'unique<TerminalSnapshot>',
    });
    const value = defineComponent(`TerminalSnapshotValue-${terminal}`, { value: 'u32' });
    const world = new World();
    const buffer = createCommandBuffer(world);
    const handle = world.allocUniqueRef('TerminalSnapshot', {}, () => buffer[terminal]());
    const holder = world.spawn({ component: owned, data: { handle } }).unwrap();
    buffer.despawn(holder);
    const pending = buffer.spawn({ component: value, data: { value: 1 } });
    flushCommands(buffer, world);
    expect(buffer.status).toBe(terminal === 'abort' ? 'aborted' : 'committed');
    expect(Array.from(world.query({ read: [value] }).unwrap())).toHaveLength(0);
    expect(world.execution.health).toBe('healthy');
    const replacements = [world.spawn().unwrap(), world.spawn().unwrap()];
    expect(replacements.map(entityIndex)).toContain(entityIndex(pending));
    expect(replacements).not.toContain(pending);
  });

  it.each([
    'spawn',
    'add',
    'command-spawn',
    'command-add',
  ] as const)('%s checks target payload ownership against its captured binding', (operation) => {
    const { target } = defineRelationship({
      sourceName: `TargetSnapshotSource-${operation}`,
      sourceField: 'parent',
      targetName: `TargetSnapshotTarget-${operation}`,
      targetField: 'children',
    });
    const world = new World();
    let holder = world.spawn().unwrap();
    const child = world.spawn().unwrap();
    let reads = 0;
    const data = {
      get children() {
        return reads++ === 0 ? [] : [child];
      },
    };
    if (operation === 'spawn') holder = world.spawn({ component: target, data }).unwrap();
    else if (operation === 'add')
      world.addComponent(holder, { component: target, data } as never).unwrap();
    else {
      const buffer = createCommandBuffer(world);
      if (operation === 'command-spawn') holder = buffer.spawn({ component: target, data });
      else buffer.addComponent(holder, { component: target, data });
      flushCommands(buffer, world);
    }
    expect(reads).toBe(1);
    expect(Array.from(world.get(holder, target).unwrap().children)).toEqual([]);
  });

  it('admits a source staged by a release hook before storing it', () => {
    const { source, target } = defineRelationship({
      sourceName: 'CascadeSnapshotSource',
      sourceField: 'parent',
      targetName: 'CascadeSnapshotTarget',
      targetField: 'children',
    });
    const owned = defineComponent('CascadeSnapshotOwned', { handle: 'unique<CascadeSnapshot>' });
    const world = new World();
    const parents = [world.spawn().unwrap(), world.spawn().unwrap()] as const;
    const buffer = createCommandBuffer(world);
    let reads = 0;
    let spawned: EntityHandle | undefined;
    const handle = world.allocUniqueRef('CascadeSnapshot', {}, () => {
      spawned = buffer.spawn({
        component: source,
        data: {
          get parent() {
            return reads++ === 0 ? parents[0] : parents[1];
          },
        },
      });
    });
    const holder = world.spawn({ component: owned, data: { handle } }).unwrap();
    buffer.despawn(holder);
    flushCommands(buffer, world);
    expect(reads).toBe(1);
    if (spawned === undefined) throw new Error('release hook did not stage a spawn');
    expect(world.get(spawned, source).unwrap().parent).toBe(parents[0]);
    expect(Array.from(world.get(parents[0], target).unwrap().children)).toEqual([spawned]);
    expect(world.hasComponent(parents[1], target)).toBe(false);
  });

  it('poisons a later cascaded admission failure and retains global commit evidence', () => {
    const owned = defineComponent('FailedCascadeSnapshotOwned', {
      handle: 'unique<FailedCascadeSnapshot>',
    });
    const value = defineComponent('FailedCascadeSnapshotValue', { value: 'u32' });
    const world = new World();
    const buffer = createCommandBuffer(world);
    const handle = world.allocUniqueRef('FailedCascadeSnapshot', {}, () => {
      buffer.spawn({ component: value, data: { unknown: 1 } } as never);
    });
    const holder = world.spawn({ component: owned, data: { handle } }).unwrap();
    buffer.despawn(holder);
    let failure: unknown;
    try {
      flushCommands(buffer, world);
    } catch (error) {
      failure = error;
    }
    expect(isEcsFault(failure, 'system-failed')).toBe(true);
    if (isEcsFault(failure, 'system-failed'))
      expect(failure.detail.lastCommittedCommand).toEqual({ index: 0, kind: 'despawn' });
    expect(world.execution.health).toBe('poisoned');
    expect(buffer.status).toBe('aborted');
  });

  it.each([
    'spawn',
    'add',
    'exclusive-add',
    'command-spawn',
    'command-add',
  ] as const)('%s uses the same declared field for admission, storage and mirrors', (operation) => {
    const { source, target } = defineRelationship({
      sourceName: `SnapshotSource-${operation}`,
      sourceField: 'parent',
      targetName: `SnapshotTarget-${operation}`,
      targetField: 'children',
      exclusive: true,
    });
    const world = new World();
    const parents = [
      world.spawn().unwrap(),
      world.spawn().unwrap(),
      world.spawn().unwrap(),
    ] as const;
    const first = parents[0];
    let reads = 0;
    const data = Object.create({
      get parent() {
        return parents[Math.min(reads++, parents.length - 1)];
      },
    });
    let child = world.spawn().unwrap();
    if (operation === 'exclusive-add')
      world.addComponent(child, { component: source, data: { parent: parents[2] } }).unwrap();
    if (operation === 'spawn') child = world.spawn({ component: source, data }).unwrap();
    else if (operation === 'add' || operation === 'exclusive-add')
      world.addComponent(child, { component: source, data }).unwrap();
    else {
      world
        .addSystem(
          Update,
          defineSystem({
            name: `snapshot-${operation}`,
            queries: [],
            fn: (_world, _queries, commands) => {
              if (operation === 'command-spawn')
                child = commands.spawn({ component: source, data });
              else commands.addComponent(child, { component: source, data });
              expect(reads).toBe(0);
            },
          }),
        )
        .unwrap();
      world.update(0).unwrap();
    }
    expect(reads).toBe(1);
    expect(world.get(child, source).unwrap().parent).toBe(first);
    for (const parent of parents) {
      const mirror = world.get(parent, target);
      expect(mirror.ok ? Array.from(mirror.value.children) : []).toEqual(
        parent === first ? [child] : [],
      );
    }
  });

  it('reads throwing scalar getters before allocating or migrating storage', () => {
    const value = defineComponent('ThrowingSnapshotValue', { value: 'u32' });
    const world = new World();
    const child = world.spawn().unwrap();
    const failure = new Error('input getter failed');
    const data = {
      get value(): number {
        throw failure;
      },
    };
    expect(() => world.spawn({ component: value, data })).toThrow(failure);
    expect(() => world.addComponent(child, { component: value, data })).toThrow(failure);
    expect(world.hasComponent(child, value)).toBe(false);
    expect(world.spawn().ok).toBe(true);
  });
});

const VisibilityLike = defineComponent('M1VisibilityLikeAtomic', {
  state: { type: 'enum', default: 0, labels: { inherited: 0, hidden: 1, visible: 2 } },
});

const Position = defineComponent('M1VisibilityAtomicPosition', {
  value: 'f32',
});

function expectInvalidValue(result: { ok: boolean; error?: unknown }, entity?: number): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const error = result.error as {
    code: string;
    expected: string;
    hint: string;
    detail: {
      entity: number | undefined;
      component: string;
      field: string;
      received: unknown;
      allowedValues: Readonly<Record<string, number>>;
    };
  };
  expect(error.code).toBe('component-field-invalid-value');
  expect(error.expected).toContain('inherited');
  expect(error.hint).toContain('VisibilityLike');
  expect(error.detail).toEqual({
    entity,
    component: 'M1VisibilityLikeAtomic',
    field: 'state',
    received: 9,
    allowedValues: { inherited: 0, hidden: 1, visible: 2 },
  });
}

describe('M1 Visibility enum writes are atomic', () => {
  it('rejects an invalid enum during spawn before creating the row', () => {
    const world = new World();

    const result = world.spawn({ component: VisibilityLike, data: { state: 9 } });

    expectInvalidValue(result);
    expect(world.spawn({ component: Position, data: { value: 1 } }).unwrap()).toBe(0);
  });

  it('rejects an invalid enum during addComponent before archetype migration', () => {
    const world = new World();
    const entity = world.spawn({ component: Position, data: { value: 1 } }).unwrap();

    const result = world.addComponent(entity, {
      component: VisibilityLike,
      data: { state: 9 },
    });

    expectInvalidValue(result, entity);
    expect(world.get(entity, VisibilityLike).ok).toBe(false);
    expect(world.get(entity, Position).unwrap().value).toBe(1);
  });

  it('rejects an invalid enum during set and preserves the previous value', () => {
    const world = new World();
    const entity = world.spawn({ component: VisibilityLike, data: { state: 1 } }).unwrap();

    const result = world.set(entity, VisibilityLike, { state: 9 });

    expectInvalidValue(result, entity);
    expect(world.get(entity, VisibilityLike).unwrap().state).toBe(1);
  });

  it('accepts every declared enum value through all three write entries', () => {
    const world = new World();
    const entity = world.spawn({ component: VisibilityLike, data: { state: 0 } }).unwrap();

    expect(world.set(entity, VisibilityLike, { state: 1 }).ok).toBe(true);
    expect(world.addComponent(entity, { component: Position, data: { value: 2 } }).ok).toBe(true);
    expect(world.get(entity, VisibilityLike).unwrap().state).toBe(1);
  });
});
