import { expect, it } from 'vitest';
import { booleanSolids } from '../boolean.ts';
import { box, cylinder } from '../build.ts';
import { measure } from '../measure.ts';
import { IDENTITY_PLACEMENT, transformShape } from '../transform.ts';
import { validate } from '../validate.ts';

function boss(z: number, h: number) {
  const B = box({ size: [2.6, 1, 1], label: 'box' });
  const c = cylinder({ radius: 0.3, height: h, label: 'boss' });
  if (!B.ok || !c.ok) throw new Error('build');
  const placed = transformShape(c.value, { ...IDENTITY_PLACEMENT, t: [0, 0, z] });
  if (!placed.ok) throw new Error('place');
  return { box: B.value, boss: placed.value };
}

it('unions a boss rising through the top face and ends above it', () => {
  const { box: B, boss: C } = boss(0.5, 1);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (r.ok) expect(validate(r.value).ok).toBe(true);
});

it('unions a boss that starts inside the box and crosses the top face', () => {
  const { box: B, boss: C } = boss(0.3, 0.5);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (r.ok) expect(validate(r.value).ok).toBe(true);
});

it('unions a boss fully inside the box with the box top beyond it', () => {
  const { box: B, boss: C } = boss(0.2, 0.3);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (r.ok) expect(validate(r.value).ok).toBe(true);
});

it('unions a boss crossing the top face with the closed-form volume', () => {
  const { box: B, boss: C } = boss(0.5, 0.5);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const m = measure(r.value);
  expect(m.ok).toBe(true);
  if (m.ok) expect(Math.abs(m.value.volume - (2.6 + Math.PI * 0.09 * 0.25))).toBeLessThan(1e-9);
});

it('unions a flush boss whose base is coplanar with the box top', () => {
  const { box: B, boss: C } = boss(0.75, 0.5);
  const r = booleanSolids(B, C, 'union');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const m = measure(r.value);
  expect(m.ok).toBe(true);
  if (m.ok) expect(Math.abs(m.value.volume - (2.6 + Math.PI * 0.09 * 0.5))).toBeLessThan(1e-9);
});
