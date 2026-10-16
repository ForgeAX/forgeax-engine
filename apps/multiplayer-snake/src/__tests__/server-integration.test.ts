import type { EntityHandle } from '@forgeax/engine-ecs';
import { encodeReplicationPacket, type PeerId } from '@forgeax/engine-net';
import { afterEach, describe, expect, it } from 'vitest';
import { Networked, Snake, SnakeBody, SnakeSegment, snakeProfile } from '../shared/components';
import { createMemorySnake } from './fixtures/memory-session';

const fixtures: Awaited<ReturnType<typeof createMemorySnake>>[] = [];
async function fixture(ids: readonly number[]) {
  const value = await createMemorySnake(ids);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose();
});

describe('assembled Snake authority', () => {
  it('keeps transport-only connections waiting and starts after two admitted peers are ready', async () => {
    const memory = await fixture([1, 2]);
    const { server } = memory;
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.snakes.size).toBe(0);
    memory.command(1, { kind: 'join' });
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.snakes.size).toBe(1);
    expect(server.game.started).toBe(false);
    expect(server.game.snakes.get(1)?.cells).toHaveLength(3);
    memory.command(2, { kind: 'join' });
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(false);
    memory.command(1, { kind: 'ready' });
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(false);
    memory.command(2, { kind: 'ready' });
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.started).toBe(true);
    expect(server.game.tick).toBe(0);
    const before = server.game.snakes.get(1)?.cells[0];
    expect(memory.update(1 / 60).ok).toBe(true);
    expect(server.game.tick).toBe(1);
    expect(server.game.snakes.get(1)?.cells[0]).not.toEqual(before);
  });
  it('installs deterministic fixed-tick simulation over a memory endpoint', async () => {
    const memory = await createStartedServer();
    const { server } = memory;
    expect(server.game.tick).toBe(0);
    expect(memory.update(1).ok).toBe(true);
    expect(server.game.tick).toBe(4);
  });

  it('rejects malformed and opposite commands at the assembled boundary', async () => {
    const memory = await fixture([2]);
    const { server } = memory;
    memory.command(2, { kind: 'join' });
    expect(memory.update(1).ok).toBe(true);
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    const before = structuredClone(snake);
    memory.send(2, new Uint8Array([99, 99, 99]));
    expect(memory.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)).toEqual(
      expect.objectContaining({ direction: before?.direction }),
    );
    // A payload with an extra identity field is malformed; identity comes from the event.
    memory.send(2, new Uint8Array([1, 2, 7]));
    expect(memory.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)?.direction).toBe(before?.direction);
    // First valid command wins for this fixed tick; the duplicate is ignored.
    memory.send(2, new Uint8Array([1, 0]));
    memory.send(2, new Uint8Array([1, 2]));
    expect(memory.update(0.25).ok).toBe(true);
    expect(server.game.snakes.get(2)?.direction).toBe('up');
  });

  it('grows on food and respawns exactly 30 fixed ticks after death', async () => {
    const fixedStep = 1 / 60;
    const memory = await createStartedServer();
    const { server } = memory;
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    if (snake === undefined) return;

    snake.cells = [{ x: 4, y: 1 }];
    server.game.food = { x: 5, y: 1 };
    const scoreBefore = snake.score;
    expect(memory.update(fixedStep).ok).toBe(true);
    expect(snake.score).toBe(scoreBefore + 1);
    expect(snake.cells).toHaveLength(2);

    snake.cells = [{ x: 23, y: 1 }];
    snake.direction = 'right';
    for (let index = 0; index < 5; index += 1) expect(memory.update(fixedStep).ok).toBe(true);
    expect(snake.cells).toHaveLength(0);
    const respawnTick = snake.respawnAt;
    expect(respawnTick).toBe(server.game.tick + 30);
    while (server.game.tick < (respawnTick as number) - 1) {
      const update = memory.update(fixedStep);
      if (!update.ok) throw new Error(update.error.message);
      expect(update.ok).toBe(true);
      expect(snake.cells).toHaveLength(0);
    }
    expect(server.game.tick).toBe((respawnTick as number) - 1);
    expect(memory.update(fixedStep).ok).toBe(true);
    expect(snake.respawnAt).toBeNull();
    expect(snake.cells).toHaveLength(3);
  });

  it('projects authoritative snakes, segments, and remapped body references into ECS', async () => {
    const memory = await createStartedServer();
    const { server } = memory;
    server.game.snakes.delete(1);
    const authoritySnake = server.game.snakes.get(2);
    expect(authoritySnake).toBeDefined();
    authoritySnake?.cells.splice(0, authoritySnake.cells.length, { x: 4, y: 2 }, { x: 3, y: 2 });
    expect(memory.update(1).ok).toBe(true);
    const snakes: EntityHandle[] = [];
    const segments: EntityHandle[] = [];
    const networked = server.world.query({ with: [Networked] }).unwrap();
    for (const row of networked) {
      const entity = row.entity;
      if (server.world.get(entity, Snake).ok) snakes.push(entity);
      if (server.world.get(entity, SnakeSegment).ok) segments.push(entity);
    }
    expect(snakes).toHaveLength(1);
    expect(segments).toHaveLength(1);
    const body = server.world.get(snakes[0] as EntityHandle, SnakeBody).unwrap();
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0]).toBe(segments[0]);
  });

  it('despawns the snake and segments after an authority death', async () => {
    const memory = await createStartedServer();
    const { server } = memory;
    server.game.snakes.delete(1);
    const snake = server.game.snakes.get(2);
    expect(snake).toBeDefined();
    snake?.cells.splice(0, snake.cells.length, { x: 23, y: 1 }, { x: 22, y: 1 });
    expect(memory.update(1).ok).toBe(true);
    expect(snake?.respawnAt).not.toBeNull();
    const projected = [] as EntityHandle[];
    const networked = server.world.query({ with: [Networked] }).unwrap();
    for (const row of networked) projected.push(row.entity);
    expect(projected.every((entity) => !server.world.get(entity, Snake).ok)).toBe(true);
  });

  it('refuses a fifth peer without creating a fifth snake', async () => {
    const memory = await fixture([1, 2, 3, 4, 5]);
    const { server } = memory;
    for (const id of [1, 2, 3, 4, 5]) memory.command(id, { kind: 'join' });
    expect(memory.update(1).ok).toBe(true);
    expect(server.game.snakes.size).toBe(4);
    expect(server.game.snakes.has(5)).toBe(false);
  });

  it('binds commands to endpoint PeerId and ignores an identity-confused event', async () => {
    const memory = await fixture([7]);
    const { server } = memory;
    memory.command(7, { kind: 'join' });
    expect(memory.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('right');

    memory.send(7, new Uint8Array([1, 2])).unwrap();
    expect(memory.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('down');
    expect(server.game.lastDirectionCommandPlayerNetworkId).toBe(7);
    expect(server.game.lastDirectionCommandGameplayTick).toBe(0);

    // The command bytes contain no peer field. A transport event claiming a
    // different peer cannot steer the connected snake because PeerId comes
    // from the endpoint event and must match the connected-peer snapshot.
    const current = memory.client(7).session.getRecoverySnapshot();
    memory.inject({
      kind: 'message',
      peerId: 99 as PeerId,
      data: encodeReplicationPacket(
        {
          version: 2,
          kind: 'application',
          sessionId: current.sessionId,
          epoch: current.epoch,
          payload: [1, 0],
        },
        snakeProfile.limits,
      ).unwrap(),
    });
    expect(memory.update(1).ok).toBe(true);
    expect(server.game.snakes.get(7)?.direction).toBe('down');
    expect(server.game.snakes.has(99)).toBe(false);
    expect(server.game.lastDirectionCommandPlayerNetworkId).toBe(7);
  });
});

async function createStartedServer() {
  const memory = await fixture([1, 2]);
  for (const id of [1, 2]) memory.command(id, { kind: 'join' });
  memory.update().unwrap();
  for (const id of [1, 2]) memory.command(id, { kind: 'ready' });
  memory.update().unwrap();
  return memory;
}
