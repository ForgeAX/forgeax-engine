import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Camera, orthographic, perspective } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const CLEAR = [0.08, 0.09, 0.12, 1] as const;

export default defineFeature({
  title: 'Orthographic camera',
  catalog: 'Orthographic camera',
  kind: 'visual',
  summary:
    'orthographic({ left, right, bottom, top }) keeps parallel lines parallel: a receding row of equal cubes keeps equal size; the ON view also has a shared NDC lens offset.',
  expect:
    'ON: all five cubes in the row appear the same size and the lens shifts the image right. OFF: perspective projection makes the far cubes visibly smaller.',
  setup({ world }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const { camera } = spawnStage(world, { eye: [4, 3, 6], target: [0, 0.5, -2] });
    for (let i = 0; i < 5; i++) {
      const hue = i / 4;
      spawnMesh(world, stageCube, standard(world, { baseColor: [1 - hue, 0.3, hue, 1] }), {
        pos: [0, 0.5, 2 - i * 2],
      });
    }
    const project = (on: boolean) => {
      const pod = on
        ? orthographic({
            left: -6.4,
            right: 6.4,
            bottom: -3.6,
            top: 3.6,
            near: 0.1,
            far: 50,
            projectionOffset: [0.22, 0.08],
          })
        : perspective({ fov: Math.PI / 4, aspect: 16 / 9 });
      world.set(camera, Camera, { ...pod, clearColor: CLEAR } as never);
    };
    project(true);
    return { toggle: project };
  },
});
