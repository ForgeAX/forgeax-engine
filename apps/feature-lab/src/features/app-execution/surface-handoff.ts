import { Update } from '@forgeax/engine/ecs';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (pred: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const end = performance.now() + timeoutMs;
  while (!pred() && performance.now() < end) await wait(50);
};

export default defineFeature({
  title: 'Surface handoff (release / restore)',
  catalog: 'Surface handoff',
  kind: 'probe',
  summary:
    'releaseSurfacePreserveWorld() pauses presentation and unconfigures the canvas surface; restoreSurface() resumes with the same World, Renderer and execution identity.',
  expect:
    'All checks pass: no frames while released, the same World/Renderer/entities after restore, and frames resume.',
  setup({ app, world }) {
    spawnStage(world);
    const cube = spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.95, 0.45, 0.1, 1] }), {
      pos: [0, 0.5, 0],
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= (async () => {
          const c = new CheckList();
          let submitted = 0;
          app.renderer.subscribe((e) => {
            if (e.kind === 'frame-submitted') submitted += 1;
          });
          let updates = 0;
          world.addSystem(Update, {
            name: 'fl-surface-count',
            queries: [],
            fn: () => {
              updates += 1;
            },
          });
          const renderer = app.renderer;
          const identity = world.identity;
          await until(() => submitted > 2);
          const released = await app.releaseSurfacePreserveWorld();
          c.ok(
            'releaseSurfacePreserveWorld ok',
            released.ok,
            released.ok ? undefined : released.error.code,
          );
          await wait(50);
          const frozenFrames = submitted;
          const frozenUpdates = updates;
          await wait(300);
          c.equal('no frames while released', submitted, frozenFrames);
          c.equal('no updates while released', updates, frozenUpdates);
          const restored = await app.restoreSurface();
          c.ok('restoreSurface ok', restored.ok, restored.ok ? undefined : restored.error.code);
          await until(() => submitted > frozenFrames + 3);
          c.ok('frames resume', submitted > frozenFrames + 3, `after=${submitted - frozenFrames}`);
          c.ok('same World', app.world === world && world.identity === identity);
          c.ok('same Renderer', app.renderer === renderer);
          c.ok('entities preserved', world.componentsOf(cube).ok);
          c.equal('execution World identity', app.execution.report().world.identity, identity);
          c.equal('no dispatch error', app.lastError?.code ?? null, null);
          return c.items;
        })();
        return memo;
      },
    };
  },
});
