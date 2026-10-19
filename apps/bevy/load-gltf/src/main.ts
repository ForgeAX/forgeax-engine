// Reproduce Bevy's `gltf/load_gltf` example through the canonical glTF asset path.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import {
  gltfDocToSceneAsset,
  meshIrToMeshAsset,
  parseGltf,
  toMaterialAsset,
} from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { DirectionalLight } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset, SceneAsset } from '@forgeax/engine-types';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import boxGltfUrl from '../../../hello/gltf/assets/box.gltf?url';
import metaJson from '../../../hello/gltf/assets/box.gltf.meta.json' with { type: 'json' };

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('bevy-load-gltf: missing canvas');

type SubAsset = { readonly guid: string; readonly kind: string };
type WindowEvidence = Window & { __bevyLoadGltfReady?: boolean };

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    { pointerLockAllowed: () => false },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appResult.ok) {
    const message = appResult.error instanceof EngineEnvironmentError
      ? 'no usable rendering backend'
      : `${appResult.error.code}: ${appResult.error.hint}`;
    console.error(`[bevy-load-gltf] createApp failed: ${message}`);
    return;
  }

  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[bevy-load-gltf] assets unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;

  const source = await fetch(boxGltfUrl);
  const docResult = await parseGltf(
    (await source.json()) as unknown,
    async (uri) => {
      throw new Error(`bevy-load-gltf: unexpected external buffer ${uri}`);
    },
    boxGltfUrl,
  );
  if (!docResult.ok) {
    console.error(`[bevy-load-gltf] parseGltf failed: ${docResult.error.code}`);
    return;
  }
  const doc = docResult.value;
  const subAssets = metaJson.subAssets as readonly SubAsset[];
  const meshGuid = readGuid(subAssets, 'mesh');
  const materialGuid = readGuid(subAssets, 'material');
  const sceneGuid = readGuid(subAssets, 'scene');
  if (meshGuid === null || materialGuid === null || sceneGuid === null) {
    console.error('[bevy-load-gltf] glTF sidecar is missing mesh/material/scene GUIDs');
    return;
  }

  const meshResult = meshIrToMeshAsset(doc.meshes);
  if (!meshResult.ok) {
    console.error(`[bevy-load-gltf] mesh bridge failed: ${meshResult.error.code}`);
    return;
  }
  const mesh = meshResult.value;
  const materialIr = doc.materials[0];
  if (materialIr === undefined) {
    console.error('[bevy-load-gltf] glTF has no material');
    return;
  }
  const material = toMaterialAsset(materialIr);
  assets.catalog<MeshAsset>(meshGuid, mesh);
  assets.catalog<MaterialAsset>(materialGuid, material);
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const materialHandle = world.allocSharedRef('MaterialAsset', material);
  const scene = gltfDocToSceneAsset(doc, {
    meshHandles: new Map([[0, meshHandle]]),
    materialHandles: new Map([[0, materialHandle]]),
  });
  assets.catalog<SceneAsset>(sceneGuid, scene);

  const sceneResult = await assets.loadByGuid<SceneAsset>(sceneGuid);
  if (!sceneResult.ok) {
    console.error(`[bevy-load-gltf] loadByGuid<SceneAsset> failed: ${sceneResult.error.code}`);
    return;
  }
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneResult.value);
  const instanceResult = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instanceResult.ok) {
    console.error(`[bevy-load-gltf] instantiate failed: ${instanceResult.error.code}`);
    return;
  }

  world.spawn(
    { component: Transform, data: { pos: [1.5, 2.5, 2.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: DirectionalLight, data: { castShadow: true, direction: [-0.4, -1, -0.3], intensity: 3 } },
  );
  const started = app.start();
  if (!started.ok) {
    console.error(`[bevy-load-gltf] app.start failed: ${started.error.code}`);
    return;
  }
  (window as WindowEvidence).__bevyLoadGltfReady = true;
  console.warn('[bevy-load-gltf] real glTF SceneAsset instantiated and running');
}

function readGuid(subAssets: readonly SubAsset[], kind: string): AssetGuid | null {
  const entry = subAssets.find((candidate) => candidate.kind === kind);
  if (entry === undefined) return null;
  const result = AssetGuid.parse(entry.guid);
  return result.ok ? result.value : null;
}
