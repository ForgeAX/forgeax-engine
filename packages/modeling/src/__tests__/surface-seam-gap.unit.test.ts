import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, D09_CLASSES } from '../surface-quality';

const S = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
const grid = (f: (a: number, b: number) => [number, number, number]): NurbsSurface => {
  const r = nurbs.grid(S(8).map((a) => S(8).map((b) => f(a, b))));
  if (!r.ok) throw r.error;
  return r.value;
};
const left = () => grid((a, b) => [0.4 * a, 0.4 * b, 0]);
const right = (gap: number) => grid((a, b) => [0.4 + gap + 0.4 * a, 0.4 * b, 0]);

const run = (surfaces: { name: string; surface: NurbsSurface }[], reach?: number) => {
  const r = checkSurfaceQuality(
    { surfaces },
    { isoparms: 5, maxNet: [24, 24], ...(reach === undefined ? {} : { reach }) },
  );
  if (!r.ok) throw r.error;
  return r.value;
};

describe('seam gap wider than adjacency (S-R1)', () => {
  it('fails coplanar patches 2 mm and 50 mm apart with the real gap', () => {
    for (const mm of [2, 50]) {
      const v = run([
        { name: 'L', surface: left() },
        { name: 'R', surface: right(mm / 1000) },
      ]);
      expect(v.pass).toBe(false);
      expect(v.edges).toHaveLength(1);
      expect(v.edges[0]?.gap.value).toBeCloseTo(mm / 1000, 6);
      expect(v.issues.some((i) => i.code === 'surface-continuity')).toBe(true);
    }
  });

  it('measures the true size of a seam that opens by 3 mm in the middle', () => {
    const r = grid((a, b) => [0.4 + 0.003 * Math.sin(Math.PI * b) * (1 - a) + 0.4 * a, 0.4 * b, 0]);
    const v = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: r },
    ]);
    const gap = Math.max(0, ...v.edges.map((e) => e.gap.value));
    expect(gap).toBeGreaterThan(0.0029);
    expect(v.pass).toBe(false);
  });

  it('leaves a gap beyond the reach, and a patch stacked above another, alone', () => {
    const far = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: right(0.5) },
    ]);
    expect(far.edges).toHaveLength(0);
    const off = run(
      [
        { name: 'L', surface: left() },
        { name: 'R', surface: right(0.05) },
      ],
      0.001,
    );
    expect(off.edges).toHaveLength(0);
    const above = run([
      { name: 'L', surface: left() },
      { name: 'U', surface: grid((a, b) => [0.4 * a, 0.4 * b, 0.05]) },
    ]);
    expect(above.edges).toHaveLength(0);
  });

  it('reaches validate through m.surface for a 2 mm gap and passes a closed seam', () => {
    const m = model();
    m.surface({
      patches: [
        { name: 'L', surface: left() },
        { name: 'R', surface: right(0.002) },
      ],
      chord: 0.002,
    });
    const v = m.validate({ surfaceQuality: { maxNet: [24, 24] }, strict: true });
    expect(v.pass).toBe(false);
    expect(
      v.issues.some((i) => i.code === 'surface-quality' && i.detail.check === 'surface-continuity'),
    ).toBe(true);

    const ok = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: right(0) },
    ]);
    expect(ok.pass).toBe(true);
  });
});

describe('Class-A surface-quality defaults (G-7)', () => {
  const tilted = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    return grid((a, b) => [0.4 + 0.4 * a, 0.4 * b, 0.4 * a * t]);
  };

  it('fails a 0.05 mm gap that the old 0.1 mm default let through', () => {
    const v = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: right(5e-5) },
    ]);
    expect(v.pass).toBe(false);
    expect(v.issues.some((i) => i.code === 'surface-continuity')).toBe(true);
  });

  it('fails a 0.3 degree kink that the old 0.5 degree default let through', () => {
    const v = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: tilted(0.3) },
    ]);
    expect(v.pass).toBe(false);
    expect(v.issues.some((i) => i.code === 'surface-continuity')).toBe(true);
  });

  it('passes a 0.05 degree kink under the 0.1 degree limit', () => {
    const v = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: tilted(0.05) },
    ]);
    expect(v.edges.every((e) => e.angle.value < 0.1)).toBe(true);
  });

  it('pins the exact Class-A limits and reads a seam just inside and just outside them', () => {
    expect(D09_CLASSES.primary).toMatchObject({ position: 1e-5, angle: 0.1 });
    const ok = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: right(5e-6) },
    ]);
    expect(ok.issues.some((i) => i.code === 'surface-continuity')).toBe(false);
    const kinked = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: tilted(0.15) },
    ]);
    expect(kinked.pass).toBe(false);
    expect(kinked.issues.some((i) => i.code === 'surface-continuity')).toBe(true);
    const inside = run([
      { name: 'L', surface: left() },
      { name: 'R', surface: tilted(0.05) },
    ]);
    expect(inside.issues.some((i) => i.code === 'surface-continuity')).toBe(false);
  });
});
