import { defineComponent, World } from '@forgeax/engine/ecs';
import { createAuthorityCoordinator } from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';
import { healthProfile, NetHealth } from './support/hub';

const Secret = defineComponent('FeatureLabNetSecret', { code: 'u32' });

export default defineFeature({
  title: 'Authority replication',
  catalog: 'Authority replication',
  kind: 'headless',
  summary:
    'createAuthorityCoordinator(world, profile) turns only profile-selected entities and components into portable baseline/delta packets with stable NetEntityIds; unselected components never leave the World.',
  expect:
    'All checks pass: publishFull emits a sequence-1 baseline with only the selected entity and component, the next publish is a delta carrying the changed value, and despawn becomes a despawn record.',
  run(checks) {
    const profile = healthProfile('authority-lab');
    if (typeof profile === 'string') {
      checks.ok('replication profile defined', false, profile);
      return;
    }
    const world = new World();
    world.components.register(NetHealth).unwrap();
    world.components.register(Secret).unwrap();
    const hero = world
      .spawn(
        { component: NetHealth, data: { hp: 80, alive: true } },
        { component: Secret, data: { code: 1234 } },
      )
      .unwrap();
    world.spawn({ component: Secret, data: { code: 5 } }).unwrap();
    const authority = createAuthorityCoordinator(world, profile);
    const full = authority.publishFull();
    checks.ok('publishFull ok', full.ok, full.ok ? undefined : full.error.code);
    if (!full.ok) return;
    const baseline = full.value;
    checks.equal('baseline kind and sequence', [baseline.kind, baseline.sequence], ['baseline', 1]);
    checks.equal(
      'baseline carries the profile fingerprint',
      'fingerprint' in baseline ? baseline.fingerprint : '',
      profile.fingerprint,
    );
    checks.equal('only the profile-selected entity is replicated', baseline.entities.length, 1);
    const record = baseline.entities[0];
    const names =
      record?.kind === 'upsert' ? record.components.map((component) => component.name) : [];
    checks.equal('only profile components are serialized', names, ['FeatureLabNetHealth']);
    checks.equal('NetEntityId is stable', record?.id, authority.idFor(hero));
    world.set(hero, NetHealth, { hp: 12, alive: true }).unwrap();
    const delta = authority.publish();
    checks.ok(
      'publish after change is a delta',
      delta.ok && delta.value.kind === 'delta',
      delta.ok ? delta.value.kind : delta.error.code,
    );
    const changed = delta.ok ? delta.value.entities[0] : undefined;
    const hp = changed?.kind === 'upsert' ? changed.components[0]?.data.hp : undefined;
    checks.equal('delta carries the new hp', hp, 12);
    const heroId = authority.idFor(hero);
    world.despawn(hero);
    const removal = authority.publish();
    const removed = removal.ok
      ? removal.value.entities.find((entity) => entity.id === heroId)
      : undefined;
    checks.equal('despawn is published as a despawn record', removed?.kind, 'despawn');
  },
});
