import { ClippingPlanes, clippingPlanesData } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Public clipping planes',
  catalog: 'Public clipping planes',
  kind: 'visual',
  summary:
    'Camera ClippingPlanes discards fragments where dot(n, p) + d < 0 for up to six world-space planes; empty planes disable it.',
  expect:
    'ON: the upper half of the orange sphere and the tall cube is cut away along y = 0.9. OFF: both are whole.',
  setup({ world }) {
    const { camera } = spawnStage(world, { eye: [0, 2.5, 5], target: [0, 0.8, 0] });
    world.addComponent(camera, {
      component: ClippingPlanes,
      data: clippingPlanesData({ planes: [[0, -1, 0, 0.9]] }),
    });
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 0.5, 0.1, 1], renderState: { cullMode: 'none' } }),
      {
        pos: [-0.9, 0.9, 0],
        scale: [1.5, 1.5, 1.5],
      },
    );
    spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.2, 0.5, 1, 1], renderState: { cullMode: 'none' } }),
      {
        pos: [1.1, 1, 0],
        scale: [0.8, 2, 0.8],
      },
    );
    return {
      toggle(on) {
        world.set(
          camera,
          ClippingPlanes,
          clippingPlanesData({ planes: on ? [[0, -1, 0, 0.9]] : [] }) as never,
        );
      },
    };
  },
});
