import { defineComponent, defineSystemSet, FixedUpdate, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deepFrozen);
}

export default defineFeature({
  title: 'World inspection snapshot',
  catalog: 'World inspection',
  kind: 'headless',
  summary:
    'world.inspect() returns a detached, deeply frozen POD summary; componentsOf(entity) lists real membership.',
  expect:
    'All checks pass: counts, systems, sets, schedules and resource keys are reported, the snapshot is frozen, and later World changes do not mutate it.',
  run(checks) {
    const A = defineComponent('FLInspectA', { v: 'f32' });
    const B = defineComponent('FLInspectB', {});
    const world = new World();
    const e = world.spawn({ component: A, data: { v: 1 } }, { component: B, data: {} }).unwrap();
    world.spawn({ component: A, data: { v: 2 } }).unwrap();
    world.insertResource('FLInspectRes', 1);
    const InspectSet = defineSystemSet({ name: 'fl-inspect-set' });
    world.addSystems(Update, InspectSet, [
      { name: 'fl-inspect-u', queries: [], fn: () => undefined },
    ]);
    world.addSystem(FixedUpdate, { name: 'fl-inspect-f', queries: [], fn: () => undefined });
    const snap = world.inspect();
    checks.equal('entityCount', snap.entityCount, 2);
    checks.equal(
      'activeComponents',
      snap.activeComponents.filter((n) => n.startsWith('FLInspect')).sort(),
      ['FLInspectA', 'FLInspectB'],
    );
    checks.equal('systems', snap.systems.map((s) => s.name).sort(), [
      'fl-inspect-f',
      'fl-inspect-u',
    ]);
    checks.equal('set membership', snap.systems.find((s) => s.name === 'fl-inspect-u')?.sets, [
      'fl-inspect-set',
    ]);
    checks.equal('systemCount == systems.length', snap.systemCount, snap.systems.length);
    checks.equal('scheduleSystemCount(Update)', snap.scheduleSystemCount(Update), 1);
    checks.ok('resource keys', snap.resourceKeys.includes('FLInspectRes'));
    checks.ok(
      'deeply frozen',
      deepFrozen(snap.archetypes) && deepFrozen(snap.tables) && Object.isFrozen(snap),
    );
    checks.equal(
      'componentsOf',
      world
        .componentsOf(e)
        .unwrap()
        .map((c) => c.name)
        .filter((n) => n.startsWith('FLInspect'))
        .sort(),
      ['FLInspectA', 'FLInspectB'],
    );
    world.spawn({ component: A, data: { v: 3 } });
    checks.equal('snapshot detached', snap.entityCount, 2);
    checks.equal('fresh snapshot sees change', world.inspect().entityCount, 3);
    world.despawn(e);
    const stale = world.componentsOf(e);
    checks.equal('componentsOf stale', stale.ok ? 'ok' : stale.error.code, 'stale-entity');
  },
});
