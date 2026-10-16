// apps/bevy/tonemapping — reproduce Bevy's `tonemapping` example.
//
// Bevy source: compare different tonemapping methods on a 3D scene.
// forgeax: 3D scene with 1-7 keys cycling through 7 tonemap modes.
// Thin over existing TONEMAP_* constants + hello/tonemap surface.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Camera } from '@forgeax/engine-render';
import { TONEMAP_MODES, TONEMAP_NAMES, buildTonemappingWorld } from './tonemapping';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-tonemapping: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-tonemapping] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-tonemapping] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const scene = buildTonemappingWorld(world, target.width / target.height);
  const camEntity = scene.camera;

  world.addSystem(Update, {
    name: 'tonemap-cycle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) return;
      for (let i = 0; i < TONEMAP_MODES.length; i++) {
        if (snap.keyboard.down(String(i + 1))) {
          const tonemap = TONEMAP_MODES[i];
          if (tonemap === undefined) continue;
          world.set(camEntity, Camera, { tonemap });
          console.log(`[tonemapping] mode: ${TONEMAP_NAMES[i]}`);
          break;
        }
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-tonemapping] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-tonemapping] running. Press 1-7 to cycle tonemap modes.');
}
