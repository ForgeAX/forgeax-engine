import { createApp } from '@forgeax/engine-app/browser';
import { unwrapHandle } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildMesh2dAlphaModeWorld, makeAlphaModePixels, TEXTURE_SIZE } from './mesh2d-alpha-mode.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-mesh2d-alpha-mode: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-mesh2d-alpha-mode] no usable backend:', error);
  else console.error('[bevy-mesh2d-alpha-mode] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-mesh2d-alpha-mode] createApp failed:', appResult.error);
  const app = appResult.value;
  const pixels = makeAlphaModePixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const handle = app.world.allocSharedRef('TextureAsset', texture);
  buildMesh2dAlphaModeWorld(app.world, unwrapHandle(handle));
  const started = app.start();
  if (!started.ok) return console.error('[bevy-mesh2d-alpha-mode] app.start failed:', started.error);
  (globalThis as { __bevyMesh2dAlphaModeReady?: boolean }).__bevyMesh2dAlphaModeReady = true;
}
