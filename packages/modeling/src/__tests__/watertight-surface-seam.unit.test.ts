import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';

const S = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
const grid = (f: (a: number, b: number) => [number, number, number]): NurbsSurface => {
  const r = nurbs.grid(S(8).map((a) => S(8).map((b) => f(a, b))));
  if (!r.ok) throw r.error;
  return r.value;
};
const left = () => grid((a, b) => [0.4 * a, 0.4 * b, 0]);
const right = (gap: number) => grid((a, b) => [0.4 + gap + 0.4 * a, 0.4 * b, 0]);

const build = (gap: number, chord: number) => {
  const m = model();
  const res = m.surface({
    patches: [
      { name: 'L', surface: left() },
      { name: 'R', surface: right(gap) },
    ],
    chord,
  });
  const v = m.poisoned ? undefined : m.validate({ watertight: true });
  const seams = m.poisoned ? [] : m.diagnostics().surfaces.flatMap((s) => s.seams ?? []);
  return {
    status: res.status,
    poisoned: m.poisoned?.code ?? null,
    seams: seams.length,
    seamKeys: seams[0] ? Object.keys(seams[0]) : [],
    pass: v?.pass ?? null,
    errors: v?.issues.filter((i) => i.severity === 'error').map((i) => i.code) ?? [],
    chains: v?.watertight?.chains?.length ?? null,
  };
};

describe('B22-3 validate({ watertight }) gates a surface seam opened beyond tolerance', () => {
  it('a 5 mm gap between two m.surface patches adds undesigned chains and errors over the sewn pair', () => {
    const closed = build(0, 0.002);
    const open = build(0.005, 0.002);
    expect(open.errors.length).toBeGreaterThan(closed.errors.length);
    expect(open.chains).toBeGreaterThan(closed.chains as number);
  });
});
