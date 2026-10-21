// apps/hello/gltf — feat-20260515-gltf-loader-via-asset-system M5 / w22.
//
// End-to-end proof that the gltf importer pipeline lands inside the same
// loadByGuid<SceneAsset> + sceneInstances.instantiate spine the hello-room
// app uses (charter P4 consistent abstraction; plan-strategy section 3.2
// sequence B). The only difference vs hello-room: instead of authoring
// .pack.json files by hand, the disk schema sidecar (<source>.meta.json)
// comes from `forgeax asset import box.gltf` and the runtime
// pipes the .gltf source through `parseGltf` + a small IR -> POD adapter.
//
// 4-step recipe (plan-strategy section 3.2 sequence B; AC-07 / AC-14):
//   (1) configureRuntimeAssetCatalog(assets, runtimeBinding) — selects the
//       scoped dev catalog or the static production catalog emitted by
//       vite-plugin-pack.
//   (2) loadByGuid<MeshAsset>(meshGuid)        — Tier-B cube positions + indices
//   (3) loadByGuid<MaterialAsset>(matGuid)     — UnlitMaterial baseColor scalar
//   (4) loadByGuid<SceneAsset>(sceneGuid)      — single Box node + Camera node
//       + sceneInstances.instantiate(handle, world)
//
// The gltf parser is a pure function (parseGltf(json, externalLoader));
// callers feed it the JSON document plus a loader for non-data: buffer URIs.
// The fixture box.gltf embeds its single buffer as a data: URI so the
// externalLoader never fires (it throws if invoked).

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
// vite resolves these at build / dev time — JSON for the meta sidecar
// (committed alongside box.gltf via `forgeax asset import`),
// raw URL for the .gltf source so the runtime can fetch + JSON.parse it.
import metaJson from '../assets/box.gltf.meta.json' with { type: 'json' };
import { AssetRegistry } from '@forgeax/engine-assets-runtime';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-gltf: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[gltf] no usable backend:', err);
  else console.error('[gltf] bootstrap error:', err);
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
  console.warn('[gltf] Standard pipeline active');

  // Step (1): choose the scoped dev catalog or the static production catalog.
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
  if (sceneEntry === undefined) throw new Error('gltf: scene source missing');
  const scene = (await assets.load(assets.parseGuid(sceneEntry.guid), 'scene')).unwrap();
  const instance = assets.instantiate(scene, world);
  assets.release(scene).unwrap();
  instance.unwrap();

  const frame = (): void => {
    void worldContext;
    world.update().unwrap();
    const r = renderer.draw(frameRequest);
    if (!r.ok) console.error('[gltf] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
