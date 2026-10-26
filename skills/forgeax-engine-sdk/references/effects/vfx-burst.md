# One-shot VFX burst

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
