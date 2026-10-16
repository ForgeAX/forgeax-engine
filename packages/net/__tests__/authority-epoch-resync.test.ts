import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createAuthorityCoordinator } from '../src/replication/authority';
import { defineReplication } from '../src/replication/profile';

const NetworkedEpoch = defineComponent('NetworkedEpoch', { enabled: 'bool' });

function profile() {
  const result = defineReplication({
    name: 'authority-epoch-resync',
    entities: { with: [NetworkedEpoch] },
    components: [NetworkedEpoch],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('authority epoch resync', () => {
  it('increments epoch and publishes a fresh sequence-one baseline', () => {
    const world = new World();
    world.spawn({ component: NetworkedEpoch, data: { enabled: true } });
    const authority = createAuthorityCoordinator(world, profile());

    const first = authority.publish().unwrap();
    const reconnect = authority.publishFull().unwrap();

    expect(first).toMatchObject({ kind: 'baseline', epoch: 0, sequence: 1 });
    expect(reconnect).toMatchObject({ kind: 'baseline', epoch: 1, sequence: 1 });
    expect(reconnect.entities).toEqual(first.entities);
  });
});
