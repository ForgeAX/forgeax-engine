// apps/bevy/bloom — reproduce Bevy's `bloom_3d` example.
//
// Bevy source: emissive spheres in a dark scene with bloom post-processing.
// forgeax: emissive sphere + non-emissive cube, Space toggles Camera.bloom.
// Thin over existing BLOOM_ENABLED/BLOOM_DISABLED + hello/bloom surface.

import { InputFrameStartScan } from "@forgeax/engine-input";
import { defineSystem } from "@forgeax/engine-ecs";
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { BLOOM_DISABLED, BLOOM_ENABLED, Camera } from '@forgeax/engine/render';
import { buildBloomWorld } from './bloom';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-bloom: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-bloom] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-bloom] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const scene = buildBloomWorld(world, target.width / Math.max(target.height, 1));

  let prevSpace = false;
  let currentBloom: number = BLOOM_DISABLED;
  const systemToken1 = defineSystem({
    name: 'bloom-toggle',
    after: [InputFrameStartScan],
    queries: [],
    fn: () => {
      const snap = world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) return;
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        currentBloom = currentBloom === BLOOM_ENABLED ? BLOOM_DISABLED : BLOOM_ENABLED;
        world.set(scene.camera, Camera, { bloom: currentBloom });
      }
      prevSpace = cur;
    },
  });
world.addSystem(Update, systemToken1);

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-bloom] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-bloom] running. Press Space to toggle Bloom.');
}
