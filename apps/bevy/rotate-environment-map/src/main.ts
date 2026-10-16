import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Time, Update } from '@forgeax/engine-ecs';
import { type EquirectAsset } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildEnvironmentWorld, stepEnvironmentRotation } from './rotate-environment-map';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-rotate-environment-map: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-rotate-environment-map] no usable backend:', error);
  else console.error('[bevy-rotate-environment-map] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) };
  const result = await createApp(target, {}, bundler);
  if (!result.ok) { console.error('[bevy-rotate-environment-map] createApp failed:', result.error); return; }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) { console.error('[bevy-rotate-environment-map] assets unavailable'); return; }
  const guid = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guid.ok) { console.error('[bevy-rotate-environment-map] HDR GUID failed:', guid.error.code); return; }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const hdr = await assets.loadByGuid<EquirectAsset>(guid.value);
  if (!hdr.ok) { console.error('[bevy-rotate-environment-map] HDR load failed:', hdr.error.code); return; }
  const equirect = app.world.allocSharedRef('EquirectAsset', hdr.value);
  const scene = buildEnvironmentWorld(app.world, equirect, target.width / Math.max(target.height, 1));
  app.world.addSystem(Update, {
    name: 'rotate-skybox-and-environment-map',
    queries: [],
    fn: (world) => stepEnvironmentRotation(world, scene, world.hasResource('Time') ? world.getResource<{ elapsed: number }>(Time).elapsed : 0),
  });
  app.onError((error) => console.error('[bevy-rotate-environment-map] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-rotate-environment-map] app.start failed:', started.error);
}
