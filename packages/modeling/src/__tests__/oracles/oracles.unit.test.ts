import { describe, expect, it } from 'vitest';
import { model } from '../../model';
import { measure, ORACLES, oracle } from './oracles';

const relative = (actual: number, expected: number) =>
  Math.abs(actual - expected) / Math.abs(expected);

describe('analytic oracles', () => {
  for (const row of ORACLES) {
    it(`${row.name} matches its faceted closed form`, () => {
      const m = model();
      row.build(m);
      expect(m.validate().closed).toBe(true);
      const got = measure(row);
      expect(relative(got.volume, row.volume)).toBeLessThan(row.tolerance);
      expect(relative(got.area, row.area)).toBeLessThan(row.tolerance);
      const scale = Math.cbrt(row.volume) + Math.max(...row.centroid.map(Math.abs));
      for (const k of [0, 1, 2]) {
        expect(Math.abs((got.centroid[k] as number) - (row.centroid[k] as number))).toBeLessThan(
          row.tolerance * scale,
        );
      }
      if (row.inertia === undefined) return;
      const top = Math.max(...[0, 1, 2].map((k) => row.inertia?.[k]?.[k] as number));
      for (const r of [0, 1, 2]) {
        for (const c of [0, 1, 2]) {
          const delta = (got.inertia[r]?.[c] as number) - (row.inertia[r]?.[c] as number);
          expect(Math.abs(delta), `I${r}${c}`).toBeLessThan(row.tolerance * top);
        }
      }
    });
  }

  it('lists each row once, with a tolerance at rounding level', () => {
    const names = ORACLES.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const row of ORACLES) expect(row.tolerance).toBeLessThanOrEqual(1e-9);
    expect(names).toEqual(
      expect.arrayContaining([
        'box',
        'cylinder',
        'sphere',
        'cone',
        'torus',
        'box.cylinder-hole',
        'cylinders.intersection',
        'box.shelled',
        'sweep.circle-arc',
      ]),
    );
  });

  it('is the faceted solid, not the smooth one', () => {
    const row = oracle('sweep.circle-arc');
    const smooth = Math.PI * 4 * 4 * ((Math.PI / 2) * 40);
    expect(relative(row.volume, smooth)).toBeGreaterThan(1e-3);
    expect(relative(measure(row).volume, row.volume)).toBeLessThan(row.tolerance);
  });

  it('catches a wrong solid: a cylinder that lost a wall segment fails the row', () => {
    const row = oracle('cylinder');
    const m = model();
    m.cylinder({ radiusTop: 0.05, radiusBottom: 0.05, height: 0.3, radialSegments: 255 });
    const got = m.validate().volume;
    expect(relative(got, row.volume)).toBeGreaterThan(row.tolerance);
  });
});
