import { expect, it } from 'vitest';
import { booleanSolids } from '../boolean.ts';
import { box, cylinder } from '../build.ts';
import { measure } from '../measure.ts';
import { type ProfileSegment, revolveProfile } from '../revolve-profile.ts';
import { IDENTITY_PLACEMENT, transformShape } from '../transform.ts';
import type { Frame, Shape } from '../types.ts';
import { validate } from '../validate.ts';

function volumeOf(shape: Shape): number {
  const m = measure(shape);
  if (!m.ok) throw new Error('measure');
  return m.value.volume;
}

function flushStud(z: number): { box: Shape; boss: Shape } {
  const B = box({ size: [2.6, 1, 1], label: 'box' });
  const c = cylinder({ radius: 0.3, height: 0.5, label: 'boss' });
  if (!B.ok || !c.ok) throw new Error('build');
  const placed = transformShape(c.value, { ...IDENTITY_PLACEMENT, t: [0, 0, z] });
  if (!placed.ok) throw new Error('place');
  return { box: B.value, boss: placed.value };
}

it('unions a flush stud whose base lies on the box top and keeps the closed-form volume', () => {
  const { box: B, boss: C } = flushStud(0.75);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(validate(r.value).ok).toBe(true);
  expect(Math.abs(volumeOf(r.value) - (2.6 + Math.PI * 0.09 * 0.5))).toBeLessThan(1e-9);
});

const alongX = (o: [number, number, number]): Frame => ({
  o,
  x: [0, 1, 0],
  y: [0, 0, 1],
  z: [1, 0, 0],
});
const line = (to: [number, number]): ProfileSegment => ({ kind: 'line', to });

it('unions a flange and a header that meet on a coaxial annulus', () => {
  const bore = 0.38;
  const flange = revolveProfile({
    start: [bore, 0],
    segments: [line([0.8, 0]), line([0.8, 0.25]), line([bore, 0.25]), line([bore, 0])],
    frame: alongX([-0.25, 0, 0]),
    label: 'flange',
    role: 'flange',
  });
  const header = revolveProfile({
    start: [bore, 0],
    segments: [line([0.5, 0]), line([0.5, 6]), line([bore, 6]), line([bore, 0])],
    frame: alongX([0, 0, 0]),
    label: 'header',
    role: 'header',
  });
  if (!flange.ok || !header.ok) throw new Error('build');
  const r = booleanSolids(flange.value, header.value, 'union');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(validate(r.value).ok).toBe(true);
  expect(volumeOf(r.value)).toBeCloseTo(volumeOf(flange.value) + volumeOf(header.value), 9);
});
