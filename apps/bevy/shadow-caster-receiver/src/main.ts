// apps/bevy/shadow-caster-receiver — Bevy's `shadow_caster_receiver` example.
// C toggles shadow casters, R toggles shadow receivers, L swaps the
// directional light and the point light. The scene lives in scene.mjs so the
// Dawn smoke falsifies exactly this composition.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { spawnCasterReceiverScene, toggleLight, toggleParticipation } from './scene.mjs';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shadow-caster-receiver: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-shadow-caster-receiver] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-shadow-caster-receiver] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const scene = spawnCasterReceiverScene(app.world, target.width / Math.max(target.height, 1));
  console.log('Controls:\n  C - toggle shadow casters\n  R - toggle shadow receivers\n  L - switch between directional and point lights');
  console.log('Using DirectionalLight');

  app.world.addSystem(Update, {
    name: 'bevy-shadow-caster-receiver-keys',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => {
      const keyboard = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.keyboard;
      if (keyboard === undefined) return;
      if (keyboard.justPressedCode('KeyL')) console.log(`Using ${toggleLight(world, scene)}`);
      if (keyboard.justPressedCode('KeyC')) {
        console.log('Toggling casters');
        toggleParticipation(world, scene, 'cast');
      }
      if (keyboard.justPressedCode('KeyR')) {
        console.log('Toggling receivers');
        toggleParticipation(world, scene, 'receive');
      }
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-shadow-caster-receiver] app.start() failed:', started.error);
  Object.assign(globalThis, { __bevyShadowCasterReceiverReady: true });
}
