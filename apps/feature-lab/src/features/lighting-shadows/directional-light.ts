import { DirectionalLight, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Directional Light',
  catalog: 'Directional Light',
  kind: 'visual',
  summary:
    'One orange DirectionalLight (direction, linear RGB color, lux intensity) lights a white scene; a dim Skylight keeps the OFF state readable.',
  expect:
    'ON: white cube and sphere are lit warm orange with cast shadows on the floor. OFF: the sun intensity is 0 and the scene falls to a dim blue-grey ambient with no shadows.',
  setup({ world }) {
    const { sun } = spawnStage(world);
    world.set(sun, DirectionalLight, { color: [1, 0.55, 0.15], intensity: 4 } as never);
    world
      .spawn({ component: Skylight, data: { color: [0.4, 0.5, 0.7], intensity: 0.15 } as never })
      .unwrap();
    const white = standard(world, { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.6 });
    spawnMesh(world, MESH.cube, white, { pos: [-0.9, 0.5, 0] });
    spawnMesh(world, MESH.sphere, white, { pos: [0.9, 0.5, 0] });
    return {
      toggle(on) {
        world.set(sun, DirectionalLight, { intensity: on ? 4 : 0 } as never);
      },
    };
  },
});
