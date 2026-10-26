# Particles: rain and snow

Needs the engine in [particles-core.md](particles-core.md) (`assets/play/particles.ts`). Pass the preset to `emit(preset, position)`.

Rain is a `Lines` streak field (`square` shape, haze blend); snow is soft points that sway. Both are one field over the play area; add a matching `Fog` for a dense volume.

```ts file=assets/play/particles-rain-snow.ts
import { box, fade, type ParticlePreset } from './particles.ts';
export const rain: ParticlePreset = { count: 1200, size: 0.02, shape: 'square', blend: 'haze', streak: 0.03, spawn(p, r) {
  p.p = box(r, 30, 12, 12, 30); p.v = [1, -16 - r.next() * 4, 0]; p.life = 12 / 16; } };
export const snow: ParticlePreset = { count: 1200, size: 0.12, shape: 'soft', blend: 'haze', spawn(p, r) {
  p.p = box(r, 30, 10, 10, 30); p.v = [0.4, -0.8 - r.next() * 0.6, 0]; p.life = 14; p.rgba = [1, 1, 1, 0.9];
  p.size = 0.5 + r.next() * 0.5; }, look(p, t) { p.v[0] = 0.4 + Math.sin(t * 20 + p.seed * 6) * 0.5; } };
```
