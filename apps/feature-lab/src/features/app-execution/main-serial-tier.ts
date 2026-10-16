import { EXECUTION_WORKERS } from '@forgeax/engine/app';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Main-serial execution tier',
  catalog: 'Main-serial tier',
  kind: 'probe',
  summary:
    'Without an execution bootstrap, World and Renderer share the Host realm; every Worker is reported off with a closed reason and no Worker prerequisite.',
  expect:
    'All checks pass: realm=host, engine worker disabled, render/kernels engine-disabled, local frame credit highWater <= 2, World identity matches.',
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.85, 0.4, 1] }), {
      pos: [0, 0.5, 0],
    });
    return {
      async checks() {
        await frames(10);
        const c = new CheckList();
        const report = app.execution.report();
        c.equal('engine realm', report.engine.realm, 'host');
        c.equal('engine worker decision', report.workers.engine, {
          requested: false,
          enabled: false,
          reason: 'disabled',
          missingCapabilities: [],
        });
        c.equal('render worker reason', report.workers.render.reason, 'engine-disabled');
        c.equal('kernel worker reason', report.workers.kernels.reason, 'engine-disabled');
        c.ok(
          'no worker enabled',
          EXECUTION_WORKERS.every((w) => !report.workers[w].enabled),
        );
        c.equal('world identity is the host World', report.world.identity, world.identity);
        c.equal('world health', report.world.health, 'healthy');
        c.equal('no fault', report.fault, null);
        c.ok(
          'frames submitted counted',
          report.frame.submitted >= 10,
          JSON.stringify(report.frame),
        );
        c.ok(
          'local credit highWater <= 2',
          report.frame.highWater <= 2,
          JSON.stringify(report.frame),
        );
        c.ok('inFlight within credit', report.frame.inFlight >= 0 && report.frame.inFlight <= 2);
        c.equal('no render worker section', report.render, undefined);
        return c.items;
      },
    };
  },
});
