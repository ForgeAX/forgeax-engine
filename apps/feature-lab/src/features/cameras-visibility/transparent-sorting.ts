import { Materials } from '@forgeax/engine/render';
import { TransparentSort } from '@forgeax/engine/render/authoring';
import { RenderQueue } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage } from '../../lab/stage';

const BLEND = {
  depthWriteEnabled: false,
  blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
} as const;

export default defineFeature({
  title: 'Transparent material sorting',
  catalog: 'Transparent material sorting',
  kind: 'visual',
  summary:
    'Transparent-queue draws are sorted by the TransparentSort mode; distance mode sorts back-to-front from the camera. Blend and depth state come from the MaterialAsset.',
  expect:
    'ON (distance): the near red panel is blended over the far blue one. OFF (layer-z, which sorts by world z instead): the far blue panel wrongly draws over red.',
  setup({ world }) {
    spawnStage(world, { eye: [6, 1.2, 0], target: [0, 1.2, 0] });
    const panel = (rgba: readonly [number, number, number, number]) =>
      material(
        world,
        Materials.unlit(rgba, {
          queue: RenderQueue.Transparent,
          renderState: BLEND,
        }),
      );
    spawnMesh(world, MESH.cube, panel([1, 0.1, 0.1, 0.85]), {
      pos: [1, 1.2, -0.4],
      scale: [0.05, 2, 2],
    });
    spawnMesh(world, MESH.cube, panel([0.1, 0.3, 1, 0.85]), {
      pos: [-1, 1.2, 0.4],
      scale: [0.05, 2, 2],
    });
    const configure = (on: boolean) =>
      TransparentSort.configure(world, {
        mode: on ? TransparentSort.distance : TransparentSort.layerZ,
        yzAlpha: 1,
      });
    configure(true);
    return {
      toggle(on) {
        configure(on);
      },
    };
  },
});
