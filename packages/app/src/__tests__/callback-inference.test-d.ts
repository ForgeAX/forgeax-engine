import { animationPlugin } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { Camera, perspective, type Renderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { createApp } from '../create-app';
import { testPlatform } from './platform-fixture';

const plugin: Plugin = animationPlugin();
void plugin;

declare const canvas: HTMLCanvasElement;
declare const renderer: Renderer;

const world = new World();
const cameraEntity = world
  .spawn({ component: Camera, data: perspective({ fov: 1, aspect: 1 }) })
  .unwrap();
const camera = world.get(cameraEntity, Camera).unwrap();
camera.projection;
const appResult = createApp({ platform: testPlatform(), renderer, world, plugins: [plugin] });
appResult.then((result) => {
  if (result.ok) {
    result.value.start();
  }
});

createRenderer(canvas).then((created) => {
  if (!created.ok) return;
  const attached = created.value.attach(world);
  if (!attached.ok) return;
  void created.value.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
});
