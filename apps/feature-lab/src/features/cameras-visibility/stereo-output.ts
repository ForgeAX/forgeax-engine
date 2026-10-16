import { StereoCamera, StereoLayoutValue } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Non-XR stereo output',
  catalog: 'Non-XR stereo output',
  kind: 'visual',
  summary: 'One perspective Camera expands into two off-axis eye views through StereoCamera.',
  expect: 'ON: two side-by-side views of the scene. OFF: one full-width ordinary perspective view.',
  setup({ world }) {
    const { camera } = spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.45, 0.1, 1] }), {
      pos: [0, 0.6, 0],
    });
    const add = () =>
      world
        .addComponent(camera, {
          component: StereoCamera,
          data: { eyeSeparation: 0.064, convergence: 5, layout: StereoLayoutValue['side-by-side'] },
        })
        .unwrap();
    add();
    return {
      toggle(on) {
        if (on) add();
        else world.removeComponent(camera, StereoCamera).unwrap();
      },
    };
  },
});
