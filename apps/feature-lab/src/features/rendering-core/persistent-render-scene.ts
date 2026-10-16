import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Persistent Render Scene',
  catalog: 'Persistent Render Scene',
  kind: 'probe',
  summary:
    'The Renderer keeps a persistent render scene fed by World change evidence: idle frames are no-change frames, a Transform write is a delta frame on the same stable slot, and a spawn adds a record without a full rebuild.',
  expect:
    'All checks pass: idle frames increase noChangeFrames, moving one cube increases deltaFrames while keeping the same record count, spawning adds exactly one record, and fullRebuilds does not grow.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    const mat = standard(world, { baseColor: [0.3, 0.7, 1, 1] });
    const cube = spawnMesh(world, MESH.cube, mat, { pos: [0, 0.5, 0] });
    await frames(4);
    return {
      async checks() {
        const checks = new CheckList();
        const scene = () => app.renderer.inspect().renderScene;
        const idle = scene();
        await frames(4);
        const afterIdle = scene();
        checks.ok(
          'idle frames are no-change frames',
          afterIdle.noChangeFrames - idle.noChangeFrames >= 3,
          `delta=${afterIdle.noChangeFrames - idle.noChangeFrames}`,
        );
        for (let i = 1; i <= 3; i++) {
          world.set(cube, Transform, { pos: [Math.sin(i), 0.5, 0] } as never).unwrap();
          await frames(1);
        }
        const moved = scene();
        checks
          .ok(
            'Transform writes produce delta frames',
            moved.deltaFrames - afterIdle.deltaFrames >= 1,
            `delta=${moved.deltaFrames - afterIdle.deltaFrames}`,
          )
          .ok(
            'Transform updates counted',
            moved.transformUpdates > afterIdle.transformUpdates,
            `${afterIdle.transformUpdates} -> ${moved.transformUpdates}`,
          )
          .equal(
            'record count stable while moving',
            moved.projectionRecords,
            afterIdle.projectionRecords,
          );
        spawnMesh(world, MESH.sphere, mat, { pos: [1.2, 0.5, 0] });
        await frames(3);
        const spawned = scene();
        checks
          .equal('spawn adds one record', spawned.projectionRecords, moved.projectionRecords + 1)
          .equal('no full rebuild', spawned.fullRebuilds, idle.fullRebuilds);
        return checks.items;
      },
    };
  },
});
