# Fade out one entity (per-entity tint and opacity)

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
