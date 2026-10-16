import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTransformWorld, stepTransform } from './transform';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-transform: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-transform] no usable backend:', error);
  else console.error('[bevy-transform] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-transform] createApp failed:', appResult.error);
  const app = appResult.value;
  buildTransformWorld(app.world);
  app.world.addSystem(Update, {
    name: 'orbit-transform',
    queries: [],
    fn: (world) => stepTransform(world, world.hasResource('Time') ? world.getResource(Time).delta : 0),
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-transform] app.start failed:', started.error);
}
