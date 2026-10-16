// apps/bevy/parenting - reproduction of Bevy's `parenting` example.
//
// Bevy source (references/repos/bevy/examples/3d/parenting.rs): a parent
// cube (2×2×2) at (0,0,1) rotates about X; a child cube at local (0,0,3)
// orbits via the ChildOf hierarchy. The Rotator system spins the parent
// each frame; propagateTransforms (auto-registered by createApp) derives
// the child's world position.
//
// forgeax mapping (thin over existing primitives):
//   - createApp -> owns the frame loop + auto-inserts Time resource
//   - ChildOf { parent: rootEntity } -> hierarchy back-reference
//   - propagateTransforms -> auto-registered in createApp's plugin chain
//   - quat.rotateAxis -> ergonomic incremental rotate (solo round 20260713-164916)
//
// The World + spin math live in the shared src/parenting.ts (SSOT for this
// app AND the dawn smoke).

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildParentingWorld, stepRotate } from './parenting';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-parenting: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-parenting] no usable backend:', err);
  } else {
    console.error('[bevy-parenting] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-parenting] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-parenting] state=${app.renderer.inspect().state}`);

  buildParentingWorld(app.world);

  // The Update system: spin the parent each frame off the auto-provided
  // Time.delta (Bevy's `add_systems(Update, rotator_system)`).
  app.world.addSystem(Update, {
    name: 'rotate-parent',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time')
        ? world.getResource(Time).delta
        : 0;
      stepRotate(world, dt);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-parenting] app.start failed:', started.error);
}
