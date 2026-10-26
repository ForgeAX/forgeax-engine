# Particles: magic motes, bubbles and dust

Needs the engine in [particles-core.md](particles-core.md) (`assets/play/particles.ts`). Pass the preset to `emit(preset, position)`.

Magic is additive motes spiralling up; bubbles rise and sway; dust is a sandstorm crossing the scene (pair with a matching `Fog`).

```ts file=assets/play/particles-magic-dust.ts
import { box, fade, type ParticlePreset } from './particles.ts';
export const magic: ParticlePreset = { count: 200, size: 0.15, shape: 'soft', blend: 'glow', spawn(p, r) {
  p.life = 2 + r.next() * 2; p.rgba = [0.4, 0.7 + r.next() * 0.3, 3, 1]; },
  look(p, t) { const a = p.seed * 6.28 + t * 6, h = t * 2.5; // motes spiral up around the origin
    p.p = [Math.cos(a) * (1 - t * 0.5), h, Math.sin(a) * (1 - t * 0.5)]; fade(p, t, 1); } };
export const bubbles: ParticlePreset = { count: 150, size: 0.25, shape: 'soft', blend: 'haze', spawn(p, r) {
  p.p = box(r, 4, 0, 0.5, 4); p.v = [0, 0.6 + r.next() * 0.6, 0]; p.life = 6; p.rgba = [0.75, 0.9, 1, 0.5];
  p.size = 0.3 + r.next() * 0.7; }, look(p, t) { p.v[0] = Math.sin(t * 25 + p.seed * 6) * 0.3; } };
export const dust: ParticlePreset = { count: 2500, size: 0.6, shape: 'soft', blend: 'haze', spawn(p, r) { // a sandstorm crossing the scene
  p.p = box(r, 1, 0, 6, 40); p.p[0] -= 20; p.v = [6 + r.next() * 3, (r.next() - 0.5) * 0.6, (r.next() - 0.5) * 2];
  p.life = 40 / p.v[0]; p.rgba = [0.78, 0.62, 0.4, 0.25]; p.size = 0.4 + r.next() * 0.6; } };
```
