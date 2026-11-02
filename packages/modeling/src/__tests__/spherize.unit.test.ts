import { describe, expect, it } from 'vitest';
import { length, sub, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';

function cage(): Model {
  const m = model();
  m.box({ size: [0.2, 0.2, 0.2], segments: [4, 4, 4], tag: 'head' });
  return m;
}

const radii = (m: Model, center: Tuple3 = [0, 0, 0]) =>
  m.editMesh.vertices().map((v) => length(sub(m.editMesh.position(v), center)));

describe('spherize (cast to sphere / ellipsoid)', () => {
  it('factor 1 puts every vertex of a quad cage on one sphere (no poles)', () => {
    const m = cage();
    const r = m.spherize(sel.all(), { factor: 1 });
    expect(r.status).toBe('ok');
    const rs = radii(m);
    const mean = rs.reduce((s, x) => s + x, 0) / rs.length;
    for (const x of rs) expect(x).toBeCloseTo(mean, 12);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Every vertex keeps valence <= 4 (the cage), unlike a UV sphere's poles.
    expect(m.editMesh.faceCount).toBe(96);
  });

  it('factor blends linearly; radii give an ellipsoid; center moves the sphere', () => {
    const half = cage();
    const full = cage();
    const before = cage();
    half.spherize(sel.all(), { factor: 0.5, radii: [0.1, 0.1, 0.1] });
    full.spherize(sel.all(), { factor: 1, radii: [0.1, 0.1, 0.1] });
    const mesh = before.editMesh;
    for (const v of mesh.vertices()) {
      const mid = mesh
        .position(v)
        .map((c, k) => (c + (full.editMesh.position(v)[k] as number)) / 2);
      expect(length(sub(half.editMesh.position(v), mid as Tuple3))).toBeLessThan(1e-12);
    }
    const egg = cage();
    egg.spherize(sel.all(), { factor: 1, radii: [0.08, 0.12, 0.1], center: [0, 0.01, 0] });
    for (const v of egg.editMesh.vertices()) {
      const [x, y, z] = egg.editMesh.position(v);
      expect((x / 0.08) ** 2 + ((y - 0.01) / 0.12) ** 2 + (z / 0.1) ** 2).toBeCloseTo(1, 12);
    }
  });

  it('a falloff rounds a region softly; invalid options and empty selections fail', () => {
    const m = cage();
    const r = m.spherize(sel.extreme('+y'), {
      factor: 1,
      center: [0, 0, 0],
      radii: [0.12, 0.12, 0.12],
      falloff: { radius: 0.06 },
    });
    expect(r.status).toBe('ok');
    for (const options of [
      { factor: Number.NaN },
      { factor: 1, radii: [0, 1, 1] as Tuple3 },
      { factor: 1, center: [0, 0] as never },
    ]) {
      expect(cage().spherize(sel.all(), options).error?.code).toBe('model-invalid-argument');
    }
    expect(cage().spherize(sel.tag('none'), { factor: 1 }).error?.code).toBe(
      'model-selection-empty',
    );
    expect(cage().spherize(sel.all(), { factor: 0 }).error?.code).toBe('model-op-no-effect');
  });

  it('property: random cages, factors and ellipsoids validate clean', () => {
    let seed = 13;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 10; trial++) {
      const m = model();
      const n = 2 + Math.floor(random() * 6);
      m.box({
        size: [0.1 + random() * 0.2, 0.1 + random() * 0.2, 0.1 + random() * 0.2],
        segments: [n, n + 1, n],
      });
      const r = m.spherize(sel.all(), {
        factor: 0.2 + random() * 0.8,
        ...(trial % 2 === 0
          ? {}
          : {
              radii: [
                0.05 + random() * 0.1,
                0.05 + random() * 0.1,
                0.05 + random() * 0.1,
              ] as Tuple3,
            }),
      });
      expect(r.status, `trial ${trial}`).toBe('ok');
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});
