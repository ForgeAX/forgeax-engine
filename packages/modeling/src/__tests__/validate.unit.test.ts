import { describe, expect, it } from 'vitest';
import { faceArea } from '../geom';
import { type Model, model } from '../model';
import { orient2d, orient3d } from '../predicates';
import { sel } from '../selectors';

function issues(m: Model, code: string) {
  return m.validate().issues.filter((issue) => issue.code === code);
}

function twoBoxes(offset: [number, number, number]): Model {
  const part = model();
  part.box({ size: [1, 1, 1] });
  const m = model();
  m.box({ size: [1, 1, 1] });
  m.append(part, { translate: offset });
  return m;
}

describe('robust predicates', () => {
  it('are exact on collinear and coplanar dyadic points and see one ulp', () => {
    expect(orient2d(1, 1, 2, 2, 3, 3)).toBe(0);
    expect(Math.sign(orient2d(1, 1, 2, 2, 3, 3 + 2 ** -51))).toBe(1);
    expect(orient3d([1, 0, 0], [0, 1, 0], [0, 0, 1], [0.25, 0.25, 0.5])).toBe(0);
    expect(
      Math.sign(orient3d([1, 0, 0], [0, 1, 0], [0, 0, 1], [0.25, 0.25, 0.5 + 2 ** -53])),
    ).not.toBe(0);
  });

  it('agree under permutation on a near-degenerate grid where float arithmetic does not', () => {
    let naiveMismatch = 0;
    for (let i = 0; i < 32; i++) {
      for (let j = 0; j < 32; j++) {
        const px = 0.5 + i * 2 ** -53;
        const py = 0.5 + j * 2 ** -53;
        const s = Math.sign(orient2d(px, py, 12, 12, 24, 24));
        expect(Math.sign(orient2d(12, 12, 24, 24, px, py))).toBe(s);
        expect(Math.sign(orient2d(24, 24, px, py, 12, 12))).toBe(s);
        expect(Math.sign(orient2d(12, 12, px, py, 24, 24))).toBe(-s || 0);
        const naive = (a: number[], b: number[], c: number[]) =>
          Math.sign(
            ((a[0] as number) - (c[0] as number)) * ((b[1] as number) - (c[1] as number)) -
              ((a[1] as number) - (c[1] as number)) * ((b[0] as number) - (c[0] as number)),
          );
        if (naive([px, py], [12, 12], [24, 24]) !== naive([12, 12], [24, 24], [px, py])) {
          naiveMismatch++;
        }
      }
    }
    expect(naiveMismatch).toBeGreaterThan(0);
  });
});

describe('orient3d staged evaluation', () => {
  it('matches an exact BigInt determinant on near-coplanar, axis-aligned and repeated points', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const grid = () => Math.floor(next() * 4096 - 2048) / 1024;
    const ulp = (x: number) =>
      x === 0 ? 2 ** -60 : 2 ** (Math.floor(Math.log2(Math.abs(x))) - 52);
    const big = (x: number) => BigInt(x * 2 ** 80);
    const reference = (a: number[], b: number[], c: number[], d: number[]) => {
      const r = [a, b, c].map((p) => p.map((x, k) => big(x) - big(d[k] as number)));
      const [[ex, ey, ez], [fx, fy, fz], [gx, gy, gz]] = r as [bigint[], bigint[], bigint[]];
      const det =
        (ez as bigint) * ((fx as bigint) * (gy as bigint) - (gx as bigint) * (fy as bigint)) +
        (fz as bigint) * ((gx as bigint) * (ey as bigint) - (ex as bigint) * (gy as bigint)) +
        (gz as bigint) * ((ex as bigint) * (fy as bigint) - (fx as bigint) * (ey as bigint));
      return det > 0n ? 1 : det < 0n ? -1 : 0;
    };
    const signs = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const onPlane = () => {
        const x = grid();
        const y = grid();
        return i % 3 === 0 ? [x, y, 0.75] : [x, y, x + y];
      };
      const [a, b, c, d] = [onPlane(), onPlane(), onPlane(), onPlane()] as [
        number[],
        number[],
        number[],
        number[],
      ];
      if (i % 5 === 1) c.splice(0, 3, ...a);
      const k = i % 3;
      const step = Math.floor(next() * 3) - 1;
      d[k] = (d[k] as number) + step * ulp(d[k] as number);
      const expected = reference(a, b, c, d);
      signs.add(expected);
      expect(Math.sign(orient3d(a as never, b as never, c as never, d as never))).toBe(expected);
    }
    expect([...signs].sort()).toEqual([-1, 0, 1]);
  });
});

describe('validate', () => {
  it('confirms crossing parts and keeps contacts as candidates', () => {
    const crossing = twoBoxes([0.5, 0.25, 0.25]);
    const confirmed = issues(crossing, 'self-intersection');
    expect(confirmed.map((issue) => [issue.severity, issue.detail.certainty])).toEqual([
      ['warn', 'confirmed'],
    ]);
    expect(crossing.validate().pass).toBe(true);

    const touching = twoBoxes([1, 0, 0]);
    expect(
      issues(touching, 'self-intersection').map((issue) => [
        issue.severity,
        issue.detail.certainty,
      ]),
    ).toEqual([['info', 'candidate']]);
    const knife = twoBoxes([1, 1, 0]);
    expect(issues(knife, 'self-intersection')[0]?.detail.certainty).toBe('candidate');
    expect(issues(twoBoxes([3, 0, 0]), 'self-intersection')).toEqual([]);
  });

  it('confirms coplanar overlapping faces', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    m.plane({ width: 1, height: 1, center: [0.5, 0.5, 0] });
    expect(issues(m, 'self-intersection')[0]?.detail.certainty).toBe('confirmed');
  });

  it('reports isolated vertices, missing UVs and zero-area UVs', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' });
    expect(issues(m, 'uv-missing')[0]?.detail).toEqual({ faces: 4 });
    m.editMesh.addVertex(5, 5, 5);
    expect(issues(m, 'isolated-vertex')[0]?.detail.count).toBe(1);
    const flat = model();
    flat.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8 });
    const op = flat.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
    expect(op.diagnostics?.[0]?.detail).toEqual({ faces: 8 });
    expect(issues(flat, 'uv-degenerate')[0]?.detail.count).toBe(8);
  });

  it('a correctly mapped face that is merely tiny in a normalized atlas is not uv-degenerate', () => {
    // A 20 um cube beside a 1 m cube in one atlas: its UV triangles are smaller than the
    // squared length tolerance in atlas units, but not collapsed.
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [2e-5, 2e-5, 2e-5], center: [2, 0, 0] });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.auto({ resolution: 1024, padding: 4 });
    const tiny = sel.inBox([1.9, -1, -1], [2.1, 1, 1]).evaluate(m.editMesh);
    const h = m.editMesh.faceHalves(tiny[0] as number);
    const [a, b, c] = h.map((x) => m.editMesh.corner('uv0', x) as Float32Array) as [
      Float32Array,
      Float32Array,
      Float32Array,
    ];
    const area = Math.abs(
      ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
        ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number)),
    );
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(1e-10);
    expect(issues(m, 'uv-degenerate')).toEqual([]);
  });
});

describe('effect assertions', () => {
  it('cylinder projection unrolls sides at their true width and projects caps flat', () => {
    const m = model();
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 2, radialSegments: 16, label: 'drum' });
    const op = m.uv.project({ mode: 'cylinder', axis: 'y', scale: 1 });
    expect(op.diagnostics).toBeUndefined();
    const mesh = m.editMesh;
    for (const f of sel.createdBy('drum', 'side').evaluate(mesh)) {
      const uv = mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) as Float32Array));
      let area = 0;
      for (let i = 0; i < uv.length; i++) {
        const a = uv[i] as number[];
        const b = uv[(i + 1) % uv.length] as number[];
        area += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
      }
      // u spans the arc at the mean radius; the face itself spans the chord.
      const arcOverChord = Math.PI / 16 / Math.sin(Math.PI / 16);
      expect(Math.abs(area / 2) / faceArea(mesh, f)).toBeCloseTo(arcOverChord, 5);
    }
    expect(m.toMesh().ok).toBe(true);
  });

  it('weld without a merge fails and reports the nearest vertex distance', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.weld({ distance: 1e-6 });
    expect(op.error?.code).toBe('model-op-no-effect');
    expect(op.error?.detail?.nearest).toBe(1);
  });
});

describe('validate self-intersection cap', () => {
  it('reports a crossing after more touches than the cap, with full totals', () => {
    const m = model();
    // 40 pairs of boxes resting flush on each other (touches), first in face order.
    for (let i = 0; i < 40; i++) {
      m.box({ size: [0.1, 0.1, 0.1], center: [i * 0.3, 0.05, 0], label: `low${i}` });
      m.box({ size: [0.1, 0.1, 0.1], center: [i * 0.3, 0.15, 0], label: `high${i}` });
    }
    // Then two boxes crossing each other.
    m.box({ size: [0.2, 0.05, 0.05], center: [0, 1, 0], label: 'bar' });
    m.box({ size: [0.05, 0.2, 0.05], center: [0, 1, 0], label: 'post' });
    const issues = m.validate().issues.filter((i) => i.code === 'self-intersection');
    const crossing = issues.find((i) => i.severity === 'warn');
    const touching = issues.find((i) => i.severity === 'info');
    expect(crossing).toBeDefined();
    expect(touching?.detail.touches).toBeGreaterThan(32);
    expect(crossing?.detail.crossings).toBeGreaterThan(0);
    expect(crossing?.detail.total).toBe(
      (crossing?.detail.crossings as number) + (crossing?.detail.touches as number),
    );
    expect((touching?.detail.pairs as unknown[]).length).toBe(32);
  });
});
