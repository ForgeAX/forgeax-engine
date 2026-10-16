import {
  DepthOfField,
  DepthOfFieldQualityValue,
  DepthOfFieldSideValue,
} from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const DOF = {
  focusDistance: 2.5,
  fStop: 0.7,
  sensorHeight: 0.24,
  maxRadiusPixels: 32,
  quality: DepthOfFieldQualityValue.high,
  blurSide: DepthOfFieldSideValue.both,
} as const;

export default defineFeature({
  title: 'Camera Depth of Field',
  catalog: 'Camera Depth of Field',
  kind: 'visual',
  summary:
    'A DepthOfField companion on the perspective camera applies a thin-lens circle of confusion; maxRadiusPixels 0 or removing the component means zero work. The lab uses a large sensor and f/0.7 so the blur reaches the 32 px cap.',
  expect:
    'ON: the near red sphere (at the 2.5 m focus distance) is sharp while the spheres receding behind it turn into soft, blurry discs. OFF: every sphere is equally sharp.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { eye: [0, 1, 3.5], target: [0, 0.6, -6] });
    const colors = [
      [1, 0.1, 0.1, 1],
      [1, 0.7, 0.1, 1],
      [0.2, 0.9, 0.2, 1],
      [0.1, 0.6, 1, 1],
      [0.8, 0.2, 1, 1],
    ] as const;
    colors.forEach((baseColor, i) => {
      spawnMesh(world, MESH.sphere, standard(world, { baseColor, roughness: 0.4 }), {
        pos: [-0.9 + i * 0.6, 0.5, 1 - i * 2.5],
        scale: [0.5, 0.5, 0.5],
      });
    });
    world.addComponent(camera, { component: DepthOfField, data: DOF }).unwrap();
    return {
      toggle(on) {
        if (on === world.hasComponent(camera, DepthOfField)) return;
        if (on) world.addComponent(camera, { component: DepthOfField, data: DOF }).unwrap();
        else world.removeComponent(camera, DepthOfField).unwrap();
      },
      async checks() {
        await frames(3);
        const dof = app.renderer.inspect().depthOfField;
        return new CheckList()
          .ok('depth of field enabled', dof?.enabled === true, JSON.stringify(dof))
          .equal('depth of field status', dof?.status, 'active').items;
      },
    };
  },
});
