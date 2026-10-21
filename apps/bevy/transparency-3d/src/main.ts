import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTransparencyWorld, stepTransparencyAlpha } from './transparency-3d';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-transparency-3d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-transparency-3d] no usable backend:', error);
  } else {
    console.error('[bevy-transparency-3d] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-transparency-3d] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('asset owner unavailable');
  const scene = buildTransparencyWorld(app.world, assets, target.width / Math.max(target.height, 1));
  app.world.addSystem(Update, {
    name: 'fade-transparency',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ dt: number; elapsed: number }>(Time).elapsed
        : 0;
      stepTransparencyAlpha(assets, scene, elapsed);
    },
  });
  app.onError((error) => console.error('[bevy-transparency-3d] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-transparency-3d] app.start failed:', started.error);
}
