import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { build2dShapesWorld, step2dShapes } from './2d-shapes.js';

type EvidenceGlobal = typeof globalThis & {
  __bevy2dShapesReady?: boolean;
  __prepare2dShapesCapture?: () => Promise<void>;
};

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-2d-shapes: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-2d-shapes] no usable backend:', error);
  else console.error('[bevy-2d-shapes] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-2d-shapes] createApp failed:', appResult.error);
  const app = appResult.value;
  const scene = build2dShapesWorld(app.world);
  app.world.addSystem(Update, {
    name: 'rotate-2d-shapes',
    queries: [],
    fn: (world) => step2dShapes(world, scene, world.getResource(Time).delta),
  });
  const started = app.start();
  if (!started.ok) return console.error('[bevy-2d-shapes] app.start failed:', started.error);
  const evidenceGlobal = globalThis as EvidenceGlobal;
  evidenceGlobal.__prepare2dShapesCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
  };
  evidenceGlobal.__bevy2dShapesReady = true;
}
