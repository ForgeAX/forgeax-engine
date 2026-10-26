# Lighting presets and a shadowed desk lamp

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
import { Camera, DirectionalLight, DirectionalShadowFilterValue, Fog, FogModeValue, GradientSky, type GradientSkyPreset, GradientSkyPresets, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';

type Rgb = [number, number, number];
interface Preset {
  exposure: number;
  sky: GradientSkyPreset; // shown as set; spread over a preset to change one field
  fill: { color: Rgb; groundColor?: Rgb; intensity: number }; // Skylight: Three HemisphereLight / π
  sun: { direction: Rgb; color: Rgb; intensity: number }; // lux; the sky draws its disc toward -direction
  fog?: { color: Rgb; near: number; far: number }; // linear, from past the playfield to the horizon
}
const PRESETS = {
  daylight: { exposure: 1.1, sky: GradientSkyPresets.daylight,
    fill: { color: [1, 0.94, 0.76], groundColor: [0.17, 0.3, 0.16], intensity: 0.7 }, // warm sky over green ground
    sun: { direction: [0.5, -0.8, 0.4], color: [1, 0.94, 0.84], intensity: 3 } }, // daylight boards get no fog
  dusk: { exposure: 1, sky: GradientSkyPresets.dusk, // orange -> rose -> violet, three stops
    fill: { color: [0.55, 0.45, 0.6], groundColor: [0.15, 0.08, 0.06], intensity: 0.4 },
    sun: { direction: [0.35, -0.08, 0.93], color: [1, 0.55, 0.3], intensity: 2.5 }, // 5° above the horizon
    fog: { color: [1.2, 0.35, 0.12], near: 20, far: 60 } }, // ACES shows it as the horizon orange
  night: { exposure: 1, sky: GradientSkyPresets.night,
    fill: { color: [0.6, 0.7, 1], intensity: 0.12 }, // low fill keeps lamp pools visible
    sun: { direction: [-0.4, -0.25, 0.85], color: [0.7, 0.8, 1], intensity: 0.4 }, // moon
    fog: { color: [0.03, 0.04, 0.07], near: 25, far: 70 } },
  overcast: { exposure: 1.1, sky: GradientSkyPresets.overcast,
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
`color.linearRgb('#e6ebe1')` from `@forgeax/engine/math`). Above the horizon it
blends `horizon` to `zenith`; below it, `horizon` to `ground`, which is also the backdrop
a top-down board or diorama camera sees (daylight uses a pale page colour). The sun or
moon disc follows the `DirectionalLight` (`direction` points from the light, so the disc
is toward `-direction`); `sunSize` is its angular radius in radians, 0 hides it, and
`sunGlow` sets the halo. Start from `GradientSkyPresets.<name>` and spread over it
(`{ ...GradientSkyPresets.dusk, sunSize: 0.03 }`) rather than retuning every colour.
With camera bloom the disc blooms like its reflection on water, so the two read as one
sun; to tame a glaring sea highlight raise the water's roughness or lower the sun
`intensity`, never shrink `sunSize` or `sunGlow` (that leaves a small dull disc above a
bright reflection: "two suns").
`exponent` shapes how fast the colour leaves the horizon, `pow(sin(elevation), exponent)`:
1 is linear, and below 0.3 the horizon colour collapses into a thin line (0.13 is already
59 % zenith 1° up), so never lower it to get "more zenith colour". A sky that blends two
complementary hues (orange to purple) passes through grey mauve: add a third stop with
`mid` and `midHeight` (its elevation sine, 0.25 is about 15°), as the dusk preset does. An opaque `Camera.clearColor` is different: it is scene-linear and
goes through exposure and the tone curve (#e6ebe1 shows as #c6c8c4), and a GradientSky
replaces it. Set `toneMapped: true` only when
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
Sunset fog must be that warm and bright: the fog replaces the sky's lowest band
(`fogBlend`), so a dull or grey fog (`[0.57, 0.23, 0.2]` shows as #d0978d) paints a dusty
pink strip where the orange horizon should be.

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
