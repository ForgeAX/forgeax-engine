// apps/bevy/shadow-biases — Bevy's `shadow_biases` example.
// 1-8 step point/directional depth and normal biases, L swaps the lights,
// F cycles the directional filter, R resets, Z zeroes, arrows and
// PageUp/PageDown move the light rig. The scene lives in scene.mjs so the Dawn
// smoke falsifies exactly this composition.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  adjustBias, BIAS_DEFAULTS, cycleFilter, describe, moveLight, setBiases, spawnBiasesScene, toggleLight,
  ZERO_BIASES,
} from './scene.mjs';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const overlay = document.querySelector<HTMLPreElement>('#status');
if (!canvas || !overlay) throw new Error('bevy-shadow-biases: missing #app canvas or #status overlay in index.html');

bootstrap(canvas, overlay).catch((err: unknown) => {
  console.error('[bevy-shadow-biases] bootstrap error:', err);
});

const BIAS_KEYS = [
  ['Digit1', 'point', 'depthBias', -1], ['Digit2', 'point', 'depthBias', 1],
  ['Digit3', 'point', 'normalBias', -1], ['Digit4', 'point', 'normalBias', 1],
  ['Digit5', 'directional', 'depthBias', -1], ['Digit6', 'directional', 'depthBias', 1],
  ['Digit7', 'directional', 'normalBias', -1], ['Digit8', 'directional', 'normalBias', 1],
] as const;
const MOVE_KEYS = [
  ['ArrowLeft', [-1, 0, 0]], ['ArrowRight', [1, 0, 0]],
  ['ArrowUp', [0, 0, -1]], ['ArrowDown', [0, 0, 1]],
  ['PageDown', [0, -1, 0]], ['PageUp', [0, 1, 0]],
] as const;

async function bootstrap(target: HTMLCanvasElement, status: HTMLPreElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-shadow-biases] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const scene = spawnBiasesScene(app.world, target.width / Math.max(target.height, 1));
  status.textContent = describe(app.world, scene);

  app.world.addSystem(Update, {
    name: 'bevy-shadow-biases-keys',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => {
      const keyboard = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.keyboard;
      if (keyboard === undefined) return;
      let changed = false;
      for (const [code, light, field, sign] of BIAS_KEYS) {
        if (keyboard.justPressedCode(code)) { adjustBias(world, scene, light, field, sign); changed = true; }
      }
      for (const [code, offset] of MOVE_KEYS) {
        if (keyboard.justPressedCode(code)) { moveLight(world, scene, offset); changed = true; }
      }
      if (keyboard.justPressedCode('KeyL')) { toggleLight(world, scene); changed = true; }
      if (keyboard.justPressedCode('KeyF')) { cycleFilter(world, scene); changed = true; }
      if (keyboard.justPressedCode('KeyR')) { setBiases(world, scene, BIAS_DEFAULTS); changed = true; }
      if (keyboard.justPressedCode('KeyZ')) { setBiases(world, scene, ZERO_BIASES); changed = true; }
      if (changed) status.textContent = describe(world, scene);
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-shadow-biases] app.start() failed:', started.error);
  Object.assign(globalThis, { __bevyShadowBiasesReady: true });
}
