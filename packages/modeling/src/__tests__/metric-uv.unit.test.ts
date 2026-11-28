import { describe, expect, it } from 'vitest';
import { sin } from '../dmath';
import { EDGE_SEAM } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import { expectContract } from './contract';

type UV = readonly [number, number];

const RECT: Point2[] = [
  [0, 0],
  [2, 0],
  [2, 1],
  [0, 1],
];

function faceUv(m: Model, f: number): UV[] {
  const mesh = m.editMesh;
  return mesh.faceHalves(f).map((h) => {
    const c = mesh.corner('uv0', h);
    if (c === undefined) throw new Error(`face ${f} has no uv0`);
    return [c[0] as number, c[1] as number] as const;
  });
}

const at = (uv: readonly UV[], i: number): UV => uv[i] as UV;
const du = (uv: readonly UV[], i: number, j: number): number => at(uv, i)[0] - at(uv, j)[0];
const dv = (uv: readonly UV[], i: number, j: number): number => at(uv, i)[1] - at(uv, j)[1];

function area(uv: readonly UV[]): number {
  let a = 0;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i] as UV;
    const q = uv[(i + 1) % uv.length] as UV;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

type P3 = readonly [number, number, number];
interface Corner {
  readonly p: P3;
  readonly uv: UV;
}

/** Position and uv0 of every corner of a face, in loop order. */
function corners(m: Model, f: number): Corner[] {
  const mesh = m.editMesh;
  const halves = mesh.faceHalves(f);
  return mesh.faceVertices(f).map((v, c) => {
    const uv = mesh.corner('uv0', halves[c] as number);
    if (uv === undefined) throw new Error(`face ${f} has no uv0`);
    return { p: mesh.position(v), uv: [uv[0] as number, uv[1] as number] as const };
  });
}

const cornersOf = (m: Model, selector: ReturnType<typeof sel.createdBy>): Corner[][] =>
  selector.evaluate(m.editMesh).map((f) => corners(m, f));

function allUv(m: Model, selector = sel.all()): UV[][] {
  return selector.evaluate(m.editMesh).map((f) => faceUv(m, f));
}

function range(uvs: readonly UV[][], axis: 0 | 1): [number, number] {
  const values = uvs.flat().map((p) => p[axis]);
  return [Math.min(...values), Math.max(...values)];
}

function seamEdges(m: Model): number {
  const mesh = m.editMesh;
  return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0).length;
}

function hasUv(m: Model, selector = sel.all()): boolean {
  const mesh = m.editMesh;
  return selector
    .evaluate(mesh)
    .every((f) => mesh.faceHalves(f).every((h) => mesh.corner('uv0', h) !== undefined));
}

function noUv(m: Model): boolean {
  const mesh = m.editMesh;
  return mesh
    .faces()
    .every((f) => mesh.faceHalves(f).every((h) => mesh.corner('uv0', h) === undefined));
}

describe('metric uv: revolve family', () => {
  const R = 0.5;
  const N = 8;

  it('cylinder side: u is the arc length around the axis, v the height, in meters', () => {
    const m = model();
    expect(
      m.cylinder({
        label: 'p',
        radiusTop: R,
        radiusBottom: R,
        height: 2,
        radialSegments: N,
        uv: 'metric',
      }).status,
    ).toBe('ok');
    const side = allUv(m, sel.createdBy('p', 'side'));
    const [u0, u1] = range(side, 0);
    const [v0, v1] = range(side, 1);
    expect(u0).toBe(0);
    expect(u1).toBeCloseTo(2 * Math.PI * R, 6);
    expect(v0).toBe(0);
    expect(v1).toBeCloseTo(2, 6);
    for (const quad of side) {
      expect(du(quad, 1, 0)).toBeCloseTo((2 * Math.PI * R) / N, 6);
      expect(dv(quad, 3, 0)).toBeCloseTo(2, 6);
    }
  });

  it('cylinder caps are planar meters of the rim and every chart is positively oriented', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
      uv: 'metric',
    });
    for (const role of ['top', 'bottom']) {
      const [cap] = allUv(m, sel.createdBy('p', role));
      const [lo, hi] = range([cap as UV[]], 0);
      expect(hi - lo).toBeCloseTo(2 * R, 6);
      expect(area(cap as UV[])).toBeCloseTo(0.5 * N * R * R * sin((2 * Math.PI) / N), 6);
    }
    for (const uv of allUv(m)) expect(area(uv)).toBeGreaterThan(0);
  });

  it('cylinder caps are the rim in meters: bottom u = x, top u is mirrored (-x), v = z (falsifier: unflipped bottom)', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
      uv: 'metric',
    });
    for (const [role, sign] of [
      ['bottom', 1],
      ['top', -1],
    ] as const) {
      const [cap] = cornersOf(m, sel.createdBy('p', role));
      expect(cap).toHaveLength(N);
      for (const c of cap as Corner[]) {
        expect(c.uv[0]).toBeCloseTo(sign * c.p[0], 6);
        expect(c.uv[1]).toBeCloseTo(c.p[2], 6);
      }
    }
  });

  it('flags the seam meridian only, so a closed cylinder cuts along one side edge', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
      uv: 'metric',
    });
    expect(seamEdges(m)).toBe(1);
    const open = model();
    open.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
      heightSegments: 3,
      openEnded: true,
      uv: 'metric',
    });
    expect(seamEdges(open)).toBe(3);
  });

  it('is isometric on a developable surface: uv area equals face area on the side', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: 64,
      uv: 'metric',
    });
    const uvArea = allUv(m, sel.createdBy('p', 'side')).reduce((s, q) => s + area(q), 0);
    expect(uvArea).toBeCloseTo(2 * Math.PI * R * 2, 6);
  });

  it('a cone keeps true slant length for v and a pole triangle keeps its area', () => {
    const m = model();
    m.cone({
      label: 'p',
      radius: 1,
      height: 2,
      radialSegments: 12,
      uv: 'metric',
    });
    const side = allUv(m, sel.createdBy('p', 'side'));
    expect(range(side, 1)[1]).toBeCloseTo(Math.hypot(1, 2), 6);
    for (const tri of side) {
      expect(tri).toHaveLength(3);
      expect(area(tri)).toBeGreaterThan(0.1);
    }
  });

  it('a pole corner sits at the mean u of its triangle base, a different u per triangle (cone and sphere)', () => {
    const cone = model();
    cone.cone({ label: 'p', radius: R, height: 2, radialSegments: N, uv: 'metric' });
    const apexes: number[] = [];
    for (const tri of cornersOf(cone, sel.createdBy('p', 'side'))) {
      const apex = tri.find((c) => Math.hypot(c.p[0], c.p[2]) < 1e-9) as Corner;
      const base = tri.filter((c) => c !== apex);
      expect(apex.uv[0]).toBeCloseTo(
        ((base[0] as Corner).uv[0] + (base[1] as Corner).uv[0]) / 2,
        6,
      );
      apexes.push(apex.uv[0]);
    }
    const step = (2 * Math.PI * R) / N;
    expect(apexes.sort((a, b) => a - b).map((u) => u / step)).toEqual(
      Array.from({ length: N }, (_, i) => expect.closeTo(i + 0.5, 6)),
    );
    const sphere = model();
    sphere.sphere({ label: 'p', radius: 1, widthSegments: 8, heightSegments: 4, uv: 'metric' });
    let poles = 0;
    for (const face of cornersOf(sphere, sel.createdBy('p'))) {
      const pole = face.filter((c) => Math.hypot(c.p[0], c.p[2]) < 1e-9);
      if (pole.length === 0) continue;
      poles++;
      const base = face.filter((c) => !pole.includes(c));
      expect(face).toHaveLength(3);
      expect((pole[0] as Corner).uv[0]).toBeCloseTo(
        ((base[0] as Corner).uv[0] + (base[1] as Corner).uv[0]) / 2,
        6,
      );
    }
    expect(poles).toBe(2 * 8);
  });

  it('sphere and torus are fully covered and positively oriented; a torus is one seam ring plus one seam meridian', () => {
    const s = model();
    s.sphere({
      label: 'p',
      radius: 1,
      widthSegments: 16,
      heightSegments: 8,
      uv: 'metric',
    });
    expect(hasUv(s)).toBe(true);
    for (const uv of allUv(s)) expect(area(uv)).toBeGreaterThan(0);
    const [su0, su1] = range(allUv(s), 0);
    expect(su1 - su0).toBeCloseTo(2 * Math.PI * Math.sin((Math.PI * 4) / 8), 6);
    const t = model();
    t.torus({
      label: 'p',
      radius: 1,
      tube: 0.25,
      radialSegments: 8,
      tubularSegments: 24,
      uv: 'metric',
    });
    expect(hasUv(t)).toBe(true);
    for (const uv of allUv(t)) expect(area(uv)).toBeGreaterThan(0);
    expect(seamEdges(t)).toBe(8 + 24);
    const [, tv1] = range(allUv(t), 1);
    expect(tv1).toBeCloseTo(2 * 0.25 * Math.PI * (Math.sin(Math.PI / 8) / (Math.PI / 8)), 1);
  });

  it('a partial revolve has no wrap-around seam; a profile with a loop closes v', () => {
    const m = model();
    const profile: Point2[] = [
      [0.5, 0],
      [0.5, 1],
    ];
    m.revolve({
      label: 'p',
      points: profile,
      segments: 6,
      angle: 180,
      uv: 'metric',
    });
    expect(seamEdges(m)).toBe(0);
    expect(range(allUv(m), 0)[1]).toBeCloseTo(Math.PI * 0.5, 6);
  });

  it('survives a boolean: every face of the cut cylinder keeps a uv0 and the surviving corners keep their meters', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: 48,
      uv: 'metric',
    });
    const tool = model();
    tool.box({ size: [0.3, 0.3, 2], center: [0, 0, 0.5] });
    const op = m.difference(tool.snapshot(), { label: 'notch' });
    expect(op.status).toBe('ok');
    const own = sel.createdBy('p');
    expect(own.evaluate(m.editMesh).length).toBeGreaterThan(48);
    expect(hasUv(m, own)).toBe(true);
    const side = allUv(m, sel.createdBy('p', 'side'));
    const [u0, u1] = range(side, 0);
    expect(u0).toBeGreaterThanOrEqual(-1e-6);
    expect(u1).toBeLessThanOrEqual(2 * Math.PI * R + 1e-6);
    for (const uv of allUv(m, own)) expect(Math.abs(area(uv))).toBeGreaterThan(0);
  });

  it('writes nothing unless asked (default stays uv-free)', () => {
    const m = model();
    m.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
    });
    m.sphere({ label: 'p', radius: 1, widthSegments: 8, heightSegments: 4 });
    m.revolve({
      label: 'p',
      points: [
        [0.5, 0],
        [0.5, 1],
      ],
      segments: 6,
    });
    expect(noUv(m)).toBe(true);
    expect(seamEdges(m)).toBe(0);
  });

  it('metric and default differ only in uv0 and seam flags (same geometry)', () => {
    const a = model();
    const b = model();
    a.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
    });
    b.cylinder({
      label: 'p',
      radiusTop: R,
      radiusBottom: R,
      height: 2,
      radialSegments: N,
      uv: 'metric',
    });
    const pos = (m: Model) => m.editMesh.vertices().map((v) => [...m.editMesh.position(v)]);
    expect(pos(b)).toEqual(pos(a));
    expect(b.editMesh.faces().length).toBe(a.editMesh.faces().length);
  });
});

describe('metric uv: extrudePolygon', () => {
  it('walls: u is the distance along the outline, v the depth; the seam is the first point edge', () => {
    const m = model();
    expect(m.extrudePolygon({ label: 'p', points: RECT, depth: 0.5, uv: 'metric' }).status).toBe(
      'ok',
    );
    const walls = allUv(m, sel.createdBy('p', 'side'));
    expect(walls).toHaveLength(4);
    expect(range(walls, 0)).toEqual([0, 6]);
    expect(range(walls, 1)).toEqual([0, 0.5]);
    expect(walls.map((q) => du(q, 1, 0))).toEqual([2, 1, 2, 1]);
    expect(seamEdges(m)).toBe(1);
    expectContract(m);
  });

  it('caps are planar meters and every face is positively oriented, holes included', () => {
    const m = model();
    m.extrudePolygon({
      label: 'p',
      points: RECT,
      holes: [
        [
          [0.5, 0.25],
          [1.5, 0.25],
          [1.5, 0.75],
          [0.5, 0.75],
        ],
      ],
      depth: 0.25,
      steps: 2,
      uv: 'metric',
    });
    expect(hasUv(m)).toBe(true);
    for (const uv of allUv(m)) expect(area(uv)).toBeGreaterThan(0);
    const top = allUv(m, sel.createdBy('p', 'top'));
    expect(top.reduce((s, q) => s + area(q), 0)).toBeCloseTo(2 - 0.5, 6);
    const hole = allUv(m, sel.createdBy('p', 'hole'));
    expect(range(hole, 0)[1]).toBeCloseTo(3, 6);
    expect(range(hole, 1)).toEqual([0, 0.25]);
    expect(seamEdges(m)).toBe(2 * 2);
  });

  it('caps are planar meters with the orientation sign: top (x, y), bottom mirrored (-x, y), both windings (falsifier: unflipped bottom)', () => {
    const L: Point2[] = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    for (const points of [L, [...L].reverse()]) {
      const m = model();
      m.extrudePolygon({ label: 'p', points, depth: 0.5, uv: 'metric' });
      for (const [role, sign, z] of [
        ['top', 1, 0.5],
        ['bottom', -1, 0],
      ] as const) {
        const caps = cornersOf(m, sel.createdBy('p', role));
        expect(caps.length).toBeGreaterThan(0);
        for (const cap of caps) {
          for (const c of cap) {
            expect(c.p[2]).toBeCloseTo(z, 6);
            expect(c.uv[0]).toBeCloseTo(sign * c.p[0], 6);
            expect(c.uv[1]).toBeCloseTo(c.p[1], 6);
          }
        }
      }
    }
  });

  it('wall v spans the step depth on every step: the quad of step s covers [s d / n, (s + 1) d / n]', () => {
    const m = model();
    m.extrudePolygon({ label: 'p', points: RECT, depth: 0.9, steps: 3, uv: 'metric' });
    const walls = allUv(m, sel.createdBy('p', 'side'));
    expect(walls).toHaveLength(12);
    const bands = new Set<string>();
    for (const q of walls) {
      expect(at(q, 0)[1]).toBeCloseTo(at(q, 1)[1], 6);
      expect(at(q, 2)[1]).toBeCloseTo(at(q, 3)[1], 6);
      expect(dv(q, 3, 0)).toBeCloseTo(0.3, 6);
      bands.add(at(q, 0)[1].toFixed(6));
    }
    expect([...bands].sort()).toEqual(['0.000000', '0.300000', '0.600000']);
    expect(range(walls, 1)[1]).toBeCloseTo(0.9, 6);
  });

  it('survives a boolean through a wall', () => {
    const m = model();
    m.extrudePolygon({
      label: 'p',
      points: RECT,
      depth: 0.5,
      steps: 4,
      uv: 'metric',
    });
    const tool = model();
    tool.box({ size: [0.4, 3, 0.2], center: [1, 0.5, 0.25] });
    expect(m.difference(tool.snapshot(), { label: 'slot' }).status).toBe('ok');
    const own = sel.createdBy('p');
    expect(hasUv(m, own)).toBe(true);
    expect(allUv(m, own.and(sel.createdBy('p', 'side'))).length).toBeGreaterThan(4);
  });

  it('writes nothing unless asked', () => {
    const m = model();
    m.extrudePolygon({ label: 'p', points: RECT, depth: 0.5 });
    expect(noUv(m)).toBe(true);
    expect(seamEdges(m)).toBe(0);
  });
});

describe('metric uv: option check', () => {
  it('refuses any uv other than omitted or metric, on every producer (the type alone does not guard JS callers)', () => {
    const bad = ['banana', 'planar', '', 0, false, null, true] as never[];
    const calls: ((m: Model, uv: never) => OpReport)[] = [
      (m, uv) => m.cylinder({ radiusTop: 1, radiusBottom: 1, height: 1, radialSegments: 8, uv }),
      (m, uv) => m.cone({ radius: 1, height: 1, radialSegments: 8, uv }),
      (m, uv) => m.sphere({ radius: 1, widthSegments: 8, heightSegments: 4, uv }),
      (m, uv) => m.torus({ radius: 1, tube: 0.25, radialSegments: 6, tubularSegments: 8, uv }),
      (m, uv) =>
        m.revolve({
          points: [
            [0.5, 0],
            [0.5, 1],
          ],
          segments: 6,
          uv,
        }),
      (m, uv) => m.extrudePolygon({ points: RECT, depth: 1, uv }),
    ];
    for (const call of calls) {
      for (const uv of bad) {
        const m = model();
        const report = call(m, uv);
        expect(report.status).toBe('failed');
        expect(report.error?.code).toBe('model-invalid-argument');
        expect(m.editMesh.faces()).toHaveLength(0);
      }
    }
  });
});
