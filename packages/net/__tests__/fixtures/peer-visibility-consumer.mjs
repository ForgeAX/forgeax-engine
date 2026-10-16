import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  AuthorityCoordinator,
  ReplicaCoordinator,
  applyReplicationPacket,
  decodeReplicationPacket,
  defineReplication,
} from '@forgeax/engine-net';
const world = new World();
const Data = defineComponent('VisibilityEvidence', { secret: 'string', owner: 'u32' });
const profile = defineReplication({
  name: 'evidence',
  entities: { with: [Data] },
  components: [Data],
}).unwrap();
const a = world.spawn({ component: Data, data: { secret: 'A-private', owner: 11 } }).unwrap();
world.spawn({ component: Data, data: { secret: 'B-private', owner: 22 } }).unwrap();
const authority = new AuthorityCoordinator(world, profile);
const replicas = new Map([
  [11, new ReplicaCoordinator(new World(), profile)],
  [22, new ReplicaCoordinator(new World(), profile)],
]);
let hideA = false;
const policy = (entity, id) =>
  world.get(entity, Data).unwrap().owner === id && !(hideA && id === 11);
const trace = [];
const publish = (phase) => {
  const peers = [];
  for (const [id, replica] of replicas) {
    const packet = authority.publish(id, policy).unwrap();
    const wire = decodeReplicationPacket(packet.bytes, profile.limits).unwrap();
    assert(!new TextDecoder().decode(packet.bytes).includes(id === 11 ? 'B-private' : 'A-private'));
    applyReplicationPacket(replica, wire).unwrap();
    const state = replica
      .snapshot()
      .map((entry) => ({ id: entry.id, ...replica.readComponent(entry.id, Data) }));
    peers.push({ sessionId: id, packet: wire, bytes: packet.bytes.byteLength, state });
  }
  trace.push({ phase, peers });
};
publish('Initial baseline');
hideA = true;
publish('Revoke A');
world.set(a, Data, { secret: 'A-updated-hidden', owner: 11 }).unwrap();
publish('Mutate while hidden');
hideA = false;
publish('Reveal complete state');
assert.equal(trace[1].peers[0].state.length, 0);
assert.equal(trace[2].peers[0].packet.entities.length, 0);
assert.equal(trace[3].peers[0].state[0].secret, 'A-updated-hidden');
assert.equal(trace[3].peers[0].state[0].id, 2);
authority.forgetSession(11);
authority.resumeSession(11, 1);
replicas.get(11).clear();
hideA = true;
publish('Reconnect hidden A');
assert.equal(trace[4].peers[0].packet.kind, 'baseline');
assert.equal(trace[4].peers[0].state.length, 0);
const output = resolve(process.argv[2] ?? 'artifacts/g25');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'visibility-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
process.stdout.write(
  'Visibility consumer: 5 phases, 2 receiver Worlds, hidden payloads absent, fresh identity and reconnect baseline verified\n',
);
