// apps/bevy/anti-aliasing — reproduce Bevy's `anti_aliasing` example.
//
// Bevy source: a 3D scene with multiple AA techniques (MSAA/FXAA/SMAA/TAA/DLSS) toggled
// via keyboard. forgeax has FXAA only (ANTIALIAS_FXAA / ANTIALIAS_NONE on Camera.antialias).
// Scene: 4 geometric shapes (triangle, cube, quad, sphere) spread horizontally under a
// slant directional light — the same scene as hello/fxaa, ported to the bevy-app convention.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Camera } from '@forgeax/engine-render';
import { ANTIALIAS_MODES, ANTIALIAS_NAMES, buildAntiAliasingWorld } from './anti-aliasing';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-anti-aliasing: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-anti-aliasing] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-anti-aliasing] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const scene = buildAntiAliasingWorld(world, target.width / target.height);
  const camEntity = scene.camera;
  world.addSystem(Update, {
    name: 'aa-cycle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) return;
      for (let i = 0; i < ANTIALIAS_MODES.length; i += 1) {
        if (!snap.keyboard.down(String(i + 1))) continue;
        const mode = ANTIALIAS_MODES[i];
        if (mode === undefined) continue;
        world.set(camEntity, Camera, { antialias: mode });
        console.log(`[anti-aliasing] mode: ${ANTIALIAS_NAMES[i]}`);
        break;
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-anti-aliasing] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-anti-aliasing] running. Press 1 for none, 2 for MSAA, 3 for FXAA.');
}
