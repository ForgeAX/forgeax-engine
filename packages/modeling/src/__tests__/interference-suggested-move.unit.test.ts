import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

function pairOf(build: (m: Model) => void) {
  const m = model();
  build(m);
  const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
  r.bindRigid(sel.createdBy('b'), 'root', { part: 'b' });
  const t = r.interference({}, { tolerance: 0.001 });
  if (!t.ok) throw t.error;
  return t.value.pairs[0];
}

const sunk = (dx: number) =>
  pairOf((m) => {
    m.box({ size: [0.4, 0.2, 0.4], center: [0, 0, 0], label: 'a' });
    m.box({ size: [0.2, 0.2, 0.2], center: [dx, 0.07, 0], label: 'b' });
  });

describe('interference suggestedMove', () => {
  it('moves the second part out along the least-overlap axis by depth plus tolerance', () => {
    const pair = sunk(0);
    expect(pair?.status).toBe('confirmed');
    const move = pair?.suggestedMove;
    expect(move?.[0]).toBe(0);
    expect(move?.[2]).toBe(0);
    expect(move?.[1]).toBeCloseTo((pair?.depth ?? 0) + 0.001, 12);
    expect(move?.[1]).toBeGreaterThan(0);
  });

  it('points the other way when the second part lies on the negative side', () => {
    const pair = pairOf((m) => {
      m.box({ size: [0.4, 0.2, 0.4], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.2, 0.2, 0.2], center: [0, -0.07, 0], label: 'b' });
    });
    expect(pair?.suggestedMove?.[1]).toBeCloseTo(-((pair?.depth ?? 0) + 0.001), 12);
  });

  it('mirrors across x: x component flips, the rest is unchanged', () => {
    const left = pairOf((m) => {
      m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.2, 0.2, 0.2], center: [0.18, 0.02, 0], label: 'b' });
    });
    const right = pairOf((m) => {
      m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.2, 0.2, 0.2], center: [-0.18, 0.02, 0], label: 'b' });
    });
    const l = left?.suggestedMove;
    const r = right?.suggestedMove;
    expect(l?.[0]).toBeGreaterThan(0);
    expect(r?.[0]).toBeCloseTo(-(l?.[0] ?? 0), 12);
    expect(r?.[1]).toBe(l?.[1]);
    expect(r?.[2]).toBe(l?.[2]);
  });

  it('is deterministic and absent without penetration', () => {
    expect(sunk(0)?.suggestedMove).toEqual(sunk(0)?.suggestedMove);
    const touching = pairOf((m) => {
      m.box({ size: [0.2, 0.2, 0.2], center: [0, 0, 0], label: 'a' });
      m.box({ size: [0.2, 0.2, 0.2], center: [0.2, 0, 0], label: 'b' });
    });
    expect(touching?.depth).toBe(0);
    expect(touching?.suggestedMove).toBeUndefined();
  });
});
