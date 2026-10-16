import { Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';
import { proceduralEquirect } from './support/scene';

export default defineFeature({
  title: 'Skylight IBL',
  catalog: 'Skylight IBL',
  kind: 'visual',
  summary:
    'A Skylight with an inline procedural equirect (blue sky, white horizon, orange ground) is projected to a cubemap and lights the scene through diffuse irradiance and prefiltered specular. There is no direct light.',
  expect:
    'ON: the spheres are lit only by the sky; the chrome ones mirror a blue top and orange bottom, the rough white one is bluish above and orange below. OFF: Skylight intensity = 0 and the spheres go black.',
  setup({ world }) {
    spawnCamera(world, {
      eye: [0, 0.4, 5],
      target: [0, 0.4, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    const equirect = world.allocSharedRef('EquirectAsset', proceduralEquirect());
    const sky = world
      .spawn({ component: Skylight, data: { equirect, intensity: 1.5 } as never })
      .unwrap();
    const roughness = [0.05, 0.35, 0.9];
    roughness.forEach((value, index) => {
      spawnMesh(
        world,
        MESH.sphere,
        standard(world, {
          baseColor: [0.95, 0.95, 0.95, 1],
          metallic: index < 2 ? 1 : 0,
          roughness: value,
        }),
        {
          pos: [-1.6 + index * 1.6, 0.4, 0],
          scale: [0.65, 0.65, 0.65],
        },
      );
    });
    return {
      toggle(on) {
        world.set(sky, Skylight, { intensity: on ? 1.5 : 0 } as never);
      },
    };
  },
});
