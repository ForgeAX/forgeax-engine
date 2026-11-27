import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/devkit/plugin-build';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import type { Plugin } from '@forgeax/engine/plugin';
import { Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';
import {
  cameraOnPath,
  cameraTransform,
  spawnCamera,
  spawnLight,
  spawnSponzaSky,
} from '../src/build-scene.ts';
import { diffuseGiFor, SPONZA } from '../src/scenes.ts';

const packageId = definePackageId('019fb37a-b02b-7a12-8b74-3c439f3a1e70');

export const sponzaBuild: Plugin = {
  name: 'sponza-player-build',
  provide: ['devkitAppOptions'],
  apply(ctx) {
    ctx.provide('devkitAppOptions', {
      configuration: {
        settings: {
          rendering: {
            renderPath: 'deferred',
            ibl: false,
            ambientOcclusion: { enabled: false },
            diffuseGi: diffuseGiFor('irradiance-field', SPONZA)!,
          },
        },
      },
    });
  },
};

export const sponzaPlayer: Plugin.Object<{ readonly scene: string }> = {
  name: 'sponza-player',
  inject: ['world', 'gameHost'],
  async apply(ctx, config) {
    const host = ctx.gameHost!;
    const renderer = host.renderer;
    const world = ctx.world;
    await ctx.effect(async function* () {
      const scene = (await host.assets.load(host.assets.parseGuid(config.scene), 'scene', { usage: 'render' })).unwrap();
      yield () => { host.assets.release(scene).unwrap(); };
      const root = host.assets.instantiate(scene, world).unwrap();
      yield () => { worldDespawnScene(world, root).unwrap(); };
      const light = spawnLight(world, SPONZA.light);
      yield () => { world.despawn(light).unwrap(); };
      const sky = spawnSponzaSky(world);
      yield () => { world.despawn(sky).unwrap(); };
      const size = host.drawingBufferSize?.();
      const camera = spawnCamera(world, SPONZA.camera, size ? size.width / size.height : 1);
      yield () => { world.despawn(camera).unwrap(); };
      const path = defineSystem({
        name: 'sponza-player-camera',
        queries: [],
        fn: () => {
          const time = world.getResource(Time).elapsed;
          const pose = cameraOnPath(SPONZA.camera, SPONZA.cameraAlt, (1 - Math.cos(time * 0.25)) / 2);
          world.set(camera, Transform, cameraTransform(pose)).unwrap();
        },
      });
      world.addSystem(Update, path).unwrap();
      yield () => { world.removeSystem(Update, path).unwrap(); };
      if (renderer === undefined) return;
      let observations = 0;
      let qualified = false;
      yield renderer.subscribe((event) => {
        if (event.kind !== 'frame-submitted' || qualified || ++observations % 30 !== 0) return;
        const gi = renderer.inspect({ fields: ['diffuseGi'] }).diffuseGi;
        if (
          gi === undefined ||
          !('gather' in gi) ||
          gi.gather !== 'irradiance-field' ||
          gi.state !== 'ready' ||
          gi.submittedFrames < 60 ||
          gi.traversal === undefined
        ) return;
        qualified = true;
        console.info('[forgeax.sponza.gi]', JSON.stringify({
          traversal: gi.traversal,
          fallback: gi.traversalFallback,
          acceleration: gi.acceleration,
          submittedFrames: gi.submittedFrames,
        }));
      });
    }, 'sponza-player/scene');
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId,
  build: () => ok({
    'plugin/build': {
      kind: 'plugin',
      module: { specifier: './sponza-player.pack.ts', export: 'sponzaBuild' },
    },
    'plugin/sponza': {
      kind: 'plugin',
      module: { specifier: './sponza-player.pack.ts', export: 'sponzaPlayer' },
      config: { scene: { $asset: SPONZA.sceneGuid } },
    },
  }),
});
