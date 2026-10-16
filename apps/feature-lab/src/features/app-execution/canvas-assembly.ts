import { createApp } from '@forgeax/engine/app/browser';
import { World } from '@forgeax/engine/ecs';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Canvas assembly entry',
  catalog: 'Canvas assembly',
  kind: 'probe',
  summary:
    'createApp(canvas) builds World, Renderer, default plugins, browser input and the rAF loop, and reports failure as a structured Result.',
  expect:
    'All checks pass: the App exposes World/Renderer/pluginContext/input, and a detached canvas yields app-canvas-detached instead of throwing.',
  setup({ app, world }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.7, 0.9, 1] }), {
      pos: [0, 0.5, 0],
    });
    return {
      async checks() {
        const c = new CheckList();
        c.ok('app.world is an ECS World', app.world instanceof World);
        c.ok('app.renderer present', typeof app.renderer?.draw === 'function');
        c.ok('app.pluginContext present', app.pluginContext !== undefined);
        c.ok('browser input backend attached', app.input !== undefined);
        c.ok('execution control present', typeof app.execution.report === 'function');
        c.equal('host realm', app.execution.report().engine.realm, 'host');
        c.equal('no dispatch error yet', app.lastError?.code ?? null, null);
        const detached = document.createElement('canvas');
        await c.run('detached canvas -> app-canvas-detached', async () => {
          const result = await createApp(detached);
          if (result.ok) {
            await result.value.dispose();
            throw new Error('unexpected ok');
          }
          const code = (result.error as { code?: string }).code;
          if (code !== 'app-canvas-detached') throw new Error(`code=${code}`);
          return true;
        });
        const again = app.start();
        c.equal(
          'second start() is app-already-running',
          again.ok ? 'ok' : again.error.code,
          'app-already-running',
        );
        return c.items;
      },
    };
  },
});
