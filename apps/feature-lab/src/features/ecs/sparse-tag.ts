import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Sparse tag component',
  catalog: 'Sparse tag component',
  kind: 'headless',
  summary:
    'An empty schema expresses presence only; storage "sparse" is accepted only for field-less tags.',
  expect:
    'All checks pass: tags filter queries via with/without, add/remove toggles presence, and a sparse component with fields throws sparse-storage-requires-tag.',
  run(checks) {
    const Unit = defineComponent('FLTagUnit', { hp: 'f32' });
    const Selected = defineComponent('FLTagSelected', {});
    const Frozen = defineComponent('FLTagFrozen', {}, { storage: 'sparse' });
    checks.equal('empty schema has no fields', Object.keys(Selected.fields).length, 0);
    checks.equal('sparse storage token', Frozen.storage, 'sparse');
    const world = new World();
    const a = world
      .spawn({ component: Unit, data: { hp: 1 } }, { component: Selected, data: {} })
      .unwrap();
    const b = world.spawn({ component: Unit, data: { hp: 2 } }).unwrap();
    const count = (q: Parameters<World['query']>[0]) => [...world.query(q).unwrap()].length;
    checks.equal('with Selected', count({ read: [Unit], with: [Selected] }), 1);
    checks.equal('without Selected', count({ read: [Unit], without: [Selected] }), 1);
    checks.ok('add sparse tag', world.addComponent(b, { component: Frozen, data: {} }).ok);
    checks.ok('hasComponent sparse', world.hasComponent(b, Frozen));
    checks.equal('with Frozen', count({ read: [Unit], with: [Frozen] }), 1);
    checks.ok('componentsOf lists tag', world.componentsOf(b).unwrap().includes(Frozen));
    checks.ok('remove tag', world.removeComponent(a, Selected).ok);
    checks.equal('with Selected after remove', count({ read: [Unit], with: [Selected] }), 0);
    const dup = world.addComponent(b, { component: Frozen, data: {} });
    checks.equal('duplicate tag', dup.ok ? 'ok' : dup.error.code, 'component-already-present');
    let code = 'none';
    try {
      defineComponent('FLTagBadSparse', { x: 'f32' }, { storage: 'sparse' });
    } catch (error) {
      code = (error as { code?: string }).code ?? 'thrown';
    }
    checks.equal('sparse with fields rejected', code, 'sparse-storage-requires-tag');
  },
});
