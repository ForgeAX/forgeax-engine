// apps/bevy/texture/src/main.ts — reproduction of Bevy's `texture` example.
//
// Bevy source (references/repos/bevy/examples/3d/texture.rs): "various ways
// to configure texture materials in 3D" — 3 textured quads with baseColorTexture.

import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTextureWorld, CHECKER_SIZE, makeCheckerboardPixels } from './texture';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-texture: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-texture] no usable backend:', err);
  } else {
    console.error('[bevy-texture] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-texture] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-texture] state=${app.renderer.inspect().state}`);

  const checkerPixels = makeCheckerboardPixels();
  const texPod = {
    kind: 'texture' as const,
    width: CHECKER_SIZE,
    height: CHECKER_SIZE,
    format: 'rgba8unorm-srgb' as const,
    data: checkerPixels,
    colorSpace: 'srgb' as const,
    mipmap: false,
  };
  const texHandle = app.world.allocSharedRef('TextureAsset', texPod);
  const texId = unwrapHandle(texHandle);


  buildTextureWorld(app.world, texId);

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-texture] app.start failed:', started.error);
  }
}
