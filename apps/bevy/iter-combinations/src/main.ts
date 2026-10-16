import { Time, Update } from '@forgeax/engine-ecs';
// apps/bevy/iter-combinations - reproduction of Bevy's `iter_combinations` example.
//
// Bevy source (references/repos/bevy/examples/ecs/iter_combinations.rs): an N-body
// gravity simulation. `interact_bodies` uses `query.iter_combinations_mut()` to
// apply each unordered PAIR's mutual gravitational force once; `integrate` then
// verlet-steps every body. Bodies attract and clump.
//
// forgeax mapping — an ECS-front-door MOTION demo:
//   - createApp -> owns the frame loop AND auto-inserts the 'Time' resource
//     (world.getResource(Time).delta) before each world.update().
//   - world.addSystem (x2, chained) -> stepInteract (pairwise force accumulation
//     via Query.combinations) then stepIntegrate (verlet), mirroring Bevy's
//     (interact_bodies, integrate) in FixedUpdate.
//   - stepInteract uses Query.combinations, mapping Bevy's Query::iter_combinations_mut.
//
// The World + step math live in the shared src/iter-combinations.ts (SSOT for this
// app AND the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildIterCombinationsWorld, stepIntegrate, stepInteract } from './iter-combinations';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-iter-combinations: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-iter-combinations] no usable backend:', err);
  } else {
    console.error('[bevy-iter-combinations] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-iter-combinations] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-iter-combinations] state=${app.renderer.inspect().state}`);

  buildIterCombinationsWorld(app.world);

  // Bevy: (interact_bodies, integrate) — accumulate pairwise forces first, then
  // verlet-integrate, both off Time.delta.
  app.world.addSystem(Update, {
    name: 'interact-bodies',
    queries: [],
    fn: (world) => {
      stepInteract(world);
    },
  });
  app.world.addSystem(Update, {
    name: 'integrate',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      stepIntegrate(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-iter-combinations] app.start failed:', started.error);
}
