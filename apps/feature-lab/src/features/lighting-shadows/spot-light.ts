import { Skylight, SpotLight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard } from '../../lab/stage';
import { spawnSpotLight } from './support/scene';

export default defineFeature({
  title: 'Spot Light',
  catalog: 'Spot Light',
  kind: 'visual',
  summary:
    'A green SpotLight (range, inner/outer cone in degrees, candela) points straight down onto a white cube, projecting a round cone of light.',
  expect:
    'ON: a sharp-edged green disc of light on the floor around the cube, with the cube shadow inside it. OFF: intensity 0, the floor is uniformly dim.',
  setup({ world }) {
    spawnGround(world);
    spawnCamera(world, { eye: [0, 4, 5], target: [0, 0, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.08 } as never })
      .unwrap();
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.95, 0.95, 0.95, 1] }), {
      pos: [0, 0.4, 0],
      scale: [0.8, 0.8, 0.8],
    });
    const spot = spawnSpotLight(world, [0, 4, 0], [0, -1, 0], [0.1, 1, 0.2]);
    return {
      toggle(on) {
        world.set(spot, SpotLight, { intensity: on ? 60 : 0 } as never);
      },
    };
  },
});
