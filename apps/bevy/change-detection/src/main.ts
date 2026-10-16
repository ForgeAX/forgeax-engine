import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildChangeDetectionWorld, readChangeDetectionState } from './change-detection.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-change-detection: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-change-detection] no usable backend:', error);
  else console.error('[bevy-change-detection] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) { console.error('[bevy-change-detection] createApp failed:', result.error); return; }
  const app = result.value;
  const state = buildChangeDetectionWorld(app.world);
  const started = app.start();
  if (!started.ok) { console.error('[bevy-change-detection] app.start failed:', started.error); return; }
  const host = globalThis as typeof globalThis & {
    __bevyChangeDetectionReady?: boolean;
    __bevyChangeDetectionState?: () => ReturnType<typeof readChangeDetectionState>;
    __prepareChangeDetectionCapture?: () => Promise<void>;
  };
  host.__bevyChangeDetectionState = () => readChangeDetectionState(app.world, state);
  host.__prepareChangeDetectionCapture = async () => {
    const before = readChangeDetectionState(app.world, state);
    if (before.addedHits !== 1 || before.changedHits === 0 || before.resourceChanged === 0) {
      throw new Error('change-detection state is not ready for capture: ' + JSON.stringify(before));
    }
    let after = before;
    for (let frame = 0; frame < 30 && after.changedHits <= before.changedHits; frame += 1) {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      after = readChangeDetectionState(app.world, state);
    }
    if (
      after.addedHits !== 1 ||
      after.changedHits <= before.changedHits ||
      after.resourceChanged <= before.resourceChanged ||
      after.changeTick <= before.changeTick
    ) {
      throw new Error('change-detection capture preparation lost ECS evidence: ' + JSON.stringify({ before, after }));
    }
  };
  host.__bevyChangeDetectionReady = true;
}
