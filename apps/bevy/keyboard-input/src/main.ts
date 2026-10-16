import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildKeyboardInputWorld, stepKeyboardInput } from './keyboard-input';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-keyboard-input: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-keyboard-input] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildKeyboardInputWorld(app.world);
  app.world.addSystem(Update, {
    name: 'bevy-keyboard-input-read',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => stepKeyboardInput(world, world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)),
  });
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-keyboard-input] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  console.warn(`[bevy-keyboard-input] state=${app.renderer.inspect().state}`);
  Object.assign(globalThis, { __bevyKeyboardInputReady: true, __bevyKeyboardInputState: state });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-keyboard-input] bootstrap error:', error));
