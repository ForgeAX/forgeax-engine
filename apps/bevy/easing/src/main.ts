// apps/bevy/easing - reproduction of Bevy's `animation/easing_functions` example.
//
// Bevy source (references/repos/bevy/examples/animation/easing_functions.rs): shows the
// built-in easing functions' behavior. forgeax mapping — a MOTION demo contrasting linear vs
// eased motion over the managed motion front door:
//   - createApp -> owns the frame loop AND writes Time { dt, elapsed }.
//   - world.addSystem -> an Update system that ping-pongs a normalized time u in [0,1] off
//     Time.elapsed and places two cubes: one at linearX(u), one at easedX(u) =
//     lerp(x0, x1, easing.smoothstep(u)) — the new easing namespace (solo round 20260713-233409).
//   - app.start() -> the eased cube visibly lags/leads the linear cube (slow-in/slow-out).
//
// The World + step math live in the shared src/easing-demo.ts (SSOT for this app AND the dawn
// smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildEasingWorld, stepEasing } from './easing-demo';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-easing: missing <canvas id="app"> in index.html');

/** Ping-pong a monotonic elapsed time into u in [0,1] (triangle wave, period 2*HALF). */
const HALF_PERIOD = 2; // seconds for one end-to-end traverse
function pingpong(elapsed: number): number {
  const phase = (elapsed / HALF_PERIOD) % 2;
  return phase <= 1 ? phase : 2 - phase;
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-easing] no usable backend:', err);
  } else {
    console.error('[bevy-easing] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-easing] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-easing] state=${app.renderer.inspect().state}`);

  buildEasingWorld(app.world);

  app.world.addSystem(Update, {
    name: 'ease-movers',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ dt: number; elapsed: number }>('Time').elapsed
        : 0;
      stepEasing(world, pingpong(elapsed));
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-easing] app.start failed:', started.error);
}
