import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAnimatedMaterialWorld, stepAnimatedMaterials } from './animated-material';

type EvidenceGlobal = typeof globalThis & {
  __bevyAnimatedMaterialReady?: boolean;
  __bevyAnimatedMaterialState?: () => { materialCount: number; hueDelta: number };
  __prepareAnimatedMaterialCapture?: () => Promise<void>;
};

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-animated-material: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-animated-material] no usable backend:', error);
  else console.error('[bevy-animated-material] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-animated-material] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('asset owner unavailable');
  const scene = buildAnimatedMaterialWorld(app.world, assets, target.width / Math.max(target.height, 1));
  let lastHueDelta = 0;
  app.world.addSystem(Update, {
    name: 'animate-materials',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ elapsed: number }>('Time').elapsed
        : 0;
      lastHueDelta = stepAnimatedMaterials(assets, scene, elapsed);
    },
  });
  app.onError((error) => console.error('[bevy-animated-material] app error:', error.code, error.hint));
  console.warn(`[bevy-animated-material] state=${app.renderer.inspect().state}`);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-animated-material] app.start failed:', started.error);
    return;
  }

  const evidenceGlobal = globalThis as EvidenceGlobal;
  evidenceGlobal.__bevyAnimatedMaterialState = () => ({
    materialCount: scene.materials.length,
    hueDelta: lastHueDelta,
  });
  evidenceGlobal.__prepareAnimatedMaterialCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
  };
  evidenceGlobal.__bevyAnimatedMaterialReady = true;
}
