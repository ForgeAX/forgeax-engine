# Gameplay cookbook for an `empty` project

One small, complete 3D game in copyable files: a WASD/jump character, a follow camera,
pushable crates, lanterns that switch on a point light, emissive material and a spark burst,
a lighthouse whose rotating spot light carries an additive beam over custom-shader water,
a DOM HUD, and a state read for a keyboard playthrough test. The TypeScript `file=` blocks
compile against current Engine in a copy of `templates/empty` through
`pnpm test:sdk:contracts`; `scripts/forgeax/__tests__/sdk-gameplay-cookbook.test.mjs` also checks
the VFX package and material GUIDs. Use the same `@forgeax/engine/<dir>` imports in your game.

Copy the blocks to the named paths, then point `forge.json` at the two plugin assets:
`roots.engine` = `AssetGuid.format(AssetGuid.derive(PLAY_PACKAGE, 'plugin/engine'))` and
`roots.frontend` = the same for `'plugin/hud'`. Replace the package IDs with your own.
When replacing `assets/scene-owner.pack.ts` and `assets/world/`, update or remove the
starter-scene test in `assets/__tests__/empty-project.test.ts`; keep its manifest test
and add assertions for your new root GUIDs.

| Recipe | File | Owner skill for details |
|:--|:--|:--|
| 0. Content pack and composition | `play.pack.ts`, `play.ts` | `forgeax-engine-assets`, `forgeax-engine-app` |
| 1. Character controller (WASD + jump) | `player.ts` | `forgeax-engine-physics` |
| 2. Third-person follow camera | `follow-camera.ts` | `templates/game-3d/assets/camera/` adds mouse orbit |
| 3. Dynamic rigid-body boxes | `crates.ts` | `forgeax-engine-physics` |
| 4. Runtime point light + emissive swap | `lanterns.ts` | `forgeax-engine-render-pipeline`, `forgeax-engine-material` |
| 5. One-shot VFX burst | `spark.pack.json`, `spark.vfx.wgsl`, `burst.ts` | `forgeax-engine-vfx` |
| 6. DOM HUD bound to game state | `hud.ts` | `forgeax-engine-app` |
| 7. Game state for a playthrough test | `state.ts`, `scripts/playthrough.mjs` | `forgeax-engine-cli` |
| 8. Rotating spot light with an additive beam | `lighthouse.ts`, `beam.surface.wgsl` | `forgeax-engine-render-pipeline` |
| 9. Custom-shader water fed a uniform per frame | `water.ts`, `water.surface.wgsl` | `forgeax-engine-material`, `forgeax-engine-shader` |

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
      'mesh/ball': createSphereGeometry(0.5, 16, 12).unwrap(),
      'material/ground': Materials.standard({ baseColor: '#d8e4ea', roughness: 0.9 }),
      'material/crate': Materials.standard({ baseColor: '#9a6f4f', roughness: 0.8 }),
      'material/lamp-off': Materials.standard({ baseColor: '#5a2a24', emissive: '#ff6826', emissiveIntensity: 0.1 }),
      'material/lamp-on': Materials.standard({ baseColor: '#ffb953', emissive: '#ff8229', emissiveIntensity: 6 }),
      'material/spark': Materials.standard({ baseColor: '#ff9a3c', emissive: '#ff7a1a', emissiveIntensity: 10 }),
      'mesh/cone': createConeGeometry(1, 1, 48).unwrap(), // apex at +y 0.5, base at -y 0.5
      'material/stone': Materials.standard({ baseColor: '#bdb6a8', roughness: 0.85 }),
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
import { BLOOM_ENABLED, Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { loadVfxGpuEffect } from '@forgeax/engine/vfx';
import { installPlayer } from './player.ts';
import { installFollowCamera } from './follow-camera.ts';
import { spawnCrates } from './crates.ts';
import { installBursts } from './burst.ts';
import { installLanterns } from './lanterns.ts';
import { installState } from './state.ts';
import { installLighthouse } from './lighthouse.ts';
import { installWater } from './water.ts';

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
      const effect = (await loadVfxGpuEffect(assets, spark)).unwrap();
      held.push(effect);
      const [camera, ...stage] = [
        world.spawn({ component: Transform, data: { pos: [0, 6, 14] } }, { component: Camera, data: { fov: 0.9, bloom: BLOOM_ENABLED, bloomThreshold: 1, bloomIntensity: 0.4 } }),
        world.spawn({ component: Skylight, data: { intensity: 0.3 } }), // ambient fill
        world.spawn({ component: DirectionalLight, data: { direction: [0.5, -0.8, 0.4], intensity: 2, castShadow: true } }),
        world.spawn({ component: Transform, data: { pos: [0, -0.5, 0], scale: [60, 1, 60] } }, // ground: static box
          { component: MeshFilter, data: { assetHandle: box } }, { component: MeshRenderer, data: { materials: [ground] } },
          { component: RigidBody, data: { type: RigidBodyTypeValue.static } }, { component: Collider, data: {} }),
      ].map((spawned) => spawned.unwrap());
      yield () => { for (const entity of [camera!, ...stage]) world.despawn(entity).unwrap(); };
      const player = yield* installPlayer(world, ball, crate);
      yield installFollowCamera(world, player, camera!);
      yield spawnCrates(world, box, crate);
      const burst = yield* installBursts(world, effect);
      const lit = yield* installLanterns(world, player, ball, lampOff, lampOn, burst);
      const feedWater = yield* installWater(world, assets, box, water);
      yield installLighthouse(world, { box, ball, cone, stone, lamp: lampOn, beam }, feedWater);
      yield installState(world, ctx.gameHost!, player, lit);
    }, 'play/engine');
  },
};
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
    { component: PointLight, data: { color: [1, 0.45, 0.15], intensity: 0, range: 8 } }, // off until lit
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
        world.set(lamps[i]!, PointLight, { intensity: 30 }).unwrap(); // light: write the component
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
Transform. The beam opts out of shadows so it does not occlude its own light. For a lit
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

Run `pnpm typecheck`, then `node scripts/playthrough.mjs`; check `artifacts/playthrough/`.
