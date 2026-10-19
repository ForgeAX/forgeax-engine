// apps/hello/fbx-cube -- feat-20260615-fbx-importer-via-sdk M3 t36 R2 fixup #2.
//
// End-to-end declare-import-load via fbxImporter through the build-time
// vite-plugin-pack pipeline:
//   (1) configureRuntimeAssetCatalog(assets, runtimeBinding) — scoped dev or static build catalog
//   (2) createRuntimeAssetImportTransport(runtimeBinding)             — dev-server POST /__import/:guid
//                                                     dispatches to fbxImporter
//   (3) loadByGuid<SceneAsset>(sceneGuid)           — runtime resolves the GUID
//                                                     and instantiates
//
// The .fbx fixture lives in forgeax-engine-assets/vendor/fbx-test/ per the
// engine repo's zero-binary invariant. pluginPack scans that directory
// for cube.fbx + cube.fbx.meta.json (see vite.config.ts).
//
// AC-15: this is the full declare-import-load (no registerWithGuid shortcut).

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import { type SceneAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// Scene GUID from forgeax-engine-assets/vendor/fbx-test/cube.fbx.meta.json.
const SCENE_GUID = '019ecd87-179b-773b-8679-4ee436fdd878';

const CLEAR_R = 0.1;
const CLEAR_G = 0.1;
const CLEAR_B = 0.15;
const CLEAR_A = 1.0;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-fbx-cube: missing <canvas id="app">');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[fbx-cube] env:', err);
  else console.error('[fbx-cube] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[fbx-cube] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world: World = app.world;
  console.warn('[fbx-cube] Standard pipeline active');

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[hello-fbx-cube] asset owner unavailable');
    return;
  }
  if (assets === null) {
    console.error('[fbx-cube] AssetRegistry is null');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const sceneGuidRes = AssetGuid.parse(SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[fbx-cube] AssetGuid.parse(scene) failed:', sceneGuidRes.error);
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuidRes.value);
  if (!sceneRes.ok) {
    console.error('[fbx-cube] loadByGuid<SceneAsset> failed:', sceneRes.error);
    return;
  }

  // feat-20260614 M8 (D-17): loadByGuid returns the payload; mint a user-tier
  // column handle for instantiate.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    console.error(
      '[fbx-cube] scene instantiate failed:',
      (instRes.error as { code: string }).code,
    );
    return;
  }
  const root: EntityHandle = instRes.value;

  // Camera + directional light (not in the FBX scene).
  const aspect = target.clientWidth / target.clientHeight;
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 30], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 100 }),
        clearColor: [CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A],
      },
    },
  );
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [-0.5, -1, -0.3],
      color: [1, 1, 1],
      intensity: 1,
    },
  });

  console.warn(`[fbx-cube] cube.fbx scene root entity=${root}`);

  app.start();
}
