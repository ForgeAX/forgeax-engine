import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  createMemoryEndpointPair,
  createReplicaCoordinator,
  type NetSession,
  netPlugin,
} from '@forgeax/engine-net';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { gridToWorldPosition, registerReplicaDerivation } from '../client';
import clientSource from '../client.ts?raw';
import { createServerWorld } from '../server';
import serverSource from '../server.ts?raw';
import { encodeCommand } from '../shared/commands';
import { GridPosition, Snake, SnakeSegment, snakeProfile } from '../shared/components';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

describe('Snake replica write contract', () => {
  it('uses NetSession snapshots and SessionId rather than transport identity for consumers', () => {
    expect(clientSource).toContain('getRecoverySnapshot');
    expect(clientSource).toContain('SessionId');
    expect(clientSource).toContain('sendToAuthority');
    expect(clientSource).toContain('ownedResources');
    expect(clientSource).not.toContain('endpoint.send(1 as PeerId');
    expect(clientSource).not.toContain('installKeyboardInput(endpoint');
    expect(serverSource).toContain('getRecoverySnapshot');
    expect(serverSource).toContain('SessionId');
    expect(serverSource).not.toContain('Map<number, SnakeEntities>');
  });

  it('branches every public lifecycle and structured failure outcome', () => {
    expect(clientSource).toContain("case 'connecting'");
    expect(clientSource).toContain("case 'resyncing'");
    expect(clientSource).toContain("case 'active'");
    expect(clientSource).toContain("case 'recovering'");
    expect(clientSource).toContain("case 'failed'");
    expect(clientSource).toContain("case 'retired'");
    expect(clientSource).toContain('lastError');
    expect(clientSource).toContain('ownedResources');
  });

  it('maps grid up to visual up', () => {
    expect(gridToWorldPosition(12, 8)).toEqual([0, 0, 0]);
    expect(gridToWorldPosition(12, 7)).toEqual([0, 1, 0]);
    expect(gridToWorldPosition(12, 9)).toEqual([0, -1, 0]);
  });

  it('waits for an accepted baseline before sending one join for the active epoch', () => {
    const world = new World();
    const replica = createReplicaCoordinator(world, snakeProfile);
    const stateTarget = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    let joinCount = 0;
    let active = false;
    const session = {
      getRecoverySnapshot: () =>
        ({
          sessionId: 7,
          state: { kind: active ? 'active' : 'resyncing', sessionId: 7, epoch: 0, sequence: 1 },
          pendingPackets: 0,
          maxPendingPackets: 32,
          acknowledgedSequence: 1,
          reconnectAttempts: 0,
          epoch: 0,
          sequence: 1,
          ownedResources: { pendingConnects: 0, timers: 0, ledgers: 0, callbacks: 0 },
        }) as never,
      sendToAuthority: () => {
        joinCount += 1;
        return ok(undefined);
      },
    } as Pick<NetSession, 'getRecoverySnapshot' | 'sendToAuthority'>;

    registerReplicaDerivation(world, replica, { stateTarget }, session);
    expect(world.update(1).ok).toBe(true);
    expect(joinCount).toBe(0);
    active = true;
    expect(world.update(1).ok).toBe(true);
    expect(joinCount).toBe(1);
    expect(stateTarget.dataset.joinSent).toBe('true');
    expect(world.update(1).ok).toBe(true);
    expect(joinCount).toBe(1);
  });

  it('applies a real batch then derives only local render components', async () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = await createServerWorld(authorityEndpoint);
    disposals.push(() => authority.host.dispose());
    const world = new World();
    const context = await createWorldContext(world, [netPlugin({ endpoint: replicaEndpoint })]);
    disposals.push(() => context.fiber.dispose());
    const replica = createReplicaCoordinator(world, snakeProfile);
    world.getResource<NetSession>('net-session').attachReplica(replica, snakeProfile.limits);
    const stateTarget = { dataset: {}, textContent: '' } as unknown as HTMLElement;
    const previousDocument = globalThis.document;
    let renderEntities: ReturnType<typeof registerReplicaDerivation>;
    Reflect.deleteProperty(globalThis, 'document');
    try {
      renderEntities = registerReplicaDerivation(world, replica, { stateTarget });
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument,
      });
    }

    acceptBaselineAndJoin(authority.world, world);
    expect(authority.world.update(1).ok).toBe(true);
    expect(world.update(1).ok).toBe(true);
    const row = replica.snapshot().find((entry) => entry.components.includes(Snake.name));
    expect(row).toBeDefined();
    if (row === undefined) return;
    const beforeSnake = replica.readComponent(row.id, Snake);
    const beforePosition = replica.readComponent(row.id, GridPosition);
    expect(beforeSnake).toBeDefined();
    expect(beforePosition).toBeDefined();

    // A second Update runs the registered derivation against the same applied data.
    expect(world.update(1).ok).toBe(true);
    expect(world.update(1).ok).toBe(true);
    expect(replica.readComponent(row.id, Snake)).toEqual(beforeSnake);
    expect(replica.readComponent(row.id, GridPosition)).toEqual(beforePosition);
    expect(renderEntities?.size).toBe(3);
    const renderEntity = renderEntities?.get(row.id);
    expect(renderEntity).toBeDefined();
    if (renderEntity === undefined) return;
    expect(world.get(renderEntity, MeshRenderer).unwrap().materials).toHaveLength(1);
    expect(world.get(renderEntity, MeshRenderer).unwrap().materials[0]).toBeGreaterThan(0);

    const segmentRow = replica
      .snapshot()
      .find((entry) => entry.components.includes(SnakeSegment.name));
    expect(segmentRow).toBeDefined();
    if (segmentRow === undefined) return;
    const segmentRenderEntity = renderEntities?.get(segmentRow.id);
    expect(segmentRenderEntity).toBeDefined();
    if (segmentRenderEntity === undefined) return;
    expect(world.get(segmentRenderEntity, MeshRenderer).ok).toBe(true);

    authorityEndpoint.close();
    expect(world.update(1 / 60).ok).toBe(true);
    expect(countRenderEntities(world)).toBe(0);
  });

  it('projects stable player identity separately from the network incarnation id', async () => {
    const [authorityEndpoint, replicaEndpoint] = createMemoryEndpointPair();
    const authority = await createServerWorld(authorityEndpoint);
    disposals.push(() => authority.host.dispose());
    const world = new World();
    const context = await createWorldContext(world, [netPlugin({ endpoint: replicaEndpoint })]);
    disposals.push(() => context.fiber.dispose());
    const replica = createReplicaCoordinator(world, snakeProfile);
    world.getResource<NetSession>('net-session').attachReplica(replica, snakeProfile.limits);
    acceptBaselineAndJoin(authority.world, world);
    authority.world.update(1).unwrap();
    world.update(1).unwrap();
    const row = replica.snapshot().find((entry) => entry.components.includes(Snake.name));
    expect(row).toBeDefined();
    if (!row) return;
    const snake = replica.readComponent(row.id, Snake);
    expect(snake).toEqual(expect.objectContaining({ playerNetworkId: expect.any(Number) }));
    expect(snake).not.toHaveProperty('color');
  });
});

function acceptBaselineAndJoin(authority: World, world: World) {
  const session = world.getResource<NetSession>('net-session');
  expect(session.receiveEvents()).toEqual([]);
  authority.update(1 / 60).unwrap();
  world.update(1 / 60).unwrap();
  const recovery = session.getRecoverySnapshot();
  expect(recovery.state.kind).toBe('active');
  const join = encodeCommand({ kind: 'join' });
  if (!join.ok) throw join.error;
  session.sendToAuthority(recovery.sessionId, join.value).unwrap();
}

function countRenderEntities(world: World): number {
  let count = 0;
  const query = world.query({ with: [Transform, MeshFilter, MeshRenderer] }).unwrap();
  for (const _row of query) count += 1;
  return count;
}
