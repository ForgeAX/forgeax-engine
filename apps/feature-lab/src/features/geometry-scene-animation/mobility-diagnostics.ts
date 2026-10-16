import { createWorldContext, type EntityHandle, World } from '@forgeax/engine/ecs';
import {
  emitMobilityDiagnostic,
  Mobility,
  type MobilityDiagnostic,
  MobilityKindValue,
  mobilityKindFromU32,
  scenePlugin,
  subscribeMobilityDiagnostics,
  Transform,
} from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Mobility component + diagnostics',
  catalog: 'Mobility',
  kind: 'headless',
  summary:
    "Mobility { kind: static | stationary | movable } declares an entity's motion commitment (absent = movable). Violations surface once per (World, code, entity) through a closed diagnostic union.",
  expect:
    'All checks pass: kind defaults to movable, initial placement of a static entity is silent, moving it twice yields exactly one mobility-static-moved with expected/hint/detail, and a repeated emit is deduplicated.',
  async run(checks) {
    const received: MobilityDiagnostic[] = [];
    const unsubscribe = subscribeMobilityDiagnostics((_world, diagnostic) =>
      received.push(diagnostic),
    );
    try {
      const world = new World();
      await createWorldContext(world, [scenePlugin()]);
      checks.equal('closed kind labels', Mobility.fields.kind.labels, {
        static: 0,
        stationary: 1,
        movable: 2,
      });
      const plain = world.spawn({ component: Mobility, data: {} }).unwrap() as EntityHandle;
      checks.equal(
        'default kind',
        mobilityKindFromU32(world.get(plain, Mobility).unwrap().kind),
        'movable',
      );

      const moved = world
        .spawn(
          { component: Transform, data: { pos: [1, 2, 3] } },
          { component: Mobility, data: { kind: MobilityKindValue.static } },
        )
        .unwrap() as EntityHandle;
      world.update(1 / 60).unwrap();
      world.update(1 / 60).unwrap();
      checks.equal('initial placement is silent', received.length, 0);

      world.set(moved, Transform, { pos: [4, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      world.set(moved, Transform, { pos: [5, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      checks.equal('reported once per entity', received.length, 1);
      const first = received[0];
      checks.equal('code', first?.code, 'mobility-static-moved');
      checks.ok(
        'expected names static',
        first?.expected.includes("'static'") === true,
        first?.expected,
      );
      checks.ok('hint names movable', first?.hint.includes('movable') === true, first?.hint);
      checks.equal('detail.entity', first?.detail.entity, moved);

      const emitted = emitMobilityDiagnostic(world, plain, {
        code: 'mobility-physics-conflict',
        rigidBodyType: 'dynamic',
      });
      const repeat = emitMobilityDiagnostic(world, plain, {
        code: 'mobility-physics-conflict',
        rigidBodyType: 'dynamic',
      });
      checks.ok('first emit delivered, repeat deduplicated', emitted && !repeat);
      checks.equal(
        'physics-conflict detail',
        received[1]?.code === 'mobility-physics-conflict'
          ? received[1].detail.rigidBodyType
          : 'missing',
        'dynamic',
      );
    } finally {
      unsubscribe();
    }
  },
});
