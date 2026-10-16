import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'UniqueRef/SharedRef write barrier',
  catalog: 'UniqueRef/SharedRef write barrier',
  kind: 'headless',
  summary:
    'Per-World ref stores: spawn/set/despawn/removeComponent retain and release shared handles and fire the unique onRelease exactly once.',
  expect:
    'All checks pass: shared payloads stay resolvable while any holder remains, the final release returns evidence, stale handles are rejected, and unique onRelease fires once on despawn.',
  run(checks) {
    const Holder = defineComponent('FLRefHolder', { mesh: 'shared<FLMesh>' });
    const Body = defineComponent('FLRefBody', { body: 'unique<FLBody>' });
    const world = new World();
    const payload = { name: 'mesh' };
    const h = world.allocSharedRef('FLMesh', payload);
    const e1 = world.spawn({ component: Holder, data: { mesh: h } }).unwrap();
    const e2 = world.spawn({ component: Holder, data: { mesh: h } }).unwrap();
    checks.ok('caller releases alloc grant', world.sharedRefs.release(h).ok);
    checks.ok('still resolvable via holders', world.sharedRefs.resolve(h).ok);
    world.despawn(e1);
    checks.ok('resolvable with one holder', world.sharedRefs.resolve(h).ok);
    world.removeComponent(e2, Holder);
    const gone = world.sharedRefs.resolve(h);
    checks.ok('released after last holder', !gone.ok, gone.ok ? 'still live' : gone.error.code);
    const again = world.sharedRefs.release(h);
    checks.ok('second release rejected', !again.ok, again.ok ? 'ok' : again.error.code);
    const interned1 = world.internSharedRef('FLMesh', payload);
    const interned2 = world.internSharedRef('FLMesh', payload);
    checks.equal('intern is idempotent', interned1, interned2);
    const other = new World();
    checks.ok('stores are per World', !other.sharedRefs.resolve(interned1).ok);

    const released: string[] = [];
    const u = world.allocUniqueRef('FLBody', 'rigid-1', (p) => released.push(p));
    const b = world.spawn({ component: Body, data: { body: u } }).unwrap();
    checks.equal('unique not released while held', released, []);
    const u2 = world.allocUniqueRef('FLBody', 'rigid-2', (p) => released.push(p));
    world.set(b, Body, { body: u2 });
    checks.equal('set releases replaced unique', released, ['rigid-1']);
    world.despawn(b);
    checks.equal('despawn releases current unique once', released, ['rigid-1', 'rigid-2']);
  },
});
