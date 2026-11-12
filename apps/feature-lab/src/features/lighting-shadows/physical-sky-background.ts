import { Atmosphere, DirectionalLight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';

export default defineFeature({
  title: 'Physical Sky Background',
  catalog: 'Physical Sky Background',
  kind: 'visual',
  summary:
    'A background-only Rayleigh/Mie atmosphere driven by one sun, using raster LUTs on WebGPU and WebGL2.',
  expect:
    'ON shows a daylight sky, bright horizon and solar disc; OFF restores the clear color. Skylight can also consume this sky for IBL; aerial perspective and surface solar attenuation stay disabled.',
  setup({ world }) {
    spawnCamera(world, {
      eye: [0, 1, 0],
      target: [0, 1, -4],
      data: { exposure: 1 / 5000, tonemap: TONEMAP_ACES_FILMIC, clearColor: [0, 0, 0, 1] },
    });
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -0.15, 0.988686], intensity: 100000, castShadow: false },
      })
      .unwrap();
    const spawn = () =>
      world.spawn({ component: Atmosphere, data: { backgroundOnly: true } }).unwrap();
    let atmosphere = spawn();
    return {
      toggle(on) {
        if (on) atmosphere = spawn();
        else world.despawn(atmosphere).unwrap();
      },
    };
  },
});
