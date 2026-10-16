import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { REPLICATION_PROTOCOL_VERSION } from '../src/replication/constants';
import { defineReplication } from '../src/replication/profile';

const NetworkedAuthority = defineComponent('NetworkedAuthority', { enabled: 'bool' });
const PositionAuthority = defineComponent('PositionAuthority', { x: 'f32', y: 'f32' });
const MessageAuthority = defineComponent('MessageAuthority', { text: 'string' });

function createProfile() {
  const profile = defineReplication({
    name: 'authority-publication',
    entities: { with: [NetworkedAuthority] },
    components: [NetworkedAuthority, PositionAuthority],
  });
  if (!profile.ok) throw profile.error;
  return profile.value;
}

describe('authority canonical publication', () => {
  it('publishes a full baseline for a new peer and deltas thereafter', () => {
    const world = new World();
    world.spawn(
      { component: NetworkedAuthority, data: { enabled: true } },
      { component: PositionAuthority, data: { x: 1, y: 2 } },
    );
    const authority = createAuthorityCoordinator(world, createProfile());

    const baseline = authority.publish();
    const unchanged = authority.publish();
    expect(baseline.ok).toBe(true);
    expect(unchanged.ok).toBe(true);
    if (!baseline.ok || !unchanged.ok) return;
    expect(baseline.value.version).toBe(REPLICATION_PROTOCOL_VERSION);
    expect(baseline.value.kind).toBe('baseline');
    expect(baseline.value.entities[0]!.components).toHaveLength(2);
    expect(unchanged.value.kind).toBe('delta');
    expect(unchanged.value.entities).toHaveLength(0);
    expect(unchanged.value.tick).toBeGreaterThan(baseline.value.tick);
  });

  it('emits a complete component replacement delta smaller than the full baseline', () => {
    const world = new World();
    const entity = world
      .spawn(
        { component: NetworkedAuthority, data: { enabled: true } },
        { component: PositionAuthority, data: { x: 1, y: 2 } },
      )
      .unwrap();
    const authority = createAuthorityCoordinator(world, createProfile());
    const baseline = authority.publish().unwrap();
    world.set(entity, PositionAuthority, { x: 3, y: 2 }).unwrap();
    const delta = authority.publish().unwrap();

    expect(delta.kind).toBe('delta');
    expect(delta.entities).toHaveLength(1);
    expect(delta.entities[0]!.components).toEqual([
      { name: 'PositionAuthority', data: { x: 3, y: 2 } },
    ]);
    expect(delta.bytes.byteLength).toBeLessThan(baseline.bytes.byteLength);
  });

  it('cleans up despawned identity and gives a late peer a fresh full baseline', () => {
    const world = new World();
    const entity = world.spawn({ component: NetworkedAuthority, data: { enabled: true } }).unwrap();
    const authority = createAuthorityCoordinator(world, createProfile());
    const first = authority.publish().unwrap();
    world.despawn(entity).unwrap();
    const despawn = authority.publish().unwrap();
    const lateJoin = authority.publishFull().unwrap();

    expect(first.entities[0]!.id).toBeGreaterThan(0);
    expect(despawn.entities[0]).toMatchObject({ kind: 'despawn', id: first.entities[0]!.id });
    expect(lateJoin.kind).toBe('baseline');
    expect(lateJoin.entities).toHaveLength(0);
  });

  it('does not advance authority baseline when canonical encoding rejects a publish', () => {
    const world = new World();
    const entity = world
      .spawn(
        { component: NetworkedAuthority, data: { enabled: true } },
        { component: MessageAuthority, data: { text: 'too long' } },
      )
      .unwrap();
    const constrained = defineReplication({
      name: 'authority-publication',
      entities: { with: [NetworkedAuthority] },
      components: [NetworkedAuthority, MessageAuthority],
      limits: { maxStringBytes: 4 },
    });
    expect(constrained.ok).toBe(true);
    if (!constrained.ok) return;
    const authority = createAuthorityCoordinator(world, constrained.value);

    expect(authority.publish().ok).toBe(false);
    world.set(entity, MessageAuthority, { text: 'fits' }).unwrap();
    const retry = authority.publish();
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.kind).toBe('baseline');
    expect(retry.value.entities).toHaveLength(1);
  });
});
