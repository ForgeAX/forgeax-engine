import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import type { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialValue } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './parallax.wgsl';

const SHADER_ID = 'bevy::parallax_mapping';
const TEXTURE_GUIDS = {
  diffuse: '019e3969-1d45-744f-8269-e1b1c6e6a8cf',
  normal: '019e3969-1d45-7020-8756-675a0f885532',
  height: '019e3969-1d45-7d3e-9bc8-55fcdc87beab',
} as const;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-parallax-mapping: missing <canvas id="app"> in index.html');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appResult.ok) {
    console.error('[bevy-parallax-mapping] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
const demoPrimitive = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
  if (assets === undefined) {
    console.error('[bevy-parallax-mapping] asset owner unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const textureHandles = await loadTextures(app.world, assets);
  if (textureHandles === null) return;

  const materials = [0, 1, 2].map((algoMode) => {
    const values: Record<string, MaterialValue> = {
      baseColor: [1, 1, 1, 1],
      heightScale: 0.1,
      algoMode,
      baseColorTexture: textureHandles.diffuse,
      normalTexture: textureHandles.normal,
      heightTexture: textureHandles.height,
    };
    return assets.create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: SHADER_ID }, renderState: { tags: { LightMode: 'Forward' } } }],
      parameters: [
        { name: 'baseColor', type: 'color' },
        { name: 'heightScale', type: 'f32' },
        { name: 'algoMode', type: 'f32' },
        { name: 'baseColorTexture', type: 'texture' },
        { name: 'normalTexture', type: 'texture' },
        { name: 'heightTexture', type: 'texture' },
      ],
      values,
    }).unwrap();
  });

  const labels = ['basic', 'steep', 'POM'];
  for (let i = 0; i < materials.length; i += 1) {
    app.world.spawn(
      { component: Transform, data: { pos: [(i - 1) * 2.25, 0, 0], scale: [1.85, 1.85, 1] } },
      { component: MeshFilter, data: { assetHandle: demoPrimitive } },
      { component: MeshRenderer, data: { materials: [materials[i]!] } },
    );
    console.info(`[bevy-parallax-mapping] panel=${labels[i]} heightScale=0.1`);
  }

  const eye: [number, number, number] = [0, 0, 8];
  app.world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -0.5, -1], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
  app.world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: target.width / Math.max(target.height, 1) }) },
  );

  app.onError((error) => console.error('[bevy-parallax-mapping] app error:', error.code, error.hint));
  console.info('[bevy-parallax-mapping] Standard pipeline active');
  const started = app.start();
  if (!started.ok) console.error('[bevy-parallax-mapping] app.start failed:', started.error);
}

async function loadTextures(
  world: World,
  assets: AssetRegistry,
): Promise<{ diffuse: number; normal: number; height: number } | null> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const diffuseGuid = AssetGuid.parse(TEXTURE_GUIDS.diffuse);
  const normalGuid = AssetGuid.parse(TEXTURE_GUIDS.normal);
  const heightGuid = AssetGuid.parse(TEXTURE_GUIDS.height);
  if (!diffuseGuid.ok || !normalGuid.ok || !heightGuid.ok) {
    console.error('[bevy-parallax-mapping] texture GUID parse failed');
    return null;
  }

  const diffuse = await assets.load(diffuseGuid.value, 'texture');
  const normal = await assets.load(normalGuid.value, 'texture');
  const height = await assets.load(heightGuid.value, 'texture');
  if (!diffuse.ok || !normal.ok || !height.ok) {
    console.error('[bevy-parallax-mapping] texture loading failed');
    return null;
  }

  return {
    diffuse: diffuse.value,
    normal: normal.value,
    height: height.value,
  };
}
