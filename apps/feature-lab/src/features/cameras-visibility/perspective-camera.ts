import { Camera } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Perspective camera',
  catalog: 'Perspective camera',
  kind: 'visual',
  summary:
    'Camera fov/aspect/near/far with autoAspect drive a perspective projection; Transform supplies the pose.',
  expect:
    'ON: fov = PI/4, the three cubes fill the frame. OFF: fov = PI/1.6, the same cubes shrink toward the center and more floor is visible.',
  setup({ world }) {
    const { camera } = spawnStage(world, { eye: [0, 2, 6], target: [0, 0.6, 0] });
    const colors = [
      [0.9, 0.15, 0.1, 1],
      [0.1, 0.8, 0.2, 1],
      [0.15, 0.3, 0.95, 1],
    ] as const;
    colors.forEach((color, i) => {
      spawnMesh(world, MESH.cube, standard(world, { baseColor: color }), {
        pos: [(i - 1) * 1.4, 0.6, 0],
      });
    });
    return {
      toggle(on) {
        world.set(camera, Camera, { fov: on ? Math.PI / 4 : Math.PI / 1.6 } as never);
      },
    };
  },
});
