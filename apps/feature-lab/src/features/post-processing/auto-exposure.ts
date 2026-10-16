import {
  CAMERA_EXPOSURE_MODE_AUTO,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DirectionalLight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Auto exposure',
  catalog: 'Auto exposure',
  kind: 'visual',
  summary:
    'Camera exposureMode = auto meters a GPU luminance histogram and adapts exposure within rangeEv at the given up/down rates; the manual multiplier is the fallback.',
  expect:
    'ON: the very dimly lit scene is brightened to a normal mid-grey exposure within a second or two. OFF (manual exposure 1): the same scene is almost black.',
  setup({ app, world, frames }) {
    const { camera, sun } = spawnStage(world, {
      eye: [0, 1.6, 5],
      target: [0, 0.5, 0],
      data: {
        tonemap: TONEMAP_ACES_FILMIC,
        clearColor: [0.004, 0.004, 0.006, 1],
        exposure: 1,
        exposureMode: CAMERA_EXPOSURE_MODE_AUTO,
        compensationEv: 0,
        rangeEv: [-8, 12],
        rates: [20, 20],
      },
    });
    world.set(sun, DirectionalLight, { intensity: 0.03 } as never).unwrap();
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.3, 0.2, 1] }), {
      pos: [-1, 0.5, 0],
    });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.2, 0.6, 0.9, 1] }), {
      pos: [1, 0.5, 0],
      scale: [0.5, 0.5, 0.5],
    });
    return {
      toggle(on) {
        world
          .set(camera, Camera, {
            exposureMode: on ? CAMERA_EXPOSURE_MODE_AUTO : CAMERA_EXPOSURE_MODE_MANUAL,
          } as never)
          .unwrap();
      },
      async checks() {
        await frames(3);
        const auto = app.renderer.inspect().output.autoExposure;
        return new CheckList()
          .equal('requested exposure kind', auto?.requested.kind, 'auto')
          .ok(
            'GPU metering, not fallback',
            auto !== undefined && auto.actualState !== 'fallback',
            `actual=${auto?.actual} state=${auto?.actualState}`,
          )
          .ok(
            'no recent failure',
            auto?.recentFailure === undefined,
            JSON.stringify(auto?.recentFailure),
          ).items;
      },
    };
  },
});
