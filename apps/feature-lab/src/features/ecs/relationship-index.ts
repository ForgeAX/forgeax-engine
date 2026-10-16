import { defineComponent, defineRelationship, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

const Spatial = defineComponent('FLRelSpatial', {});
const { source: FLChildOf, target: FLChildren } = defineRelationship({
  sourceName: 'FLRelChildOf',
  sourceField: 'parent',
  targetName: 'FLRelChildren',
  targetField: 'entities',
  sourceRequires: [Spatial],
  exclusive: true,
  linkedSpawn: true,
});

export default defineFeature({
  title: 'Relationship reverse index',
  catalog: 'Relationship reverse index',
  kind: 'headless',
  summary:
    'The source component (ChildOf) is the only writable fact; ECS materializes the target (Children) as a read-only reverse index.',
  expect:
    'All checks pass: Children follows every attach/detach/reparent, requires are materialized, direct target writes and self-cycles are rejected, and linked despawn cascades.',
  run(checks) {
    const world = new World();
    const kids = (p: Parameters<World['get']>[0]) => {
      const r = world.get(p, FLChildren);
      return r.ok ? Array.from(r.value.entities) : [];
    };
    const p1 = world.spawn().unwrap();
    const p2 = world.spawn().unwrap();
    const c1 = world.spawn({ component: FLChildOf, data: { parent: p1 } }).unwrap();
    const c2 = world.spawn({ component: FLChildOf, data: { parent: p1 } }).unwrap();
    checks.equal('children of p1', kids(p1), [c1, c2]);
    checks.ok('sourceRequires materialized', world.hasComponent(c1, Spatial));
    checks.ok('reparent', world.reparent(c1, p2, FLChildOf, {}).ok);
    checks.equal('p1 after reparent', kids(p1), [c2]);
    checks.equal('p2 after reparent', kids(p2), [c1]);
    const set = world.set(c2, FLChildOf, { parent: p2 });
    checks.ok('source write moves child', set.ok);
    checks.equal('p1 empty', kids(p1), []);
    checks.equal('p2 holds both', kids(p2).sort(), [c1, c2].sort());
    const direct = world.set(p2, FLChildren as never, { entities: new Uint32Array([p1]) } as never);
    checks.ok(
      'direct target write rejected',
      !direct.ok,
      direct.ok ? undefined : direct.error.code,
    );
    const self = world.set(c1, FLChildOf, { parent: c1 });
    checks.equal('self cycle', self.ok ? 'ok' : self.error.code, 'relationship-self-cycle');
    checks.equal('ancestors of c1', [...world.iterAncestors(c1)], [p2]);
    checks.equal('descendant count of p2', [...world.iterDescendants(p2)].length, 2);
    checks.ok('removeComponent detaches', world.removeComponent(c2, FLChildOf).ok);
    checks.equal('p2 after detach', kids(p2), [c1]);
    checks.ok('despawn parent', world.despawn(p2).ok);
    checks.ok('linkedSpawn despawns child', !world.get(c1, Spatial).ok);
    checks.ok('detached child survives', world.get(c2, Spatial).ok);
  },
});
