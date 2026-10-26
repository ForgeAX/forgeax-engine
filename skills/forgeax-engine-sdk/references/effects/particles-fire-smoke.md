# Particles: fire and smoke

Needs the engine in [particles-core.md](particles-core.md) (`assets/play/particles.ts`). Pass the preset to `emit(preset, position)`.

Fire is additive (`glow`) with colours above 1 so it blooms; smoke is alpha-blended (`haze`). Emit both at the same position for a brazier.

```ts file=assets/play/particles-fire-smoke.ts
import { box, fade, type ParticlePreset } from './particles.ts';
export const fire: ParticlePreset = { count: 160, size: 0.8, shape: 'soft', blend: 'glow', spawn(p, r) {
  p.p = box(r, 0.7, 0, 0.1, 0.7); p.v = [0, 1 + r.next(), 0]; p.life = 0.5 + r.next() * 0.6; },
  look(p, t) { p.rgba = [2, 0.2 + 0.7 * (1 - t), 0.1, 0.22 * (1 - t)]; p.size = 1 - t * 0.7; } }; // yellow core, red tips
export const smoke: ParticlePreset = { count: 120, size: 1.6, shape: 'soft', blend: 'haze', spawn(p, r) {
  p.p = box(r, 0.4, 0.8, 1, 0.4); p.v = [0.2 + (r.next() - 0.5) * 0.4, 0.6 + r.next() * 0.4, (r.next() - 0.5) * 0.4];
  p.life = 3 + r.next() * 2; p.rgba = [0.3, 0.3, 0.32, 0.12]; }, look(p, t) { fade(p, t, 0.12); p.size = 0.3 + t * 0.7; } };
```
