// apps/bevy/smooth-follow - reproduction of Bevy's `smooth_follow` example.
//
// Bevy source (references/repos/bevy/examples/movement/smooth_follow.rs): a red
// follower sphere smoothly chases a moving blue target sphere. `move_follower` calls
// `following.translation.smooth_nudge(&target.translation, decay_rate, delta_time)` —
// the frame-rate-INDEPENDENT exponential-decay interpolation.
//
// forgeax mapping — a MOTION demo over the managed motion front door (same shape as
// apps/bevy/3d-rotation + translation):
//   - createApp -> owns the frame loop AND auto-inserts the 'Time' resource
//     (world.getResource(Time).delta) before each world.update().
//   - world.addSystem (x2, chained) -> stepTarget then stepFollower each frame,
//     mirroring Bevy's `.add_systems(Update, (move_target, move_follower).chain())`.
//   - stepFollower uses vec3.smoothDamp — the frame-rate-independent damping helper
//     added in solo round 20260713-183918, mapping Bevy's Vec3::smooth_nudge.
//
// The World + step math live in the shared src/smooth-follow.ts (SSOT for this app
// AND the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSmoothFollowWorld, stepFollower, stepTarget } from './smooth-follow';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-smooth-follow: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-smooth-follow] no usable backend:', err);
  } else {
    console.error('[bevy-smooth-follow] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-smooth-follow] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-smooth-follow] state=${app.renderer.inspect().state}`);

  buildSmoothFollowWorld(app.world);

  // Bevy: `.add_systems(Update, (move_target, move_follower).chain())` — target moves
  // first, then the follower damps toward the target's NEW position, both off Time.delta.
  app.world.addSystem(Update, {
    name: 'move-target',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      stepTarget(world, dt);
    },
  });
  app.world.addSystem(Update, {
    name: 'move-follower',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      stepFollower(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-smooth-follow] app.start failed:', started.error);
}
