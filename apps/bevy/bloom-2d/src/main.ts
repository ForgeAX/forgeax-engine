import { InputFrameStartScan } from "@forgeax/engine-input";
import { defineSystem } from "@forgeax/engine-ecs";
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { BLOOM_DISABLED, BLOOM_ENABLED, Camera } from '@forgeax/engine/render';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildBloom2dWorld } from './bloom-2d';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-bloom-2d: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, { pointerLockAllowed: () => false }, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-bloom-2d] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const scene = buildBloom2dWorld(app.world);
  const state = { bloomEnabled: false, toggles: 0, quadCount: scene.quadCount, brightCount: scene.brightCount };
  let previousSpace = false;
  const systemToken1 = defineSystem({
    name: 'bevy-bloom-2d-toggle',
    after: [InputFrameStartScan],
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
      const space = snapshot.keyboard.down(' ');
      if (space && !previousSpace) {
        state.bloomEnabled = !state.bloomEnabled;
        state.toggles += 1;
        world.set(scene.camera, Camera, { bloom: state.bloomEnabled ? BLOOM_ENABLED : BLOOM_DISABLED });
      }
      previousSpace = space;
    },
  });
app.world.addSystem(Update, systemToken1);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-bloom-2d] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  Object.assign(globalThis, { __bevyBloom2dReady: true, __bevyBloom2dState: state });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-bloom-2d] bootstrap error:', error));
