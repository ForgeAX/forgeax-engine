import { defineSystem } from "@forgeax/engine-ecs";
import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildScreenShakeWorld, stepScreenShake } from './screen-shake.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error(`[2d-screen-shake] createApp failed:`, appResult.error);
    return;
  }
  const app = appResult.value;

  buildScreenShakeWorld(app.world);

  const systemToken1 = defineSystem({
    name: 'screen-shake',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource(Time) ? world.getResource(Time).delta : 0;
      const elapsed = world.hasResource(Time) ? world.getResource(Time).elapsed : 0;
      const snapshot = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepScreenShake(world, dt, elapsed, snapshot);
    },
  });
app.world.addSystem(Update, systemToken1);

  const started = app.start();
  if (!started.ok) {
    console.error(`[2d-screen-shake] app.start() failed:`, started.error);
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('2d-screen-shake: missing <canvas id="app"> in index.html');
bootstrap(canvas);