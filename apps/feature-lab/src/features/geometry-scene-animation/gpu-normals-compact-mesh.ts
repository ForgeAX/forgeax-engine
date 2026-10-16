import type { EntityHandle } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const SHAPED: readonly (readonly [number, number, number])[] = [
  [1.6, 0.5, 0.9],
  [-0.6, 1.4, 0.6],
  [0.5, 0.5, -1.8],
];

export default defineFeature({
  title: 'GPU-derived normals and compact mesh payloads',
  catalog: 'GPU normal matrix and compact mesh payloads',
  kind: 'visual',
  summary:
    'The per-draw mesh record no longer ships a CPU normal matrix: shaders derive it from the model matrix on the GPU, so non-uniform and mirrored scales must still shade correctly.',
  expect:
    'ON: three spheres with non-uniform and mirrored (negative) scale - flattened, tall and elongated - each lit smoothly with the highlight facing the sun, no inverted or faceted shading. OFF: the same spheres at uniform scale.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.6, 6], target: [0, 0.8, 0] });
    const colors: readonly (readonly [number, number, number, number])[] = [
      [1, 0.3, 0.2, 1],
      [0.3, 1, 0.4, 1],
      [0.3, 0.5, 1, 1],
    ];
    const spheres: EntityHandle[] = SHAPED.map((_, index) =>
      spawnMesh(
        world,
        MESH.sphere,
        standard(world, { baseColor: colors[index] ?? [1, 1, 1, 1], roughness: 0.3 }),
        {
          pos: [(index - 1) * 1.8, 0.9, 0],
          scale: SHAPED[index] ?? [1, 1, 1],
        },
      ),
    );
    return {
      toggle(on) {
        spheres.forEach((sphere, index) => {
          world.set(sphere, Transform, {
            scale: on ? (SHAPED[index] ?? [1, 1, 1]) : [0.9, 0.9, 0.9],
          } as never);
        });
      },
    };
  },
});
