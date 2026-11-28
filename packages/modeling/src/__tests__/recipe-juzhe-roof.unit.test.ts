import { describe, expect, it } from 'vitest';
import {
  type JuzhePurlin,
  type JuzheRoofOptions,
  juzhePurlins,
  juzheRoof,
} from '../recipes/juzhe-roof';
import { sel } from '../selectors';

function anchor(
  r: { anchors: Readonly<Record<string, readonly number[]>> },
  key: string,
): number[] {
  const a = r.anchors[key];
  if (a === undefined) throw new Error(`missing anchor ${key}`);
  return [...a];
}

describe('juzhePurlins fold', () => {
  it.each([
    2, 3, 4, 5, 6, 7, 8,
  ])('spans %i: first drop is H/10, later drops halve, eave at 0', (n) => {
    const H = 0.7;
    const run = 1.3;
    const p = juzhePurlins(H, run, n);
    expect(p).toHaveLength(n + 1);
    expect(p[0]?.run).toBe(0);
    expect(p[0]?.height).toBe(H);
    expect(p[n]?.run).toBeCloseTo(run, 12);
    expect(p[n]?.height).toBeCloseTo(0, 12);
    // The chord from the ridge to the eave drops by H/10 at the first purlin.
    const chord1 = H * (1 - run / n / run);
    expect((p[1]?.height ?? NaN) - chord1).toBeCloseTo(-H / 10, 12);
    // Each later drop is half the previous one (measured against the chord from the previous point).
    for (let k = 2; k < n; k++) {
      const a = p[k - 1] as JuzhePurlin;
      const b = p[k] as JuzhePurlin;
      const eave = p[n] as JuzhePurlin;
      const chord = (a.height * (eave.run - b.run)) / (eave.run - a.run);
      expect(chord - b.height).toBeCloseTo(H / 10 / 2 ** (k - 1), 12);
    }
  });

  it.each([
    2, 3, 4, 5, 6, 7, 8,
  ])('spans %i: each interior purlin is strictly below its neighbours chord', (n) => {
    const p = juzhePurlins(0.7, 1.3, n);
    for (let k = 1; k < n; k++) {
      const a = p[k - 1] as JuzhePurlin;
      const b = p[k] as JuzhePurlin;
      const c = p[k + 1] as JuzhePurlin;
      const chord = a.height + ((b.run - a.run) / (c.run - a.run)) * (c.height - a.height);
      expect(b.height).toBeLessThan(chord);
    }
  });

  it.each([2, 3, 4, 5, 6, 7, 8])('spans %i: slopes strictly decrease toward the eave', (n) => {
    const p = juzhePurlins(0.7, 1.3, n);
    const slopes: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = p[k] as JuzhePurlin;
      const b = p[k + 1] as JuzhePurlin;
      slopes.push((a.height - b.height) / (b.run - a.run));
    }
    for (let k = 0; k + 1 < slopes.length; k++) {
      expect(slopes[k] as number).toBeGreaterThan(slopes[k + 1] as number);
    }
  });
});

describe('juzheRoof', () => {
  it('defaults build a closed, clean prism with no non-info issues', () => {
    const r = juzheRoof({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate({ contacts: [] });
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('hand-computed two-span roof: run 1.2, pavilion, ridge 0.8 (2/3 of run), middle purlin fold', () => {
    const r = juzheRoof({ run: 1.2, spans: 2, kind: 'pavilion' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dimensions.ridgeHeight).toBeCloseTo(0.8, 12);
    expect(r.value.dimensions.firstDrop).toBeCloseTo(0.08, 12);
    // Chord ridge->eave at run 0.6 is 0.4; dropped by H/10 = 0.08 gives 0.32.
    expect(anchor(r.value, 'purlin-1-right')[0]).toBeCloseTo(0.6, 12);
    expect(anchor(r.value, 'purlin-1-right')[1]).toBeCloseTo(0.32, 12);
    expect(anchor(r.value, 'purlin-2-left')[0]).toBeCloseTo(-1.2, 12);
    expect(anchor(r.value, 'purlin-2-left')[1]).toBeCloseTo(0, 12);
  });

  it('hall ridge is one quarter of the run, pavilion one third', () => {
    const hall = juzheRoof({ kind: 'hall', run: 1.2 });
    const pavilion = juzheRoof({ kind: 'pavilion', run: 1.2 });
    expect(hall.ok && pavilion.ok).toBe(true);
    if (!hall.ok || !pavilion.ok) return;
    expect(anchor(hall.value, 'ridge')[1]).toBeCloseTo(0.6, 12);
    expect(anchor(pavilion.value, 'ridge')[1]).toBeCloseTo(0.8, 12);
    expect(hall.value.dimensions.eaveUpturn).toBe(0);
  });

  it('bounds are the run across, the ridge height up and the length along Z', () => {
    const r = juzheRoof({ run: 0.9, spans: 3, length: 1.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const box = r.value.model.bounds(sel.all());
    expect(box.ok).toBe(true);
    if (!box.ok) return;
    expect(box.value.min[0]).toBeCloseTo(-0.9, 9);
    expect(box.value.max[0]).toBeCloseTo(0.9, 9);
    expect(box.value.max[1]).toBeCloseTo(0.6, 9);
    expect(box.value.min[2]).toBeCloseTo(0, 9);
    expect(box.value.max[2]).toBeCloseTo(1.5, 9);
  });

  it('is deterministic: the same options give the same mesh bytes', () => {
    const options: JuzheRoofOptions = { kind: 'hall', spans: 5, run: 1.1 };
    const a = juzheRoof(options);
    const b = juzheRoof(options);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(
      Buffer.from(a.value.model.snapshot()).equals(Buffer.from(b.value.model.snapshot())),
    ).toBe(true);
  });

  it.each([
    ['unknown kind', { kind: 'dome' as never }],
    ['run too small', { run: 0.1 }],
    ['zero spans', { spans: 0 }],
    ['fractional spans', { spans: 2.5 }],
    ['zero length', { length: 0 }],
  ])('refuses %s with a structured argument error', (_, options) => {
    const r = juzheRoof(options as JuzheRoofOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: the built purlins are not a straight line between ridge and eave', () => {
    const r = juzheRoof({ run: 0.9, spans: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Ridge 0.6 over run 0.9: the chord at run 0.3 is 0.4, the fold puts the purlin at 0.34.
    const linear = 0.6 * (1 - 1 / 3);
    expect(anchor(r.value, 'purlin-1-right')[1]).toBeCloseTo(0.34, 12);
    expect(Math.abs((anchor(r.value, 'purlin-1-right')[1] as number) - linear)).toBeGreaterThan(
      0.05,
    );
  });
});
