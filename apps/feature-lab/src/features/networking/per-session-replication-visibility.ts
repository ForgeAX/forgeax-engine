import { World } from '@forgeax/engine/ecs';
import {
  createAuthorityCoordinator,
  createReplicaCoordinator,
  createSessionId,
} from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';
import { healthProfile, NetHealth } from './support/hub';
export default defineFeature({
  title: 'Per-session replication visibility',
  catalog: 'Per-session replication visibility',
  kind: 'headless',
  summary:
    'One authority projects receiver-local identities and bounded visibility changes into ordinary replication packets.',
  expect:
    'Separate receivers see only admitted entities; hiding removes the projection and re-entry creates a fresh identity.',
  run(checks) {
    const profile = healthProfile();
    if (typeof profile === 'string') {
      checks.ok('profile', false, profile);
      return;
    }
    const world = new World();
    world.components.register(NetHealth).unwrap();
    const a = world.spawn({ component: NetHealth, data: { hp: 100 } }).unwrap(),
      b = world.spawn({ component: NetHealth, data: { hp: 42 } }).unwrap();
    const authority = createAuthorityCoordinator(world, profile),
      sa = createSessionId(11).unwrap(),
      sb = createSessionId(12).unwrap();
    const wa = new World(),
      wb = new World();
    wa.components.register(NetHealth).unwrap();
    wb.components.register(NetHealth).unwrap();
    const ra = createReplicaCoordinator(wa, profile),
      rb = createReplicaCoordinator(wb, profile);
    let visible = true;
    const policy = (entity: typeof a, session: typeof sa) =>
      visible && entity === (session === sa ? a : b);
    ra.apply(authority.publish(sa, policy).unwrap()).unwrap();
    rb.apply(authority.publish(sb, policy).unwrap()).unwrap();
    const original = authority.idFor(a, sa);
    checks.equal('receiver A health', ra.readComponent(original, NetHealth)?.hp, 100);
    checks.equal('receiver B health', rb.readComponent(authority.idFor(b, sb), NetHealth)?.hp, 42);
    checks.equal('unadmitted identity absent', authority.idFor(b, sa), 0);
    visible = false;
    ra.apply(authority.publish(sa, policy).unwrap()).unwrap();
    checks.equal('hide removes entity', ra.entityFor(original), undefined);
    visible = true;
    ra.apply(authority.publish(sa, policy).unwrap()).unwrap();
    const current = authority.idFor(a, sa);
    checks.ok('re-entry changes identity', current !== original);
    checks.equal('re-entry restores data', ra.readComponent(current, NetHealth)?.hp, 100);
    ra.clear();
    rb.clear();
    authority.forgetSession(sa);
    authority.forgetSession(sb);
  },
});
