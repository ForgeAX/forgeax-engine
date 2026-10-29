import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Camera, CameraError, perspective } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Perspective camera',
  catalog: 'Perspective camera',
  kind: 'visual',
  summary:
    'Camera fov uses radians strictly between zero and PI; aspect/near/far and autoAspect drive the lens. Transform supplies the pose. An NDC lens offset shifts the ON view independently of camera motion.',
  expect:
    'ON: fov = PI/4, the three cubes fill the frame and are shifted right by the lens offset. OFF: fov = PI/1.6, the same cubes shrink toward the center and more floor is visible.',
  setup({ world }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const { camera } = spawnStage(world, { eye: [0, 2, 6], target: [0, 0.6, 0] });
    const colors = [
      [0.9, 0.15, 0.1, 1],
      [0.1, 0.8, 0.2, 1],
      [0.15, 0.3, 0.95, 1],
    ] as const;
    colors.forEach((color, i) => {
      spawnMesh(world, stageCube, standard(world, { baseColor: color }), {
        pos: [(i - 1) * 1.4, 0.6, 0],
      });
    });
    world.set(camera, Camera, { projectionOffset: [0.22, 0.08] }).unwrap();
    return {
      toggle(on) {
        world.set(camera, Camera, {
          fov: on ? Math.PI / 4 : Math.PI / 1.6,
          projectionOffset: on ? [0.22, 0.08] : [0, 0],
        } as never);
      },
      checks() {
        const checks = new CheckList();
        for (const fov of [0, 74, Math.PI, NaN]) {
          let rejected: unknown;
          try {
            perspective({ fov, aspect: 1 });
          } catch (cause) {
            rejected = cause;
          }
          checks.ok(
            `invalid FOV ${String(fov)} has a structured projection error`,
            rejected instanceof CameraError && rejected.code === 'camera-projection-invalid',
          );
        }
        const radians = (74 * Math.PI) / 180;
        checks.equal(
          '74 degrees converted to radians is accepted',
          perspective({ fov: radians, aspect: 1 }).fov,
          radians,
        );
        return checks.items;
      },
    };
  },
});
