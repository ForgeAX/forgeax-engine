import {
  Atmosphere,
  DirectionalLight,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Analytic Sky',
  catalog: 'Analytic Sky',
  kind: 'visual',
  summary:
    'Atmosphere renders an analytic Rayleigh/Mie sky cube from the single DirectionalLight sun; an equirect-less Skylight uses that same cube for ambient light.',
  expect:
    'ON: a blue daylight sky that brightens toward the horizon and the low sun, with a small sun disc; the sphere picks up blue ambient light. OFF: Atmosphere is despawned; the background is the clear color and the sphere loses its sky ambient.',
  setup({ world }) {
    spawnCamera(world, {
      eye: [0, 0.3, 4],
      target: [0, 1, -4],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0.3, -0.25, 1], intensity: 3, castShadow: false } as never,
      })
      .unwrap();
    world
      .spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 1 } as never })
      .unwrap();
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [0.9, 0.9, 0.9, 1], roughness: 0.6 }),
      { pos: [0, 0.3, 0], scale: [0.5, 0.5, 0.5] },
    );
    let atmosphere = world.spawn({ component: Atmosphere, data: {} as never }).unwrap();
    return {
      toggle(on) {
        if (on) atmosphere = world.spawn({ component: Atmosphere, data: {} as never }).unwrap();
        else world.despawn(atmosphere).unwrap();
      },
    };
  },
});
