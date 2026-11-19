import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createCommandBuffer, flushCommands } from '../commands';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { createSharedKernelFailureError, isEcsFault } from '../errors';
import { defineRelationship } from '../relationship-index';
import { defineSystem } from '../schedule';
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
  const membershipCases: [string, ('add' | 'remove')[]][] = [];
  for (const initial of ['live-empty', 'live-present', 'pending-empty', 'pending-present'])
    for (let length = 1; length <= 4; length++)
      for (let bits = 0; bits < 2 ** length; bits++)
        membershipCases.push([
          initial,
          Array.from({ length }, (_, index) => ((bits >> index) & 1 ? 'add' : 'remove')),
        ]);

  it.each(
    membershipCases,
  )('preserves staged membership and atomic refusal for %s %j', (initial, operations) => {
    const world = new World();
    const pending = initial.startsWith('pending');
    const initiallyPresent = initial.endsWith('present');
    const input = initiallyPresent ? [{ component: CommandPosition, data: { x: 7 } }] : [];
    const commands = createCommandBuffer(world);
    const entity = pending ? commands.spawn(...input) : world.spawn(...input).unwrap();
    const epoch = world[worldInternal].getMutationEpoch();
    let present = initiallyPresent;
    let expectedValue = initiallyPresent ? 7 : undefined;
    let refusal: 'component-already-present' | 'component-not-present' | undefined;
    for (const [index, operation] of operations.entries()) {
      if (operation === 'add')
        commands.addComponent(entity, { component: CommandPosition, data: { x: index + 11 } });
      else commands.removeComponent(entity, CommandPosition);
      if (refusal !== undefined) continue;
      if (operation === 'add' && present) refusal = 'component-already-present';
      else if (operation === 'remove' && !present) refusal = 'component-not-present';
      else {
        present = operation === 'add';
        expectedValue = present ? index + 11 : undefined;
      }
    }
    if (refusal === undefined) {
      flushCommands(commands, world);
      expect(commands.status).toBe('committed');
    } else {
      expect(() => flushCommands(commands, world)).toThrowError(
        expect.objectContaining({
          code: 'command-failed',
          detail: expect.objectContaining({ cause: expect.objectContaining({ code: refusal }) }),
        }),
      );
      expect(commands.status).toBe('aborted');
      expect(world[worldInternal].getMutationEpoch()).toBe(epoch);
      present = !pending && initiallyPresent;
      expectedValue = present ? 7 : undefined;
    }
    expect(world.hasComponent(entity, Entity)).toBe(!pending || refusal === undefined);
    expect(world.hasComponent(entity, CommandPosition)).toBe(present);
    const result = world.get(entity, CommandPosition);
    expect(result.ok ? result.value.x : undefined).toBe(expectedValue);
    expect(world.execution.health).toBe('healthy');
  });

  it('follows an earlier pending source chain after its entities materialize', () => {
    const world = new World();
    const commands = createCommandBuffer(world);
    const root = commands.spawn();
    const child = commands.spawn({ component: CommandChildOf, data: { parent: root } });
    const leaf = commands.spawn({ component: CommandChildOf, data: { parent: child } });
    flushCommands(commands, world);
    expect(commands.status).toBe('committed');
    expect(world.get(child, CommandChildOf).unwrap().parent).toBe(root);
    expect(world.get(leaf, CommandChildOf).unwrap().parent).toBe(child);
    expect([...world.get(root, CommandChildren).unwrap().entities]).toEqual([child]);
    expect([...world.get(child, CommandChildren).unwrap().entities]).toEqual([leaf]);
    expect(world.execution.health).toBe('healthy');
  });

  it.each([false, true])('retains allowSelf=%s for a pending holder', (allowSelf) => {
    const { source: Source, target: Back } = defineRelationship({
      sourceName: `PendingSelfSource_${allowSelf}`,
      sourceField: 'target',
      targetName: `PendingSelfBack_${allowSelf}`,
      targetField: 'sources',
      allowSelf,
    });
    const world = new World();
    const commands = createCommandBuffer(world);
    const entity = commands.spawn();
    commands.addComponent(entity, { component: Source, data: { target: entity } });
    if (allowSelf) {
      flushCommands(commands, world);
      expect(commands.status).toBe('committed');
      expect(world.get(entity, Source).unwrap().target).toBe(entity);
      expect([...world.get(entity, Back).unwrap().sources]).toEqual([entity]);
    } else {
      expect(() => flushCommands(commands, world)).toThrow(
        expect.objectContaining({ code: 'command-failed' }),
      );
      expect(commands.status).toBe('aborted');
      expect(world.hasComponent(entity, Entity)).toBe(false);
      expect(world.inspect().entityCount).toBe(0);
    }
    expect(world.execution.health).toBe('healthy');
  });

  it.each([
    false,
    true,
  ])('rejects a two-pending-node cycle with allowSelf=%s before commit', (allowSelf) => {
    const { source: Source } = defineRelationship({
      sourceName: `PendingCycleSource_${allowSelf}`,
      sourceField: 'target',
      targetName: `PendingCycleBack_${allowSelf}`,
      targetField: 'sources',
      allowSelf,
    });
    const world = new World();
    const commands = createCommandBuffer(world);
    const a = commands.spawn();
    const b = commands.spawn({ component: Source, data: { target: a } });
    commands.addComponent(a, { component: Source, data: { target: b } });
    expect(() => flushCommands(commands, world)).toThrow(
      expect.objectContaining({
        code: 'command-failed',
        detail: expect.objectContaining({
          commandIndex: 2,
          cause: expect.objectContaining({ code: 'relationship-self-cycle' }),
        }),
      }),
    );
    expect(commands.status).toBe('aborted');
    expect(world.inspect().entityCount).toBe(0);
    expect(world.hasComponent(a, Entity)).toBe(false);
    expect(world.hasComponent(b, Entity)).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('admits a reversal after an earlier exclusive reparent removes the old path', () => {
    const world = new World();
    const b = world.spawn().unwrap();
    const c = world.spawn().unwrap();
    const a = world.spawn({ component: CommandChildOf, data: { parent: b } }).unwrap();
    const commands = createCommandBuffer(world);
    commands.addComponent(a, { component: CommandChildOf, data: { parent: c } });
    commands.addComponent(b, { component: CommandChildOf, data: { parent: a } });
    flushCommands(commands, world);
    expect(commands.status).toBe('committed');
    expect(world.get(a, CommandChildOf).unwrap().parent).toBe(c);
    expect(world.get(b, CommandChildOf).unwrap().parent).toBe(a);
    expect([...world.get(b, CommandChildren).unwrap().entities]).toEqual([]);
    expect([...world.get(c, CommandChildren).unwrap().entities]).toEqual([a]);
    expect([...world.get(a, CommandChildren).unwrap().entities]).toEqual([b]);
    expect(world.execution.health).toBe('healthy');
  });

  it('revalidates the live graph if an earlier release callback creates a cycle', () => {
    const world = new World();
    const a = world.spawn().unwrap();
    const b = world.spawn().unwrap();
    const Trigger = defineComponent('CommandCycleTrigger', {
      value: 'unique<CommandCycleTrigger>',
    });
    let releases = 0;
    const value = world.allocUniqueRef('CommandCycleTrigger', {}, () => {
      releases++;
      world.addComponent(a, { component: CommandChildOf, data: { parent: b } }).unwrap();
    });
    const trigger = world.spawn({ component: Trigger, data: { value } }).unwrap();
    const commands = createCommandBuffer(world);
    commands.removeComponent(trigger, Trigger);
    commands.addComponent(b, { component: CommandChildOf, data: { parent: a } });
    let failure: unknown;
    try {
      flushCommands(commands, world);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'system-failed',
      detail: {
        cause: { code: 'relationship-self-cycle' },
        lastCommittedCommand: { index: 0, kind: 'removeComponent' },
      },
    });
    expect(releases).toBe(1);
    expect(commands.status).toBe('aborted');
    expect(world.execution).toMatchObject({
      health: 'poisoned',
      fault: { partialWrite: true, retryable: false, cause: { code: 'relationship-self-cycle' } },
    });
    expect(world.spawn().ok).toBe(false);
  });

  it('admits a FIFO edge reversal after the earlier source is removed', () => {
    function fixture() {
      const world = new World();
      const b = world.spawn().unwrap();
      const a = world.spawn({ component: CommandChildOf, data: { parent: b } }).unwrap();
      return { world, a, b };
    }
    const direct = fixture();
    const directEpoch = direct.world[worldInternal].getMutationEpoch();
    const directStructure = direct.world.getStructureEpoch();
    direct.world.removeComponent(direct.a, CommandChildOf).unwrap();
    direct.world
      .addComponent(direct.b, { component: CommandChildOf, data: { parent: direct.a } })
      .unwrap();

    const { world, a, b } = fixture();
    const epoch = world[worldInternal].getMutationEpoch();
    const structure = world.getStructureEpoch();
    const commands = createCommandBuffer(world);
    commands.removeComponent(a, CommandChildOf);
    commands.addComponent(b, { component: CommandChildOf, data: { parent: a } });
    expect(world.get(a, CommandChildOf).unwrap().parent).toBe(b);
    expect(world[worldInternal].getMutationEpoch()).toBe(epoch);
    expect(() => flushCommands(commands, world)).not.toThrow();
    expect(commands.status).toBe('committed');
    expect(world.hasComponent(a, CommandChildOf)).toBe(false);
    expect(world.get(b, CommandChildOf).unwrap().parent).toBe(a);
    expect([...world.get(b, CommandChildren).unwrap().entities]).toEqual([]);
    expect([...world.get(a, CommandChildren).unwrap().entities]).toEqual([b]);
    expect(world.execution.health).toBe('healthy');
    expect(world[worldInternal].getMutationEpoch() - epoch).toBe(
      direct.world[worldInternal].getMutationEpoch() - directEpoch,
    );
    expect(world.getStructureEpoch() - structure).toBe(
      direct.world.getStructureEpoch() - directStructure,
    );
  });

  it.each([
    ['committed-cycle', true, false, 'relationship-self-cycle', 0],
    ['removed-cycle', true, true, 'component-already-present', 1],
    ['overlay-cycle', false, false, 'component-already-present', 1],
  ] as const)('preserves %s and membership error priority', (name, initialEdge, removeEdge, code, index) => {
    const { source: Source } = defineRelationship({
      sourceName: `CommandPrioritySource_${name}`,
      sourceField: 'target',
      targetName: `CommandPriorityBack_${name}`,
      targetField: 'sources',
      exclusive: false,
    });
    const world = new World();
    const b = world.spawn({ component: Source, data: { target: null } }).unwrap();
    const a = initialEdge
      ? world.spawn({ component: Source, data: { target: b } }).unwrap()
      : world.spawn().unwrap();
    const epoch = world[worldInternal].getMutationEpoch();
    const structure = world.getStructureEpoch();
    const commands = createCommandBuffer(world);
    if (removeEdge) commands.removeComponent(a, Source);
    else if (!initialEdge) commands.addComponent(a, { component: Source, data: { target: b } });
    commands.addComponent(b, { component: Source, data: { target: a } });
    let failure: unknown;
    try {
      flushCommands(commands, world);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'command-failed',
      detail: { commandIndex: index, cause: { code } },
    });
    expect(commands.status).toBe('aborted');
    expect(world.execution.health).toBe('healthy');
    expect(world[worldInternal].getMutationEpoch()).toBe(epoch);
    expect(world.getStructureEpoch()).toBe(structure);
    expect(world.hasComponent(a, Source)).toBe(initialEdge);
    expect(world.get(b, Source).unwrap().target).toBeNull();
  });

  it('keeps concurrent buffers independent when one aborts its pending entities', () => {
    const world = new World();
    const aborted = createCommandBuffer(world);
    const committed = createCommandBuffer(world);
    const cancelled = aborted.spawn({ component: CommandPosition, data: { x: 1 } });
    const accepted = committed.spawn({ component: CommandPosition, data: { x: 2 } });

    aborted.abort();
    expect(committed.status).toBe('open');
    expect(committed.isDeferred(accepted)).toBe(true);
    flushCommands(committed, world);

    expect(aborted.status).toBe('aborted');
    expect(committed.status).toBe('committed');
    expect(world.get(cancelled, CommandPosition).ok).toBe(false);
    expect(world.get(accepted, CommandPosition).unwrap().x).toBe(2);
    expect(world.execution.health).toBe('healthy');
  });

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
    expect(() => flushCommands(buffer, world)).toThrow(
      expect.objectContaining({ code: 'command-failed' }),
    );
    expect(buffer.status).toBe('aborted');
    expect(poison).not.toHaveBeenCalled();
  });

  it('poisons the World on a system exception after command staging', () => {
    const world = new World();
    const systemToken1 = defineSystem({
      name: 'throws-after-stage',
      queries: [],
      fn: (_world, _queries, commands) => {
        commands.despawn(1 as never);
        throw new Error('system failure');
      },
    });
    world.addSystem(Update, systemToken1).unwrap();
    const result = world.update(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isEcsFault(result.error, 'system-failed')).toBe(true);
    expect(world.execution.health).toBe('poisoned');
    expect(world.update(0).ok).toBe(false);
  });

  it('preflights same-batch duplicate component mutations without partial writes', () => {
    const world = new World();
    const entity = world.spawn({ component: CommandPosition, data: { x: 1 } }).unwrap();
    const buffer = createCommandBuffer(world, 'duplicate', Update.name);
    buffer.addComponent(entity, { component: CommandVelocity, data: { x: 2 } });
    buffer.addComponent(entity, { component: CommandVelocity, data: { x: 3 } });

    expect(() => flushCommands(buffer, world)).toThrow(
      expect.objectContaining({ code: 'command-failed' }),
    );
    expect(world.hasComponent(entity, CommandVelocity)).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('preflights relationship cycles and keeps the existing hierarchy intact', () => {
    const world = new World();
    const root = world.spawn().unwrap();
    const child = world.spawn({ component: CommandChildOf, data: { parent: root } }).unwrap();
    const grandchild = world.spawn({ component: CommandChildOf, data: { parent: child } }).unwrap();
    const buffer = createCommandBuffer(world, 'cycle', Update.name);
    buffer.addComponent(root, { component: CommandChildOf, data: { parent: grandchild } });

    expect(() => flushCommands(buffer, world)).toThrow(
      expect.objectContaining({ code: 'command-failed' }),
    );
    expect(world.execution.health).toBe('healthy');
    const current = world.get(child, CommandChildOf);
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value.parent).toBe(root);
  });

  it.each([
    false,
    true,
  ])('preserves staged source membership through reparent/remove/re-add (removeLast=%s)', (removeLast) => {
    const world = new World();
    const parents = [
      world.spawn().unwrap(),
      world.spawn().unwrap(),
      world.spawn().unwrap(),
    ] as const;
    const child = world.spawn().unwrap();
    const commands = createCommandBuffer(world);
    commands.addComponent(child, { component: CommandChildOf, data: { parent: parents[0] } });
    commands.addComponent(child, { component: CommandChildOf, data: { parent: parents[1] } });
    commands.removeComponent(child, CommandChildOf);
    commands.addComponent(child, { component: CommandChildOf, data: { parent: parents[2] } });
    commands.addComponent(child, { component: CommandChildOf, data: { parent: parents[0] } });
    if (removeLast) commands.removeComponent(child, CommandChildOf);
    flushCommands(commands, world);
    expect(commands.status).toBe('committed');
    expect(world.hasComponent(child, CommandChildOf)).toBe(!removeLast);
    if (!removeLast) expect(world.get(child, CommandChildOf).unwrap().parent).toBe(parents[0]);
    for (const [index, parent] of parents.entries()) {
      const children = world.get(parent, CommandChildren);
      expect(children.ok ? [...children.value.entities] : []).toEqual(
        !removeLast && index === 0 ? [child] : [],
      );
    }
    expect(world.execution.health).toBe('healthy');
  });

  it('treats an exclusive relationship add as a staged reparent', () => {
    const world = new World();
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const child = world.spawn({ component: CommandChildOf, data: { parent: first } }).unwrap();
    const buffer = createCommandBuffer(world, 'reparent', Update.name);
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
    const buffer = createCommandBuffer(world, 'batch-cycle', Update.name);
    buffer.addComponent(a, { component: CommandChildOf, data: { parent: b } });
    buffer.addComponent(b, { component: CommandChildOf, data: { parent: a } });

    expect(() => flushCommands(buffer, world)).toThrow(
      expect.objectContaining({ code: 'command-failed' }),
    );
    expect(world.hasComponent(a, CommandChildOf)).toBe(false);
    expect(world.hasComponent(b, CommandChildOf)).toBe(false);
    expect(world.execution.health).toBe('healthy');
  });

  it('bumps a cancelled pending reservation so a later entity cannot alias its handle', () => {
    const world = new World();
    let pending: EntityHandle | undefined;
    const systemToken2 = defineSystem({
      name: 'pending-abort',
      queries: [],
      fn: (_world, _queries, commands) => {
        pending = commands.spawn({ component: CommandPosition, data: { x: 4 } });
        throw new Error('abort pending');
      },
    });
    world.addSystem(Update, systemToken2).unwrap();

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
    const buffer = createCommandBuffer(world, 'flush', Update.name);
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
    expect(isEcsFault(failure, 'system-failed')).toBe(true);
    if (isEcsFault(failure, 'system-failed')) {
      expect(failure.detail.lastCommittedCommand).toEqual({ index: 0, kind: 'despawn' });
    }
    expect(world.execution.health).toBe('poisoned');
  });

  it('poisons on a first-command materialization failure without reclaiming its row', () => {
    const world = new World();
    const buffer = createCommandBuffer(world, 'flush', Update.name);
    const pending = buffer.spawn({ component: CommandPosition, data: { x: 7 } });
    const injected = createSharedKernelFailureError(
      'World.materializeEntity',
      world.identity,
      new Error('post-write materialization fault'),
      true,
    );
    const materialize = world[worldInternal].materializeEntity;
    vi.spyOn(world[worldInternal], 'materializeEntity').mockImplementationOnce(
      (entity, componentDatas) => {
        const result = materialize(entity, componentDatas);
        return result.ok ? err(injected) : result;
      },
    );

    expect(() => flushCommands(buffer, world)).toThrow(
      expect.objectContaining({ code: 'system-failed' }),
    );
    expect(world.execution.health).toBe('poisoned');
    expect(world.execution.fault?.partialWrite).toBe(true);
    expect(world.hasComponent(pending, CommandPosition)).toBe(true);
  });
});
