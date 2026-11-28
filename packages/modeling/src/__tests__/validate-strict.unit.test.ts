import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Drawing, model } from '../index';
import { type NurbsSurface, nurbs } from '../nurbs';
import type { ValidateOptions } from '../validate';

const S = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
const grid = (f: (a: number, b: number) => Tuple3): NurbsSurface => {
  const r = nurbs.grid(S(8).map((a) => S(8).map((b) => f(a, b))));
  if (!r.ok) throw r.error;
  return r.value;
};
const line = (points: Tuple3[]) => {
  const c = nurbs.interpolate(points, { degree: 1 });
  if (!c.ok) throw c.error;
  return c.value;
};

/** One real warning of the family: `pass` is true by default and false under `strict`. */
const gate = (m: ReturnType<typeof model>, options: ValidateOptions, code: string) => {
  const plain = m.validate(options);
  const strict = m.validate({ ...options, strict: true });
  const found = plain.issues.filter((i) => i.code === code && i.severity === 'warn');
  expect(found.length).toBeGreaterThan(0);
  expect(plain.pass).toBe(true);
  expect(strict.pass).toBe(false);
  expect(strict.issues).toEqual(plain.issues);
  expect(m.validate({ ...options, strict: [code as never] }).pass).toBe(false);
  expect(m.validate({ ...options, strict: ['mesh-open'] }).pass).toBe(true);
  expect(m.validate({ ...options, strict: false }).pass).toBe(true);
};

describe('validate({ strict }) gates warning families', () => {
  it('surface-quality: a 2 degree kink', () => {
    const k = Math.tan((2 * Math.PI) / 180);
    const m = model();
    m.surface({
      patches: [
        { name: 'L', surface: grid((a, b) => [0.4 * a, 0.4 * b, 0]) },
        { name: 'R', surface: grid((a, b) => [0.4 + 0.4 * a, 0.4 * b, k * 0.4 * a]) },
      ],
    });
    gate(m, { surfaceQuality: { isoparms: 0, maxNet: [24, 24] } }, 'surface-quality');
  });

  it('surface-quality: a 0.4 degree kink is flagged by the Class-A defaults', () => {
    const k = Math.tan((0.4 * Math.PI) / 180);
    const m = model();
    m.surface({
      patches: [
        { name: 'L', surface: grid((a, b) => [0.4 * a, 0.4 * b, 0]) },
        { name: 'R', surface: grid((a, b) => [0.4 + 0.4 * a, 0.4 * b, k * 0.4 * a]) },
      ],
    });
    const v = m.validate({ surfaceQuality: { isoparms: 0, maxNet: [24, 24] } });
    expect(v.issues.some((i) => i.detail.check === 'surface-continuity')).toBe(true);
  });

  it('edge-flow: a feature line off the edge loops', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
    m.featureLine({
      name: 'shoulder',
      curve: line([
        [-0.5, 0.18, 0],
        [0.5, 0.18, 0],
      ]),
    });
    gate(m, { edgeFlow: true }, 'edge-flow');
  });

  it('patch-layout: a declared layout that was never built', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    m.patchLayout({
      name: 'plan',
      patches: [{ id: 'P', role: 'primary', degree: [3, 3], net: [4, 4] }],
    });
    gate(m, { layout: true }, 'patch-layout');
  });

  it('drawing: an outline 30 percent too large', () => {
    const sq = (h: number): [number, number][] => [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    const m = model();
    m.box({ size: [1, 1, 1] });
    const d: Drawing = {
      name: 'sheet',
      views: [{ id: 'front', ortho: 'front' }],
      items: [
        {
          id: 'outline',
          view: 'front',
          role: 'silhouette',
          kind: 'curve',
          closed: true,
          curve: { kind: 'polyline', points: sq(0.65) },
        },
      ],
    };
    expect(m.drawing(d).status).toBe('ok');
    gate(m, { drawing: true }, 'drawing');
  });

  it('a clean model stays a pass under strict', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.validate({ strict: true, edgeFlow: true, layout: true }).pass).toBe(true);
  });
});
