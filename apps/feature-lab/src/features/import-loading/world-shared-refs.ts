import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'World shared asset refs',
  catalog: 'World shared asset refs',
  kind: 'headless',
  summary:
    'After a payload loads, the World owns its reference: allocSharedRef grants an independent handle, internSharedRef reuses one handle per payload object, and entity columns retain/release through the write barrier.',
  expect:
    'intern returns the same handle twice, alloc returns a new one, spawning a holder adds one reference and despawning removes it, and the final release makes the handle unresolvable.',
  run(checks) {
    const world = new World();
    const Holder = defineComponent('FeatureLabSharedHolder', { asset: 'shared<FeatureLabAsset>' });
    checks.ok('register holder', world.components.register(Holder).ok);
    const payload = { name: 'loaded payload' };
    const baseline = world.sharedRefs._liveCount();

    const interned = world.internSharedRef('FeatureLabAsset', payload);
    checks.ok(
      'intern is idempotent per payload',
      world.internSharedRef('FeatureLabAsset', payload) === interned,
    );
    const allocated = world.allocSharedRef('FeatureLabAsset', payload);
    checks.ok('alloc is an independent grant', allocated !== interned);
    checks.equal('two live slots', world.sharedRefs._liveCount() - baseline, 2);
    checks.equal('intern grant rc', world.sharedRefs.refcount(interned), 1);

    const entity = world.spawn({ component: Holder, data: { asset: interned } });
    checks.ok('spawn holder', entity.ok);
    checks.equal('entity column retains', world.sharedRefs.refcount(interned), 2);
    if (entity.ok) checks.ok('despawn holder', world.despawn(entity.value).ok);
    checks.equal('despawn releases the column grant', world.sharedRefs.refcount(interned), 1);

    const resolved = world.sharedRefs.resolve(interned);
    checks.ok('resolve returns the payload object', resolved.ok && resolved.value === payload);
    checks.ok('release interned', world.sharedRefs.release(interned).ok);
    checks.ok('released handle no longer resolves', !world.sharedRefs.resolve(interned).ok);
    checks.ok('release alloc', world.sharedRefs.release(allocated).ok);
    checks.equal('no leaked slots', world.sharedRefs._liveCount(), baseline);
  },
});
