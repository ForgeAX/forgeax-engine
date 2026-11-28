import { expect, it } from 'vitest';
import { booleanSolids } from '../boolean.ts';
import { measure } from '../measure.ts';
import { type ProfileSegment, revolveProfile } from '../revolve-profile.ts';
import type { Frame, Shape } from '../types.ts';
import { validate } from '../validate.ts';

const alongX = (o: [number, number, number]): Frame => ({
  o,
  x: [0, 1, 0],
  y: [0, 0, 1],
  z: [1, 0, 0],
});
const line = (to: [number, number]): ProfileSegment => ({ kind: 'line', to });
function must(r: { ok: true; value: Shape } | { ok: false; error: unknown }): Shape {
  if (!r.ok) throw new Error('build');
  return r.value;
}
function volumeOf(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error('measure');
  return m.value.volume;
}
const tube = (): Shape =>
  must(
    revolveProfile({
      start: [0.38, 0],
      segments: [line([0.5, 0]), line([0.5, 6]), line([0.38, 6]), line([0.38, 0])],
      frame: alongX([0, 0, 0]),
      label: 'tube',
      role: 'header',
    }),
  );
const ring = (x0: number): Shape =>
  must(
    revolveProfile({
      start: [0.5, 0],
      segments: [line([0.62, 0]), line([0.62, 0.3]), line([0.5, 0.3]), line([0.5, 0])],
      frame: alongX([x0, 0, 0]),
      label: 'ring',
      role: 'stiffener',
    }),
  );

// A stiffener seated on the tube: its bore lies exactly on the tube's outer cylinder over the ring's
// whole length. Materials meet on that surface, so the overlapped band is interior and the union is the
// tube plus the ring with no overlap volume.
it.each([
  1.8, 3.9,
])('unions a stiffener ring at x=%s seated on the tube with a coincident bore', (x0) => {
  const t = tube();
  const rg = ring(x0);
  const r = booleanSolids(t, rg, 'union');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(validate(r.value).ok).toBe(true);
  expect(Math.abs(volumeOf(r.value) - (volumeOf(t) + volumeOf(rg)))).toBeLessThan(1e-6);
});

// Only the union is supported for a coincident coaxial contact; a difference stays refused, never guessed.
it('keeps a difference across a coincident coaxial bore refused', () => {
  const r = booleanSolids(tube(), ring(1.8), 'difference');
  expect(r.ok).toBe(false);
});
