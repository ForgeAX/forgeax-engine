import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildMouseInputWorld, stepMouseInput } from './mouse-input';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-mouse-input: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, { pointerLockAllowed: () => false }, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-mouse-input] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildMouseInputWorld(app.world);
  app.world.addSystem(Update, {
    name: 'bevy-mouse-input-read',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => stepMouseInput(world, world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)),
  });
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-mouse-input] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  console.warn(`[bevy-mouse-input] state=${app.renderer.inspect().state}`);
  Object.assign(globalThis, { __bevyMouseInputReady: true, __bevyMouseInputState: state });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-mouse-input] bootstrap error:', error));
