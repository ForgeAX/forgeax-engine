// apps/bevy/translation - reproduction of Bevy's `translation` example.
//
// Bevy source (references/repos/bevy/examples/transforms/translation.rs): a cube
// with a `Movable { spawn, max_distance, speed }` component slides along its own
// local X axis; an `Update` system `move_cube(Query<(&mut Transform, &mut
// Movable)>, Res<Time>)` does `transform.translation += transform.local_x() *
// speed * time.delta_secs()`, reversing `speed` at the `max_distance` band edge.
//
// forgeax mapping — a MOTION demo over the managed motion front door (same shape
// as apps/bevy/3d-rotation):
//   - createApp -> owns the frame loop AND auto-inserts the 'Time' resource
//     (world.getResource(Time).delta) before each world.update().
//   - world.addSystem -> an Update system that slides the cube each frame via the
//     shared stepMove (which uses quat.right — the ergonomic local-basis accessor
//     added in solo round 20260713-174912, mapping Bevy's transform.local_x()).
//   - app.start() -> begins the rAF loop; the cube visibly slides back and forth.
//
// The World + move math live in the shared src/translation.ts (SSOT for this app
// AND the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTranslationWorld, stepMove } from './translation';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-translation: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-translation] no usable backend:', err);
  } else {
    console.error('[bevy-translation] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-translation] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-translation] state=${app.renderer.inspect().state}`);

  buildTranslationWorld(app.world);

  // The Update system: slide every Movable each frame off the auto-provided
  // Time.delta (Bevy's `add_systems(Update, move_cube)`).
  app.world.addSystem(Update, {
    name: 'move-cube',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time')
        ? world.getResource(Time).delta
        : 0;
      stepMove(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-translation] app.start failed:', started.error);
}
