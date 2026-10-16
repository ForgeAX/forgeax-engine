import { ANTIALIAS_TAA, Camera } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { lookRotation, MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'TAA history reset',
  catalog: 'TAA history reset',
  kind: 'probe',
  summary:
    'Camera.historyVersion is the explicit reset owner for cuts: bumping it discards TAA history once, while ordinary camera motion keeps history valid.',
  expect:
    'All checks pass: moving the camera keeps a stable history with no history-version reset; bumping historyVersion reports resetReason history-version, then history becomes valid again.',
  setup({ app, world, frames }) {
    const { camera } = spawnStage(world, { data: { antialias: ANTIALIAS_TAA } });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.4, 0.1, 1] }), {
      pos: [0, 0.5, 0],
    });
    const temporal = () => app.renderer.inspect().temporal;
    return {
      async checks() {
        const list = new CheckList();
        await frames(10);
        list.equal('warm-up status', temporal().status, 'stable');
        const reasons: (string | undefined)[] = [];
        for (let i = 0; i < 8; i++) {
          const eye = [Math.sin(i * 0.05) * 5, 1.5, Math.cos(i * 0.05) * 5] as const;
          world.set(camera, Transform, { pos: eye, quat: lookRotation(eye, [0, 0.5, 0]) }).unwrap();
          await frames(1);
          reasons.push(temporal().resetReason);
        }
        list.ok(
          'camera motion never resets history',
          !reasons.includes('history-version'),
          JSON.stringify(reasons),
        );
        list.equal('history still valid after motion', temporal().historyValid, true);
        const version = world.get(camera, Camera).unwrap().historyVersion;
        world.set(camera, Camera, { historyVersion: version + 1 } as never).unwrap();
        const after: (string | undefined)[] = [];
        for (let i = 0; i < 3; i++) {
          await frames(1);
          after.push(temporal().resetReason);
        }
        list.ok(
          'historyVersion bump reports history-version reset',
          after.includes('history-version'),
          JSON.stringify(after),
        );
        await frames(5);
        list.equal('history recovers after reset', temporal().status, 'stable');
        return list.items;
      },
    };
  },
});
