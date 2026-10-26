# Point light and emissive at runtime

Write component fields with `world.set`; switch emissive by swapping the material handle.

Glow strength under ACES at exposure 1.1: emissive adds `emissive * emissiveIntensity` to the
lit colour before the tone curve, which rolls bright values toward white. Keep large glowing
areas (windows, screens, panels, signs) at `emissiveIntensity` 0.8-1.5 so they keep their hue;
at 3 a warm `#ffd27a` window shows as near-white `#f9f3de`. Reserve 3-10 for small bulbs,
eyes and sparks that should bloom (bloom threshold 1).

```ts file=assets/play/lanterns.ts
import { type World } from '@forgeax/engine/ecs';
import { MeshFilter, MeshRenderer, PointLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

/** Lamps start off; `light(i)` swaps the emissive material and raises the point light. */
export function* installLamps(world: World, positions: ReadonlyArray<readonly [number, number]>, ball: AssetHandle<'mesh'>,
  off: AssetHandle<'material'>, on: AssetHandle<'material'>, burst: (pos: [number, number, number]) => void) {
  const lamps = positions.map(([x, z]) => world.spawn(
    { component: Transform, data: { pos: [x, 1.6, z], scale: [0.5, 0.6, 0.5] } },
    { component: MeshFilter, data: { assetHandle: ball } },
    { component: MeshRenderer, data: { materials: [off] } },
    { component: PointLight, data: { color: [1, 0.45, 0.15], intensity: 0, range: 10 } }, // off until lit
  ).unwrap());
  yield () => { for (const lamp of lamps) world.despawn(lamp).unwrap(); };
  return {
    light(i: number) {
      const [x, z] = positions[i]!;
      world.set(lamps[i]!, MeshRenderer, { materials: [on] }).unwrap(); // emissive: swap material
      world.set(lamps[i]!, PointLight, { intensity: 40 }).unwrap(); // cd: ~16 lux below, ~4 lux 3 m out
      burst([x, 1.6, z]);
    },
  };
}
```
