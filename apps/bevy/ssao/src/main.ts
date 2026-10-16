import { createApp } from '@forgeax/engine-app/browser';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSsaoWorld } from './ssao';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-ssao: missing <canvas id="app">');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    {
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: 'deferred',
        ssao: true,
      },
    },
    forgeaxBundlerAdapter(),
  );
  if (!result.ok) {
    console.error('[bevy-ssao] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const scene = buildSsaoWorld(app.world, target.width / Math.max(target.height, 1));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-ssao] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  Object.assign(globalThis, {
    __bevySsaoReady: true,
    __bevySsaoState: {
      enabled: true,
      meshCount: scene.meshCount,
      pipeline: DEFAULT_STANDARD_PROFILE.pipelineId,
    },
  });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-ssao] bootstrap error:', error));
