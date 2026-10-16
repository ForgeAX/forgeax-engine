import { DirectionalLight, ShadowParticipation } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Shadow caster opt-out',
  catalog: 'Shadow caster opt-out',
  kind: 'visual',
  summary:
    'ShadowParticipation { cast: false } keeps the entity visible but removes it from every shadow map. The green cube uses it; the red reference cube always casts.',
  expect:
    'ON: the green cube (middle) casts no shadow while the red cube beside it does. OFF: the green cube casts a shadow like the red one.',
  setup({ world }) {
    const { sun } = spawnStage(world, { eye: [0, 3.5, 6], target: [0, 0.5, 0] });
    world.set(sun, DirectionalLight, { direction: [0.5, -1, -0.4], intensity: 3 } as never);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.15, 0.1, 1] }), {
      pos: [-1.5, 1, 0],
      scale: [1, 1, 1],
    });
    const cube = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.1, 0.85, 0.2, 1] }),
      { pos: [1, 1, 0], scale: [1, 1, 1] },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    );
    return {
      toggle(on) {
        world.set(cube, ShadowParticipation, { cast: !on }).unwrap();
      },
    };
  },
});
