import { RuntimeMaterialValue } from '@forgeax/engine-assets-runtime';
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './animate-shader.wgsl';

const SHADER_ID = 'bevy::animate_shader';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-animate-shader: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!result.ok) {
    console.error('[bevy-animate-shader] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const geometry = createBoxGeometry(1, 1, 1);
  if (!geometry.ok) {
    console.error('[bevy-animate-shader] createBoxGeometry failed:', geometry.error);
    return;
  }
  const mesh = app.world.allocSharedRef('MeshAsset', geometry.value);
  const material = app.world.allocSharedRef('MaterialAsset', makeMaterial());
  const timeValue = app.world.spawn({ component: RuntimeMaterialValue, data: { asset: material, parameter: 'time', value: [0] } }).unwrap();
  app.world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  );

  const eye: [number, number, number] = [-2, 2.5, 5];
  app.world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.5, 0], [0, 1, 0]) } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: target.width / Math.max(target.height, 1) }) },
  );
  app.world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
  });

  app.world.addSystem(Update, {
    name: 'animate-shader-time',
    queries: [],
    fn: (world) => {
      const time = world.hasResource('Time')
        ? world.getResource<{ elapsed: number }>('Time').elapsed
        : 0;
      world.set(timeValue, RuntimeMaterialValue, { value: [time] }).unwrap();
    },
  });
  app.onError((error) => console.error('[bevy-animate-shader] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-animate-shader] app.start failed:', started.error);
}

function makeMaterial(): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: SHADER_ID }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { time: 0 },
  };
}
