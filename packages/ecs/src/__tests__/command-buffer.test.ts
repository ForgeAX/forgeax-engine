import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createCommandBuffer, flushCommands } from '../commands';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { CommandFailedError, SharedKernelFailureError, SystemFailedError } from '../errors';
import { defineRelationship } from '../relationship-index';
import { Update } from '../schedule-token';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const CommandPosition = defineComponent('CommandBufferPosition', { x: 'f32' });
const CommandVelocity = defineComponent('CommandBufferVelocity', { x: 'f32' });
const { source: CommandChildOf, target: CommandChildren } = defineRelationship({
  sourceName: 'CommandBufferChildOf',
  sourceField: 'parent',
  targetName: 'CommandBufferChildren',
  targetField: 'entities',
});

describe('CommandBuffer terminal lifecycle', () => {
  it('commits after a successful drain and rejects later writes', () => {
    const world = new World();
    const buffer = createCommandBuffer(world);
    buffer.despawn(1 as never);
    flushCommands(buffer, world);
    expect(buffer.status).toBe('committed');
    expect(() => buffer.despawn(1 as never)).toThrow('committed');
  });

  it('aborts a preflight command failure without poisoning the world', () => {
    const world = new World();
    const buffer = createCommandBuffer(world);
    const poison = vi.spyOn(world[worldInternal], 'poisonExecution');
    const entity = world.spawn().unwrap();
    buffer.removeComponent(entity, Entity);
    expect(() => flushCommands(buffer, world)).toThrow(CommandFailedError);
    expect(buffer.status).toBe('aborted');
    expect(poison).not.toHaveBeenCalled();
  });

  it('poisons the World on a system exception after command staging', () => {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'throws-after-stage',
        queries: [],
        fn: (_world, _queries, commands) => {
          commands.despawn(1 as never);
          throw new Error('system failure');
        },
      })
      .unwrap();
    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SystemFailedError);
    expect(world.execution.health).toBe('poisoned');
    expect(world.update(0).ok).toBe(false);
  });

  it('preflights same-batch duplicate component mutations without partial writes', () => {
    const world = new World();
    const entity = world.spawn({ component: CommandPosition, data: { x: 1 } }).unwrap();
    const buffer = createCommandBuffer(world, {
      systemName: 'duplicate',
      scheduleName: Update.name,
    });
    buffer.addComponent(entity, { component: CommandVelocity, data: { x: 2 } });
    buffer.addComponent(entity, { component: CommandVelocity, data: { x: 3 } });

    expect(() => flushCommands(buffer, world)).toThrow(CommandFailedError);
    expect(world.hasComponent(entity, CommandVelocity)).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('preflights relationship cycles and keeps the existing hierarchy intact', () => {
    const world = new World();
    const root = world.spawn().unwrap();
    const child = world.spawn({ component: CommandChildOf, data: { parent: root } }).unwrap();
    const grandchild = world.spawn({ component: CommandChildOf, data: { parent: child } }).unwrap();
    const buffer = createCommandBuffer(world, { systemName: 'cycle', scheduleName: Update.name });
    buffer.addComponent(root, { component: CommandChildOf, data: { parent: grandchild } });

    expect(() => flushCommands(buffer, world)).toThrow(CommandFailedError);
    expect(world.execution.health).toBe('healthy');
    const current = world.get(child, CommandChildOf);
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value.parent).toBe(root);
  });

  it('treats an exclusive relationship add as a staged reparent', () => {
    const world = new World();
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const child = world.spawn({ component: CommandChildOf, data: { parent: first } }).unwrap();
    const buffer = createCommandBuffer(world, {
      systemName: 'reparent',
      scheduleName: Update.name,
    });
    buffer.addComponent(child, { component: CommandChildOf, data: { parent: second } });

    expect(() => flushCommands(buffer, world)).not.toThrow();
    const current = world.get(child, CommandChildOf);
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value.parent).toBe(second);
    const oldChildren = world.get(first, CommandChildren);
    const newChildren = world.get(second, CommandChildren);
    expect(oldChildren.ok && Array.from(oldChildren.value.entities)).toEqual([]);
    expect(newChildren.ok && Array.from(newChildren.value.entities)).toEqual([child]);
  });

  it('sees relationship edges staged earlier in the same batch when checking cycles', () => {
    const world = new World();
    const a = world.spawn().unwrap();
    const b = world.spawn().unwrap();
    const buffer = createCommandBuffer(world, {
      systemName: 'batch-cycle',
      scheduleName: Update.name,
    });
    buffer.addComponent(a, { component: CommandChildOf, data: { parent: b } });
    buffer.addComponent(b, { component: CommandChildOf, data: { parent: a } });

    expect(() => flushCommands(buffer, world)).toThrow(CommandFailedError);
    expect(world.hasComponent(a, CommandChildOf)).toBe(false);
    expect(world.hasComponent(b, CommandChildOf)).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('bumps a cancelled pending reservation so a later entity cannot alias its handle', () => {
    const world = new World();
    let pending: EntityHandle | undefined;
    world
      .addSystem(Update, {
        name: 'pending-abort',
        queries: [],
        fn: (_world, _queries, commands) => {
          pending = commands.spawn({ component: CommandPosition, data: { x: 4 } });
          throw new Error('abort pending');
        },
      })
      .unwrap();

    const failed = world.update();
    expect(failed.ok).toBe(false);
    expect(world.execution.health).toBe('poisoned');
    const replacementWorld = new World();
    replacementWorld.spawn().unwrap();
    const stale = world.get(pending as EntityHandle, CommandPosition);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('stale-entity');
    expect(replacementWorld.identity).not.toBe(world.identity);
  });

  it('reports the last committed command when a later flush write unexpectedly fails', () => {
    const world = new World();
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const buffer = createCommandBuffer(world, { systemName: 'flush', scheduleName: Update.name });
    buffer.despawn(first);
    buffer.despawn(second);
    const original = world.despawn.bind(world);
    vi.spyOn(world, 'despawn')
      .mockImplementationOnce((entity) => original(entity))
      .mockImplementationOnce(() => {
        throw new Error('unexpected write fault');
      });

    let failure: unknown;
    try {
      flushCommands(buffer, world);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SystemFailedError);
    if (failure instanceof SystemFailedError) {
      expect(failure.detail.lastCommittedCommand).toEqual({ index: 0, kind: 'despawn' });
    }
    expect(world.execution.health).toBe('poisoned');
  });

  it('poisons on a first-command materialization failure without reclaiming its row', () => {
    const world = new World();
    const buffer = createCommandBuffer(world, { systemName: 'flush', scheduleName: Update.name });
    const pending = buffer.spawn({ component: CommandPosition, data: { x: 7 } });
    const injected = new SharedKernelFailureError(
      'World.materializeEntity',
      world.identity,
      new Error('post-write materialization fault'),
      true,
    );
    const materialize = world[worldInternal].materializePendingEntity;
    vi.spyOn(world[worldInternal], 'materializePendingEntity').mockImplementationOnce(
      (entity, componentDatas) => {
        const result = materialize(entity, componentDatas);
        return result.ok ? err(injected) : result;
      },
    );

    expect(() => flushCommands(buffer, world)).toThrow(SystemFailedError);
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.hasComponent(pending, CommandPosition)).toBe(true);
  });
});
