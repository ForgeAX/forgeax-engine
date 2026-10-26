# Custom-shader water with a per-frame uniform

A custom Standard Surface keeps Engine lighting, shadows and fog: the WGSL returns
color, normal and roughness, so the spot light and sun give real specular highlights on
the waves. `input.frameTime` animates without a uniform; values the game owns, here the
beam direction, are written with `assets.update(handle, { values })` each frame. Waves
bend the shading normal; the mesh stays flat (no vertex displacement in a Surface).

For an ocean in the sense of Three.js `Water` / `Water2`, do not write a Surface: use the
stock `model: 'single-layer-medium'` material, which adds the sun glint, reflects a
`GradientSky` and fogs itself (render README "Single-layer medium Surface" and "Sea sun
and sky"). This Surface suits other animated Standard materials; it reads `positionWS`,
so a tide plane that rises with `Transform.pos.y` needs no change.
Keep wave normal strength about 1: a gain of 5 aliases into a checker/moire pattern near the horizon; damp stronger gains with distance.

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
  let v = input.viewDirectionWS;
  let fresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  let crest = smoothstep(0.06, 0.15, w.z);
  let body = mix(material.deepColor.rgb, material.shallowColor.rgb, clamp(crest * 0.4, 0.0, 1.0));
  // Glitter on the crests the beam sweeps over: compare the lamp-to-point heading with beamDir.
  let heading = normalize(p - material.lampPos.xz + vec2<f32>(1e-4, 0.0));
  let aim = dot(heading, normalize(material.beamDir.xz + vec2<f32>(1e-4, 0.0)));
  let beam = material.beamColor.rgb * smoothstep(0.985, 1.0, aim) * (0.2 + crest) * 2.0;
  return SurfaceData(body, n, 0.0, 0.06, vec3<f32>(fresnel * 0.1) + beam, 1.0, 1.0, 0.0);
}
```
