import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpecularTintWorld } from './specular-tint';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const SPECULAR_TINT_GUID = '019e3969-1d46-79d1-9d22-ffd8c6859c64';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-specular-tint: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-specular-tint] no usable backend:', error);
  else console.error('[bevy-specular-tint] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = {
    ...forgeaxBundlerAdapter(),
    ...(runtimeBinding === undefined
      ? {}
      : { importTransport: createRuntimeAssetImportTransport(runtimeBinding) }),
  };
  const result = await createApp(target, {}, bundler);
  if (!result.ok) { console.error('[bevy-specular-tint] createApp failed:', result.error); return; }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) { console.error('[bevy-specular-tint] assets unavailable'); return; }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const hdrGuid = AssetGuid.parse(NEWPORT_LOFT_GUID);
  const tintGuid = AssetGuid.parse(SPECULAR_TINT_GUID);
  if (!hdrGuid.ok || !tintGuid.ok) { console.error('[bevy-specular-tint] asset GUID parse failed'); return; }
  const hdr = await assets.load(hdrGuid.value, 'equirect');
  const tint = await assets.load(tintGuid.value, 'texture');
  if (!hdr.ok) { console.error('[bevy-specular-tint] HDR load failed:', hdr.error.code); return; }
  if (!tint.ok) { console.error('[bevy-specular-tint] texture load failed:', tint.error.code); return; }
  const equirect = hdr.value;
  const specularColorTexture = tint.value;
  buildSpecularTintWorld(app.world, equirect, specularColorTexture, target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-specular-tint] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-specular-tint] app.start failed:', started.error);
}
