import { ANTIALIAS_NONE, ANTIALIAS_TAA, Camera } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Semantic scene-data target',
  catalog: 'Semantic scene-data target',
  kind: 'probe',
  summary:
    'A temporal consumer (TAA) makes the Standard scene producer publish the forgeax::scene-data::temporal-v1 sampled target; consumers get an opaque token, never their own velocity or G-buffer.',
  expect:
    "All checks pass: with TAA the inspection reports the 'standard-scene-temporal' target from 'forgeax::standard::scene-data', schema temporal-v1, one rgba16float target sized to the frame; with antialias off no temporal consumer is active.",
  async setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { data: { antialias: ANTIALIAS_TAA } });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.6, 0.1, 1] }), {
      pos: [0, 0.5, 0],
    });
    await frames(4);
    return {
      async checks() {
        const checks = new CheckList();
        const target = app.renderer.inspect().temporalTarget;
        checks
          .equal('target identity', target?.identity, 'standard-scene-temporal')
          .equal('producer', target?.producerId, 'forgeax::standard::scene-data')
          .equal('schema', target?.schema, 'forgeax::scene-data::temporal-v1')
          .equal('one target', target?.targetCount, 1)
          .equal('format', target?.descriptor.format, 'rgba16float')
          .ok(
            'sized to the frame',
            (target?.descriptor.width ?? 0) > 0 && (target?.descriptor.bytes ?? 0) > 0,
            JSON.stringify(target?.descriptor),
          );
        world.set(camera, Camera, { antialias: ANTIALIAS_NONE } as never).unwrap();
        await frames(4);
        checks.ok(
          'temporal consumer off without TAA',
          app.renderer.inspect().temporal.mode !== 'taa',
          `mode=${app.renderer.inspect().temporal.mode}`,
        );
        world.set(camera, Camera, { antialias: ANTIALIAS_TAA } as never).unwrap();
        await frames(2);
        return checks.items;
      },
    };
  },
});
