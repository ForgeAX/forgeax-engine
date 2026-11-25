import {
  AmbientLight,
  BoxGeometry,
  Fog,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGPURenderer,
} from '@forgeax/engine/three';
import { EffectComposer } from '@forgeax/engine/three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from '@forgeax/engine/three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from '@forgeax/engine/three/addons/postprocessing/OutputPass.js';
import { Pass } from '@forgeax/engine/three/addons/postprocessing/Pass.js';
import { RenderPass } from '@forgeax/engine/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '@forgeax/engine/three/addons/postprocessing/UnrealBloomPass.js';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { expect, it } from 'vitest';

it.each([
  { renderPath: 'forward', algorithm: 'ssao' },
  { renderPath: 'deferred', algorithm: 'gtao' },
] as const)('submits and retires Three composer $algorithm and Bloom work on $renderPath', {
  timeout: 120_000,
}, async ({ renderPath, algorithm }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const renderer = new WebGPURenderer({
    canvas,
    antialias: renderPath === 'forward',
    forgeax: {
      renderer: {
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath,
          ambientOcclusion: { enabled: false },
        },
      },
    },
  });
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 20);
  camera.position.set(3, 2, 4);
  camera.lookAt(0, 0, 0);
  scene.add(
    new AmbientLight(0xffffff, 0.5),
    new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({
        roughness: 0.6,
        emissive: 0xff6914,
        emissiveIntensity: 4,
      }),
    ),
  );
  const floor = new Mesh(new BoxGeometry(8, 0.15, 8), new MeshStandardMaterial());
  floor.position.y = -0.55;
  scene.add(floor);

  const composer = new EffectComposer(renderer);
  const gtao = new GTAOPass(scene, camera);
  const bloom = new UnrealBloomPass(new Vector2(128, 128), 0.5, 0.7, 1);
  const output = new OutputPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(gtao);
  composer.addPass(bloom);
  composer.addPass(output);

  async function completedFrame(): Promise<void> {
    const deadline = performance.now() + 20_000;
    do {
      composer.render();
      const receipt = renderer.inspect().receipt;
      if (!receipt) throw new Error('Composer did not submit a frame');
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      if (receipt.presentation === 'ready') return;
      if (receipt.preparationCompleted) {
        const prepared = await receipt.preparationCompleted;
        if (!prepared.ok) throw prepared.error;
      } else {
        await new Promise(requestAnimationFrame);
      }
    } while (performance.now() < deadline);
    throw new Error('Composer frame did not become ready');
  }

  try {
    await renderer.init();
    for (let i = 0; i < 60; i++) await completedFrame();
    const lighting = () => renderer.inspect().renderer.standardLighting?.ambientOcclusion;
    const bloomState = () => renderer.inspect().renderer.bloom;
    expect(lighting()).toMatchObject({ status: 'active', algorithm });
    expect(lighting()?.methodFallback).toBe(
      renderPath === 'forward' ? 'forward-only-ssao' : undefined,
    );
    expect(bloomState()).toMatchObject({ state: 'active', passCount: 11, encodeCount: 11 });

    if (renderPath === 'forward') {
      scene.fog = new Fog(0x204060, 2, 9);
      await completedFrame();
      const key = renderer.inspect().renderer.featureGraph?.last.topologyKey;
      expect(key).toContain('"forwardDisplay"');
      expect(key).toContain('"samples":4');
      expect(bloomState()).toMatchObject({ state: 'active', encodeCount: 11 });
    }
    gtao.enabled = false;
    await completedFrame();
    expect(lighting()?.status).toBe('off');
    expect(bloomState().state).toBe('active');
    gtao.enabled = true;
    bloom.enabled = false;
    await completedFrame();
    expect(lighting()).toMatchObject({ status: 'active', algorithm });
    expect(bloomState().enabled).toBe(false);

    const custom = new Pass();
    composer.insertPass(custom, 3);
    expect(() => composer.render()).toThrow('EffectComposer pass or ordering');
    composer.removePass(custom);
    composer.removePass(gtao);
    await completedFrame();
    expect(lighting()?.status).toBe('off');
    expect(bloomState().enabled).toBe(false);
  } finally {
    composer.dispose();
    gtao.dispose();
    bloom.dispose();
    output.dispose();
    await renderer.dispose();
    canvas.remove();
  }
});
