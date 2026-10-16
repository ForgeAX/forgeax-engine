import { LensEffects } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, unlit } from '../../lab/stage';
import { passChecks, spawnCheckerWall } from './shared/scenes';

const LENS = {
  vignetteIntensity: 1,
  vignetteRadius: 0.35,
  vignetteSoftness: 0.4,
  vignetteColor: [0.35, 0, 0],
  chromaticAberration: 14,
  chromaticAberrationAngle: 0,
  grainIntensity: 0.35,
  grainSize: 1.5,
} as const;

export default defineFeature({
  title: 'Lens effects (vignette, chromatic aberration, grain)',
  catalog: 'Lens effects',
  kind: 'visual',
  summary:
    'A LensEffects Camera companion adds vignette, radial chromatic aberration and film grain in one output pass; all three intensities at zero schedule no pass.',
  expect:
    'ON: the frame edges fall off into a dark red vignette, white bars show red/blue color fringes toward the corners, and fine grain covers the image. OFF: clean, evenly lit checkerboard with sharp white bars.',
  setup({ app, world, frames }) {
    spawnCheckerWall(world, 8);
    const white = unlit(world, [1, 1, 1, 1]);
    for (let i = 0; i < 7; i++)
      spawnMesh(world, MESH.cube, white, { pos: [-6 + i * 2, 0, 0.1], scale: [0.12, 7, 0.05] });
    const camera = spawnCamera(world, {
      eye: [0, 0, 5.2],
      target: [0, 0, 0],
      fov: Math.PI / 3,
      data: { clearColor: [0, 0, 0, 1] },
    });
    world.addComponent(camera, { component: LensEffects, data: LENS as never }).unwrap();
    return {
      toggle(on) {
        world
          .set(
            camera,
            LensEffects,
            on
              ? (LENS as never)
              : { vignetteIntensity: 0, chromaticAberration: 0, grainIntensity: 0 },
          )
          .unwrap();
      },
      async checks() {
        await frames(3);
        return passChecks(app.renderer.inspect().perFramePassNames, ['lens-effects']);
      },
    };
  },
});
