import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildRotationWorld, stepRotationWorld } from './rotation.js';

type EvidenceGlobal = typeof globalThis & {
  __bevy2dRotationReady?: boolean;
  __prepareRotationCapture?: () => Promise<void>;
};

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-2d-rotation: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-2d-rotation] no usable backend:', error);
  else console.error('[bevy-2d-rotation] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-2d-rotation] createApp failed:', appResult.error);
  const app = appResult.value;
  buildRotationWorld(app.world);
  app.world.addSystem(Update, {
    name: 'rotation',
    queries: [],
    fn: (world) => {
      const dt = world.getResource(Time).delta;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepRotationWorld(world, dt, snapshot);
    },
  });
  const started = app.start();
  if (!started.ok) return console.error('[bevy-2d-rotation] app.start failed:', started.error);
  const evidenceGlobal = globalThis as EvidenceGlobal;
  evidenceGlobal.__prepareRotationCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
  };
  evidenceGlobal.__bevy2dRotationReady = true;
}
