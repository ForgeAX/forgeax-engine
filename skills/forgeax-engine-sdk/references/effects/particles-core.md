# Particles: engine for rain, snow, sparks, bubbles, dust, fire, smoke, magic

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

Presets live in one small file per effect: [particles-rain-snow.md](particles-rain-snow.md),
[particles-sparks.md](particles-sparks.md) (sparks, embers, glow halo),
[particles-fire-smoke.md](particles-fire-smoke.md),
[particles-magic-dust.md](particles-magic-dust.md) (magic, bubbles, dust). Copy this file and
only the preset files you use. `emit` is returned by `installParticles`; its result stops that field.

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

export const box = (r: Rng, x: number, y0: number, y1: number, z: number): V3 =>
  [(r.next() - 0.5) * x, y0 + r.next() * (y1 - y0), (r.next() - 0.5) * z];
export const fade = (p: Particle, t: number, alpha: number) => { p.rgba[3] = alpha * (1 - t); };

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

`play.ts` lights a brazier with `emit(fire, …)` and its smoke. Weather is one
field over the play area (`emit(snow, [0, 0, 0])`); a hit calls
`emit(sparks, pos)`, and the burst removes itself when its sparks die.
