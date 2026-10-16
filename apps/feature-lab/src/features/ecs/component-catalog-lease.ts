import { defineComponent, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'World-local ComponentCatalog lease',
  catalog: 'World-local ComponentCatalog lease',
  kind: 'headless',
  summary:
    'world.components.register leases a component name per World; dispose refuses while entities or systems still use it.',
  expect:
    'All checks pass: two Worlds lease independently, in-use disposal returns component-in-use, and a same-name different token returns component-name-conflict.',
  run(checks) {
    const Pos = defineComponent('FLLeasePos', { x: 'f32' });
    const Clash = defineComponent('FLLeasePos', { x: 'f32' });
    const a = new World();
    const b = new World();
    const leaseA = a.components.register(Pos);
    const leaseB = b.components.register(Pos);
    checks.ok('register in A and B', leaseA.ok && leaseB.ok);
    checks.ok('A resolves', a.components.resolve('FLLeasePos') === Pos);
    const clash = a.components.register(Clash);
    checks.equal(
      'name conflict in one World',
      clash.ok ? 'ok' : clash.error.code,
      'component-name-conflict',
    );
    const clashOther = new World().components.register(Clash);
    checks.ok('same name ok in a different World', clashOther.ok);
    const e = a.spawn({ component: Pos, data: { x: 1 } }).unwrap();
    if (!leaseA.ok || !leaseB.ok) return;
    const busy = leaseA.value.dispose();
    checks.equal('entity keeps lease', busy.ok ? 'ok' : busy.error.code, 'component-in-use');
    a.despawn(e);
    a.addSystem(Update, {
      name: 'fl-lease-reader',
      queries: [{ read: [Pos] }],
      fn: () => undefined,
    });
    const busySystem = leaseA.value.dispose();
    checks.equal(
      'system keeps lease',
      busySystem.ok ? 'ok' : busySystem.error.code,
      'component-in-use',
    );
    a.removeSystem(Update, 'fl-lease-reader');
    checks.ok('dispose after release', leaseA.value.dispose().ok);
    checks.ok('A no longer resolves', a.components.resolve('FLLeasePos') === undefined);
    checks.ok('B still resolves', b.components.resolve('FLLeasePos') === Pos);
    checks.ok('B dispose', leaseB.value.dispose().ok);
  },
});
