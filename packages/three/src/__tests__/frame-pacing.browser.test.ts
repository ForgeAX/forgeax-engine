import * as THREE from '@forgeax/engine/three';
import { EffectComposer } from '@forgeax/engine/three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from '@forgeax/engine/three/addons/postprocessing/OutputPass.js';
import { RenderPass } from '@forgeax/engine/three/addons/postprocessing/RenderPass.js';
import { expect, it, vi } from 'vitest';
import { browserRendererFixture, readyFrames, testScene } from './render.fixture';

const makeRenderer = browserRendererFixture();

it('admits two display draws and resumes when a new receipt settles', async () => {
  const renderer = makeRenderer();
  const { scene, camera } = testScene();
  await renderer.init();
  await readyFrames(renderer, scene, camera);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  const submitted = () => {
    const receipt = THREE.readThreeFrame(renderer)?.receipt;
    if (receipt === undefined) throw new Error('Expected a display receipt');
    return receipt;
  };
  const draw = vi.fn((enabled: boolean) => {
    if (enabled) composer.render();
  });
  const render = THREE.paceThreeDisplayFrames(renderer, draw);

  expect(render(false)).toBe(false);
  expect(render(true)).toBe(true);
  const first = submitted();
  expect(render(true)).toBe(true);
  const second = submitted();
  expect(second.frameId).toBeGreaterThan(first.frameId);
  expect(render(true)).toBe(false);
  expect(submitted()).toBe(second);
  expect(draw).toHaveBeenCalledTimes(3);

  expect((await (first.creditCompleted ?? first.completed)).ok).toBe(true);
  expect(render(true)).toBe(true);
  const third = submitted();
  expect(third.frameId).toBeGreaterThan(second.frameId);
  expect((await third.completed).ok).toBe(true);

  const serial = THREE.paceThreeDisplayFrames(renderer, draw, { maxFramesInFlight: 1 });
  expect(serial(true)).toBe(true);
  expect(serial(true)).toBe(false);
  expect((await submitted().completed).ok).toBe(true);
  expect(() => THREE.paceThreeDisplayFrames(renderer, draw, { maxFramesInFlight: 0 })).toThrow(
    THREE.ThreeCompatibilityError,
  );
  composer.dispose();
});
