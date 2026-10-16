import { type Component, defineComponent } from '@forgeax/engine/ecs';
import { DEFAULT_REPLICATION_LIMITS, defineReplication } from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';
import { NetHealth } from './support/hub';

const Tag = defineComponent('FeatureLabNetTag', { team: 'u32' });

export default defineFeature({
  title: 'Replication profile',
  catalog: 'Replication profile',
  kind: 'headless',
  summary:
    'defineReplication({ name, entities: { with }, components, limits? }) freezes the portable component set, the entity filter, the limits and a schema fingerprint that both peers must share.',
  expect:
    'All checks pass: the profile is frozen with default limits, the same definition yields the same fingerprint, any change to name, components or limits changes it, and overrides merge onto the defaults.',
  run(checks) {
    const make = (
      name: string,
      components: readonly Component[] = [NetHealth],
      limits?: { maxEntities: number },
    ) =>
      defineReplication({
        name,
        entities: { with: [NetHealth] },
        components,
        ...(limits === undefined ? {} : { limits }),
      });
    const base = make('lab');
    checks.ok('valid profile returns ok', base.ok, base.ok ? undefined : base.error.code);
    if (!base.ok) return;
    const profile = base.value;
    checks.ok(
      'profile object is frozen',
      Object.isFrozen(profile) && Object.isFrozen(profile.components),
    );
    checks.equal('default limits applied', profile.limits, DEFAULT_REPLICATION_LIMITS);
    checks.ok(
      'fingerprint is a non-empty string',
      typeof profile.fingerprint === 'string' && profile.fingerprint.length > 0,
    );
    const same = make('lab');
    checks.ok(
      'identical definition gives identical fingerprint',
      same.ok && same.value.fingerprint === profile.fingerprint,
    );
    const renamed = make('lab-2');
    checks.ok(
      'name change alters fingerprint',
      renamed.ok && renamed.value.fingerprint !== profile.fingerprint,
    );
    const wider = make('lab', [NetHealth, Tag]);
    checks.ok(
      'component set change alters fingerprint',
      wider.ok && wider.value.fingerprint !== profile.fingerprint,
    );
    const limited = make('lab', [NetHealth], { maxEntities: 4 });
    checks.ok(
      'limit override alters fingerprint',
      limited.ok && limited.value.fingerprint !== profile.fingerprint,
    );
    checks.equal(
      'limit override merges onto defaults',
      limited.ok ? limited.value.limits.maxEntities : -1,
      4,
    );
    checks.equal(
      'other limits keep defaults',
      limited.ok ? limited.value.limits.maxMessageBytes : -1,
      DEFAULT_REPLICATION_LIMITS.maxMessageBytes,
    );
  },
});
