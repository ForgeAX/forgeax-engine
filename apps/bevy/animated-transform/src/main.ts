import { createApp } from '@forgeax/engine-app/browser';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { quat } from '@forgeax/engine-math';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildAnimatedTransformWorld,
  TRANSFORM_CLIP_GUID,
  transformClip,
  replayAnimatedTransform,
  setAnimatedTransformPaused,
  setAnimatedTransformSpeed,
} from './animated-transform';

declare global {
  var __bevyAnimatedTransformEvidence:
    | { running: boolean; motion: boolean; isolation: boolean }
    | undefined;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-animated-transform: missing canvas');

bootstrap(canvas).catch((error: unknown) => {
  console.error('[bevy-animated-transform] bootstrap failed:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const created = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!created.ok) throw created.error;
  const app = created.value;
  const clip = transformClip();
  if (app.assets === undefined) throw new Error('bevy-animated-transform: assets unavailable');
  app.assets.catalog(TRANSFORM_CLIP_GUID, clip).unwrap();
  const demo = buildAnimatedTransformWorld(app.world, clip);

  const materials = [
    app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.2, 0.6, 1, 1] }),
    ),
    app.world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 0.45, 0.15, 1] }),
    ),
  ] as const;
  for (let instanceIndex = 0; instanceIndex < demo.instances.length; instanceIndex++) {
    const instance = demo.instances[instanceIndex];
    const material = materials[instanceIndex];
    if (!instance || !material) continue;
    for (const entity of [instance.planet, instance.satellite]) {
      app.world
        .addComponent(entity, { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } })
        .unwrap();
      app.world
        .addComponent(entity, { component: MeshRenderer, data: { materials: [material] } })
        .unwrap();
    }
  }
  app.world.spawn({
    component: DirectionalLight,
    data: { castShadow: true, direction: [-0.5, -0.8, -0.4], color: [1, 1, 1], intensity: 3 },
  });
  const eye: [number, number, number] = [10, 8, 16];
  app.world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 2, 0], [0, 1, 0]) },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  document.querySelector('#pause')?.addEventListener('click', () => {
    setAnimatedTransformPaused(app.world, demo, 'direct', true);
  });
  document.querySelector('#resume')?.addEventListener('click', () => {
    setAnimatedTransformPaused(app.world, demo, 'direct', false);
  });
  document.querySelector('#replay')?.addEventListener('click', () => {
    replayAnimatedTransform(app.world, demo, 'direct');
    replayAnimatedTransform(app.world, demo, 'graph');
  });
  document.querySelector('#speed')?.addEventListener('input', (event) => {
    const speed = Number((event.currentTarget as HTMLInputElement).value);
    setAnimatedTransformSpeed(app.world, demo, 'direct', speed);
    setAnimatedTransformSpeed(app.world, demo, 'graph', speed);
  });

  setAnimatedTransformPaused(app.world, demo, 'direct', true);
  const directStart = app.world.get(demo.instances[0].planet, Transform).unwrap().pos[1] ?? 0;
  const graphStart = app.world.get(demo.instances[1].planet, Transform).unwrap().pos[1] ?? 0;
  globalThis.__bevyAnimatedTransformEvidence = {
    running: true,
    motion: false,
    isolation: false,
  };
  const started = app.start();
  if (!started.ok) throw started.error;

  window.setTimeout(() => {
    const directEnd = app.world.get(demo.instances[0].planet, Transform).unwrap().pos[1] ?? 0;
    const graphEnd = app.world.get(demo.instances[1].planet, Transform).unwrap().pos[1] ?? 0;
    const motion = Math.abs(graphEnd - graphStart) > 0.05;
    const isolation = Math.abs(directEnd - directStart) < 1e-4 && motion;
    globalThis.__bevyAnimatedTransformEvidence = { running: true, motion, isolation };
    setAnimatedTransformPaused(app.world, demo, 'direct', false);
    console.warn(
      `[bevy-animated-transform] running=1 motion=${motion ? 1 : 0} isolation=${isolation ? 1 : 0}`,
    );
  }, 500);
}
