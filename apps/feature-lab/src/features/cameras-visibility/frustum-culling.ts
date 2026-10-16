import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

export default defineFeature({
  title: 'Frustum culling',
  catalog: 'Frustum culling',
  kind: 'probe',
  summary:
    'The renderer culls MeshAsset AABBs transformed by GlobalTransform.world against the camera frustum before drawing.',
  expect:
    'PASS when 8 cubes placed behind the camera are counted as culled, and moving them into view drops the culled count by 8.',
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [0, 1.5, 6], target: [0, 0.5, 0] });
    const mat = standard(world, { baseColor: [0.2, 0.7, 1, 1] });
    const cubes = Array.from({ length: 8 }, (_, i) =>
      spawnMesh(world, MESH.cube, mat, { pos: [(i - 3.5) * 0.5, 0.5, 20], scale: [0.3, 0.3, 0.3] }),
    );
    const place = (z: number) => {
      for (const [i, cube] of cubes.entries())
        world.set(cube, Transform, { pos: [(i - 3.5) * 0.5, 0.5, z] } as never);
    };
    return {
      checks: serial(async () => {
        const checks = new CheckList();
        place(20);
        await frames(5);
        const behind = app.renderer.inspect().frustumStats;
        checks.ok('cubes behind the camera are culled', behind.culled >= 8, JSON.stringify(behind));
        place(0);
        await frames(5);
        const inView = app.renderer.inspect().frustumStats;
        checks.equal('culled count drops by 8 once in view', behind.culled - inView.culled, 8);
        checks.equal('total candidates unchanged', inView.total, behind.total);
        const view = app.renderer.inspect().views?.[0];
        if (view !== undefined)
          checks.equal('per-view frustum stats agree', view.frustum.culled, inView.culled);
        return checks.items;
      }),
    };
  },
});
