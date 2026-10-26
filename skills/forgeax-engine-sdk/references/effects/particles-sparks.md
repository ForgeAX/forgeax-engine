# Particles: sparks, embers and glow halo

Needs the engine in [particles-core.md](particles-core.md) (`assets/play/particles.ts`). Pass the preset to `emit(preset, position)`.

**Soft sparks and embers.** The default preset shape is `soft` with the `glow` blend. Use
`shape: 'square'` only for hard streaks such as rain: a spark overridden to `square` renders as
big square blobs.

**Glow halo** (lamp, pickup, star; Three `Sprite` with `AdditiveBlending`, a radial-gradient
`CanvasTexture` `map`, `depthWrite: false`, `fog: false`). One `point-list` mesh, two points on
the source, `Points { sizeUnits: world, shape: soft }` and the additive `glow` material with
`renderState: { fog: false }`; per-point `uv1.x` scales the size, the `color` stream sets alpha:

| point | world diameter | alpha |
|---|---|---|
| core | 1.5 x source diameter | 1 |
| halo | 5 x source diameter | 0.25 |

A Three `CanvasTexture` gradient with stops (0: 1, .25: .6, .6: .15, 1: 0) is the equivalent
falloff to aim for. In the benchmark a Three halo had a half-radius of about 8 px on screen;
size yours to match. Halos sum additively: keep the sum of overlapping alphas under about 0.6.

**Glow brightness budget.** Do not scale `emissiveIntensity` or a glow colour linearly with a
game value (pickups, combo): it clips to flat 255 patches. Clamp it, e.g.
`Math.min(base + count * step, cap)`, with the cap near twice the camera `bloomThreshold`.

```ts file=assets/play/particles-sparks.ts
import { box, fade, type ParticlePreset } from './particles.ts';
export const sparks: ParticlePreset = { count: 120, size: 0.1, shape: 'soft', blend: 'glow', gravity: 9, once: true, spawn(p, r) {
  const a = r.next() * Math.PI * 2, s = 2 + r.next() * 5; p.v = [Math.cos(a) * s, 2 + r.next() * 4, Math.sin(a) * s];
  p.life = 0.5 + r.next() * 0.6; p.rgba = [4, 1.6, 0.4, 1]; }, look(p, t) { fade(p, t, 1); p.size = 1 - t * 0.6; } };
```
