import { createApp } from '@forgeax/engine-app/browser';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { assertMaterialAsset, type MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackage from './shader-defs.pack.json';
import redMaterialPackage from './shader-defs-red.pack.json';
import './shader-defs.wgsl';
import './shader-defs-red.wgsl';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';


const authoredPayload = materialPackage.assets[0]?.payload;
assertMaterialAsset(authoredPayload, 'shader-defs.pack.json');
const authoredMaterial: MaterialAsset = authoredPayload;
const redAuthoredPayload = redMaterialPackage.assets[0]?.payload;
assertMaterialAsset(redAuthoredPayload, 'shader-defs-red.pack.json');
const redAuthoredMaterial: MaterialAsset = redAuthoredPayload;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-defs: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!appResult.ok) {
    console.error('[bevy-shader-defs] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const geometry = createBoxGeometry(1, 1, 1);
  if (!geometry.ok) {
    console.error('[bevy-shader-defs] createBoxGeometry failed:', geometry.error);
    return;
  }
  const mesh = assets.create(geometry.value).unwrap();
  const texture = assets.create({
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: 2, height: 2 },
    },
    format: 'rgba8unorm',
    data: new Uint8Array([
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  }).unwrap();
  const blue = makeMaterial(app.world, authoredMaterial, [0.05, 0.25, 1], texture);
  const red = makeMaterial(app.world, redAuthoredMaterial, [0.05, 1, 0.1], texture);

  app.world.spawn(
    { component: Transform, data: { pos: [-0.9, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [blue] } },
  );
  app.world.spawn(
    { component: Transform, data: { pos: [0.9, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [red] } },
  );
  app.world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: target.width / Math.max(target.height, 1), near: 0.1, far: 100 }) },
  );
  app.world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
  });

  app.onError((error) => console.error('[bevy-shader-defs] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-shader-defs] app.start failed:', started.error);
}

function makeMaterial(
  world: import('@forgeax/engine-ecs').World,
  sourceMaterial: MaterialAsset,
  baseColor: readonly [number, number, number],
  texture: import('@forgeax/engine-types').AssetHandle<'texture'>,
): import('@forgeax/engine-types').AssetHandle<'material'> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  if (sourceMaterial.parent !== undefined) {
    throw new Error('shader-defs material child cannot override the root pass');
  }
  const [authoredPass] = sourceMaterial.passes ?? [];
  if (authoredPass === undefined) throw new Error('shader-defs material pack has no pass');
  const material = {
    ...sourceMaterial,
    passes: [{
      ...authoredPass,
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    }],
    values: { baseColor: [...baseColor, 1], time: 0, speed: 1, baseColorTexture: texture },
  } satisfies MaterialAsset;
  return sceneAssets.create(material).unwrap();
}
