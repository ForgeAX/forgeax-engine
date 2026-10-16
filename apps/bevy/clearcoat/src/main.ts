import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type EquirectAsset } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildClearcoatWorld } from './clearcoat';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-clearcoat: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-clearcoat] no usable backend:', error);
  else console.error('[bevy-clearcoat] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = {
    ...forgeaxBundlerAdapter(),
    ...(runtimeBinding === undefined
      ? {}
      : { importTransport: createRuntimeAssetImportTransport(runtimeBinding) }),
  };
  const result = await createApp(target, {}, bundler);
  if (!result.ok) {
    console.error('[bevy-clearcoat] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[bevy-clearcoat] assets unavailable');
    return;
  }
  const guid = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guid.ok) {
    console.error('[bevy-clearcoat] HDR GUID failed:', guid.error.code);
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const hdr = await assets.loadByGuid<EquirectAsset>(guid.value);
  if (!hdr.ok) {
    console.error('[bevy-clearcoat] HDR load failed:', hdr.error.code);
    return;
  }
  const equirect = app.world.allocSharedRef('EquirectAsset', hdr.value);
  await buildClearcoatWorld(app.world, assets, equirect, target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-clearcoat] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-clearcoat] app.start failed:', started.error);
}
