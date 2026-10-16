import type { EntityHandle } from '@forgeax/engine/ecs';
import {
  createCapsuleGeometry,
  createConeGeometry,
  createRevolutionGeometry,
  createSweepGeometry,
  createTeapotGeometry,
  createTorusGeometry,
} from '@forgeax/engine/geometry';
import { MeshFilter } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: '3D procedural geometry',
  catalog: '3D Procedural Geometry',
  kind: 'visual',
  summary:
    'Pure geometry factories (torus, cone, capsule, Utah teapot, sweep, revolution) return Result<MeshAsset> with tangents and AABB; allocSharedRef makes them drawable.',
  expect:
    'ON: a row of six distinct shapes - torus, cone, capsule, teapot, swept tube and revolved vase. OFF: every shape is replaced by the same unit cube.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 2.2, 7], target: [0, 0.7, 0] });
    const built: [string, ReturnType<typeof createTorusGeometry>][] = [
      ['torus', createTorusGeometry(0.4, 0.15, 24, 12)],
      ['cone', createConeGeometry(0.45, 1, 24)],
      ['capsule', createCapsuleGeometry(0.3, 0.6, 6)],
      ['teapot', createTeapotGeometry(0.4, 10)],
      [
        'sweep',
        createSweepGeometry(
          [
            [0, 0, 0],
            [0.3, 0.5, 0],
            [0, 1, 0.2],
            [-0.3, 1.3, 0],
          ],
          0.12,
          12,
        ),
      ],
      [
        'revolution',
        createRevolutionGeometry(
          [
            { x: 0.1, y: 0 },
            { x: 0.45, y: 0.2 },
            { x: 0.25, y: 0.7 },
            { x: 0.35, y: 1.1 },
          ],
          24,
        ),
      ],
    ];
    const colors: readonly (readonly [number, number, number, number])[] = [
      [1, 0.2, 0.2, 1],
      [1, 0.7, 0.1, 1],
      [0.3, 1, 0.3, 1],
      [0.2, 0.8, 1, 1],
      [0.5, 0.3, 1, 1],
      [1, 0.3, 0.9, 1],
    ];
    const entities: { entity: EntityHandle; mesh: ReturnType<typeof world.allocSharedRef> }[] = [];
    built.forEach(([name, result], index) => {
      if (!result.ok) {
        console.warn(`[feature-lab] ${name} geometry failed: ${result.error.code}`);
        return;
      }
      const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', result.value);
      const x = (index - 2.5) * 1.15;
      const lift = name === 'torus' ? 0.6 : name === 'capsule' ? 0.6 : 0;
      const entity = spawnMesh(
        world,
        mesh,
        standard(world, { baseColor: colors[index] ?? [1, 1, 1, 1], roughness: 0.4 }),
        {
          pos: [x, lift, 0],
        },
      );
      entities.push({ entity, mesh });
    });
    return {
      toggle(on) {
        for (const { entity, mesh } of entities) {
          world.set(entity, MeshFilter, { assetHandle: on ? mesh : MESH.cube } as never);
        }
      },
    };
  },
});
