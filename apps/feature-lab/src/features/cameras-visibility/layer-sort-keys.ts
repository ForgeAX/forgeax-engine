import { Layer, Materials } from '@forgeax/engine/render';
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
  title: 'Layer and sort keys',
  catalog: 'Layer and sort keys',
  kind: 'visual',
  summary:
    'Layer.value is the primary transparent sort key (ascending, so higher layers draw later), ahead of the depth key.',
  expect:
    'ON: the far blue panel has Layer 1, draws last and covers the near red panel in the overlap. OFF: both at Layer 0, depth order wins and red stays in front.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.2, 6], target: [0, 1.2, 0] });
    const panel = (rgba: readonly [number, number, number, number]) =>
      material(
        world,
        Materials.unlit(rgba, {
          queue: RenderQueue.Transparent,
          renderState: BLEND,
        }),
      );
    spawnMesh(
      world,
      MESH.cube,
      panel([1, 0.1, 0.1, 0.85]),
      { pos: [-0.5, 1.2, 1], scale: [2, 2, 0.05] },
      {
        component: Layer,
        data: { value: 0 },
      },
    );
    const far = spawnMesh(
      world,
      MESH.cube,
      panel([0.1, 0.3, 1, 0.85]),
      { pos: [0.5, 1.2, -1], scale: [2, 2, 0.05] },
      {
        component: Layer,
        data: { value: 1 },
      },
    );
    return {
      toggle(on) {
        world.set(far, Layer, { value: on ? 1 : 0 } as never);
      },
    };
  },
});
