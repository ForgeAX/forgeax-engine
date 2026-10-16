import { describe, expect, it, vi } from 'vitest';
import { createCommandBuffer, flushCommands } from '../commands';
import { componentId, defineComponent } from '../component';
import { ComponentNotPresentError } from '../errors';
import {
  defineSharedKernel,
  SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
  type SharedKernelExecutor,
} from '../execution/shared-kernel';
import { defineRelationship } from '../relationship-index';
import { Update } from '../schedule-token';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Position = defineComponent('WorldHealthPosition', { x: 'f32' });
const { source: WorldHealthChildOf, target: WorldHealthChildren } = defineRelationship({
  sourceName: 'WorldHealthChildOf',
  sourceField: 'parent',
  targetName: 'WorldHealthChildren',
  targetField: 'entities',
});
function integrate(): void {}

describe('World execution health', () => {
  it('poisons synchronous materialization after a row has been published', () => {
    const world = new World();
    const target = world.spawn().unwrap();
    const injected = new ComponentNotPresentError(target as number, 'InjectedRelationshipFailure');
    const mutationEpoch = world[worldInternal].getMutationEpoch();
    const structureEpoch = world.getStructureEpoch();
    const onInsert = vi.spyOn(
      world as unknown as {
        relationshipOnInsert: (...args: never[]) => unknown;
      },
      'relationshipOnInsert',
    );
    onInsert.mockReturnValueOnce({ ok: false, error: injected });

    const failed = world.spawn({ component: WorldHealthChildOf, data: { parent: target } });

    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBe(injected);
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world[worldInternal].getMutationEpoch()).toBe(mutationEpoch);
    expect(world.getStructureEpoch()).toBe(structureEpoch);
    const rejected = world.spawn();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
  });

  it('poisons before reclaim when archetype-row append fails after table append', () => {
    const world = new World();
    const existing = world.spawn().unwrap();
    const archetype = world[worldInternal].getEntityArchetype(existing);
    if (archetype === undefined) throw new Error('fixture archetype missing');
    const injected = new Error('injected archetype row allocation fault');
    const rows = archetype.rows;
    archetype.rows = new Proxy(rows, {
      set() {
        throw injected;
      },
    }) as typeof rows;

    expect(() => world.spawn()).toThrow(injected);
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.update(0).ok).toBe(false);
    const rejected = world.spawn();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
  });

  it('poisons deferred materialization on a real relationship storage failure', () => {
    const world = new World();
    const target = world.spawn({ component: WorldHealthChildren, data: { entities: [] } }).unwrap();
    const targetArchetype = world[worldInternal].getEntityArchetype(target);
    if (targetArchetype === undefined) throw new Error('fixture target archetype missing');
    const targetTable = world[worldInternal].getGraph().tables[targetArchetype.tableId];
    const targetStorage = targetTable?.storage.get(componentId(WorldHealthChildren));
    if (targetStorage === undefined) throw new Error('fixture target storage missing');
    targetStorage.fields.delete('entities:count');

    const buffer = createCommandBuffer(world, {
      systemName: 'relationship-flush',
      scheduleName: Update.name,
    });
    const pending = buffer.spawn({ component: WorldHealthChildOf, data: { parent: target } });
    const mutationEpoch = world[worldInternal].getMutationEpoch();

    expect(() => flushCommands(buffer, world)).toThrow();
    expect(buffer.status).toBe('aborted');
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.hasComponent(pending, WorldHealthChildOf)).toBe(true);
    expect(world[worldInternal].getMutationEpoch()).toBe(mutationEpoch);
    const rejected = world.spawn();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
  });

  it('publishes target mirror evidence for direct addComponent', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = world.spawn().unwrap();
    const added = world
      .query({ read: [WorldHealthChildren], added: [WorldHealthChildren] })
      .unwrap();
    const childAdded = world
      .query({ read: [WorldHealthChildOf], added: [WorldHealthChildOf] })
      .unwrap();
    const mutationEpoch = world[worldInternal].getMutationEpoch();
    const structureEpoch = world.getStructureEpoch();

    world.addComponent(child, { component: WorldHealthChildOf, data: { parent } }).unwrap();

    expect(Array.from(added, (row) => row.entity)).toEqual([parent]);
    expect(Array.from(childAdded, (row) => row.entity)).toEqual([child]);
    expect(world.get(parent, WorldHealthChildren).unwrap().entities).toEqual(
      new Uint32Array([child as number]),
    );
    const targetChange = world[worldInternal].getComponentChange(
      parent,
      componentId(WorldHealthChildren),
    );
    expect(targetChange?.added).toBeGreaterThan(0);
    expect(world[worldInternal].getMutationEpoch()).toBeGreaterThan(mutationEpoch);
    expect(world.getStructureEpoch()).toBeGreaterThan(structureEpoch);
  });

  it('publishes target mirror evidence through addChild', () => {
    const world = new World();
    const parent = world.spawn().unwrap();
    const child = world.spawn().unwrap();
    const added = world
      .query({ read: [WorldHealthChildren], added: [WorldHealthChildren] })
      .unwrap();
    const mutationEpoch = world[worldInternal].getMutationEpoch();
    const structureEpoch = world.getStructureEpoch();

    world.addChild(parent, child, WorldHealthChildOf, { parent }).unwrap();

    expect(Array.from(added, (row) => row.entity)).toEqual([parent]);
    expect(world[worldInternal].getMutationEpoch()).toBeGreaterThan(mutationEpoch);
    expect(world.getStructureEpoch()).toBeGreaterThan(structureEpoch);
    expect(world.get(parent, WorldHealthChildren).unwrap().entities).toEqual(
      new Uint32Array([child as number]),
    );
  });

  it('preserves target mirror evidence across exclusive reparent', () => {
    const world = new World();
    const firstParent = world.spawn().unwrap();
    const secondParent = world.spawn().unwrap();
    const child = world
      .spawn({ component: WorldHealthChildOf, data: { parent: firstParent } })
      .unwrap();
    const added = world
      .query({ read: [WorldHealthChildren], added: [WorldHealthChildren] })
      .unwrap();
    expect(Array.from(added, (row) => row.entity)).toEqual([firstParent]);
    const childAdded = world
      .query({ read: [WorldHealthChildOf], added: [WorldHealthChildOf] })
      .unwrap();
    expect(Array.from(childAdded, (row) => row.entity)).toEqual([child]);
    const mutationEpoch = world[worldInternal].getMutationEpoch();
    const structureEpoch = world.getStructureEpoch();

    world
      .addComponent(child, { component: WorldHealthChildOf, data: { parent: secondParent } })
      .unwrap();

    expect(Array.from(added, (row) => row.entity)).toEqual([secondParent]);
    expect(Array.from(childAdded, (row) => row.entity)).toEqual([child]);
    expect(world[worldInternal].getMutationEpoch()).toBeGreaterThan(mutationEpoch);
    expect(world.getStructureEpoch()).toBeGreaterThan(structureEpoch);
    expect(world.get(firstParent, WorldHealthChildren).unwrap().entities).toEqual(
      new Uint32Array(),
    );
    expect(world.get(secondParent, WorldHealthChildren).unwrap().entities).toEqual(
      new Uint32Array([child as number]),
    );
  });

  it('transitions once to poisoned after a possible partial write and rejects future update', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const executor: SharedKernelExecutor = {
      execute: (_kernel, spans) => {
        spans[0]?.span.mut(Position).x.fill(2);
        return {
          cause: new Error('fixture fault'),
          dispatched: 2,
          completed: 1,
          partialWrite: true,
        };
      },
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    world
      .addSystem(
        Update,
        defineSharedKernel(import.meta.url, {
          name: 'faulting',
          minimumRows: 1,
          queries: [{ write: [Position] }],
          run: integrate,
        }),
      )
      .unwrap();
    const failed = world.update();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('system-failed');
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.execution.fault?.retryable).toBe(false);
    const rejected = world.update();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
  });

  it('gives every rebuilt World a new identity', () => {
    expect(new World().identity).not.toBe(new World().identity);
  });

  it('falls back inline when dispatch fails before any shared write', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1 } }).unwrap();
    const executor: SharedKernelExecutor = {
      execute: () => ({
        cause: new Error('pool not ready'),
        dispatched: 0,
        completed: 0,
        partialWrite: false,
      }),
    };
    world.insertResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, executor);
    world
      .addSystem(
        Update,
        defineSharedKernel(import.meta.url, {
          name: 'predispatch-fallback',
          minimumRows: 1,
          queries: [{ write: [Position] }],
          run: function inline(spans) {
            spans[0]?.mut(Position).x.fill(3);
          },
        }),
      )
      .unwrap();

    expect(world.update().ok).toBe(true);
    expect(world.execution.health).toBe('healthy');
    const [row] = world.query({ read: [Position] }).unwrap();
    expect(row?.get(Position).x).toBe(3);
  });
});
