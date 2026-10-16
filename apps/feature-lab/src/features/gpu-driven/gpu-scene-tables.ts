import { GlobalTransform, Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { inspect, spawnGrid } from './support/scene';

const TABLES = ['primitive', 'instance', 'transform', 'drawTemplate', 'material'] as const;

export default defineFeature({
  title: 'GPU Scene tables',
  catalog: 'GPU Scene tables',
  kind: 'probe',
  summary:
    'With storage buffers, the renderer derives Primitive, Instance, Transform, DrawTemplate, and Material tables from its persistent CPU Render Scene and uploads only changed ranges.',
  expect:
    "All checks pass: GPU Scene status is 'resident' with all five tables sized, a still scene counts noChangeFrames upward with zero table upload, and moving one cube adds a range-scoped delta upload without a full rebuild.",
  async setup({ app, world, frames }) {
    const { visible } = spawnGrid(world);
    await frames(20);
    return {
      async checks() {
        const checks = new CheckList();
        const first = inspect(app);
        checks.equal('caps.storageBuffer', first.caps.storageBuffer, true);
        checks.equal('GPU Scene status', first.gpu.status, 'resident');
        if (first.gpu.status !== 'resident') return checks.items;
        checks.ok(
          'capacity covers the 20 cubes',
          first.gpu.capacity >= 20,
          `capacity=${first.gpu.capacity}`,
        );
        for (const name of TABLES) {
          const table = first.gpu.tables[name];
          checks.ok(
            `table '${name}' allocated`,
            table.capacity > 0 && table.bytes > 0,
            JSON.stringify(table),
          );
        }
        await frames(5);
        const still = inspect(app);
        const stillCount = still.gpu.status === 'resident' ? still.gpu.noChangeFrames : -1;
        checks.ok(
          'still scene: noChangeFrames grows',
          stillCount > first.gpu.noChangeFrames,
          `${first.gpu.noChangeFrames} -> ${stillCount}`,
        );
        checks.equal(
          'still scene: GPU-driven table upload bytes',
          still.driven.sceneTableUploadBytes,
          0,
        );

        const moved = visible[0];
        const stillScene = app.renderer.inspect().renderScene;
        const stillDeltaFrames = stillScene.deltaFrames;
        const before = inspect(app);
        const beforeRanges = before.gpu.status === 'resident' ? before.gpu.uploadRanges : -1;
        const setResult =
          moved === undefined
            ? 'no-entity'
            : (() => {
                const r = world.set(moved, Transform, { pos: [-2.6, 1.6, -2.6] } as never);
                return r.ok ? 'ok' : r.error.code;
              })();
        checks.equal('world.set(Transform) on a grid cube', setResult, 'ok');
        let after = before;
        for (let i = 0; i < 5; i++) {
          await frames(1);
          after = inspect(app);
          if (after.gpu.status === 'resident' && after.gpu.uploadRanges > beforeRanges) break;
        }
        const translation = moved === undefined ? undefined : world.get(moved, GlobalTransform);
        const t = translation?.ok
          ? Array.from((translation.value as { world: ArrayLike<number> }).world).slice(12, 15)
          : [];
        checks.ok(
          'GlobalTransform propagated the move',
          Math.abs((t[0] ?? 0) + 2.6) < 1e-4 && Math.abs((t[1] ?? 0) - 1.6) < 1e-4,
          JSON.stringify(t),
        );
        const cpuBefore = app.renderer.inspect().renderScene;
        checks.ok(
          'CPU Render Scene recorded the move as a delta frame',
          cpuBefore.deltaFrames > stillDeltaFrames,
          `deltaFrames ${stillDeltaFrames} -> ${cpuBefore.deltaFrames} noChangeFrames ${stillScene.noChangeFrames} -> ${cpuBefore.noChangeFrames}`,
        );
        checks.ok(
          'moving one cube uploads a delta range',
          after.gpu.status === 'resident' && after.gpu.uploadRanges > beforeRanges,
          after.gpu.status === 'resident'
            ? `uploadRanges ${beforeRanges} -> ${after.gpu.uploadRanges} noChangeFrames ${before.gpu.status === 'resident' ? before.gpu.noChangeFrames : -1} -> ${after.gpu.noChangeFrames}`
            : after.gpu.status,
        );
        checks.ok(
          'delta upload stays range-scoped (no full rebuild)',
          after.gpu.status === 'resident' && after.gpu.fullRebuilds === first.gpu.fullRebuilds,
          after.gpu.status === 'resident'
            ? `fullRebuilds=${after.gpu.fullRebuilds} uploadRanges=${after.gpu.uploadRanges} uploadBytes=${after.gpu.uploadBytes}`
            : after.gpu.status,
        );
        return checks.items;
      },
    };
  },
});
