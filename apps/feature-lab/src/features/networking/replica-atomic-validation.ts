import { World } from '@forgeax/engine/ecs';
import type {
  ReplicationDataPacket,
  ReplicationEntityRecord,
  SessionId,
} from '@forgeax/engine/net';
import {
  applyReplicationPacket,
  createReplicaCoordinator,
  decodeAndApplyReplicationPacket,
} from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';
import { healthProfile, NetHealth } from './support/hub';

export default defineFeature({
  title: 'Replica atomic validation',
  catalog: 'Replica atomic validation',
  kind: 'headless',
  summary:
    'The replica coordinator validates fingerprint, packet order, identities, unknown components, references and bytes before it touches the World. A refused packet is a structured NetError and leaves the World exactly as it was.',
  expect:
    'All checks pass: every malformed packet is refused with its specific code (schema-invalid, session-illegal-transition, identity-invalid, decode error) while the replica snapshot and entity count stay unchanged; a valid baseline then applies.',
  run(checks) {
    const profile = healthProfile('replica-lab');
    if (typeof profile === 'string') {
      checks.ok('replication profile defined', false, profile);
      return;
    }
    const world = new World();
    world.components.register(NetHealth).unwrap();
    const replica = createReplicaCoordinator(world, profile);
    const hero: ReplicationEntityRecord = {
      id: 1,
      kind: 'upsert',
      components: [{ name: 'FeatureLabNetHealth', data: { hp: 50, alive: true } }],
    };
    const packet = (overrides: Partial<ReplicationDataPacket>): ReplicationDataPacket =>
      ({
        version: 2,
        kind: 'baseline',
        sessionId: 1 as SessionId,
        epoch: 1,
        sequence: 1,
        fingerprint: profile.fingerprint,
        tick: 1,
        entities: [hero],
        ...overrides,
      }) as ReplicationDataPacket;
    const entityCount = () =>
      replica.snapshot().length + (replica.entityFor(1) === undefined ? 0 : 1);
    const refused = (name: string, candidate: ReplicationDataPacket, code: string) => {
      const result = applyReplicationPacket(replica, candidate);
      checks.ok(
        `${name} refused with ${code}`,
        !result.ok && result.error.code === code,
        result.ok ? 'accepted' : result.error.code,
      );
      checks.ok(`${name} leaves the World unchanged`, entityCount() === 0);
    };
    refused('fingerprint mismatch', packet({ fingerprint: 'not-the-profile' }), 'schema-invalid');
    refused(
      'delta before any baseline',
      packet({ kind: 'delta', sequence: 2 }),
      'session-illegal-transition',
    );
    refused('zero entity identity', packet({ entities: [{ ...hero, id: 0 }] }), 'identity-invalid');
    refused(
      'unknown component name',
      packet({
        entities: [{ id: 1, kind: 'upsert', components: [{ name: 'NotInProfile', data: {} }] }],
      }),
      'schema-invalid',
    );
    const garbage = decodeAndApplyReplicationPacket(
      replica,
      Uint8Array.of(0xff, 0x00, 0x13),
      profile.limits,
    );
    checks.ok(
      'undecodable bytes refused',
      !garbage.ok,
      garbage.ok ? 'accepted' : garbage.error.code,
    );
    checks.ok('undecodable bytes leave the World unchanged', entityCount() === 0);
    const accepted = applyReplicationPacket(replica, packet({}));
    checks.ok('valid baseline applies', accepted.ok, accepted.ok ? undefined : accepted.error.code);
    checks.equal('replica now holds one entity', replica.snapshot().length, 1);
    checks.ok(
      'replica entity is a real World entity',
      replica.entityFor(1) !== undefined &&
        world.hasComponent(replica.entityFor(1) as never, NetHealth),
    );
    checks.equal('replicated value readable', replica.readComponent(1, NetHealth)?.hp, 50);
    const stale = applyReplicationPacket(replica, packet({ tick: 1, sequence: 1 }));
    checks.ok(
      're-sent baseline is harmless',
      stale.ok && replica.lastPacketOutcome === 'duplicate',
      replica.lastPacketOutcome,
    );
  },
});
