import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildPhysicsFixedWorld, installPhysicsFixedSystems } from './physics-fixed-loop';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-physics-fixed-loop: missing canvas');

const result = await createApp(
  canvas,
  { time: { fixedDeltaSeconds: 1 / 30, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.25 } },
  forgeaxBundlerAdapter(),
);
if (!result.ok) {
  console.error('[bevy-physics-fixed-loop] createApp failed:', result.error);
} else {
  buildPhysicsFixedWorld(result.value.world);
  installPhysicsFixedSystems(result.value.world);
  const started = result.value.start();
  if (!started.ok) console.error('[bevy-physics-fixed-loop] app.start failed:', started.error);
}
