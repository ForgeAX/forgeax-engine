import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTextureAtlasWorld, makeAtlas, type AtlasTexture } from './texture-atlas';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-texture-atlas: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-texture-atlas] no usable backend:', error);
  else console.error('[bevy-texture-atlas] bootstrap failed:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-texture-atlas] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  console.warn(`[bevy-texture-atlas] backend=${app.renderer.inspect().capabilities.backendKind}`);
  const atlases = [makeAtlas('unpadding'), makeAtlas('padding'), makeAtlas('unpadding'), makeAtlas('padding')];
  const variants: Array<{ texture: number; atlas: AtlasTexture }> = [];
  for (let index = 0; index < atlases.length; index += 1) {
    const atlas = atlases[index]!;
    const texture = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: atlas.size, height: atlas.size } },
      format: 'rgba8unorm-srgb' as const,
      data: atlas.pixels,
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    };
    const textureHandle = assets.create(texture).unwrap();
    variants.push({ texture: textureHandle, atlas });
  }
  buildTextureAtlasWorld(app.world, variants);
  const started = app.start();
  if (!started.ok) { console.error('[bevy-texture-atlas] app.start failed:', started.error); return; }
  (globalThis as typeof globalThis & { __bevyTextureAtlasReady?: boolean }).__bevyTextureAtlasReady = true;
}
