import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import { expectContract } from './contract';

const H: Tuple3 = [0.5, 0.4, 0.3];

function box(): Model {
  const m = model();
  m.box({ size: [2 * H[0], 2 * H[1], 2 * H[2]] });
  return m;
}

const X = sel.edges.parallel('x');
const Y = sel.edges.parallel('y');
const Z = sel.edges.parallel('z');

function mixed(m: Model, [a, b, c]: Tuple3, segments: number): OpReport {
  return m.bevel(sel.edges.all(), {
    width: [
      { edges: X, width: a },
      { edges: Y, width: b },
      { edges: Z, width: c },
    ],
    segments,
    label: 'b',
  });
}

/** The 24 vertices of the box chamfered with widths a (x edges), b (y edges), c (z edges). */
function chamferVertices([a, b, c]: Tuple3): Tuple3[] {
  const [hx, hy, hz] = H;
  const out: Tuple3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        out.push([sx * (hx - b), sy * (hy - a), sz * hz]);
        out.push([sx * hx, sy * (hy - c), sz * (hz - b)]);
        out.push([sx * (hx - c), sy * hy, sz * (hz - a)]);
      }
  return out;
}

const sub = (p: Tuple3, q: Tuple3): Tuple3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Tuple3, q: Tuple3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: Tuple3, q: Tuple3): Tuple3 => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];

/** Volume of the convex hull of `points` (brute-force face planes; the origin is inside). */
function hullVolume(points: readonly Tuple3[]): number {
  const planes: { n: Tuple3; d: number }[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const [p, q, r] = [points[i], points[j], points[k]] as [Tuple3, Tuple3, Tuple3];
        let normal = cross(sub(q, p), sub(r, p));
        const l = Math.hypot(...normal);
        if (l < 1e-12) continue;
        normal = [normal[0] / l, normal[1] / l, normal[2] / l];
        let d = dot(normal, p);
        if (d < 0) {
          normal = [-normal[0], -normal[1], -normal[2]];
          d = -d;
        }
        if (points.some((s) => dot(normal, s) > d + 1e-12)) continue;
        if (planes.some((pl) => dot(pl.n, normal) > 1 - 1e-12 && Math.abs(pl.d - d) < 1e-12))
          continue;
        planes.push({ n: normal, d });
      }
  let volume = 0;
  for (const { n: normal, d } of planes) {
    const on = points.filter((s) => Math.abs(dot(normal, s) - d) < 1e-12);
    const c = on.reduce<Tuple3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
    const centre: Tuple3 = [c[0] / on.length, c[1] / on.length, c[2] / on.length];
    const u = sub(on[0] as Tuple3, centre);
    const v = cross(normal, u);
    on.sort((p, q) => {
      const ap = Math.atan2(dot(sub(p, centre), v), dot(sub(p, centre), u));
      const aq = Math.atan2(dot(sub(q, centre), v), dot(sub(q, centre), u));
      return ap - aq;
    });
    let area = 0;
    for (let i = 0; i < on.length; i++) {
      const p = sub(on[i] as Tuple3, centre);
      const q = sub(on[(i + 1) % on.length] as Tuple3, centre);
      area += dot(cross(p, q), normal) / 2;
    }
    volume += (area * d) / 3;
  }
  return volume;
}

function volumeOf(m: Model): number {
  const report = m.validate();
  expect(report.closed).toBe(true);
  return report.volume;
}

describe('bevel: per-edge widths', () => {
  it('an all-equal width list is byte-identical to the scalar width', () => {
    for (const segments of [1, 3]) {
      const scalar = box();
      expect(scalar.bevel(sel.edges.all(), { width: 0.07, segments, label: 'b' }).status).toBe(
        'ok',
      );
      const listed = box();
      expect(mixed(listed, [0.07, 0.07, 0.07], segments).status).toBe('ok');
      expect(listed.snapshot()).toEqual(scalar.snapshot());
    }
  });

  it('a chamfer with three widths at every corner matches the analytic polyhedron', () => {
    const widths: Tuple3 = [0.05, 0.09, 0.13];
    const m = box();
    expect(mixed(m, widths, 1).status).toBe('ok');
    expectContract(m);
    const expected = chamferVertices(widths);
    const mesh = m.editMesh;
    const got = [...mesh.vertices()].map((v) => mesh.position(v));
    expect(got).toHaveLength(24);
    for (const p of expected) {
      const nearest = Math.min(...got.map((q) => Math.hypot(...sub(p, q))));
      expect(nearest).toBeLessThan(1e-12);
    }
    expect(volumeOf(m)).toBeCloseTo(hullVolume(expected), 12);
    expect(m.count(sel.createdBy('b', 'corner'))).toBe(8);
  });

  it('a round three-width corner is a valid manifold patch outside its chamfer plane', () => {
    const widths: Tuple3 = [0.05, 0.09, 0.13];
    const m = box();
    expect(mixed(m, widths, 4).status).toBe('ok');
    expectContract(m);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const chamfer = hullVolume(chamferVertices(widths));
    const full = 8 * H[0] * H[1] * H[2];
    expect(report.volume).toBeGreaterThan(chamfer);
    expect(report.volume).toBeLessThan(full);
    // Every corner patch point of the (+, +, +) corner lies inside the corner cell of the box
    // and on the outer side of the chamfer triangle through the analytic corner points.
    const [p1, p2, p3] = chamferVertices(widths).slice(21) as [Tuple3, Tuple3, Tuple3];
    let normal = cross(sub(p2, p1), sub(p3, p1));
    if (dot(normal, [1, 1, 1]) < 0) normal = [-normal[0], -normal[1], -normal[2]];
    const mesh = m.editMesh;
    const ids = sel.createdBy('b', 'corner').evaluate(mesh);
    const points = ids
      .flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)))
      .filter((p) => p[0] > 0 && p[1] > 0 && p[2] > 0);
    expect(points.length).toBeGreaterThan(3);
    const reach = Math.max(...widths);
    for (const p of points) {
      for (const k of [0, 1, 2]) {
        expect(p[k] as number).toBeLessThanOrEqual((H[k] as number) + 1e-12);
        expect(p[k] as number).toBeGreaterThanOrEqual((H[k] as number) - reach - 1e-12);
      }
      expect(dot(normal, sub(p, p1))).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('volume decreases monotonically in each width', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const segments of [1, 3]) {
      for (let trial = 0; trial < 4; trial++) {
        const base: Tuple3 = [0.02 + 0.1 * next(), 0.02 + 0.1 * next(), 0.02 + 0.1 * next()];
        for (const k of [0, 1, 2]) {
          let previous = Number.POSITIVE_INFINITY;
          for (const step of [0, 0.02, 0.04, 0.06]) {
            const w = [...base] as Tuple3;
            w[k] = (w[k] as number) + step;
            const m = box();
            const op = mixed(m, w, segments);
            expect(op.status).toBe('ok');
            expect((op.diagnostics ?? []).filter((d) => d.severity !== 'info')).toEqual([]);
            const v = volumeOf(m);
            expect(v).toBeLessThan(previous);
            previous = v;
          }
        }
      }
    }
  });

  it('the first entry that contains an edge wins; selected edges no entry contains stay sharp', () => {
    const first = box();
    expect(
      first.bevel(sel.edges.all(), {
        width: [
          { edges: Z, width: 0.1 },
          { edges: sel.edges.all(), width: 0.05 },
        ],
        segments: 1,
        label: 'b',
      }).status,
    ).toBe('ok');
    const explicit = box();
    expect(mixed(explicit, [0.05, 0.05, 0.1], 1).status).toBe('ok');
    expect(first.snapshot()).toEqual(explicit.snapshot());

    const partial = box();
    expect(
      partial.bevel(sel.edges.all(), { width: [{ edges: Z, width: 0.1 }], segments: 1 }).status,
    ).toBe('ok');
    expect(volumeOf(partial)).toBeCloseTo(
      8 * H[0] * H[1] * H[2] - (4 * 2 * H[2] * (0.1 * 0.1)) / 2,
      12,
    );
  });

  it('rejects an entry outside the selection, an empty list and a non-positive width', () => {
    const outside = box();
    const op = outside.bevel(Z, {
      width: [
        { edges: Z, width: 0.1 },
        { edges: X, width: 0.05 },
      ],
      segments: 1,
    });
    expect(op.error?.code).toBe('model-selection-empty');
    expect(op.error?.detail).toMatchObject({ entry: 1 });

    const empty = box();
    expect(empty.bevel(Z, { width: [], segments: 1 }).error?.code).toBe('model-invalid-argument');
    const negative = box();
    expect(negative.bevel(Z, { width: [{ edges: Z, width: -1 }], segments: 1 }).error?.code).toBe(
      'model-invalid-argument',
    );
  });

  it('records entry selectors as descriptions in the history', () => {
    const m = box();
    mixed(m, [0.05, 0.06, 0.07], 2);
    const args = m.journal.at(-1)?.args as { width: { edges: string; width: number }[] };
    expect(args.width.map((w) => typeof w.edges)).toEqual(['string', 'string', 'string']);
  });
});
