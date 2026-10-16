// apps/hello/oit - weighted blended order-independent transparency exemplar.
//
// Three translucent planes interpenetrate at the origin, so no object order
// can composite both halves correctly. One Camera field selects the method:
//
//   { component: Camera, data: { ..., transparency: TRANSPARENCY_WEIGHTED_BLENDED } }
//
// Press `T` to toggle between weighted blended OIT and the default sorted
// path, and `O` to reverse the spawn order of the layers. OIT stays identical
// under both orders; the sorted path changes on one half of the image.
// `renderer.inspect().transparency` reports the resolved mode and draw counts.

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { World } from '@forgeax/engine-ecs';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { propagateTransforms } from '@forgeax/engine-scene';
import { spawnOitScene } from '../scripts/oit-scene.mjs';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-oit: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[oit] no usable backend:', err);
  else console.error('[oit] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const size = Math.min(window.innerWidth, window.innerHeight);
  target.width = size;
  target.height = size;
  target.style.width = `${size}px`;
  target.style.height = `${size}px`;
  const rendererResult = await createRenderer(target, {}, forgeaxBundlerAdapter());
  if (!rendererResult.ok) {
    console.error('[oit] renderer construction failed:', rendererResult.error);
    return;
  }
  const renderer = rendererResult.value;
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const scene = spawnOitScene(world);

  let mode: 'sorted' | 'weighted-blended' = 'weighted-blended';
  let reversed = false;
  window.addEventListener('keydown', (event) => {
    if (event.key === 't' || event.key === 'T') {
      mode = mode === 'sorted' ? 'weighted-blended' : 'sorted';
      scene.setTransparency(mode);
    } else if (event.key === 'o' || event.key === 'O') {
      reversed = !reversed;
      scene.spawnLayers(reversed ? [2, 1, 0] : [0, 1, 2]);
    } else return;
    console.warn('[oit]', { mode, reversed, transparency: renderer.inspect().transparency });
  });

  const frame = (): void => {
    world.update().unwrap();
    propagateTransforms(world).unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) console.error('[oit] draw error:', drawn.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
