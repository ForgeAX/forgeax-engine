import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type EquirectAsset } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSkyboxWorld } from './skybox';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-skybox: missing <canvas id="app" in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-skybox] no usable backend:', error);
  } else {
    console.error('[bevy-skybox] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) };
  const appResult = await createApp(target, {}, bundler);
  if (!appResult.ok) {
    console.error('[bevy-skybox] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[bevy-skybox] asset owner is unavailable');
    return;
  }
  const guidResult = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidResult.ok) {
    console.error('[bevy-skybox] HDR GUID parse failed:', guidResult.error.code);
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const hdrResult = await assets.loadByGuid<EquirectAsset>(guidResult.value);
  if (!hdrResult.ok) {
    console.error('[bevy-skybox] HDR load failed:', hdrResult.error.code, hdrResult.error.hint);
    return;
  }

  const equirect = app.world.allocSharedRef('EquirectAsset', hdrResult.value);
  buildSkyboxWorld(app.world, equirect, target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-skybox] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-skybox] app.start failed:', started.error);
    return;
  }
  console.warn('[bevy-skybox] skybox active: Newport Loft HDR equirect');
}
