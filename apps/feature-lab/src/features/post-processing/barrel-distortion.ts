import { BarrelDistortion } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { passChecks, spawnCheckerWall } from './shared/scenes';

const BARREL = { strength: 0.3, centerX: 0.5, centerY: 0.5 } as const;

export default defineFeature({
  title: 'BarrelDistortion',
  catalog: 'BarrelDistortion',
  kind: 'visual',
  summary:
    'A BarrelDistortion companion on the Camera radially remaps the finished LDR image (after LUT, before FXAA); strength 0 means zero work.',
  expect:
    'ON: the straight checkerboard grid bulges outward, lines bow toward the edges like a fisheye lens. OFF: every grid line is perfectly straight.',
  setup({ app, world, frames }) {
    spawnCheckerWall(world);
    const camera = spawnCamera(world, {
      eye: [0, 0, 5.2],
      target: [0, 0, 0],
      fov: Math.PI / 3,
      data: { clearColor: [0, 0, 0, 1] },
    });
    world.addComponent(camera, { component: BarrelDistortion, data: BARREL }).unwrap();
    return {
      toggle(on) {
        world.set(camera, BarrelDistortion, { strength: on ? BARREL.strength : 0 }).unwrap();
      },
      async checks() {
        await frames(3);
        const inspection = app.renderer.inspect();
        const mapping = inspection.barrelDistortion.effectiveMapping;
        return [
          ...passChecks(inspection.perFramePassNames, ['barrel-distortion']),
          ...new CheckList().ok(
            'effective mapping published',
            mapping !== undefined,
            JSON.stringify(inspection.barrelDistortion),
          ).items,
        ];
      },
    };
  },
});
