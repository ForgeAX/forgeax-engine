import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { enginePreviewPlugin } from '@forgeax/engine-dsh/engine-preview';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('dsh-federation: missing canvas');

let cube: EntityHandle | undefined;
let app: App | undefined;
const result = await createApp(
  canvas,
  {
    plugins: [
      enginePreviewPlugin({
        control(state) {
          const next = state === 0 ? 1 : 0;
          if (cube !== undefined && app !== undefined) {
            app.world
              .set(cube, Transform, {
                pos: next === 0 ? [-0.75, 0, 0] : [0.75, 0, 0],
                scale: next === 0 ? [0.8, 0.8, 0.8] : [1.25, 1.25, 1.25],
              })
              .unwrap();
          }
          return next;
        },
      }),
    ],
  },
  forgeaxBundlerAdapter(),
);
if (!result.ok) throw result.error;

app = result.value;
const world = result.value.world;
cube = world
  .spawn(
    { component: Transform, data: { pos: [-0.75, 0, 0], scale: [0.8, 0.8, 0.8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
  )
  .unwrap();
world
  .spawn(
    { component: Transform, data: { pos: [0, 0, 3] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  )
  .unwrap();
world
  .spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -1, -0.3], color: [0.7, 1, 0.95], intensity: 1.5 },
  })
  .unwrap();

result.value.start().unwrap();

Object.assign(globalThis, {
  __forgeaxFederation: {
    status: () => ({ ready: true, entities: world.inspect().entityCount }),
    dispose: async () => {
      result.value.stop();
      await result.value.pluginContext.fiber.dispose();
    },
  },
});
