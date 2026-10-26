# Content pack and composition

Copy the blocks you need to the named paths, then point `forge.json` `roots.engine` at the plugin asset:
`AssetGuid.format(AssetGuid.derive(PLAY_PACKAGE, 'plugin/engine'))`. Replace the package IDs with your own.
When replacing `assets/scene-owner.pack.ts` and `assets/world/`, update or remove the
starter-scene test in `assets/__tests__/empty-project.test.ts`; keep its manifest test
and add assertions for your new root GUIDs.

Each `install*` function registers its systems and yields or returns its inverse; the
plugin's `ctx.effect` generator runs those inverses on disposal and hot reload.

Meshes and materials are built at pack time and loaded by GUID at runtime. The plugin
spawns camera, lights and ground, then composes the recipes (`play.ts` shows the wiring of
every topic file; keep only the installs you use).

```ts file=assets/play/play.pack.ts
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok, RenderQueue } from '@forgeax/engine/types';
import { createBoxGeometry, createConeGeometry, createCylinderGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { Materials } from '@forgeax/engine/render';

export const PLAY_PACKAGE = definePackageId('3b1f6a52-8c0e-4d6b-9f1e-2a7c5d0e9b41');
const SPARK_PACKAGE = definePackageId('3b1f6a52-8c0e-4d6b-9f1e-2a7c5d0e9b42'); // spark.pack.json
const guid = (pkg: typeof PLAY_PACKAGE, key: string) => ({ $asset: AssetGuid.format(AssetGuid.derive(pkg, key)) });

export default definePack({
  schemaVersion: '2.0.0', plugins: true, packageId: PLAY_PACKAGE,
  build: ({ packageId }) => {
    const assets = {
      'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/ball': createSphereGeometry(0.5, 16, 12).unwrap(), // also Cylinder/Cone/Capsule/Torus/Plane: model what the request names
      'material/ground': Materials.standard({ baseColor: '#8f9ba3', roughness: 0.9 }),
            'material/lamp-off': Materials.standard({ baseColor: '#5a2a24', emissive: '#ff6826', emissiveIntensity: 0.1 }),
      'material/lamp-on': Materials.standard({ baseColor: '#ffb953', emissive: '#ff8229', emissiveIntensity: 6 }),
      'material/spark': Materials.standard({ baseColor: '#ff9a3c', emissive: '#ff7a1a', emissiveIntensity: 10 }),
      'mesh/cone': createConeGeometry(1, 1, 48, 1, true).unwrap(), // open-ended: apex +y 0.5, no base cap at -y 0.5
      'material/stone': Materials.standard({ baseColor: '#bdb6a8', roughness: 0.85 }),
      'material/particle-glow': Materials.unlit([1, 1, 1, 1], { queue: RenderQueue.Transparent, renderState: { // additive
        depthWriteEnabled: false, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } } }),
      'material/particle-haze': Materials.unlit([1, 1, 1, 1], { queue: RenderQueue.Transparent, renderState: { // alpha
        depthWriteEnabled: false, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } } }),
      'material/beam': Materials.standard({ // custom WGSL Surface (beam.surface.wgsl), additive, no depth write
        surfaceModule: 'play::beam_surface',
        parameters: [{ name: 'beamColor', type: 'color' }, { name: 'glow', type: 'f32' }],
        values: { beamColor: [1, 0.85, 0.6, 1], glow: 0.6 },
        renderState: { cullMode: 'none', depthWriteEnabled: false,
          blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } },
        queue: RenderQueue.Transparent,
      }),
      'mesh/pillar': createCylinderGeometry(0.2, 0.6, 1, 32, 1, true).unwrap(), // thin, tapered, open: no caps
      'material/pillar': Materials.standard({ // pillar.surface.wgsl; adds light, keeps the display sky's alpha
        surfaceModule: 'play::pillar_surface',
        parameters: [{ name: 'pillarColor', type: 'color' }, { name: 'glow', type: 'f32' }],
        values: { pillarColor: [0.3, 1, 0.8, 1], glow: 0.18 },
        renderState: { cullMode: 'none', depthWriteEnabled: false,
          blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } },
        queue: RenderQueue.Transparent,
      }),
      'material/water': Materials.standard({ // custom WGSL Surface (water.surface.wgsl); water.ts feeds lampPos, beamDir
        surfaceModule: 'play::water_surface',
        parameters: [{ name: 'deepColor', type: 'color' }, { name: 'shallowColor', type: 'color' },
          { name: 'beamColor', type: 'color' }, { name: 'lampPos', type: 'vec3' }, { name: 'beamDir', type: 'vec3' }],
        values: { deepColor: [0.01, 0.05, 0.08, 1], shallowColor: [0.06, 0.24, 0.3, 1],
          beamColor: [1, 0.85, 0.6, 1], lampPos: [0, 0, 0], beamDir: [1, 0, 0] },
      }),
    };
    const refs = Object.fromEntries(Object.keys(assets).map((key) => [key, guid(packageId, key)]));
    return ok({ ...assets,
      'plugin/engine': { kind: 'plugin' as const, module: { specifier: './play.ts', export: 'play' },
        config: { refs, spark: guid(SPARK_PACKAGE, 'vfx/spark') } },
    });
  },
});
```

```ts file=assets/play/play.ts
import type {} from '@forgeax/engine/app';
import type { Plugin } from '@forgeax/engine/plugin';
import { AmbientOcclusion, ANTIALIAS_TAA, BLOOM_ENABLED, Camera, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { loadVfxGpuEffect } from '@forgeax/engine/vfx';
import { installGrowth } from './growth.ts';
import { installProps } from './props.ts';
import { installBursts } from './burst.ts';
import { installLamps } from './lanterns.ts';
import { installLighthouse } from './lighthouse.ts';
import { installWater } from './water.ts';
import { installPillars } from './pillars.ts';
import { installParticles } from './particles.ts';
import { fire, smoke } from './particles-fire-smoke.ts';
import { spawnLighting } from './lighting.ts';

export const play: Plugin.Object<{ refs: Record<string, string>; spark: string }> = {
  name: 'play/engine', inject: ['world', 'assets'],
  async apply(ctx, { refs, spark }) {
    const { world } = ctx, assets = ctx.assets!;
    await ctx.effect(async function* () {
      const held: number[] = [];
      yield () => { for (const handle of held) assets.release(handle).unwrap(); };
      const load = async <K extends 'mesh' | 'material'>(kind: K, key: string) => {
        const handle = (await assets.load(refs[`${kind}/${key}`]!, kind)).unwrap();
        held.push(handle);
        return handle;
      };
      const [box, ball, ground, lampOff, lampOn] = await Promise.all([load('mesh', 'box'), load('mesh', 'ball'),
        load('material', 'ground'), load('material', 'lamp-off'), load('material', 'lamp-on')]);
      const [cone, stone, beam, water] = await Promise.all([load('mesh', 'cone'),
        load('material', 'stone'), load('material', 'beam'), load('material', 'water')]);
      const [glow, haze] = await Promise.all([load('material', 'particle-glow'), load('material', 'particle-haze')]);
      const [pillarMesh, pillar] = await Promise.all([load('mesh', 'pillar'), load('material', 'pillar')]);
      const effect = (await loadVfxGpuEffect(assets, spark)).unwrap();
      held.push(effect);
      const [camera, ...stage] = [
        world.spawn({ component: Transform, data: { pos: [0, 6, 14] } }, { component: Camera, data: { fov: 0.9,
          antialias: ANTIALIAS_TAA, bloom: BLOOM_ENABLED, bloomThreshold: 1, bloomIntensity: 0.3 } }, // only emissive > 1 glows
          { component: AmbientOcclusion, data: {} }), // GTAO contact darkening
        world.spawn({ component: Transform, data: { pos: [0, -0.5, 0], scale: [60, 1, 60] } },
          { component: MeshFilter, data: { assetHandle: box } }, { component: MeshRenderer, data: { materials: [ground] } }),
      ].map((spawned) => spawned.unwrap());
      yield () => { for (const entity of [camera!, ...stage]) world.despawn(entity).unwrap(); };
      yield spawnLighting(world, camera!, 'daylight'); // 'dusk', 'night' (lamps are the key light), 'overcast'
      const burst = yield* installBursts(world, effect);
      const lamps = yield* installLamps(world, [[-6, -6], [6, -6]], ball, lampOff, lampOn, burst);
      lamps.light(0); // switch a lamp on from game code
      const feedWater = yield* installWater(world, assets, box, water);
      yield installLighthouse(world, { box, ball, cone, stone, lamp: lampOn, beam }, feedWater);
      yield installPillars(world, pillarMesh, pillar, [[6, -8], [10, -4], [12, 2]]);
      yield* installProps(world, assets);
      yield* installGrowth(world, assets);
      const emit = yield* installParticles(world, assets, glow!, haze!);
      emit(fire, [-4, 0, 3]); // a brazier: fire plus its smoke
      emit(smoke, [-4, 0, 3]);
    }, 'play/engine');
  },
};
```
