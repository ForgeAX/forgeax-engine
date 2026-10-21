// apps/hello/gltf-instancing - feat-20260518 M5 demo.
//
// Loads a Tier-B box mesh with EXT_mesh_gpu_instancing N=4 + per-node
// Name='InstancedBox'. Single SceneEntity carries MeshFilter + MeshRenderer
// + Instances + Name + Transform; the RenderSystem records one instanced
// drawcall (instanceCount === 4).
//
// 4-step recipe (mirrors apps/hello/gltf):
//   (1) configureRuntimeAssetCatalog(assets, runtimeBinding)
//   (2) loadByGuid<MeshAsset>(meshGuid)
//   (3) loadByGuid<MaterialAsset>(matGuid)
//   (4) loadByGuid<SceneAsset>(sceneGuid) + sceneInstances.instantiate

import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createWorldContext, World } from '@forgeax/engine-ecs';

import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { renderComponentsPlugin } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import metaJson from '../assets/instanced-box.gltf.meta.json' with { type: 'json' };
import { AssetRegistry } from '@forgeax/engine-assets-runtime';



const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-gltf-instancing: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[gltf-instancing] no usable backend:', err);
  else console.error('[gltf-instancing] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(
    target,
    {},
    {
      ...forgeaxBundlerAdapter(),
      importTransport: createRuntimeAssetImportTransport(runtimeBinding),
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer, assets } = constructed.value;
  console.warn('[gltf-instancing] Standard pipeline active');

  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = new World({ assets: assets });
  const sceneAssets = world.assets;
  if (!(sceneAssets instanceof AssetRegistry))
    throw new Error('Scene requires its runtime asset owner');


  const worldContext = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  const sceneEntry = metaJson.subAssets.find((row) => row.kind === 'scene');
  if (sceneEntry === undefined) throw new Error('gltf-instancing: scene source missing');
  const scene = (await assets.load(assets.parseGuid(sceneEntry.guid), 'scene')).unwrap();
  const instance = assets.instantiate(scene, world);
  assets.release(scene).unwrap();
  instance.unwrap();

  const frame = (): void => {
    void worldContext;
    world.update().unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error('[gltf-instancing] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
