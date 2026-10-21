import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { PointLight, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnGround, spawnMesh, standard, unlit } from '../../lab/stage';
import { spawnPointLight } from './support/scene';

export default defineFeature({
  title: 'Point Light',
  catalog: 'Point Light',
  kind: 'visual',
  summary:
    'A red PointLight (Transform position, candela, metric range, default inverse-square decay: 2) floats above the floor between two white shapes. No sun.',
  expect:
    'ON: a red pool of light on the floor, fading with distance, red-lit sides on the cube and sphere. OFF: intensity 0, only the dim ambient remains.',
  setup({ world }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const stageSphere = primitiveAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

    spawnGround(world);
    spawnCamera(world, { eye: [0, 2.5, 5], target: [0, 0.3, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.08 } as never })
      .unwrap();
    const white = standard(world, { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.5 });
    spawnMesh(world, stageCube, white, { pos: [-1.2, 0.5, 0] });
    spawnMesh(world, stageSphere, white, { pos: [1.2, 0.5, 0] });
    spawnMesh(world, stageSphere, unlit(world, [1, 0.3, 0.3, 1]), {
      pos: [0, 0.9, 0.3],
      scale: [0.12, 0.12, 0.12],
    });
    const light = spawnPointLight(world, [0, 0.9, 0.3], [1, 0.1, 0.05], 12, 6);
    return {
      toggle(on) {
        world.set(light, PointLight, { intensity: on ? 12 : 0, decay: 2 } as never);
      },
    };
  },
});
