import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildContiguousQueryWorld, readContiguousQueryState } from './contiguous-query.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-contiguous-query: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-contiguous-query] no usable backend:', error);
  else console.error('[bevy-contiguous-query] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) { console.error('[bevy-contiguous-query] createApp failed:', result.error); return; }
  const app = result.value;
  const state = buildContiguousQueryWorld(app.world);
  const started = app.start();
  if (!started.ok) { console.error('[bevy-contiguous-query] app.start failed:', started.error); return; }
  const host = globalThis as {
    __bevyContiguousQueryReady?: boolean;
    __bevyContiguousQueryState?: () => ReturnType<typeof readContiguousQueryState>;
  };
  host.__bevyContiguousQueryState = () => readContiguousQueryState(state);
  host.__bevyContiguousQueryReady = true;
}
