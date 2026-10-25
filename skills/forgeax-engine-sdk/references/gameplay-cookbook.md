# Gameplay cookbook for an `empty` project

One small, complete 3D game in copyable files: a WASD/jump character, a follow camera,
pushable crates, lanterns that switch on a point light, emissive material and a spark burst,
a lighthouse whose rotating spot light carries an additive beam over custom-shader water,
a brazier of fire and smoke particles (with rain, snow, dust and other presets), a DOM HUD,
and a state read for a keyboard playthrough test. The TypeScript `file=` blocks
compile against current Engine in a copy of `templates/empty` through
`pnpm test:sdk:contracts`; `scripts/forgeax/__tests__/sdk-gameplay-cookbook.test.mjs` also checks
the VFX package and material GUIDs and steps every particle preset through a real World. Use the same `@forgeax/engine/<dir>` imports in your game.

Copy the blocks to the named paths, then point `forge.json` at the two plugin assets:
`roots.engine` = `AssetGuid.format(AssetGuid.derive(PLAY_PACKAGE, 'plugin/engine'))` and
`roots.frontend` = the same for `'plugin/hud'`. Replace the package IDs with your own.
When replacing `assets/scene-owner.pack.ts` and `assets/world/`, update or remove the
starter-scene test in `assets/__tests__/empty-project.test.ts`; keep its manifest test
and add assertions for your new root GUIDs.

| Recipe | File | Owner skill for details |
|:--|:--|:--|
| 0. Content pack, composition and lighting presets | `play.pack.ts`, `play.ts`, `lighting.ts`, `desk-lamp.ts` | `forgeax-engine-assets`, `forgeax-engine-app`, `forgeax-engine-render-pipeline` |
| 1. Character controller (WASD + jump) | `player.ts` | `forgeax-engine-physics` |
| 2. Third-person follow camera | `follow-camera.ts` | `templates/game-3d/assets/camera/` adds mouse orbit |
| 3. Dynamic rigid-body boxes | `crates.ts` | `forgeax-engine-physics` |
| 4. Runtime point light + emissive swap | `lanterns.ts` | `forgeax-engine-render-pipeline`, `forgeax-engine-material` |
| 5. One-shot VFX burst | `spark.pack.json`, `spark.vfx.wgsl`, `burst.ts` | `forgeax-engine-vfx` |
| 6. DOM HUD bound to game state | `hud.ts` | `forgeax-engine-app` |
| 7. Game state for a playthrough test | `state.ts`, `scripts/playthrough.mjs` | `forgeax-engine-cli` |
| 8. Rotating spot light with an additive beam | `lighthouse.ts`, `beam.surface.wgsl` | `forgeax-engine-render-pipeline` |
| 9. Custom-shader water fed a uniform per frame | `water.ts`, `water.surface.wgsl` | `forgeax-engine-material`, `forgeax-engine-shader` |
| 10. Fade out one enemy (per-entity tint and opacity) | `fade.ts` | `forgeax-engine-material`, `forgeax-engine-assets` |
| 11. Board / diorama camera (orthographic, diagonal, fitted) | `board-camera.ts` | `forgeax-engine-render-pipeline` |
| 12. Particles: rain, snow, sparks, bubbles, dust, fire, smoke, magic | `particles.ts` | `forgeax-engine-vfx` (when to switch to GPU VFX) |

Each `install*` function registers its systems and yields or returns its inverse; the
plugin's `ctx.effect` generator runs those inverses on disposal and hot reload.

## 0. Content pack and composition

Meshes and materials are built at pack time and loaded by GUID at runtime. The plugin
installs Rapier, spawns camera, lights and ground, then composes the recipes.

```ts file=assets/play/play.pack.ts
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok, RenderQueue } from '@forgeax/engine/types';
import { createBoxGeometry, createConeGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
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
      'material/crate': Materials.standard({ baseColor: '#9a6f4f', roughness: 0.8 }),
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
      'plugin/hud': { kind: 'plugin' as const, module: { specifier: './hud.ts', export: 'hud' } },
    });
  },
});
```

```ts file=assets/play/play.ts
import type {} from '@forgeax/engine/app';
import { physicsPlugin, Collider, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import type { Plugin } from '@forgeax/engine/plugin';
import { AmbientOcclusion, ANTIALIAS_TAA, BLOOM_ENABLED, Camera, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { loadVfxGpuEffect } from '@forgeax/engine/vfx';
import { installGrowth } from './growth.ts';
import { installProps } from './props.ts';
import { installPlayer } from './player.ts';
import { installFollowCamera } from './follow-camera.ts';
import { spawnCrates } from './crates.ts';
import { installBursts } from './burst.ts';
import { installLanterns } from './lanterns.ts';
import { installState } from './state.ts';
import { installLighthouse } from './lighthouse.ts';
import { installWater } from './water.ts';
import { installParticles, PARTICLES } from './particles.ts';
import { spawnLighting } from './lighting.ts';

export const play: Plugin.Object<{ refs: Record<string, string>; spark: string }> = {
  name: 'play/engine', inject: ['world', 'assets', 'gameHost'],
  async apply(ctx, { refs, spark }) {
    await ctx.plugin(physicsPlugin('rapier-3d'));
    const { world } = ctx, assets = ctx.assets!;
    await ctx.effect(async function* () {
      const held: number[] = [];
      yield () => { for (const handle of held) assets.release(handle).unwrap(); };
      const load = async <K extends 'mesh' | 'material'>(kind: K, key: string) => {
        const handle = (await assets.load(refs[`${kind}/${key}`]!, kind)).unwrap();
        held.push(handle);
        return handle;
      };
      const [box, ball, ground, crate, lampOff, lampOn] = await Promise.all([load('mesh', 'box'), load('mesh', 'ball'),
        load('material', 'ground'), load('material', 'crate'), load('material', 'lamp-off'), load('material', 'lamp-on')]);
      const [cone, stone, beam, water] = await Promise.all([load('mesh', 'cone'),
        load('material', 'stone'), load('material', 'beam'), load('material', 'water')]);
      const [glow, haze] = await Promise.all([load('material', 'particle-glow'), load('material', 'particle-haze')]);
      const effect = (await loadVfxGpuEffect(assets, spark)).unwrap();
      held.push(effect);
      const [camera, ...stage] = [
        world.spawn({ component: Transform, data: { pos: [0, 6, 14] } }, { component: Camera, data: { fov: 0.9,
          antialias: ANTIALIAS_TAA, bloom: BLOOM_ENABLED, bloomThreshold: 1, bloomIntensity: 0.3 } }, // only emissive > 1 glows
          { component: AmbientOcclusion, data: {} }), // GTAO contact darkening
        world.spawn({ component: Transform, data: { pos: [0, -0.5, 0], scale: [60, 1, 60] } }, // ground: static box
          { component: MeshFilter, data: { assetHandle: box } }, { component: MeshRenderer, data: { materials: [ground] } },
          { component: RigidBody, data: { type: RigidBodyTypeValue.static } }, { component: Collider, data: {} }),
      ].map((spawned) => spawned.unwrap());
      yield () => { for (const entity of [camera!, ...stage]) world.despawn(entity).unwrap(); };
      yield spawnLighting(world, camera!, 'daylight'); // 'dusk', 'night' (lamps are the key light), 'overcast'
      const player = yield* installPlayer(world, ball, crate);
      yield installFollowCamera(world, player, camera!);
      yield spawnCrates(world, box, crate);
      const burst = yield* installBursts(world, effect);
      const lit = yield* installLanterns(world, player, ball, lampOff, lampOn, burst);
      const feedWater = yield* installWater(world, assets, box, water);
      yield installLighthouse(world, { box, ball, cone, stone, lamp: lampOn, beam }, feedWater);
      yield installState(world, ctx.gameHost!, player, lit);
      yield* installProps(world, assets);
      yield* installGrowth(world, assets);
      const emit = yield* installParticles(world, assets, glow!, haze!);
      emit(PARTICLES.fire, [-4, 0, 3]); // a brazier: fire plus its smoke
      emit(PARTICLES.smoke, [-4, 0, 3]);
    }, 'play/engine');
  },
};
```

Pick the lighting preset by the scene, not by habit. **Daylight** fits sunny, outdoor,
pastel, toy, board and diorama scenes: ACES tone mapping, a strong sky fill and a warm sun.
**Dusk** (golden hour) is a warm horizon, a low orange sun that casts long shadows and a
setting sun disc. **Night** fits scenes whose requirement is a visible lamp, torch, lantern,
neon or window pool: the same curve with a weak fill so that local lights win, under a
moon. **Overcast** is soft grey light with faint shadows and no sun disc. All use
`TONEMAP_ACES_FILMIC` (the curve Three.js games use). `TONEMAP_AGX` is the desaturated
base AgX curve with no look applied: it greys pastel and saturated colours, so use it only
when the request asks for a muted filmic grade.

```ts file=assets/play/lighting.ts
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { Camera, DirectionalLight, DirectionalShadowFilterValue, Fog, FogModeValue, GradientSky, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';

type Rgb = [number, number, number];
interface Preset {
  exposure: number;
  sky: { zenith: Rgb; horizon: Rgb; ground: Rgb; sunSize?: number; sunGlow?: number }; // shown as set
  fill: { color: Rgb; groundColor?: Rgb; intensity: number }; // Skylight: Three HemisphereLight / π
  sun: { direction: Rgb; color: Rgb; intensity: number }; // lux; the sky draws its disc toward -direction
  fog?: { color: Rgb; near: number; far: number }; // linear, from past the playfield to the horizon
}
const PRESETS = {
  daylight: { exposure: 1.1, sky: { zenith: [0.2, 0.45, 0.85], horizon: [0.75, 0.85, 0.95], ground: [0.79, 0.83, 0.75] },
    fill: { color: [1, 0.94, 0.76], groundColor: [0.17, 0.3, 0.16], intensity: 0.7 }, // warm sky over green ground
    sun: { direction: [0.5, -0.8, 0.4], color: [1, 0.94, 0.84], intensity: 3 } }, // daylight boards get no fog
  dusk: { exposure: 1, sky: { zenith: [0.07, 0.08, 0.25], horizon: [0.95, 0.45, 0.2], ground: [0.1, 0.07, 0.07], sunSize: 0.05, sunGlow: 1 },
    fill: { color: [0.55, 0.45, 0.6], groundColor: [0.15, 0.08, 0.06], intensity: 0.4 },
    sun: { direction: [0.35, -0.08, 0.93], color: [1, 0.55, 0.3], intensity: 2.5 }, // 5° above the horizon
    fog: { color: [1.2, 0.35, 0.12], near: 20, far: 60 } }, // ACES shows it as the horizon orange
  night: { exposure: 1, sky: { zenith: [0.005, 0.008, 0.025], horizon: [0.025, 0.035, 0.075], ground: [0.01, 0.012, 0.02], sunSize: 0.025, sunGlow: 0.25 },
    fill: { color: [0.6, 0.7, 1], intensity: 0.12 }, // low fill keeps lamp pools visible
    sun: { direction: [-0.4, -0.25, 0.85], color: [0.7, 0.8, 1], intensity: 0.4 }, // moon
    fog: { color: [0.03, 0.04, 0.07], near: 25, far: 70 } },
  overcast: { exposure: 1.1, sky: { zenith: [0.5, 0.53, 0.57], horizon: [0.74, 0.76, 0.78], ground: [0.4, 0.41, 0.39], sunSize: 0 },
    fill: { color: [0.9, 0.92, 0.95], groundColor: [0.25, 0.26, 0.24], intensity: 0.9 },
    sun: { direction: [0.3, -0.9, 0.3], color: [0.95, 0.96, 1], intensity: 1.2 },
    fog: { color: [0.55, 0.58, 0.62], near: 25, far: 90 } },
} satisfies Record<string, Preset>;
export type LightingPreset = keyof typeof PRESETS;

/** Tone mapping on `camera` plus sky, fill, sun or moon and fog; returns the despawn. */
export function spawnLighting(world: World, camera: EntityHandle, preset: LightingPreset) {
  const p: Preset = PRESETS[preset];
  world.set(camera, Camera, { tonemap: TONEMAP_ACES_FILMIC, exposure: p.exposure }).unwrap();
  const spawned = [
    world.spawn({ component: GradientSky, data: p.sky }), // replaces clearColor
    world.spawn({ component: Skylight, data: p.fill }),
    world.spawn({ component: DirectionalLight, data: { ...p.sun, castShadow: true, shadowDistance: 40,
      shadowFilter: DirectionalShadowFilterValue.pcssMedium } }), // soft penumbra
    ...(p.fog === undefined ? [] : [world.spawn({ component: Fog, data: { ...p.fog, mode: FogModeValue.linear } })]),
  ].map((entity) => entity.unwrap());
  return () => { for (const entity of spawned) world.despawn(entity).unwrap(); };
}
```

Background: `GradientSky` is the sky. Like Three.js `scene.background`, its colours are
display-referred: linear `[0.79, 0.83, 0.75]` shows as #e6ebe1 whatever the exposure and
tone curve, because it is composited behind the finished frame (hex to linear:
`color.fromHex(color.create(), '#e6ebe1').subarray(0, 3)` from `@forgeax/engine/math`). Above the horizon it
blends `horizon` to `zenith`; below it, `horizon` to `ground`, which is also the backdrop
a top-down board or diorama camera sees (daylight uses a pale page colour). The sun or
moon disc follows the `DirectionalLight` (`direction` points from the light, so the disc
is toward `-direction`); `sunSize` is its angular radius in radians, 0 hides it, and
`sunGlow` sets the halo. An opaque `Camera.clearColor` is different: it is scene-linear and
goes through exposure and the tone curve (#e6ebe1 shows as #c6c8c4), and a GradientSky
replaces it. A DOM HUD over the sky needs no page CSS. Set `toneMapped: true` only when
the sky must bloom or show in reflections; its colours then go through the tone curve. A
cool blue `Skylight` fill greys warm grass, wood and roofs; keep the daylight sky fill
warm white and the ground fill green or earth.

Fog: `Fog` tints geometry, and with a `GradientSky` it also covers the sky at and below
the horizon (fading out by `fogBlend`, default 0.15), so far ground meets the sky without
a seam whatever the fog colour. Any fog over the subject lifts its black level and cuts
saturation (13 % pale fog greys a sunlit board by about 40 %), so daylight, board and
diorama scenes need none. Add fog only for a visible horizon, and start it beyond the
playfield: `mode: FogModeValue.linear` with `near` past the farthest playfield point and
`far` at the horizon is Three.js `Fog(color, near, far)`; `mode: FogModeValue.exp2` with
the same `density` is `FogExp2`. Both measure camera view depth, so Three.js numbers
transfer. The default `exp` mode has no start distance and fogs everything in front of
the camera. Fog `color` is scene-linear and goes through the tone curve; it may exceed 1
(under ACES at exposure 1, dusk's `[1.2, 0.35, 0.12]` shows as the horizon orange).

Light units are physical but scene-referred for exposure about 1 (never real photometry
such as 100000 lux sunlight). A point or spot light gives `E = cd / d²` lux at distance
`d` and is the key light only where that beats the sun about twice: 26 cd at 3.2 m is
2.5 lux and vanishes under a 3 lux sun. Lights are divided by π (Lambert), but a solid-colour
`Skylight` adds `color * intensity * albedo` with no 1/π, so divide a Three.js ambient or
hemisphere intensity by π; `Skylight.ambientIrradiance` is the exception and takes Three units.

| Light | Component (unit) | Value | At the subject |
|:--|:--|:--|:--|
| Daylight sun / moon or window | `DirectionalLight` (lux) | 3 / 0.2-0.5 | same |
| Ambient fill, daylight | `Skylight.intensity` | 0.6-0.9 | - |
| Ambient fill, night or lamp-lit interior | `Skylight.intensity` | 0.1-0.2; 0.3+ flattens local lights | - |
| Three.js `HemisphereLight` / `AmbientLight` `I` | `Skylight.intensity` | `I / π` (2.5 is 0.8); sky colour is `color`, ground is `groundColor` | - |
| Desk lamp | `SpotLight` (cd), range 6 | 20-30 | about 10 lux at 1.5 m |
| Lantern, torch | `PointLight` (cd), range 10 | 30-50 | about 4 lux at 3 m |
| Street light | `SpotLight` (cd), range 20 | 300-500 | about 10 lux at 6 m |

A frame admits up to 256 local `PointLight`/`SpotLight` entities by default, so every lamp
of a street or mine can be a real light; more return `standard-light-budget-exceeded`.

Indoor lamp as key light: start from the night preset, use window light (0.3 lux) and a
Skylight of 0.1, then add a shadowed warm spot above the subject (plus an emissive bulb
mesh for bloom).
Shadowed lamps are `SpotLight { castShadow: true }`. A shadowed `PointLight` also needs
`PointLightShadow` and `package.json#forgeax.pointShadows: true` (DevKit compiles the
point-shadow shader entry only then; without it `renderer.inspect().pointShadow.status`
stays `unavailable`).

```ts file=assets/play/desk-lamp.ts
import type { World } from '@forgeax/engine/ecs';
import { SpotLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

/** Warm key light 1.5 m above `target`: 25 cd / 1.55² m ≈ 10 lux, about 30x a 0.3 lux window. */
export function spawnDeskLamp(world: World, target: readonly [number, number, number]) {
  const lamp = world.spawn(
    { component: Transform, data: { pos: [target[0] + 0.4, target[1] + 1.5, target[2]] } },
    { component: SpotLight, data: { direction: [-0.26, -0.97, 0], color: [1, 0.72, 0.42], intensity: 25, range: 6,
      innerConeDeg: 25, outerConeDeg: 50, castShadow: true } },
  ).unwrap();
  return () => world.despawn(lamp).unwrap();
}
```

## 1. Character controller

Kinematic body + capsule `Collider` + `CharacterController`, moved once per fixed step with
`moveAndSlide`; it writes `Transform` and `grounded`. Spawn at rest height, not in the ground.

```ts file=assets/play/player.ts
import { FixedTime, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';
import { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue,
  type PhysicsWorld } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

const SPEED = 5, JUMP = 6.5, GRAVITY = 18;

export function* installPlayer(world: World, mesh: AssetHandle<'mesh'>, material: AssetHandle<'material'>) {
  const player = world.spawn(
    { component: Transform, data: { pos: [0, 0.81, 6], scale: [0.6, 1.6, 0.6] } }, // rest height: radius + halfHeight + offset
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.5, halfHeight: 0.5 / 1.6 } },
    { component: CharacterController, data: { snapToGroundDist: 0.3 } },
  ).unwrap();
  yield () => world.despawn(player).unwrap();
  let verticalVelocity = 0, jumpQueued = false;
  world.addSystem(FixedUpdate, {
    name: 'play-player-move', after: ['physicsSyncBackend'], before: ['physicsStepSimulation'], queries: [],
    fn() {
      if (!world.hasResource('PhysicsWorld')) return;
      const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
      if (!physics.hasBody(player)) return;
      const dt = world.getResource(FixedTime).delta;
      const keys = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard;
      const x = Number(keys.downCode('KeyD')) - Number(keys.downCode('KeyA'));
      const z = Number(keys.downCode('KeyS')) - Number(keys.downCode('KeyW'));
      const length = Math.hypot(x, z) || 1;
      jumpQueued ||= keys.justPressedCode('Space');
      const grounded = world.get(player, CharacterController).unwrap().grounded === true;
      if (grounded) verticalVelocity = jumpQueued ? JUMP : -1;
      jumpQueued = false;
      verticalVelocity -= GRAVITY * dt;
      physics.moveAndSlide(player, vec3.create((x / length) * SPEED * dt, verticalVelocity * dt, (z / length) * SPEED * dt));
      if (x !== 0 || z !== 0) world.set(player, Transform, { quat: quat.eulerY(Math.atan2(-x, -z)) }).unwrap();
    },
  }).unwrap();
  yield () => world.removeSystem(FixedUpdate, 'play-player-move').unwrap();
  return player;
}
```

## 2. Follow camera

Follow the interpolated presentation pose after `FixedUpdate` and before transform propagation.

```ts file=assets/play/follow-camera.ts
import { FixedUpdate, Time, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { PROPAGATE_TRANSFORMS_SYSTEM, readPresentationWorldMatrix, Transform } from '@forgeax/engine/scene';

const OFFSET = [0, 4.5, 8] as const, LOOK_HEIGHT = 1, FOLLOW = 6;

export function installFollowCamera(world: World, target: EntityHandle, camera: EntityHandle) {
  const position = [...world.get(camera, Transform).unwrap().pos] as [number, number, number];
  world.addSystem(Update, {
    name: 'play-follow-camera', after: [FixedUpdate], before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      const m = readPresentationWorldMatrix(world, target); // interpolated pose, not the fixed-step one
      if (m === undefined) return;
      const focus = [m[12] ?? 0, (m[13] ?? 0) + LOOK_HEIGHT, m[14] ?? 0] as const;
      const blend = 1 - Math.exp(-FOLLOW * world.getResource(Time).delta);
      for (let i = 0; i < 3; i++) position[i]! += (focus[i]! + OFFSET[i]! - position[i]!) * blend;
      const rotation = quat.fromLookAt(quat.create(), position, focus, [0, 1, 0]);
      world.set(camera, Transform, { pos: position, quat: rotation }).unwrap();
    },
  }).unwrap();
  return () => world.removeSystem(Update, 'play-follow-camera').unwrap();
}
```

## 3. Dynamic boxes

Never write a dynamic body's `Transform` per frame; the controller pushes them natively.

```ts file=assets/play/crates.ts
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

/** Dynamic bodies: Rapier owns their pose; the character controller pushes them on contact. */
export function spawnCrates(world: World, box: AssetHandle<'mesh'>, material: AssetHandle<'material'>) {
  const crates: EntityHandle[] = [];
  for (let i = 0; i < 10; i++) {
    crates.push(world.spawn( // two stacked rows of five
      { component: Transform, data: { pos: [((i % 5) - 2) * 1.05, 0.5 + Math.floor(i / 5) * 1.01, -3] } },
      { component: MeshFilter, data: { assetHandle: box } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1.5, linearDamping: 0.1 } },
      { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], friction: 0.6 } },
    ).unwrap());
  }
  return () => { for (const crate of crates) world.despawn(crate).unwrap(); };
}
```

## 4. Point light and emissive at runtime

Write component fields with `world.set`; switch emissive by swapping the material handle.

Glow strength under ACES at exposure 1.1: emissive adds `emissive * emissiveIntensity` to the
lit colour before the tone curve, which rolls bright values toward white. Keep large glowing
areas (windows, screens, panels, signs) at `emissiveIntensity` 0.8-1.5 so they keep their hue;
at 3 a warm `#ffd27a` window shows as near-white `#f9f3de`. Reserve 3-10 for small bulbs,
eyes and sparks that should bloom (bloom threshold 1).

```ts file=assets/play/lanterns.ts
import { FixedUpdate, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { MeshFilter, MeshRenderer, PointLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

export const LANTERNS = [[-6, -6], [6, -6], [6, 6], [-6, 6]] as const;
const RADIUS = 1.8;

export function* installLanterns(world: World, player: EntityHandle, ball: AssetHandle<'mesh'>,
  off: AssetHandle<'material'>, on: AssetHandle<'material'>, burst: (pos: [number, number, number]) => void) {
  const lit = new Set<number>();
  const lamps = LANTERNS.map(([x, z]) => world.spawn(
    { component: Transform, data: { pos: [x, 1.6, z], scale: [0.5, 0.6, 0.5] } },
    { component: MeshFilter, data: { assetHandle: ball } },
    { component: MeshRenderer, data: { materials: [off] } },
    { component: PointLight, data: { color: [1, 0.45, 0.15], intensity: 0, range: 10 } }, // off until lit
  ).unwrap());
  yield () => { for (const lamp of lamps) world.despawn(lamp).unwrap(); };
  world.addSystem(FixedUpdate, {
    name: 'play-lanterns', after: ['play-player-move'], queries: [],
    fn() {
      const [px, , pz] = world.get(player, Transform).unwrap().pos;
      LANTERNS.forEach(([x, z], i) => {
        if (lit.has(i) || Math.hypot(px! - x, pz! - z) > RADIUS) return;
        lit.add(i);
        world.set(lamps[i]!, MeshRenderer, { materials: [on] }).unwrap(); // emissive: swap material
        world.set(lamps[i]!, PointLight, { intensity: 40 }).unwrap(); // cd: ~16 lux below, ~4 lux 3 m out
        burst([x, 1.6, z]);
      });
    },
  }).unwrap();
  yield () => world.removeSystem(FixedUpdate, 'play-lanterns').unwrap();
  return lit;
}
```

## 5. One-shot VFX burst

Particle behavior is WGSL; the effect is a cooked asset. `rate: 0` plus a time-zero burst
fires once per spawned `ParticleEffectPlayer`; generated games already attach the VFX runtime.
The billboard material GUID is `material/spark` derived from `PLAY_PACKAGE`.

```json file=assets/play/spark.pack.json
{
  "schemaVersion": "3.0.0",
  "packageId": "3b1f6a52-8c0e-4d6b-9f1e-2a7c5d0e9b42",
  "assets": {
    "vfx/spark": {
      "kind": "particle-effect",
      "payload": {
        "schemaVersion": 3,
        "emitters": [{
          "id": "sparks", "capacity": 64, "backend": { "required": "gpu" }, "space": "local",
          "schedule": { "rate": 0, "bursts": [{ "time": 0, "count": 48 }] },
          "bounds": { "kind": "sphere", "center": [0, 0, 0], "radius": 3 },
          "program": { "module": "spark.vfx.wgsl" },
          "renderers": [{ "kind": "billboard", "material": "ebed9839-58bd-5bc4-a98c-ea1bef4c2a4d", "blend": "additive" }]
        }]
      },
      "refs": ["ebed9839-58bd-5bc4-a98c-ea1bef4c2a4d"],
      "artifacts": {}
    }
  }
}
```

```wgsl file=assets/play/spark.vfx.wgsl
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let speed = 1.0 + vfx_random_spawn(ctx, 1u) * 2.0;
  (*particle).position = vec3<f32>(0.0, 0.0, 0.0);
  (*particle).velocity = vec3<f32>(cos(angle) * speed, 2.0 + vfx_random_spawn(ctx, 2u) * 2.5, sin(angle) * speed);
  (*particle).color = vec4<f32>(1.0, 0.6, 0.2, 1.0);
  (*particle).sprite_size = vec2<f32>(0.12, 0.12);
  (*particle).lifetime = 0.6 + vfx_random_spawn(ctx, 3u) * 0.6;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 5.0 * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 1.0 - life;
}
```

```ts file=assets/play/burst.ts
import { FixedTime, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';

/** Each spawned Player fires the effect's time-zero burst once; despawn it after its particles die. */
export function* installBursts(world: World, effect: AssetHandle<'particle-effect'>, lifetime = 1.5) {
  const live = new Map<EntityHandle, number>();
  world.addSystem(FixedUpdate, {
    name: 'play-bursts', queries: [],
    fn() {
      const dt = world.getResource(FixedTime).delta;
      for (const [player, left] of live) {
        if (left > dt) live.set(player, left - dt);
        else { live.delete(player); world.despawn(player).unwrap(); }
      }
    },
  }).unwrap();
  yield () => {
    world.removeSystem(FixedUpdate, 'play-bursts').unwrap();
    for (const player of live.keys()) world.despawn(player).unwrap();
  };
  return (pos: [number, number, number]) => live.set(world.spawn(
    { component: Transform, data: { pos } },
    { component: ParticleEffectPlayer, data: { effect, seed: live.size + 1 } },
  ).unwrap(), lifetime);
}
```

## 6. DOM HUD

The HUD is a separate frontend root. The World posts on `host.port`; the HUD listens on
`presentationPort ?? port`, so it works with and without an Engine Worker.

```ts file=assets/play/hud.ts
import type {} from '@forgeax/engine/app';
import type { Plugin } from '@forgeax/engine/plugin';

export const STATE_MESSAGE = 'play/state'; // the game-owned port protocol
export type PlayState = { lit: number; total: number; done: boolean; position: number[]; grounded: boolean };

/** Frontend root (forge.json roots.frontend): DOM under the Host-owned uiRoot. */
export const hud: Plugin = {
  name: 'play/hud', inject: ['gameHost'],
  apply(ctx) {
    const host = ctx.gameHost!, port = host.presentationPort ?? host.port;
    ctx.effect(() => {
      const panel = host.uiRoot!.ownerDocument.createElement('div');
      panel.id = 'play-hud';
      panel.style.cssText = 'position:absolute;left:16px;top:16px;padding:6px 12px;border-radius:6px;' +
        'background:#000a;color:#fff;font:600 18px system-ui;pointer-events:none';
      panel.textContent = 'Lanterns 0';
      host.uiRoot!.append(panel);
      const receive = (event: MessageEvent) => {
        if (event.data?.type !== STATE_MESSAGE) return;
        const state = event.data.state as PlayState;
        panel.textContent = state.done ? 'All lanterns lit!' : `Lanterns ${state.lit} / ${state.total}`;
        panel.dataset.lit = String(state.lit);
      };
      port?.addEventListener('message', receive);
      port?.start();
      return () => { port?.removeEventListener('message', receive); panel.remove(); };
    });
  },
};
```

## 7. State for tests

`gameProjection.registerRead` exposes JSON to `__forgeaxGameInspection.read(id)` in dev and
capture sessions. The playthrough drives real keys and only reads state.
`project play` usually takes 1–3 minutes; wait for it in a single call (use your shell tool's longest wait) instead of re-checking it; use `play.advance` for any in-game timer (day/night cycles and long waits too, instead of `play.wait`/long `waitFor` timeouts). It steps update-only frames and renders the last one; pass `{ render: true }` only when game logic reads the rendered picture.

```ts file=assets/play/state.ts
import type { GameHost } from '@forgeax/engine/app';
import { Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { CharacterController } from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { STATE_MESSAGE, type PlayState } from './hud.ts';
import { LANTERNS } from './lanterns.ts';

/** One JSON projection feeds the HUD (port message) and tests (`__forgeaxGameInspection.read('play.state')`). */
export function installState(world: World, host: GameHost, player: EntityHandle, lit: ReadonlySet<number>) {
  const read = (): PlayState => ({
    lit: lit.size, total: LANTERNS.length, done: lit.size === LANTERNS.length,
    position: Array.from(world.get(player, Transform).unwrap().pos),
    grounded: world.get(player, CharacterController).unwrap().grounded === true,
  });
  let sent = -1;
  world.addSystem(Update, {
    name: 'play-state', queries: [],
    fn() {
      if (lit.size === sent) return; // post on change only
      sent = lit.size;
      host.port?.postMessage({ type: STATE_MESSAGE, state: read() });
    },
  }).unwrap();
  const unregister = host.gameProjection?.registerRead({ id: 'play.state', title: 'Play state', read });
  return () => { unregister?.(); world.removeSystem(Update, 'play-state').unwrap(); };
}
```

```js file=scripts/playthrough.mjs
import assert from 'node:assert/strict';
import { createBrowserCapture } from '@forgeax/engine/devkit';

const browser = createBrowserCapture(process.cwd());
const session = await browser.open({ backend: 'auto', headless: true, requireUi: true, outputDir: 'artifacts/playthrough' });
try {
  const { page } = session;
  const state = () => page.evaluate(() => globalThis.__forgeaxGameInspection.read('play.state'));
  await page.waitForFunction(async () => (await globalThis.__forgeaxGameInspection?.list())?.reads.includes('play.state'),
    undefined, { timeout: 120_000 });
  await page.locator('canvas').first().click();
  const walkTo = async (x, z) => { // real key events only; the test never writes game state
    for (const started = Date.now(); Date.now() - started < 30_000; await page.waitForTimeout(60)) {
      const [px, , pz] = (await state()).position, dx = x - px, dz = z - pz;
      if (Math.hypot(dx, dz) < 0.5) break;
      for (const [key, down] of [['KeyA', dx < -0.2], ['KeyD', dx > 0.2], ['KeyW', dz < -0.2], ['KeyS', dz > 0.2]])
        await (down ? page.keyboard.down(key) : page.keyboard.up(key));
    }
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
  };
  for (const [x, z] of [[-6, -6], [6, -6], [6, 6], [-6, 6]]) await walkTo(x, z);
  assert.equal((await state()).done, true);
  await page.waitForFunction(() => document.querySelector('#play-hud')?.textContent === 'All lanterns lit!');
  await session.capture(undefined, { output: 'artifacts/playthrough/done.png' });
  const report = session.report();
  assert.deepEqual([report.pageErrors, report.consoleErrors], [[], []]);
} finally {
  await session.close();
  await browser.close();
}
```

## 8. Rotating spot light with an additive beam

`SpotLight` lights the ground; the cone mesh only adds the visible glow. Aim both from one
system: write `SpotLight.direction` (the light ignores Transform rotation) and the cone's
Transform. Build the cone with `openEnded` (`createConeGeometry(r, h, segments, 1, true)`,
like Three.js `ConeGeometry(..., openEnded)`) so its far end shows no hard disc. A blended
beam casts no shadow by default, so it does not occlude its own light. For a lit
medium instead of a glow mesh, `VolumetricFog { light: spot }` scatters the same light
(`forgeax-engine-render-pipeline`, Local volumetric fog).

```ts file=assets/play/lighthouse.ts
import { Time, Update, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { Collider, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import { MeshFilter, MeshRenderer, ShadowParticipation, SpotLight } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

export const LAMP = [-18, 9, -18] as const; // lamp position; the water shader reads it too
const TILT = 0.42, SPIN = 0.5, OUTER_DEG = 7; // pitch below the horizon (rad), rad/s, cone half-angle
const LENGTH = LAMP[1] / Math.sin(TILT); // the cone ends where the beam meets the ground
type Vec3 = [number, number, number];
type Parts = { box: AssetHandle<'mesh'>; ball: AssetHandle<'mesh'>; cone: AssetHandle<'mesh'>;
  stone: AssetHandle<'material'>; lamp: AssetHandle<'material'>; beam: AssetHandle<'material'> };

export function installLighthouse(world: World, parts: Parts, onAim: (direction: Vec3) => void) {
  const [x, y, z] = LAMP, radius = LENGTH * Math.tan((OUTER_DEG * Math.PI) / 180);
  const entities = [
    world.spawn({ component: Transform, data: { pos: [x, (y - 0.5) / 2, z], scale: [1.6, y - 0.5, 1.6] } }, // tower
      { component: MeshFilter, data: { assetHandle: parts.box } }, { component: MeshRenderer, data: { materials: [parts.stone] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } }, { component: Collider, data: {} }),
    world.spawn({ component: Transform, data: { pos: [x, y, z], scale: [0.9, 0.9, 0.9] } }, // emissive lamp; blooms
      { component: MeshFilter, data: { assetHandle: parts.ball } }, { component: MeshRenderer, data: { materials: [parts.lamp] } },
      { component: ShadowParticipation, data: { cast: false } }), // the spot sits inside it
  ].map((spawned) => spawned.unwrap());
  const light = world.spawn({ component: Transform, data: { pos: [...LAMP] } }, { component: SpotLight, data: {
    direction: [1, 0, 0], color: [1, 0.85, 0.6], intensity: 4000, range: 80, // candela, metres
    innerConeDeg: OUTER_DEG * 0.4, outerConeDeg: OUTER_DEG, castShadow: true } }).unwrap();
  const beam = world.spawn({ component: Transform, data: { scale: [radius, LENGTH, radius] } },
    { component: MeshFilter, data: { assetHandle: parts.cone } }, { component: MeshRenderer, data: { materials: [parts.beam] } },
    { component: ShadowParticipation, data: { cast: false, receive: false } }).unwrap();
  const down = [0, -1, 0] as const, rotation = quat.create();
  world.addSystem(Update, {
    name: 'play-lighthouse', before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      const angle = world.getResource(Time).elapsed * SPIN;
      const direction: Vec3 = [Math.cos(angle) * Math.cos(TILT), -Math.sin(TILT), Math.sin(angle) * Math.cos(TILT)];
      world.set(light, SpotLight, { direction }).unwrap();
      quat.fromUnitVectors(rotation, down, direction); // cone -y (base) along the beam, apex at the lamp
      const pos = [0, 1, 2].map((i) => LAMP[i]! + direction[i]! * LENGTH * 0.5);
      world.set(beam, Transform, { pos, quat: rotation }).unwrap();
      onAim(direction);
    },
  }).unwrap();
  return () => {
    world.removeSystem(Update, 'play-lighthouse').unwrap();
    for (const entity of [...entities, light, beam]) world.despawn(entity).unwrap();
  };
}
```

The beam Surface is emission only: brightest on the axis and near the lamp, fading to the
rim and the far end, so the base cap stays dark. Additive blending makes overlaps and both cone faces sum softly.

```wgsl file=assets/play/beam.surface.wgsl
#define_import_path play::beam_surface

#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let along = clamp(0.5 - input.positionOS.y, 0.0, 1.0); // 0 at the apex, 1 at the base cap
  let facing = abs(dot(normalize(input.vertexNormalWS), input.viewDirectionWS));
  let glow = facing * facing * pow(1.0 - along, 1.6) * material.glow;
  return SurfaceData(vec3<f32>(0.0), input.vertexNormalWS, 0.0, 1.0, material.beamColor.rgb * glow, 1.0, glow, 0.0);
}
```

## 9. Custom-shader water with a per-frame uniform

A custom Standard Surface keeps Engine lighting, shadows and fog: the WGSL only returns
color, normal and roughness, so the spot light and sun give real specular highlights on
the waves. `input.frameTime` animates without a uniform; values the game owns, here the
beam direction, are written with `assets.update(handle, { values })` each frame. Waves
bend the shading normal; the mesh stays flat (no vertex displacement in a Surface).

```ts file=assets/play/water.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { World } from '@forgeax/engine/ecs';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';
import { LAMP } from './lighthouse.ts';

export function* installWater(world: World, assets: AssetRegistry, box: AssetHandle<'mesh'>, water: AssetHandle<'material'>) {
  const pool = world.spawn( // a thin box over the ground around the lighthouse
    { component: Transform, data: { pos: [LAMP[0], 0.02, LAMP[2]], scale: [22, 0.04, 22] } },
    { component: MeshFilter, data: { assetHandle: box } },
    { component: MeshRenderer, data: { materials: [water] } },
  ).unwrap();
  yield () => world.despawn(pool).unwrap();
  assets.update(water, { values: { lampPos: [...LAMP] } }).unwrap(); // once; the beam direction every frame
  return (beamDir: [number, number, number]) => assets.update(water, { values: { beamDir } }).unwrap();
}
```

```wgsl file=assets/play/water.surface.wgsl
#define_import_path play::water_surface

#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput}

// xy = height gradient, z = height of one travelling sine wave.
fn wave(p : vec2<f32>, t : f32, dir : vec2<f32>, freq : f32, amp : f32, speed : f32) -> vec3<f32> {
  let d = normalize(dir);
  let phase = dot(d, p) * freq + t * speed;
  return vec3<f32>(d * (amp * freq * cos(phase)), amp * sin(phase));
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let p = input.positionWS.xz;
  let t = input.frameTime;
  let w = wave(p, t, vec2<f32>(1.0, 0.3), 0.8, 0.1, 1.1) + wave(p, t, vec2<f32>(-0.4, 1.0), 1.7, 0.05, 1.7)
    + wave(p, t, vec2<f32>(0.7, -0.6), 3.3, 0.02, 2.6);
  let n = normalize(vec3<f32>(-w.x, 1.0, -w.y));
  let fresnel = pow(1.0 - clamp(dot(n, input.viewDirectionWS), 0.0, 1.0), 5.0);
  let crest = smoothstep(0.06, 0.15, w.z);
  let color = mix(material.deepColor.rgb, material.shallowColor.rgb, clamp(fresnel + crest * 0.4, 0.0, 1.0));
  // Glitter on the crests the beam sweeps over: compare the lamp-to-point heading with beamDir.
  let heading = normalize(p - material.lampPos.xz + vec2<f32>(1e-4, 0.0));
  let aim = dot(heading, normalize(material.beamDir.xz + vec2<f32>(1e-4, 0.0)));
  let glitter = smoothstep(0.985, 1.0, aim) * (0.2 + crest) * 2.0;
  return SurfaceData(color, n, 0.0, 0.06, material.beamColor.rgb * glitter, 1.0, 1.0, 0.0);
}
```

## 10. Fade out one enemy (per-entity tint and opacity)

There is no per-entity `opacity` or tint field: color and alpha are material `values`, and
every entity bound to a material shares them. For one entity, `assets.copy` a material
into its own editable identity, bind the copy, and `assets.update` its values per frame
(Three.js `material.clone()` then `material.opacity`). A fade needs a blended material
from the start, so declare a Pack twin of the enemy material with
`renderState: { blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }, depthWriteEnabled: false }`
and `queue: RenderQueue.Transparent`, and swap to a copy of it only when the enemy dies:
the opaque original keeps depth writes and shadows while it lives (blended-only meshes
cast no shadow). Release the copy after despawning.

Make enemies readable before tuning the fade: their luminance must differ clearly from
the background (pale or saturated bodies on a dark sea, dark on a bright sky) and, at
night, carry an emissive rim, eyes or halo. Check one screenshot at gameplay distance.

```ts file=assets/play/fade.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Time, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

type Rgb = [number, number, number];
interface Fade { material: AssetHandle<'material'>; color: Rgb; glow: number; left: number; total: number; scale: Rgb }

/** `fadeOut(enemy)` fades and shrinks one entity over `seconds`, then despawns it; others keep their look. */
export function* installFades(world: World, assets: AssetRegistry, blended: AssetHandle<'material'>) {
  const fading = new Map<EntityHandle, Fade>();
  const finish = (entity: EntityHandle, fade: Fade) => {
    fading.delete(entity);
    world.despawn(entity).unwrap();
    assets.release(fade.material).unwrap(); // the despawned binding held the other reference
  };
  world.addSystem(Update, {
    name: 'play-fades', queries: [],
    fn() {
      const dt = world.getResource(Time).delta;
      for (const [entity, fade] of fading) {
        fade.left -= dt;
        const a = Math.max(0, fade.left / fade.total);
        if (a === 0) { finish(entity, fade); continue; }
        assets.update(fade.material, { values: { baseColor: [...fade.color, a], emissiveIntensity: fade.glow * a } }).unwrap();
        world.set(entity, Transform, { scale: fade.scale.map((v) => v * (0.6 + 0.4 * a)) as Rgb }).unwrap();
      }
    },
  }).unwrap();
  yield () => {
    world.removeSystem(Update, 'play-fades').unwrap();
    for (const [entity, fade] of fading) finish(entity, fade);
  };
  return (entity: EntityHandle, color: Rgb, glow = 2, seconds = 0.6) => {
    if (fading.has(entity)) return;
    const material = assets.copy(blended).unwrap(); // this enemy's own values
    world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
    const scale = [...world.get(entity, Transform).unwrap().scale] as Rgb;
    fading.set(entity, { material, color, glow, left: seconds, total: seconds, scale });
  };
}
```

Run `pnpm typecheck`, then `node scripts/playthrough.mjs`; check `artifacts/playthrough/`.

## 11. Board / diorama camera

A board, town, garden or tabletop scene reads best like the Three.js entries: an
orthographic camera on a 45° diagonal, pitched about 35° down, with the board filling the
frame. Top-down flattens props into a grid; front-on hides the board; a far perspective
camera makes it tiny. Fit the bounds of the board's corners in camera space plus a margin,
and refit when the canvas aspect changes: the Host updates `aspect` only for perspective
cameras, so read `gameHost.drawingBufferSize()`. Pair it with the daylight preset.

```ts file=assets/play/board-camera.ts
import { Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { Camera, CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine/scene';

type V3 = [number, number, number];
const YAW = Math.PI / 4, PITCH = (35 * Math.PI) / 180, MARGIN = 1.15; // margin 15% around the board

/** Aim `camera` at the box `min`..`max` and refit its orthographic bounds to the canvas aspect. */
export function installBoardCamera(world: World, camera: EntityHandle, min: V3, max: V3,
  canvasSize: () => { width: number; height: number }) {
  const center = min.map((v, i) => (v + max[i]!) / 2) as V3;
  const back: V3 = [Math.cos(PITCH) * Math.sin(YAW), Math.sin(PITCH), Math.cos(PITCH) * Math.cos(YAW)];
  const right: V3 = [Math.cos(YAW), 0, -Math.sin(YAW)]; // camera axes: back points from the board to the eye
  const up: V3 = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let halfW = 0, halfH = 0, radius = 0;
  for (let corner = 0; corner < 8; corner++) {
    const d = [0, 1, 2].map((i) => ((corner >> i) & 1 ? max[i]! : min[i]!) - center[i]!) as V3;
    halfW = Math.max(halfW, Math.abs(dot(d, right)));
    halfH = Math.max(halfH, Math.abs(dot(d, up)));
    radius = Math.max(radius, Math.hypot(...d));
  }
  const distance = radius * 2 + 1;
  const eye = center.map((v, i) => v + back[i]! * distance) as V3;
  world.set(camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, center, [0, 1, 0]) }).unwrap();
  let fitted = 0;
  world.addSystem(Update, {
    name: 'play-board-camera', before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      const { width, height } = canvasSize();
      const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
      if (aspect === fitted) return;
      fitted = aspect;
      const h = Math.max(halfH, halfW / aspect) * MARGIN, w = h * aspect; // the tighter axis fills the frame
      world.set(camera, Camera, { projection: CAMERA_PROJECTION_ORTHOGRAPHIC, left: -w, right: w, bottom: -h, top: h,
        near: 0.1, far: distance + radius * 2 }).unwrap();
    },
  }).unwrap();
  return () => world.removeSystem(Update, 'play-board-camera').unwrap();
}
```

In the engine plugin, replace `installFollowCamera` with
`yield installBoardCamera(world, camera!, [-8, 0, -6], [8, 2, 6], () => ctx.gameHost!.drawingBufferSize?.() ?? { width: 16, height: 9 });`.

## 12. Particles: rain, snow, sparks, bubbles, dust, fire, smoke, magic

Weather and small effects need no shader and no build step: a `point-list` mesh with a
`Points` component is Three.js `Points` + `PointsMaterial`. `sizeUnits: world` is
`sizeAttenuation` (a true world diameter), shape `soft` is the radial-gradient glow
sprite, the mesh `color` stream is `vertexColors` (alpha fades a point) and `uv1.x`
scales each point's size. The material is an unlit Pack material: additive
(`src-alpha`, `one`, no depth write: Three.js `AdditiveBlending, depthWrite: false`)
for sparks, fire and magic; alpha-blended for rain, snow, bubbles, dust and smoke.
Game code moves the particles each frame and writes the three streams with one
`writeRange`. `play.pack.ts` declares both materials (`particle-glow`, `particle-haze`).

Use this CPU loop for up to a few thousand points per field (the engine re-expands
every written point each frame); a cooked GPU effect (recipe 5) is for tens of
thousands, GPU collision, ribbons and trails. Fire colours above 1 bloom.
A dense dust or snow volume reads better with a matching `Fog`.

```ts file=assets/play/particles.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { type EntityHandle, Time, Update, type World } from '@forgeax/engine/ecs';
import { createMeshBuilder } from '@forgeax/engine/geometry';
import { type Rng, rng } from '@forgeax/engine/math';
import { Lines, LineWidthUnitsValue, MeshFilter, MeshRenderer, Points, PointShapeValue, PointSizeUnitsValue } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

type V3 = [number, number, number];
/** One particle: `spawn` sets it up, the loop ages it and integrates `v` under gravity. */
export interface Particle { p: V3; v: V3; rgba: [number, number, number, number]; size: number; age: number; life: number; seed: number }
export interface ParticlePreset {
  readonly count: number;
  readonly size: number; // largest world diameter (a streak's width); Particle.size scales it (0..1)
  readonly shape: keyof typeof PointShapeValue;
  readonly blend: 'glow' | 'haze'; // additive or alpha-blended material
  readonly gravity?: number;
  readonly once?: boolean; // a burst: dead particles stay dead, the field stops when all are
  readonly streak?: number; // draw each particle as `Lines` over this many seconds of travel (no per-point colour)
  spawn(p: Particle, r: Rng): void;
  look?(p: Particle, t: number): void; // per frame over normalized age t: fade, colour ramp, growth
}

const box = (r: Rng, x: number, y0: number, y1: number, z: number): V3 =>
  [(r.next() - 0.5) * x, y0 + r.next() * (y1 - y0), (r.next() - 0.5) * z];
const fade = (p: Particle, t: number, alpha: number) => { p.rgba[3] = alpha * (1 - t); };

export const PARTICLES = {
  rain: { count: 1200, size: 0.02, shape: 'square', blend: 'haze', streak: 0.03, spawn(p, r) {
    p.p = box(r, 30, 12, 12, 30); p.v = [1, -16 - r.next() * 4, 0]; p.life = 12 / 16; } },
  snow: { count: 1200, size: 0.12, shape: 'soft', blend: 'haze', spawn(p, r) {
    p.p = box(r, 30, 10, 10, 30); p.v = [0.4, -0.8 - r.next() * 0.6, 0]; p.life = 14; p.rgba = [1, 1, 1, 0.9];
    p.size = 0.5 + r.next() * 0.5; }, look(p, t) { p.v[0] = 0.4 + Math.sin(t * 20 + p.seed * 6) * 0.5; } },
  sparks: { count: 120, size: 0.1, shape: 'soft', blend: 'glow', gravity: 9, once: true, spawn(p, r) {
    const a = r.next() * Math.PI * 2, s = 2 + r.next() * 5; p.v = [Math.cos(a) * s, 2 + r.next() * 4, Math.sin(a) * s];
    p.life = 0.5 + r.next() * 0.6; p.rgba = [4, 1.6, 0.4, 1]; }, look(p, t) { fade(p, t, 1); p.size = 1 - t * 0.6; } },
  bubbles: { count: 150, size: 0.25, shape: 'soft', blend: 'haze', spawn(p, r) {
    p.p = box(r, 4, 0, 0.5, 4); p.v = [0, 0.6 + r.next() * 0.6, 0]; p.life = 6; p.rgba = [0.75, 0.9, 1, 0.5];
    p.size = 0.3 + r.next() * 0.7; }, look(p, t) { p.v[0] = Math.sin(t * 25 + p.seed * 6) * 0.3; } },
  dust: { count: 2500, size: 0.6, shape: 'soft', blend: 'haze', spawn(p, r) { // a sandstorm crossing the scene
    p.p = box(r, 1, 0, 6, 40); p.p[0] -= 20; p.v = [6 + r.next() * 3, (r.next() - 0.5) * 0.6, (r.next() - 0.5) * 2];
    p.life = 40 / p.v[0]; p.rgba = [0.78, 0.62, 0.4, 0.25]; p.size = 0.4 + r.next() * 0.6; } },
  fire: { count: 160, size: 0.8, shape: 'soft', blend: 'glow', spawn(p, r) {
    p.p = box(r, 0.7, 0, 0.1, 0.7); p.v = [0, 1 + r.next(), 0]; p.life = 0.5 + r.next() * 0.6; },
    look(p, t) { p.rgba = [2, 0.2 + 0.7 * (1 - t), 0.1, 0.22 * (1 - t)]; p.size = 1 - t * 0.7; } }, // yellow core, red tips
  smoke: { count: 120, size: 1.6, shape: 'soft', blend: 'haze', spawn(p, r) {
    p.p = box(r, 0.4, 0.8, 1, 0.4); p.v = [0.2 + (r.next() - 0.5) * 0.4, 0.6 + r.next() * 0.4, (r.next() - 0.5) * 0.4];
    p.life = 3 + r.next() * 2; p.rgba = [0.3, 0.3, 0.32, 0.12]; }, look(p, t) { fade(p, t, 0.12); p.size = 0.3 + t * 0.7; } },
  magic: { count: 200, size: 0.15, shape: 'soft', blend: 'glow', spawn(p, r) {
    p.life = 2 + r.next() * 2; p.rgba = [0.4, 0.7 + r.next() * 0.3, 3, 1]; },
    look(p, t) { const a = p.seed * 6.28 + t * 6, h = t * 2.5; // motes spiral up around the origin
      p.p = [Math.cos(a) * (1 - t * 0.5), h, Math.sin(a) * (1 - t * 0.5)]; fade(p, t, 1); } },
} satisfies Record<string, ParticlePreset>;

type Streams = { position: Float32Array; color?: Float32Array; uv1?: Float32Array };
interface Field { preset: ParticlePreset; particles: Particle[]; mesh: AssetHandle<'mesh'>; entity: EntityHandle; streams: Streams; rand: Rng }

function respawn(field: Field, p: Particle) {
  Object.assign(p, { p: [0, 0, 0], v: [0, 0, 0], rgba: [1, 1, 1, 1], size: 1, age: 0, seed: field.rand.next() });
  field.preset.spawn(p, field.rand);
}

/** Copy one particle into the streams: a sprite, or a streak from its position back along its velocity. */
function write({ preset, streams }: Field, p: Particle, i: number) {
  if (preset.streak === undefined) {
    streams.position.set(p.p, i * 3); streams.color?.set(p.rgba, i * 4); if (streams.uv1) streams.uv1[i * 2] = p.size;
    return;
  }
  const alive = p.age < p.life ? preset.streak : 0; // a dead streak collapses to a point
  streams.position.set([...p.p, ...p.p.map((x, k) => x - p.v[k]! * alive)], i * 6);
}

/** Advance one field by `dt` and write its streams; false once a burst has fully died. */
function step(assets: AssetRegistry, field: Field, dt: number): boolean {
  const { preset, particles, streams } = field;
  let alive = 0;
  particles.forEach((p, i) => {
    p.age += dt;
    if (p.age >= p.life && !preset.once) respawn(field, p);
    if (p.age < p.life) {
      alive++;
      p.v[1] -= (preset.gravity ?? 0) * dt;
      for (let k = 0; k < 3; k++) p.p[k]! += p.v[k]! * dt;
      preset.look?.(p, p.age / p.life);
    } else p.rgba[3] = 0;
    write(field, p, i);
  });
  assets.writeRange(field.mesh, Object.entries(streams).map(([attribute, values]) =>
    ({ attribute: attribute as keyof Streams, first: 0, values }))).unwrap();
  return alive > 0;
}

function spawnField(world: World, assets: AssetRegistry, material: AssetHandle<'material'>, preset: ParticlePreset, at: V3, seed: number) {
  const n = preset.count, streak = preset.streak !== undefined;
  const streams: Streams = streak ? { position: new Float32Array(n * 6) }
    : { position: new Float32Array(n * 3), color: new Float32Array(n * 4), uv1: new Float32Array(n * 2) };
  const mesh = assets.create(createMeshBuilder({ attributes: streams, submeshes: [{ topology: streak ? 'line-list' : 'point-list' }] })
    .build().unwrap()).unwrap(); // ours for writeRange; MeshFilter holds its own reference
  const common = [{ component: Transform, data: { pos: at } }, { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } }] as const;
  const entity = (streak
    ? world.spawn(...common, { component: Lines, data: { width: preset.size, widthUnits: LineWidthUnitsValue.world } })
    : world.spawn(...common, { component: Points, data: { size: preset.size, sizeUnits: PointSizeUnitsValue.world,
      shape: PointShapeValue[preset.shape] } })).unwrap();
  const field: Field = { preset, particles: [], mesh, entity, streams, rand: rng.create(seed) };
  for (let i = 0; i < n; i++) {
    const p = {} as Particle;
    respawn(field, p);
    if (!preset.once) { // pre-warm a looping field: start each particle part-way through its life
      p.age = field.rand.next() * p.life;
      for (let k = 0; k < 3; k++) p.p[k]! += p.v[k]! * p.age;
    }
    field.particles.push(p);
  }
  return field;
}

/** Updates every live field each frame; returns `emit(preset, at)`, whose result stops that field. */
export function* installParticles(world: World, assets: AssetRegistry, glow: AssetHandle<'material'>, haze: AssetHandle<'material'>) {
  const fields = new Set<Field>();
  const remove = (field: Field) => {
    if (!fields.delete(field)) return;
    world.despawn(field.entity).unwrap();
    assets.release(field.mesh).unwrap();
  };
  world.addSystem(Update, {
    name: 'play-particles', queries: [],
    fn() {
      const dt = Math.min(world.getResource(Time).delta, 0.1);
      for (const field of fields) if (!step(assets, field, dt)) remove(field);
    },
  }).unwrap();
  yield () => {
    world.removeSystem(Update, 'play-particles').unwrap();
    for (const field of fields) remove(field);
  };
  let seed = 1;
  return (preset: ParticlePreset, at: V3) => {
    const field = spawnField(world, assets, preset.blend === 'glow' ? glow : haze, preset, at, seed++);
    fields.add(field);
    return () => remove(field);
  };
}
```

`play.ts` lights a brazier with `emit(PARTICLES.fire, …)` and its smoke. Weather is one
field over the play area (`emit(PARTICLES.snow, [0, 0, 0])`); a hit calls
`emit(PARTICLES.sparks, pos)`, and the burst removes itself when its sparks die.

## Procedural props built at pack time

Geometry known before play is a Pack output, not runtime code: one seeded `build` lathes
vases (`createRevolutionGeometry`), extrudes a bevelled gear with a hole
(`createExtrusionGeometry`), sweeps a star section along a leaning spine
(`createProfileSweepGeometry`) and a tube along a Catmull-Rom arch (`createSweepGeometry`).
The factories emit normals, UVs and tangents, so Standard materials shade them directly.
The `seed` parameter is the only source of variation: the same seed cooks the same
meshes, and a new seed (View **Generate**, or a Pack instance's `values`) re-cooks them.
The game loads the outputs by the GUIDs that `(packageId, sourceKey)` derive, like any asset.

| Files | Factories | Owner skill for details |
|:--|:--|:--|
| `props.pack.ts`, `props.ts` | revolution, extrusion, profile sweep, sweep | `forgeax-engine-assets`, `packages/geometry/README.md` |
| `growth.ts` | runtime `create` / `writeRange` / `release`, `MeshBuilder` | `packages/assets-runtime/README.md` |

```ts file=assets/play/props.pack.ts
import { createExtrusionGeometry, createProfileSweepGeometry, createRevolutionGeometry, createSweepGeometry,
  type Vec2Point, type Vec3Point } from '@forgeax/engine/geometry';
import { curve3, rng, vec3 } from '@forgeax/engine/math';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';

export const PROPS_PACKAGE = definePackageId('3b1f6a52-8c0e-4d6b-9f1e-2a7c5d0e9b43');
export const VASE_COUNT = 3;

/** Closed 2D loop (either winding); alternating radii make teeth or star points. */
const loop = (count: number, radius: (i: number) => number): Vec2Point[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: Math.cos(angle) * radius(i), y: Math.sin(angle) * radius(i) };
  });

export default definePack({
  schemaVersion: '2.0.0', packageId: PROPS_PACKAGE,
  parameters: [{ name: 'seed', type: 'u32', default: 7 }],
  build: ({ values }) => {
    const rand = rng.create(values.seed); // the seed fixes the stream; never Math.random()
    const vases = Object.fromEntries(Array.from({ length: VASE_COUNT }, (_, i) => {
      // Lathe a (radius, height) profile around +Y; radius 0 at both ends closes base and lid.
      const belly = 0.22 + rand.next() * 0.14, neck = 0.08 + rand.next() * 0.06, height = 0.8 + rand.next() * 0.5;
      const profile: Vec2Point[] = [{ x: 0, y: 0 }, { x: 0.16, y: 0 }, { x: belly, y: height * 0.35 },
        { x: neck, y: height * 0.8 }, { x: neck + 0.05, y: height }, { x: 0, y: height }];
      return [`mesh/vase-${i}`, createRevolutionGeometry(profile, 32).unwrap()];
    }));
    // Extrude a toothed contour with a hole along Z (centred), bevelling both rims.
    const teeth = 9 + Math.floor(rand.next() * 4);
    const gear = createExtrusionGeometry(loop(teeth * 4, (i) => (i % 4 < 2 ? 0.55 : 0.44)), 0.18,
      { holes: [loop(24, () => 0.14)], bevelSize: 0.03, bevelSegments: 2 }).unwrap();
    // Sweep a star section along a leaning spine; `up` must not be parallel to the first tangent.
    const lean = (rand.next() - 0.5) * 0.8;
    const spine = Array.from({ length: 24 }, (_, i): Vec3Point => [Math.sin((i / 23) * Math.PI) * lean, (i / 23) * 1.8, 0]);
    const column = createProfileSweepGeometry({ contour: loop(10, (i) => (i % 2 ? 0.09 : 0.2)) }, spine,
      { up: [1, 0, 0] }).unwrap();
    // Sweep a round tube along a sampled Catmull-Rom curve; sampling density is the author's.
    const knots = [[-0.7, 0, 0], [-0.6, 1.1 + rand.next() * 0.4, 0], [0.6, 1.1 + rand.next() * 0.4, 0], [0.7, 0, 0]];
    const point = vec3.create();
    const arch = Array.from({ length: 40 }, (_, i): Vec3Point => {
      curve3.catmullRom(point, knots, i / 39);
      return [point[0]!, point[1]!, point[2]!];
    });
    const pipe = createSweepGeometry(arch, 0.06, 12).unwrap();
    return ok({ ...vases, 'mesh/gear': gear, 'mesh/column': column, 'mesh/pipe': pipe,
      'material/glaze': Materials.standard({ baseColor: '#3f7fa6', roughness: 0.25 }),
      'material/brass': Materials.standard({ baseColor: '#c9a043', metallic: 1, roughness: 0.35 }),
      'material/marble': Materials.standard({ baseColor: '#e8e2d6', roughness: 0.6 }),
      'material/copper': Materials.standard({ baseColor: '#b8673e', metallic: 1, roughness: 0.4 }),
      'material/leaf': Materials.standard({ baseColor: '#4f9a3a', roughness: 0.7 }), // growth.ts
      'material/shard': Materials.standard({ baseColor: '#8c8f96', roughness: 0.8 }), // growth.ts
    });
  },
});
```

```ts file=assets/play/props.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Time, Update, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine/scene';
import { PROPS_PACKAGE, VASE_COUNT } from './props.pack.ts';

/** Pack and game share only the package id; each output GUID derives from its sourceKey. */
export const propGuid = (key: string) => AssetGuid.format(AssetGuid.derive(PROPS_PACKAGE, key));

export async function* installProps(world: World, assets: AssetRegistry) {
  const placed: [mesh: string, material: string, pos: [number, number, number]][] = [
    ...Array.from({ length: VASE_COUNT }, (_, i): [string, string, [number, number, number]] =>
      [`vase-${i}`, 'glaze', [-6 + i * 0.9, 0, 1.5]]),
    ['gear', 'brass', [-2, 0.62, 1.5]], ['column', 'marble', [0.5, 0, 1.5]], ['pipe', 'copper', [2.5, 0, 1.5]],
  ];
  const [meshes, materials] = await Promise.all([
    Promise.all(placed.map(async ([mesh]) => (await assets.load(propGuid(`mesh/${mesh}`), 'mesh')).unwrap())),
    Promise.all(placed.map(async ([, material]) => (await assets.load(propGuid(`material/${material}`), 'material')).unwrap())),
  ]);
  yield () => { for (const handle of [...meshes, ...materials]) assets.release(handle).unwrap(); };
  const props = placed.map(([, , pos], i) => world.spawn(
    { component: Transform, data: { pos } },
    { component: MeshFilter, data: { assetHandle: meshes[i]! } },
    { component: MeshRenderer, data: { materials: [materials[i]!] } },
  ).unwrap());
  yield () => { for (const entity of props) world.despawn(entity).unwrap(); };
  const gear = props[VASE_COUNT]!, spin = quat.create();
  world.addSystem(Update, {
    name: 'play-gear-spin', before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      quat.fromAxisAngle(spin, [0, 0, 1], world.getResource(Time).elapsed * 0.8);
      world.set(gear, Transform, { quat: spin }).unwrap();
    },
  }).unwrap();
  yield () => world.removeSystem(Update, 'play-gear-spin').unwrap();
}
```

## Meshes generated during play

Content that exists only because of play (a stem that grows, debris from a hit, water
that deforms) has no Pack declaration: build a `MeshAsset` in code and `assets.create` it.
The caller owns the returned handle; an ECS binding takes its own reference, so release
yours once nothing else writes to the mesh, and despawning the last user frees it.
Change a live mesh with `writeRange` when the vertex and index counts stay the same (cheap,
per frame) or `replace` with a complete new `MeshAsset` when its topology changes. The
materials still come from the Pack. Per-frame material `values` edits cannot move vertices.

The stem is one swept tube whose positions are rewritten every frame: rows past the
growth front collapse onto it, so it grows smoothly to a point. Each debris burst creates
fresh meshes with `createMeshBuilder`, which fills any missing normal, UV and tangent
streams, so positions and indices are enough.
A fixed gameplay seed makes every run drop the same shards.

```ts file=assets/play/growth.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Time, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { createMeshBuilder, createSweepGeometry, type Vec3Point } from '@forgeax/engine/geometry';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import { type Rng, rng } from '@forgeax/engine/math';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { propGuid } from './props.ts';

const ROWS = 48, SIDES = 8, RING = SIDES + 1, GROW = 8; // path samples, tube sides, ring vertices, rows/s
const ROOT = [4.5, 0, 1.5] as const;
const PATH = Array.from({ length: ROWS }, (_, i): Vec3Point => {
  const t = i / (ROWS - 1);
  return [Math.cos(t * 10) * 0.3 * t, t * 2.6, Math.sin(t * 10) * 0.3 * t];
});

/** Restore the front's row and collapse the rest onto the front point; earlier rows are already final. */
function front(full: Float32Array, grown: number) {
  const k = Math.min(ROWS - 2, Math.floor(grown)), f = Math.min(1, grown - k);
  const a = PATH[k]!, b = PATH[k + 1]!;
  const values = full.slice(k * RING * 3, ROWS * RING * 3);
  for (let i = RING * 3; i < values.length; i += 3)
    for (let axis = 0; axis < 3; axis++) values[i + axis] = a[axis] + (b[axis] - a[axis]) * f;
  return { attribute: 'position', first: k * RING, values } as const;
}

/** A flat-shaded random tetrahedron around the origin, with outward faces. */
function shard(rand: Rng) {
  const corners = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((c) => c.map((v) => v * (0.08 + rand.next() * 0.1)));
  const position: number[] = [], normal: number[] = [], uv: number[] = [];
  for (const [i, j, k] of [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]] as const) {
    const a = corners[i]!, u = corners[j]!.map((v, x) => v - a[x]!), w = corners[k]!.map((v, x) => v - a[x]!);
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const outward = n[0]! * a[0]! + n[1]! * a[1]! + n[2]! * a[2]! > 0; // counter-clockwise from outside
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) * (outward ? 1 : -1);
    position.push(...a, ...corners[outward ? j : k]!, ...corners[outward ? k : j]!);
    for (let v = 0; v < 3; v++) normal.push(n[0]! / length, n[1]! / length, n[2]! / length);
    uv.push(0, 0, 1, 0, 0, 1);
  }
  const attributes = { position: new Float32Array(position), normal: new Float32Array(normal), uv: new Float32Array(uv) };
  return createMeshBuilder({ attributes, indices: [...Array(12).keys()] }).build().unwrap();
}

export async function* installGrowth(world: World, assets: AssetRegistry) {
  const [leaf, stone] = await Promise.all(['leaf', 'shard'].map(async (key) =>
    (await assets.load(propGuid(`material/${key}`), 'material')).unwrap()));
  yield () => { assets.release(leaf!).unwrap(); assets.release(stone!).unwrap(); };
  const source = createSweepGeometry(PATH, 0.05, SIDES).unwrap();
  const full = source.attributes.position; // create() captures its own copy; this one stays ours
  if (!(full instanceof Float32Array)) throw new Error('factory positions are Float32Array');
  const mesh = assets.create(source).unwrap(); // caller-owned reference, kept for writeRange
  yield () => assets.release(mesh).unwrap();
  assets.writeRange(mesh, front(full, 0)).unwrap();
  const stem = world.spawn({ component: Transform, data: { pos: [...ROOT] } },
    { component: MeshFilter, data: { assetHandle: mesh } }, { component: MeshRenderer, data: { materials: [leaf!] } }).unwrap();
  yield () => world.despawn(stem).unwrap();
  const rand = rng.create(42), debris: { entity: EntityHandle; until: number }[] = [];
  let nextBurst = 1;
  world.addSystem(Update, {
    name: 'play-growth', queries: [],
    fn() {
      const { elapsed } = world.getResource(Time);
      const cycle = (elapsed * GROW) % (ROWS + 2 * GROW); // grow, hold two seconds, regrow
      assets.writeRange(mesh, front(full, Math.min(ROWS - 1, cycle))).unwrap();
      if (elapsed >= nextBurst) {
        nextBurst = elapsed + 3;
        for (let i = 0; i < 6; i++) {
          const handle = assets.create(shard(rand)).unwrap();
          const entity = world.spawn(
            { component: Transform, data: { pos: [ROOT[0] + 1.2 + rand.next() - 0.5, 2.5 + rand.next(), ROOT[2] + rand.next() - 0.5] } },
            { component: MeshFilter, data: { assetHandle: handle } },
            { component: MeshRenderer, data: { materials: [stone!] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 0.2 } },
            { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.1 } },
          ).unwrap();
          assets.release(handle).unwrap(); // MeshFilter now holds the only reference
          debris.push({ entity, until: elapsed + 4 });
        }
      }
      while (debris[0] !== undefined && debris[0].until <= elapsed)
        world.despawn(debris.shift()!.entity).unwrap(); // last reference dropped: the shard mesh is freed
    },
  }).unwrap();
  yield () => {
    world.removeSystem(Update, 'play-growth').unwrap();
    for (const { entity } of debris) world.despawn(entity).unwrap();
  };
}
```

`play.ts` composes both after `installState`. The props Pack is an ordinary Pack under
`assets/` and needs no forge.json root.
