import { PerspectiveCamera, Scene, Vector2 } from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { EffectComposer } from '../addons/postprocessing/EffectComposer';
import { OutputPass } from '../addons/postprocessing/OutputPass';
import { RenderPass } from '../addons/postprocessing/RenderPass';
import { UnrealBloomPass } from '../addons/postprocessing/UnrealBloomPass';
import { renderThreePostProcessing } from '../post-processing';
import type { WebGPURenderer } from '../renderer';

it('maps the current Three r187 Bloom strength to native HDR gain', () => {
  const render = vi.fn<WebGPURenderer[typeof renderThreePostProcessing]>();
  const renderer = {
    getSize: (size: Vector2) => size.set(32, 32),
    getPixelRatio: () => 1,
    [renderThreePostProcessing]: render,
  } as unknown as WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const composer = new EffectComposer(renderer);
  const bloom = new UnrealBloomPass(new Vector2(32, 32), 0.5, 0.7, 1.1);
  const output = new OutputPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloom);
  composer.addPass(output);
  try {
    composer.render();
    expect(render).toHaveBeenNthCalledWith(1, scene, camera, {
      bloom: { intensity: 4.5, radius: 0.7, threshold: 1.1 },
    });
    expect(bloom.strength).toBe(0.5);

    bloom.strength = 0.125;
    composer.render();
    expect(render).toHaveBeenNthCalledWith(2, scene, camera, {
      bloom: { intensity: 1.125, radius: 0.7, threshold: 1.1 },
    });
  } finally {
    composer.dispose();
    bloom.dispose();
    output.dispose();
  }
});
