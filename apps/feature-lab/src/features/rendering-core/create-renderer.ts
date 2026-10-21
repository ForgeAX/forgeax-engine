import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera, spawnMesh, spawnStage, spawnSun, standard } from '../../lab/stage';

export default defineFeature({
  title: 'createRenderer assembly',
  catalog: '`createRenderer` assembly',
  kind: 'probe',
  summary:
    'createRenderer(canvas, options, forgeaxBundlerAdapter()) selects the backend and assembles a standalone Renderer without createApp. The caller attaches its own World, draws, and disposes.',
  expect:
    "All checks pass on a second hidden canvas: the Result is ok with a backend kind, attach/draw succeed, the receipt completes, state is 'alive' before dispose and 'disposed' after.",
  async setup({ world, frames }) {
    spawnStage(world);
    await frames(1);
    return {
      async checks() {
        const checks = new CheckList();
        const [{ createRenderer }, { forgeaxBundlerAdapter }] = await Promise.all([
          import('@forgeax/engine/runtime'),
          import('virtual:forgeax/bundler'),
        ]);
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 144;
        const created = await createRenderer(canvas, {}, forgeaxBundlerAdapter());
        checks.ok('createRenderer ok', created.ok, created.ok ? undefined : created.error.message);
        if (!created.ok) return checks.items;
        const renderer = created.value;
        checks.ok(
          'backend selected',
          renderer.inspect().capabilities.backendKind !== undefined,
          renderer.inspect().capabilities.backendKind,
        );
        const own = new World();
        const primitiveAssetsOwn = own.assets;
        if (!(primitiveAssetsOwn instanceof AssetRegistry))
          throw new Error('Scene requires its runtime asset owner');

        const stageCube = primitiveAssetsOwn.create(createPrimitiveMesh('cube').unwrap()).unwrap();

        spawnCamera(own);
        spawnSun(own);
        spawnMesh(own, stageCube, standard(own, { baseColor: [0.1, 0.9, 0.4, 1] }), {
          pos: [0, 0.5, 0],
        });
        const lease = renderer.attach(own);
        checks.ok('attach ok', lease.ok, lease.ok ? undefined : lease.error.code);
        if (lease.ok) {
          own.update(1 / 60);
          const drawn = renderer.draw({
            leases: [lease.value],
            camera: { lease: lease.value },
            environment: { lease: lease.value },
          });
          checks.ok('draw returned a receipt', drawn.ok, drawn.ok ? undefined : drawn.error.code);
          if (drawn.ok) {
            const completed = await drawn.value.completed;
            checks.ok(
              'receipt completed',
              completed.ok,
              completed.ok ? undefined : completed.error.code,
            );
          }
        }
        checks.equal('alive before dispose', renderer.state(), 'alive');
        const disposed = await renderer.dispose();
        checks
          .ok('dispose ok', disposed.ok, disposed.ok ? undefined : disposed.error.code)
          .equal('state disposed', renderer.state(), 'disposed');
        return checks.items;
      },
    };
  },
});
