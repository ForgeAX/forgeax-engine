import { GradientSky, GradientSkyPresets } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnSun } from '../../lab/stage';

export default defineFeature({
  title: 'Gradient Sky',
  catalog: 'Gradient Sky',
  kind: 'visual',
  summary:
    'A GradientSky draws a three-stop dusk background and a disc aligned with the DirectionalLight. It needs neither a sky texture nor an Atmosphere.',
  expect:
    'ON: violet overhead blends through rose into an orange horizon, with a warm sun disc. OFF: the entire background is the camera clear color. This background does not provide scene lighting.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 0, 0], target: [0, 0.15, -1], fov: Math.PI / 2 });
    spawnSun(world, { direction: [-0.25, -0.12, 1] });
    let sky = world.spawn({ component: GradientSky, data: GradientSkyPresets.dusk }).unwrap();
    return {
      toggle(on) {
        if (on)
          sky = world.spawn({ component: GradientSky, data: GradientSkyPresets.dusk }).unwrap();
        else world.despawn(sky).unwrap();
      },
    };
  },
});
