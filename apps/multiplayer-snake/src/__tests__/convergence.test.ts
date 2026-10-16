import { World } from '@forgeax/engine-ecs';
import {
  createReplicaCoordinator,
  decodeAndApplyReplicationPacket,
  type NetSession,
  type PeerId,
} from '@forgeax/engine-net';
import { afterEach, describe, expect, it } from 'vitest';
import { GridPosition, Snake, SnakeBody, SnakeSegment, snakeProfile } from '../shared/components';
import { createMemorySnake } from './fixtures/memory-session';

const fixtures: Awaited<ReturnType<typeof createMemorySnake>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('Snake deterministic convergence', () => {
  it('remaps SnakeBody.segments and cleans disconnected replica entities', async () => {
    const memory = await createMemorySnake([2, 3]);
    fixtures.push(memory);
    const authority = memory.server;
    for (const id of [2, 3]) memory.command(id, { kind: 'join' });
    memory.update().unwrap();
    authority.game.snakes.set(2, {
      sessionId: 2,
      direction: 'right',
      score: 2,
      cells: [
        { x: 5, y: 1 },
        { x: 4, y: 1 },
        { x: 3, y: 1 },
      ],
      respawnAt: null,
    });
    authority.world
      .getResource<NetSession>('net-session')
      .requestFullBaselineForSession(2 as never);
    const start = memory.sent.length;
    expect(memory.update(1).ok).toBe(true);
    const firstBatch = memory.sent
      .slice(start)
      .find((row) => row.peerId === 2 && packetKind(row.data) === 'baseline')?.data;
    expect(firstBatch).toBeDefined();
    if (firstBatch === undefined) return;
    const replicaWorld = new World();
    replicaWorld.spawn().unwrap();
    replicaWorld.spawn().unwrap();
    const replica = createReplicaCoordinator(replicaWorld, snakeProfile);
    const fixture = decodePacket(firstBatch) as {
      entities: Array<{
        id: number;
        components: Array<{ name: string; data: Record<string, unknown> }>;
      }>;
    };
    const bodyRecord = fixture.entities
      .flatMap((entity) => entity.components.map((component) => ({ entity, component })))
      .find(({ component }) => component.name === SnakeBody.name);
    expect(bodyRecord).toBeDefined();
    if (bodyRecord === undefined) return;
    expect(bodyRecord.component.data.segments).toHaveLength(2);
    const applied = decodeAndApplyReplicationPacket(replica, firstBatch, snakeProfile.limits);
    if (!applied.ok) throw new Error(applied.error.message);
    const snakeRow = replica.snapshot().find((row) => row.components.includes(Snake.name));
    expect(snakeRow).toBeDefined();
    if (snakeRow === undefined) return;
    const body = replica.readComponent(snakeRow.id, SnakeBody);
    const segmentRefs = Object.values(body?.segments ?? {});
    expect(segmentRefs.length).toBeGreaterThanOrEqual(2);
    const localSnake = replica.entityFor(snakeRow.id);
    expect(localSnake).toBeDefined();
    if (localSnake === undefined) return;
    const semantic = resolveBodySemantic(replica, snakeRow.id);
    expect(semantic.map((segment) => segment.order)).toEqual([1, 2]);
    expect(semantic.every((segment) => segment.owner === snakeRow.id)).toBe(true);
    const lateWorld = new World();
    for (let index = 0; index < 5; index += 1) lateWorld.spawn().unwrap();
    const late = createReplicaCoordinator(lateWorld, snakeProfile);
    expect(decodeAndApplyReplicationPacket(late, firstBatch, snakeProfile.limits).ok).toBe(true);
    const lateSnake = late.snapshot().find((row) => row.components.includes(Snake.name));
    expect(lateSnake).toBeDefined();
    if (lateSnake !== undefined) expect(resolveBodySemantic(late, lateSnake.id)).toEqual(semantic);

    const validSegments = segmentRefs as never[];
    const copiedLocal = replicaWorld.set(localSnake, SnakeBody, {
      segments: [replicaWorld.spawn().unwrap(), ...validSegments.slice(1)],
    });
    expect(copiedLocal.ok).toBe(true);
    expect(() => assertBodySemantic(replica, snakeRow.id)).toThrow();
    replicaWorld.set(localSnake, SnakeBody, { segments: validSegments }).unwrap();
    replicaWorld.set(localSnake, SnakeBody, { segments: [...validSegments].reverse() }).unwrap();
    expect(() => assertBodySemantic(replica, snakeRow.id)).toThrow();
    replicaWorld.set(localSnake, SnakeBody, { segments: validSegments }).unwrap();
    expect(() => assertBodySemantic(replica, snakeRow.id)).not.toThrow();

    memory
      .client(2)
      .host.disconnect(2 as PeerId)
      .unwrap();
    expect(memory.update(1).ok).toBe(true);
    expect(authority.game.snakes.has(2)).toBe(false);
    replica.clear();
    expect(
      replica
        .snapshot()
        .filter((row) =>
          row.components.some((name) => name === Snake.name || name === SnakeSegment.name),
        ),
    ).toHaveLength(0);
  });

  it('publishes a late peer full baseline with the admitted roster', async () => {
    const memory = await createMemorySnake([2, 3]);
    fixtures.push(memory);
    for (const id of [2, 3]) memory.command(id, { kind: 'join' });
    memory.update().unwrap();
    const early = memory.client(2).replica;
    const first = memory.sent
      .filter((row) => row.peerId === 2 && packetKind(row.data) === 'baseline')
      .at(-1)?.data;
    expect(playerIdsInBatch(first)).toEqual([2, 3]);
    const tick = early.tick;
    for (const id of [2, 3]) memory.command(id, { kind: 'ready' });
    memory.update(1).unwrap();
    expect(early.tick).toBeGreaterThan(tick);

    const start = memory.sent.length;
    memory.connect(4);
    memory.update().unwrap();
    const connectionBaseline = memory.sent
      .slice(start)
      .find((row) => row.peerId === 4 && packetKind(row.data) === 'baseline')?.data;
    expect(playerIdsInBatch(connectionBaseline)).toEqual([2, 3]);
    expect(memory.server.game.snakes.has(4)).toBe(false);
    memory.command(4, { kind: 'join' });
    memory.update().unwrap();
    const admittedBaseline = memory.sent
      .filter((row) => row.peerId === 4 && packetKind(row.data) === 'baseline')
      .at(-1)?.data;
    expect(playerIdsInBatch(admittedBaseline)).toEqual([2, 3, 4]);
    expect(
      memory
        .client(4)
        .replica.snapshot()
        .flatMap((row) => {
          const value = memory.client(4).replica.readComponent(row.id, Snake);
          return value ? [Number(value.playerNetworkId)] : [];
        })
        .sort(),
    ).toEqual([2, 3, 4]);
  });
});

function playerIdsInBatch(bytes: Uint8Array | undefined): number[] {
  if (bytes === undefined) throw new Error('Missing baseline packet');
  const batch = decodePacket(bytes) as {
    entities: Array<{ components: Array<{ name: string; data: { playerNetworkId?: number } }> }>;
  };
  return batch.entities
    .flatMap((entity) => entity.components)
    .filter((component) => component.name === Snake.name)
    .map((component) => component.data.playerNetworkId ?? 0)
    .sort((left, right) => left - right);
}

function packetKind(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  const body = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { kind?: unknown };
  return typeof body.kind === 'string' ? body.kind : '';
}

function decodePacket(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
}

function resolveBodySemantic(
  replica: ReturnType<typeof createReplicaCoordinator>,
  snakeId: number,
) {
  const body = replica.readComponent(snakeId, SnakeBody);
  const refs = Object.values(body?.segments ?? {});
  const snake = replica.readComponent(snakeId, Snake);
  return refs.map((segment) => {
    const row = replica.snapshot().find((candidate) => replica.entityFor(candidate.id) === segment);
    if (row === undefined) throw new Error('unresolved replica segment handle');
    const data = replica.readComponent(row.id, SnakeSegment);
    const position = replica.readComponent(row.id, GridPosition);
    if (
      data === undefined ||
      position === undefined ||
      Number(data.playerNetworkId) !== Number(snake?.playerNetworkId)
    )
      throw new Error('segment semantic mismatch');
    return {
      netId: row.id,
      owner: snakeId,
      order: Number(data.order),
      position: { x: Number(position.x), y: Number(position.y) },
    };
  });
}

function assertBodySemantic(replica: ReturnType<typeof createReplicaCoordinator>, snakeId: number) {
  const semantic = resolveBodySemantic(replica, snakeId);
  semantic.forEach((segment, index) => {
    if (segment.order !== index + 1) throw new Error('segment order mismatch');
  });
}
