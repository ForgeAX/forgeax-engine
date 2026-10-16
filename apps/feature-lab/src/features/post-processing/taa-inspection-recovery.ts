import { ANTIALIAS_NONE, ANTIALIAS_TAA, Camera } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'TAA inspection and recovery',
  catalog: 'TAA inspection/recovery',
  kind: 'probe',
  summary:
    'renderer.inspect().temporal is a bounded, detached POD: mode, status, reset reason, history bytes, coverage and resource counts; history lives only in the renderer.',
  expect:
    'All checks pass: TAA reports stable history with non-zero bytes and coverage; switching TAA off releases the history (status off); switching back rebuilds it to stable.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { data: { antialias: ANTIALIAS_TAA } });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.2, 0.7, 1, 1] }), {
      pos: [0, 0.6, 0],
      scale: [0.6, 0.6, 0.6],
    });
    const temporal = () => app.renderer.inspect().temporal;
    return {
      async checks() {
        const list = new CheckList();
        await frames(8);
        const on = temporal();
        list
          .equal('mode', on.mode, 'taa')
          .equal('status', on.status, 'stable')
          .ok('history bytes > 0', on.historyBytes > 0, `historyBytes=${on.historyBytes}`)
          .ok(
            'coverage matches a real extent',
            on.coverage.width > 0 && on.coverage.height > 0,
            JSON.stringify(on.coverage),
          )
          .ok('active history resources', on.resources.active > 0, JSON.stringify(on.resources))
          .ok(
            'inspection is frozen POD',
            Object.isFrozen(on) && JSON.parse(JSON.stringify(on)).mode === 'taa',
          );
        world.set(camera, Camera, { antialias: ANTIALIAS_NONE } as never).unwrap();
        await frames(4);
        const off = temporal();
        list
          .equal('TAA off: status', off.status, 'off')
          .equal('TAA off: no active history', off.resources.active, 0);
        world.set(camera, Camera, { antialias: ANTIALIAS_TAA } as never).unwrap();
        await frames(8);
        const back = temporal();
        list
          .equal('TAA back on: status', back.status, 'stable')
          .ok('TAA back on: history valid', back.historyValid);
        return list.items;
      },
    };
  },
});
