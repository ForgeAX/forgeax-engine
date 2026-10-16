import { Time, Update } from '@forgeax/engine-ecs';
// apps/bevy/scale — reproduction of Bevy's `transforms/scale` example.
// The shared src/scale.ts scene and step are the SSOT for this browser app and
// the Dawn smoke. createApp owns the frame loop and auto-provides Time.delta.

import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildScaleWorld, stepScale } from './scale';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-scale: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-scale] no usable backend:', err);
  } else {
    console.error('[bevy-scale] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-scale] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-scale] state=${app.renderer.inspect().state}`);
  buildScaleWorld(app.world);
  app.world.addSystem(Update, {
    name: 'scale-cube',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      stepScale(world, dt);
    },
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-scale] app.start failed:', started.error);
  else globalThis.__bevyScaleReady = true;
}
