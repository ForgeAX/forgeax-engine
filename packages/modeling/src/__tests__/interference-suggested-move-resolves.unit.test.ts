import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

type Shift = readonly [number, number, number];
const plus = (c: readonly [number, number, number], s: Shift): [number, number, number] => [
  c[0] + s[0],
  c[1] + s[1],
  c[2] + s[2],
];

function pair(build: (m: Model, shift: Shift) => void, shift: Shift = [0, 0, 0], contacts = false) {
  const m = model();
  build(m, shift);
  const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
  r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
  const t = r.interference(
    {},
    {
      tolerance: 0.001,
      ...(contacts
        ? { contacts: [{ parts: ['a', 'b'] as [string, string], tolerance: 0.5 }] }
        : {}),
    },
  );
  if (!t.ok) throw t.error;
  return t.value.pairs.find((p) => p.parts.includes('a') && p.parts.includes('b'));
}

// The moved scene is rebuilt with part b's geometry shifted, so the check does not depend on translate semantics.
const cases: Record<string, (m: Model, s: Shift) => void> = {
  contained: (m, s) => {
    m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 0], label: 'a' });
    m.box({ size: [0.1, 0.1, 0.1], center: plus([0.02, 0, 0], s), label: 'b' });
  },
  rotatedBoth: (m, s) => {
    m.box({ size: [0.4, 0.05, 0.1], center: [0, 0, 0], label: 'a' });
    m.rotate(sel.createdBy('a'), 'z', 45);
    const c = plus([0.02, -0.02, 0], s);
    m.box({ size: [0.4, 0.05, 0.1], center: c, label: 'b' });
    m.rotate(sel.createdBy('b'), 'z', 45, c);
  },
  rotatedB: (m, s) => {
    m.box({ size: [0.4, 0.4, 0.05], center: [0, 0, 0], label: 'a' });
    const c = plus([0, 0, 0.1], s);
    m.box({ size: [0.3, 0.02, 0.3], center: c, label: 'b' });
    m.rotate(sel.createdBy('b'), 'y', 30, c);
  },
  deepPlunge: (m, s) => {
    m.box({ size: [0.4, 0.2, 0.4], center: [0, 0, 0], label: 'a' });
    m.box({ size: [0.05, 0.5, 0.05], center: plus([0, 0.15, 0], s), label: 'b' });
  },
};

describe('F-4 suggestedMove resolves the pair it is emitted for', () => {
  for (const [name, build] of Object.entries(cases)) {
    it(`${name}: the suggested move leaves no confirmed interference`, () => {
      const p = pair(build);
      expect(p?.status).toBe('confirmed');
      const move = p?.suggestedMove;
      expect(move).toBeDefined();
      const after = pair(build, move as Shift);
      expect(after === undefined || after.status !== 'confirmed').toBe(true);
    });
  }

  it('a designed pair carries no suggestion', () => {
    const p = pair(cases.contained as (m: Model, s: Shift) => void, [0, 0, 0], true);
    expect(p?.status).toBe('designed');
    expect(p?.suggestedMove).toBeUndefined();
  });
});
