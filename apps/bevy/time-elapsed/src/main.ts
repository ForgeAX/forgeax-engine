// apps/bevy/time-elapsed - reproduction of Bevy's `time` example (elapsed-keyed motion).
//
// Bevy source (references/repos/bevy/examples/time/time.rs): reads Time::elapsed to drive
// behavior by absolute time since startup. forgeax mapping — a MOTION demo over the managed
// motion front door, but keyed to Time.elapsed (not integrated dt):
//   - createApp -> owns the frame loop AND writes the 'Time' resource { dt, elapsed } before
//     each world.update() (elapsed = accumulated clamped seconds, added solo round 20260713-212920).
//   - world.addSystem -> an Update system that reads Time.elapsed and sets the cube's
//     position/scale via the shared stepByElapsed (y = AMPLITUDE * sin(elapsed * OMEGA)).
//   - app.start() -> the cube oscillates + pulses on the absolute clock.
//
// The World + step math live in the shared src/time-elapsed.ts (SSOT for this app AND the
// dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTimeElapsedWorld, stepByElapsed } from './time-elapsed';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-time-elapsed: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-time-elapsed] no usable backend:', err);
  } else {
    console.error('[bevy-time-elapsed] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-time-elapsed] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-time-elapsed] state=${app.renderer.inspect().state}`);

  buildTimeElapsedWorld(app.world);

  // Update system: drive the cube from the ABSOLUTE elapsed clock (Bevy's
  // Time::elapsed), not by integrating dt. Reads Time.elapsed straight off the resource.
  app.world.addSystem(Update, {
    name: 'oscillate-by-elapsed',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ dt: number; elapsed: number }>('Time').elapsed
        : 0;
      stepByElapsed(world, elapsed);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-time-elapsed] app.start failed:', started.error);
}
