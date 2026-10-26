# Rotating spot light with an additive beam, and vertical light pillars

`SpotLight` lights the ground; an open cone mesh (`createConeGeometry(r, h, segments, 1, true)`)
adds only the glow and casts no shadow. Aim both from one system: `SpotLight.direction` (the light
ignores Transform rotation) and the cone's Transform. For lit air instead of a glow mesh use
`VolumetricFog { light: spot }` (`forgeax-engine-render-pipeline`).

```ts file=assets/play/lighthouse.ts
import { Time, Update, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
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
      { component: MeshFilter, data: { assetHandle: parts.box } }, { component: MeshRenderer, data: { materials: [parts.stone] } }),
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

The beam Surface is emission only, brightest on the axis and fading in from the apex and out to
the base and rim. Peak alpha near 0.1; additive blending sums both cone faces softly. Return
`surfaceEmissionOnly` (normal = view direction, occlusion 0): the Standard template otherwise adds
the sun's Fresnel glare and the sky reflection, and a zero-emission cone renders white.

```wgsl file=assets/play/beam.surface.wgsl
#define_import_path play::beam_surface

#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput, surfaceEmissionOnly}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let along = clamp(0.5 - input.positionOS.y, 0.0, 1.0); // 0 at the apex, 1 at the base cap
  let facing = abs(dot(normalize(input.vertexNormalWS), input.viewDirectionWS));
  let glow = facing * facing * smoothstep(0.0, 0.15, along) * pow(1.0 - along, 1.6) * material.glow;
  return surfaceEmissionOnly(input, material.beamColor.rgb * glow, glow);
}
```

## Vertical light pillars

A pillar of light is a thin, tapered, **open** cylinder (`createCylinderGeometry(rTop, rBottom, h,
32, 1, true)`, Three `CylinderGeometry(..., openEnded)`) scaled in height only, with the same
emission-only Surface. Fade with `positionOS.y`, not `1 - uv0.y`: `createCylinderGeometry` has V=0
at the top, the reverse of Three's `vUv.y`. Three `ShaderMaterial` colours are display values;
scale them to about `value^1.5` linear. Keep the peak below about 0.2 and below `bloomThreshold`.
Alpha blend `zero / one` keeps the destination alpha, so a display `GradientSky` still shows.

```ts file=assets/play/pillars.ts
import type { World } from '@forgeax/engine/ecs';
import { MeshFilter, MeshRenderer, ShadowParticipation } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle } from '@forgeax/engine/types';

const HEIGHT = 18; // metres; the unit mesh is scaled in height only

export function installPillars(world: World, mesh: AssetHandle<'mesh'>, material: AssetHandle<'material'>,
  spots: readonly (readonly [number, number])[]) {
  const pillars = spots.map(([x, z]) => world.spawn({ component: Transform, data: { pos: [x, HEIGHT / 2, z], scale: [1, HEIGHT, 1] } },
    { component: MeshFilter, data: { assetHandle: mesh } }, { component: MeshRenderer, data: { materials: [material] } },
    { component: ShadowParticipation, data: { cast: false, receive: false } }).unwrap());
  return () => { for (const pillar of pillars) world.despawn(pillar).unwrap(); };
}
```

```wgsl file=assets/play/pillar.surface.wgsl
#define_import_path play::pillar_surface

#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput, surfaceEmissionOnly}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let v = clamp(input.positionOS.y + 0.5, 0.0, 1.0); // 0 at the base, 1 at the top
  let facing = abs(dot(normalize(input.vertexNormalWS), input.viewDirectionWS)); // 0 at the silhouette edge
  let bands = 0.75 + 0.25 * sin(v * 40.0 - input.frameTime * 3.0); // scrolling upwards
  let glow = pow(1.0 - v, 1.5) * facing * bands * material.glow;
  return surfaceEmissionOnly(input, material.pillarColor.rgb * glow, glow);
}
```
