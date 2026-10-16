// apps/bevy/3d-rotation - reproduction of Bevy's `3d_rotation` example.
//
// Bevy source (references/repos/bevy/examples/transforms/3d_rotation.rs): a cube
// with a `Rotatable { speed }` component spins about +Y; an `Update` system
// `rotate_cube(Query<(&mut Transform, &Rotatable)>, Res<Time>)` calls
// `transform.rotate_y(speed * TAU * time.delta_secs())`.
//
// forgeax mapping — the loop's FIRST motion demo. Unlike the static
// apps/bevy/3d-scene + 3d-shapes (which manual-rAF redraw an unchanging world),
// this uses the managed motion front door:
//   - createApp -> owns the frame loop AND auto-inserts the 'Time' resource
//     (world.getResource(Time).delta) before each world.update().
//   - world.addSystem -> an Update system that spins the cube each frame via the
//     shared stepSpin (which uses quat.rotateAxis — the ergonomic incremental
//     rotate helper added in solo round 20260713-164916).
//   - app.start() -> begins the rAF loop; the cube visibly rotates.
//
// The World + spin math live in the shared src/rotation.ts (SSOT for this app AND
// the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildRotationWorld, stepSpin } from './rotation';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-3d-rotation: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-3d-rotation] no usable backend:', err);
  } else {
    console.error('[bevy-3d-rotation] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-3d-rotation] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-3d-rotation] state=${app.renderer.inspect().state}`);

  buildRotationWorld(app.world);

  // The Update system: spin every Rotatable each frame off the auto-provided
  // Time.delta (Bevy's `add_systems(Update, rotate_cube)`).
  app.world.addSystem(Update, {
    name: 'rotate-cube',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time')
        ? world.getResource(Time).delta
        : 0;
      stepSpin(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-3d-rotation] app.start failed:', started.error);
}
