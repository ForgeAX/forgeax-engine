// Managed Font loading and native GlyphText rendering with depth and HDR tint.
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';


import { Transform } from '@forgeax/engine-scene';

import { BLOOM_ENABLED, perspective, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import {
  FONT_GUID,
  spawnTextScenes,
} from './text-scenes.js';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();



const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[text] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[text] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[text] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[text] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const assets = app.assets;
  if (assets === undefined || assets === null) {
    console.error('[text] AssetRegistry is unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;

  const fontGuidParsed = AssetGuid.parse(FONT_GUID);
  if (!fontGuidParsed.ok) {
    console.error('[text] FONT_GUID parse failed:', fontGuidParsed.error.code);
    return;
  }
  const fontHandleRes = await assets.load(fontGuidParsed.value, 'font');
  if (!fontHandleRes.ok) {
    console.error(
      '[text] Font load failed:',
      fontHandleRes.error.code,
      fontHandleRes.error.hint,
    );
    return;
  }
  const fontHandle = fontHandleRes.value;

  spawnTextScenes(world, fontHandle);

  // A grey cube placed BETWEEN the camera and scene (d)'s text to exercise
  // depth occlusion (AC-11). The cube needs a standard material.
  const cubeMat = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: { baseColor: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 },
  }).unwrap();
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [2.2, -1.0, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5]},
      },
      { component: MeshFilter, data: { assetHandle: assets.create(BUILTIN_CUBE).unwrap() } },
      { component: MeshRenderer, data: { materials: [cubeMat] } },
    )
    .unwrap();

  world
    .spawn({
      component: DirectionalLight,
      data: { castShadow: true,
        direction: [-0.3, -0.5, -0.8],
        color: [1, 1, 1],
        intensity: 1.2,
      },
    })
    .unwrap();

  // Camera with HDR tonemap + bloom enabled so scene (c)'s >1.0 text feeds the
  // Bloom extraction (AC-12).
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8]} },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
          tonemap: TONEMAP_REINHARD_EXTENDED,
          bloom: BLOOM_ENABLED,
          bloomThreshold: 1.0,
          bloomIntensity: 1.0,
          bloomSmoothWidth: 0.01,
          bloomRadius: 0,
        },
      },
    )
    .unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[text] running. Four world-space text scenes spawned.');
}

function reportAppError(err: CanvasAppError | EngineEnvironmentError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[text] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[text] ${err.code}: ${err.hint}`);
}
