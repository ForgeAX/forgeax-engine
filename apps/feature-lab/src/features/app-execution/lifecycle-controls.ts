import type { App } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { Time, Update } from '@forgeax/engine/ecs';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (pred: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const end = performance.now() + timeoutMs;
  while (!pred() && performance.now() < end) await wait(50);
};

export default defineFeature({
  title: 'start / stop / pause / resume / stepFrame',
  catalog: 'Start/stop/pause/resume',
  kind: 'probe',
  summary:
    'pause() halts rAF scheduling without touching the World; stepFrame(dt) advances exactly one update+draw while paused; stop() is terminal.',
  expect:
    'All checks pass: no frames while paused, one frame per stepFrame, invalid steps return app-frame-step-invalid, stop makes pause return app-not-started.',
  setup({ world }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.95, 0.75, 0.1, 1] }), {
      pos: [0, 0.5, 0],
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= probePrivate();
        return memo;
      },
    };
  },
});

// stop() is terminal, so the lifecycle runs on a private App; the lab App keeps rendering.
async function probePrivate(): Promise<readonly FeatureCheck[]> {
  const c = new CheckList();
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  canvas.style.cssText = 'position:fixed;right:8px;bottom:8px;width:96px;height:96px';
  document.body.appendChild(canvas);
  const created = await createApp(canvas);
  c.ok(
    'private createApp(canvas) ok',
    created.ok,
    created.ok ? undefined : String((created.error as { code?: string }).code),
  );
  if (!created.ok) {
    canvas.remove();
    return c.items;
  }
  const app = created.value;
  spawnStage(app.world);
  spawnMesh(app.world, MESH.cube, standard(app.world, { baseColor: [0.95, 0.75, 0.1, 1] }), {
    pos: [0, 0.5, 0],
  });
  c.ok('private start() ok', app.start().ok);
  await probe(app, c);
  const disposed = await app.dispose();
  c.ok('private dispose ok', disposed.ok, disposed.ok ? undefined : disposed.error.code);
  canvas.remove();
  return c.items;
}

async function probe(app: App, c: CheckList): Promise<void> {
  const world = app.world;
  let submitted = 0;
  app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') submitted += 1;
  });
  let updates = 0;
  let lastDelta = 0;
  world.addSystem(Update, {
    name: 'fl-lifecycle-count',
    queries: [],
    fn: (world) => {
      updates += 1;
      lastDelta = world.getResource(Time).delta;
    },
  });
  const code = (r: { ok: boolean; error?: { code: string } }) =>
    r.ok ? 'ok' : (r.error?.code ?? '?');
  await until(() => updates > 0);
  c.ok('running loop updates', updates > 0, `updates=${updates}`);
  c.equal('pause() ok', code(app.pause()), 'ok');
  c.equal('pause() again is idempotent', code(app.pause()), 'ok');
  await wait(60);
  const pausedUpdates = updates;
  const pausedFrames = submitted;
  await wait(300);
  c.equal('no World update while paused', updates, pausedUpdates);
  c.equal('no frame submitted while paused', submitted, pausedFrames);
  c.equal('stepFrame(1/30) ok', code(app.stepFrame(1 / 30)), 'ok');
  await until(() => updates > pausedUpdates && submitted > pausedFrames, 5_000);
  await wait(100);
  c.equal('stepFrame ran exactly one update', updates, pausedUpdates + 1);
  c.near('stepFrame delta reaches Time.delta', lastDelta, 1 / 30, 1e-6);
  c.equal('stepFrame submitted exactly one frame', submitted, pausedFrames + 1);
  c.equal('stepFrame(-1) rejected', code(app.stepFrame(-1)), 'app-frame-step-invalid');
  c.equal('stepFrame(NaN) rejected', code(app.stepFrame(Number.NaN)), 'app-frame-step-invalid');
  c.equal('rejected steps did not update', updates, pausedUpdates + 1);
  c.equal('resume() ok', code(app.resume()), 'ok');
  await until(() => submitted > pausedFrames + 4);
  c.ok(
    'frames resume after resume()',
    submitted > pausedFrames + 3,
    `submitted=${submitted - pausedFrames}`,
  );
  c.ok('first resumed delta is not the paused gap', lastDelta < 0.2, `delta=${lastDelta}`);
  c.equal(
    'stepFrame while running rejected',
    code(app.stepFrame(1 / 60)),
    'app-frame-step-invalid',
  );
  c.equal('start() while running', code(app.start()), 'app-already-running');
  c.equal('stop() ok', code(app.stop()), 'ok');
  await wait(100);
  const stoppedUpdates = updates;
  await wait(200);
  c.equal('no updates after stop', updates, stoppedUpdates);
  c.equal('pause() after stop', code(app.pause()), 'app-not-started');
  c.equal('resume() after stop', code(app.resume()), 'app-not-started');
  c.equal('World survives stop (update still ok)', code(world.update(0)), 'ok');
}
