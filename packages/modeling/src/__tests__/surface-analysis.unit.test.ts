import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';
import {
  curvatureComb,
  curvatureShading,
  divergingColor,
  surfaceField,
  zebraStripes,
} from '../surface-analysis';

/** Bicubic patch of z = f(x, y) over a rectangle, exact for cubic f. */
function heightPatch(
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  f: (x: number, y: number) => number,
): NurbsSurface {
  const rows = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 4 }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / 3;
      const y = y0 + ((y1 - y0) * j) / 3;
      return [x, y, f(x, y)];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
}

const paraboloid = (x: number, y: number) => 0.2 * (x * x + y * y);

function tessellate(surface: NurbsSurface, chord = 0.002): MeshAsset {
  const m = model();
  m.surface({ patches: [{ surface }], chord });
  const exported = m.toMesh({ normals: { mode: 'smooth' } });
  if (!exported.ok) throw exported.error;
  return exported.value.mesh;
}

const at = (data: ArrayLike<number>, i: number): Tuple3 => [
  data[3 * i] as number,
  data[3 * i + 1] as number,
  data[3 * i + 2] as number,
];

describe('surface field', () => {
  const surface = heightPatch([-1, 1], [-1, 1], paraboloid);
  const mesh = tessellate(surface);

  it('evaluates every vertex of a tessellated patch exactly', () => {
    const field = surfaceField(mesh, [surface]);
    if (!field.ok) throw field.error;
    const count = field.value.positions.length / 3;
    expect(field.value.exactVertices).toBe(count);
    for (let v = 0; v < count; v += 7) {
      const [x, y] = at(field.value.positions, v);
      // z = a r^2: K = 4a^2 / w^4, H = a (2 + 4a^2 r^2) / w^3 with w^2 = 1 + 4a^2 r^2.
      const r2 = x * x + y * y;
      const w2 = 1 + 0.16 * r2;
      expect(field.value.gaussian[v]).toBeCloseTo(0.16 / (w2 * w2), 9);
      expect(field.value.mean[v]).toBeCloseTo((0.2 * (2 + 0.16 * r2)) / w2 ** 1.5, 9);
      expect(at(field.value.normals, v)[2]).toBeGreaterThan(0);
    }
  });

  it('estimates curvature from the mesh where no patch matches', () => {
    const field = surfaceField(mesh);
    if (!field.ok) throw field.error;
    expect(field.value.exactVertices).toBe(0);
    const count = field.value.positions.length / 3;
    let checked = 0;
    for (let v = 0; v < count; v++) {
      const [x, y] = at(field.value.positions, v);
      if (Math.abs(x) > 0.8 || Math.abs(y) > 0.8) continue;
      const r2 = x * x + y * y;
      const w2 = 1 + 0.16 * r2;
      expect(
        Math.abs((field.value.mean[v] as number) - (0.2 * (2 + 0.16 * r2)) / w2 ** 1.5),
      ).toBeLessThan(0.04);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('rejects a mesh without triangles and a bad tolerance', () => {
    expect(surfaceField(mesh, [surface], { tolerance: 0 }).ok).toBe(false);
    const lines = surfaceField({ ...mesh, submeshes: [] });
    expect(!lines.ok && lines.error.code).toBe('model-precondition');
  });
});

describe('curvature shading', () => {
  it('maps signed curvature onto a diverging blue-white-red scale', () => {
    expect(divergingColor(0)).toEqual([0.96 * 0.96, 0.96 * 0.96, 0.96 * 0.96]);
    expect(divergingColor(-2)[2]).toBeGreaterThan(divergingColor(-2)[0]);
    expect(divergingColor(1)[0]).toBeGreaterThan(divergingColor(1)[2]);
    const surface = heightPatch([-1, 1], [-1, 1], (x, y) => 0.2 * (x * x - y * y));
    const field = surfaceField(tessellate(surface), [surface]);
    if (!field.ok) throw field.error;
    const shaded = curvatureShading(field.value, { kind: 'gaussian' });
    if (!shaded.ok) throw shaded.error;
    // A saddle: Gaussian curvature is negative everywhere, so every vertex is blue.
    for (let i = 0; i < shaded.value.colors.length; i += 4)
      expect(shaded.value.colors[i + 2]).toBeGreaterThan(shaded.value.colors[i] as number);
    expect(shaded.value.range).toBeGreaterThan(0);
    expect(curvatureShading(field.value, { kind: 'mean', range: -1 }).ok).toBe(false);
  });
});

describe('zebra stripes', () => {
  const view = {
    direction: [0, 0, 1] as Tuple3,
    right: [1, 0, 0] as Tuple3,
    up: [0, 1, 0] as Tuple3,
  };

  it('shows one stripe on a plane and splits a curved patch exactly on stripe borders', () => {
    const plane = heightPatch([-1, 1], [-1, 1], () => 0);
    const flat = surfaceField(tessellate(plane), [plane]);
    if (!flat.ok) throw flat.error;
    const stripes = zebraStripes(flat.value, [plane], view);
    if (!stripes.ok) throw stripes.error;
    const shades = new Set<number>();
    for (let i = 0; i < stripes.value.colors.length; i += 4)
      shades.add(stripes.value.colors[i] as number);
    expect(shades.size).toBe(1);

    const surface = heightPatch([-1, 1], [-1, 1], paraboloid);
    const field = surfaceField(tessellate(surface, 0.02), [surface]);
    if (!field.ok) throw field.error;
    const curved = zebraStripes(field.value, [surface], { ...view, width: 5 });
    if (!curved.ok) throw curved.error;
    const colors = new Set<number>();
    for (let i = 0; i < curved.value.colors.length; i += 4)
      colors.add(curved.value.colors[i] as number);
    expect(colors.size).toBe(2);
    expect(curved.value.triangles).toBeGreaterThan(field.value.indices.length / 3);
    // Refined corners lie on the exact patch, not on the coarse triangles.
    let worst = 0;
    for (let i = 0; i < curved.value.positions.length; i += 3 * 97) {
      const p = at(curved.value.positions, i / 3);
      worst = Math.max(worst, Math.abs(p[2] - paraboloid(p[0], p[1])));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it('turns the stripes with the orientation and rejects malformed views', () => {
    const surface = heightPatch([-1, 1], [-1, 1], paraboloid);
    const field = surfaceField(tessellate(surface, 0.01), [surface]);
    if (!field.ok) throw field.error;
    const a = zebraStripes(field.value, [surface], view);
    const b = zebraStripes(field.value, [surface], { ...view, orientation: 90 });
    if (!a.ok || !b.ok) throw new Error('zebra');
    expect(a.value.colors).not.toEqual(b.value.colors);
    expect(zebraStripes(field.value, [surface], { ...view, width: 0 }).ok).toBe(false);
    expect(zebraStripes(field.value, [surface], { right: [1, 0, 0], up: [0, 1, 0] }).ok).toBe(
      false,
    );
  });
});

describe('curvature comb', () => {
  it('draws equal teeth on a circle arc and flips them at an inflection', () => {
    const H = Math.SQRT1_2;
    const quarter: NurbsCurve = {
      degree: 2,
      points: [
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      weights: [1, H, 1],
      knots: [0, 0, 0, 1, 1, 1],
    };
    const comb = curvatureComb(quarter, { samples: 9, scale: 0.1 });
    if (!comb.ok) throw comb.error;
    expect(comb.value.maxCurvature).toBeCloseTo(1, 9);
    for (let k = 0; k < 9; k++) {
      const base = at(comb.value.positions, 2 * k);
      const tip = at(comb.value.positions, 2 * k + 1);
      expect(Math.hypot(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2])).toBeCloseTo(0.1, 6);
      // Teeth point away from the center of curvature.
      expect(Math.hypot(tip[0], tip[1])).toBeCloseTo(1.1, 6);
    }
    const s = nurbs.interpolate([
      [0, 0, 0],
      [1, 0.4, 0],
      [2, 0, 0],
      [3, -0.4, 0],
      [4, 0, 0],
    ]);
    if (!s.ok) throw s.error;
    const flipped = curvatureComb(s.value, { samples: 33 });
    if (!flipped.ok) throw flipped.error;
    const side = (k: number) => {
      const base = at(flipped.value.positions, 2 * k);
      const tip = at(flipped.value.positions, 2 * k + 1);
      return Math.sign(tip[1] - base[1]);
    };
    expect(side(8)).toBe(1);
    expect(side(24)).toBe(-1);
    expect(curvatureComb(s.value, { samples: 1 }).ok).toBe(false);
    const straight = nurbs.interpolate([
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
    ]);
    if (!straight.ok) throw straight.error;
    const flat = curvatureComb(straight.value);
    if (!flat.ok) throw flat.error;
    for (let k = 0; k < 64; k++) {
      const base = at(flat.value.positions, 2 * k);
      const tip = at(flat.value.positions, 2 * k + 1);
      expect(Math.hypot(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2])).toBeLessThan(1e-9);
    }
  });
});
