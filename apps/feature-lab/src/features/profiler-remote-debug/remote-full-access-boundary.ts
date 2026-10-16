import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { evalInApp } from './_shared/eval';

export default defineFeature({
  title: 'Remote full-access boundary',
  catalog: 'Remote full-access boundary',
  kind: 'probe',
  summary:
    'eval is neither sandboxed nor read-only: a script may despawn entities or touch host globals; only the Host decides whether to expose it.',
  expect:
    'A script despawns a live entity and reads globalThis; no method blacklist refuses either.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    const victim = spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.2, 0.2, 1] }), {
      pos: [0, 0.5, 0],
    });
    const aliveBefore = world.get(victim, Transform).ok;
    const destroyed = await evalInApp(app, `world.despawn(${Number(victim)}); return true;`);
    await frames(2);
    const aliveAfter = world.get(victim, Transform).ok;
    const globals = await evalInApp(app, 'typeof globalThis.document');
    return {
      checks: () => [
        { name: 'entity alive before eval', ok: aliveBefore },
        {
          name: 'eval despawn succeeded',
          ok: destroyed.ok && destroyed.value === true,
          detail: destroyed.ok ? '' : destroyed.error.code,
        },
        { name: 'entity gone after eval (mutation is real)', ok: !aliveAfter },
        {
          name: 'eval reaches host globals (no sandbox)',
          ok: globals.ok && globals.value === 'object',
        },
      ],
    };
  },
});
