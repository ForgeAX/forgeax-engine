import { describe, expect, it } from 'vitest';
import { measureUv } from '../compute/uv-ts';
import type { Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

type Info = {
  chains: number;
  straightened: number;
  maxAngleError: number;
  verdicts: Record<string, number>;
  islands: { status: string; stretchBefore: number; stretchAfter: number }[];
};

function info(report: OpReport): Info {
  const d = report.diagnostics?.filter((x) => x.severity === 'info').at(-1);
  if (d === undefined) throw new Error(`${report.op}: ${report.error?.message}`);
  return d.detail as unknown as Info;
}

function warned(report: OpReport): string[] {
  return (report.diagnostics ?? []).filter((x) => x.severity === 'warn').map((x) => x.message);
}

function uvs(m: Model): number[][] {
  const mesh = m.editMesh;
  return mesh
    .faces()
    .flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) as Float32Array)),
    );
}

/** UV of the first corner at `vertex`. */
function uvAt(m: Model, vertex: number): [number, number] {
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      if (mesh.hVert[h] === vertex) {
        const c = mesh.corner('uv0', h) as Float32Array;
        return [c[0] as number, c[1] as number];
      }
    }
  }
  throw new Error(`vertex ${vertex} has no corner`);
}

/** Largest distance of the points from the line through the first and last one. */
function offLine(points: readonly [number, number][]): number {
  const [a, b] = [points[0], points[points.length - 1]] as [[number, number], [number, number]];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy);
  return Math.max(...points.map((p) => Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len));
}

interface Grid {
  readonly m: Model;
  readonly row: (j: number) => number[];
}

/** Triangulated cols x rows grid in the plane z = 0, planar-projected to uv0. */
function grid(
  cols: number,
  rows: number,
  pos: (i: number, j: number) => [number, number],
  skip: (i: number, j: number) => boolean = () => false,
): Grid {
  const m = model();
  const mesh = m.editMesh;
  const ids: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const line: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const [x, y] = pos(i, j);
      line.push(mesh.addVertex(x, y, 0));
    }
    ids.push(line);
  }
  const v = (i: number, j: number) => (ids[j] as number[])[i] as number;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (skip(i, j)) continue;
      const [a, b, c, d] = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
      const even = (i + j) % 2 === 0;
      for (const tri of even
        ? [
            [a, b, c],
            [a, c, d],
          ]
        : [
            [a, b, d],
            [b, c, d],
          ]) {
        const f = mesh.addFace(tri);
        if (!f.ok) throw f.error;
      }
    }
  }
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return { m, row: (j) => ids[j] as number[] };
}

const wavy = (i: number, j: number): [number, number] => [
  i,
  j + (j === 0 ? 0.12 * Math.sin(i * 1.7) : 0),
];

describe('uv.straighten gates', () => {
  it('leaves a gentle arc whose chord deviation exceeds maxAngle, and counts it', () => {
    const m = model();
    const mesh = m.editMesh;
    const c = mesh.addVertex(0, -0.5, 0);
    const arc: number[] = [];
    for (let k = 0; k <= 12; k++) {
      arc.push(mesh.addVertex(Math.cos((Math.PI * k) / 12), Math.sin((Math.PI * k) / 12), 0));
    }
    for (let k = 0; k < 12; k++) {
      const f = mesh.addFace([c, arc[k] as number, arc[k + 1] as number]);
      if (!f.ok) throw f.error;
    }
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const before = uvs(m);
    const i = info(m.uv.straighten());
    expect(i.chains).toBe(1);
    expect(i.straightened).toBe(0);
    expect(i.verdicts.none).toBe(1);
    expect(uvs(m)).toEqual(before);
  });

  it('counts a chain of one edge as no chain', () => {
    const m = model();
    const mesh = m.editMesh;
    const tri = [mesh.addVertex(0, 0, 0), mesh.addVertex(1, 0, 0), mesh.addVertex(0, 1, 0)];
    const f = mesh.addFace(tri);
    if (!f.ok) throw f.error;
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const i = info(m.uv.straighten());
    expect(i.chains).toBe(0);
    expect(i.verdicts.none).toBe(1);
  });

  it('a faces subset keeps the outside and its border byte for byte and reports partial', () => {
    const { m } = grid(8, 5, wavy);
    const inside = new Set(sel.inBox([-1, -1, -1], [4.001, 10, 1]).evaluate(m.editMesh));
    const before = uvs(m);
    const r = m.uv.straighten({ faces: sel.inBox([-1, -1, -1], [4.001, 10, 1]) });
    expect(info(r).islands[0]?.status).toBe('partial');
    const after = uvs(m);
    const mesh = m.editMesh;
    let k = 0;
    let moved = 0;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const x = mesh.position(mesh.hVert[h] as number)[0] as number;
        if (!inside.has(f) || x > 3.999) expect(after[k]).toEqual(before[k]);
        else if (after[k]?.[0] !== before[k]?.[0] || after[k]?.[1] !== before[k]?.[1]) moved++;
        k++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('a chain with only some selected edges is straightened as a whole', () => {
    const g = grid(8, 5, wavy);
    const near = sel.inBox([-1, -1, -1], [2.5, 1.5, 1]).toEdges('touching');
    const bottom = () => g.row(0).map((v) => uvAt(g.m, v));
    expect(offLine(bottom())).toBeGreaterThan(0.05);
    const i = info(g.m.uv.straighten({ edges: near }));
    expect(i.straightened).toBeGreaterThan(0);
    expect(offLine(bottom())).toBeLessThan(1e-3);
  });

  it('interior chain vertices land at their 3D arc-length parameter', () => {
    const xs = [0, 0.1, 0.5, 1.5, 1.6, 3, 4, 4.1, 6];
    const g = grid(8, 3, (i, j) => [xs[i] as number, j + (j === 0 ? 0.01 * Math.sin(i * 2.3) : 0)]);
    expect(info(g.m.uv.straighten()).straightened).toBeGreaterThan(0);
    const mesh = g.m.editMesh;
    const ids = g.row(0);
    const pts = ids.map((v) => mesh.position(v));
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      const [p, q] = [pts[k - 1], pts[k]] as [Tuple3, Tuple3];
      cum.push((cum[k - 1] as number) + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    const total = cum[cum.length - 1] as number;
    const u = ids.map((v) => uvAt(g.m, v)[0]);
    const [u0, u1] = [u[0] as number, u[u.length - 1] as number];
    for (let k = 0; k < u.length; k++) {
      expect(((u[k] as number) - u0) / (u1 - u0)).toBeCloseTo((cum[k] as number) / total, 3);
    }
  });

  it('moves a chain that has to push several rows aside, over several stages', () => {
    const rows = (i: number, j: number): [number, number] => {
      const end = i === 0 || i === 8;
      if (j === 0) return [i, end ? 0 : -0.3];
      if (j <= 3) return [i, end ? 0.1 * j : -0.3 + 0.08 * j];
      return [i, j];
    };
    const g = grid(8, 6, rows);
    const bottom = () => g.row(0).map((v) => uvAt(g.m, v));
    expect(offLine(bottom())).toBeGreaterThan(0.2);
    const r = g.m.uv.straighten({ maxStretch: 20 });
    const i = info(r);
    expect(i.islands[0]?.status).toBe('accepted');
    expect(offLine(bottom())).toBeLessThan(1e-3);
    const after = measureUv(g.m.editMesh);
    if (!after.ok) throw after.error;
    expect(after.value.flipped + after.value.zeroArea).toBe(0);
  });
});

describe('uv.straighten verdicts', () => {
  const dip = (i: number, j: number): [number, number] => {
    const end = i === 0 || i === 8;
    if (j === 0) return [i, end ? 0 : -0.3];
    if (j === 1) return [i, end ? 0.2 : -0.1];
    return [i, j];
  };

  it('names blocked an island whose chain cannot pass a frozen neighbor, and keeps its UVs', () => {
    const g = grid(8, 4, dip);
    const before = uvs(g.m);
    const r = g.m.uv.straighten({ faces: sel.inBox([-1, -2, -1], [9, 0.25, 1]), maxStretch: 6 });
    const i = info(r);
    expect(i.islands[0]?.status).toBe('blocked');
    expect(i.verdicts.blocked).toBe(1);
    expect(i.verdicts.flipped).toBe(0);
    expect(i.straightened).toBe(0);
    expect(warned(r).some((w) => w.includes('keep their UVs'))).toBe(true);
    expect(uvs(g.m)).toEqual(before);
  });
});

describe('uv.straighten collapse at landing', () => {
  it.each([
    0.125, 0.0625, 0.1,
  ])('names blocked a lone triangle whose chain landing makes it zero-area (bulge %s)', (bulge) => {
    const m = model();
    const mesh = m.editMesh;
    const ids = [mesh.addVertex(0, 0, 0), mesh.addVertex(1, bulge, 0), mesh.addVertex(2, 0, 0)];
    const f = mesh.addFace(ids);
    if (!f.ok) throw f.error;
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const before = uvs(m);
    const r = m.uv.straighten();
    const i = info(r);
    expect(i.chains).toBe(1);
    expect(i.islands[0]?.status).toBe('blocked');
    expect(i.straightened).toBe(0);
    expect(uvs(m)).toEqual(before);
  });
});

describe('uv.straighten more verdicts', () => {
  it('keeps an island whose straightened layout would overlap more, and names overlap', () => {
    const rows = 14;
    const half = rows / 2;
    const g = grid(
      18,
      rows,
      (i, j) => {
        if (j === half && i >= 1) return [i, half - 0.7 * Math.sin((Math.PI * (i - 1)) / 17)];
        if (j === half + 1 && i === 9) return [i, 6.5];
        return [i, j];
      },
      (i, j) => j === half && i >= 1 && i <= 17,
    );
    const before = uvs(g.m);
    const r = g.m.uv.straighten({ maxStretch: 3 });
    const i = info(r);
    expect(i.islands[0]?.status).toBe('overlap');
    expect(i.verdicts.overlap).toBe(1);
    expect(i.straightened).toBe(0);
    expect(warned(r).some((w) => w.includes('keep their UVs'))).toBe(true);
    expect(uvs(g.m)).toEqual(before);
  });

  it('ignores boundary loops without two corners: a smooth disc and a single-corner teardrop', () => {
    const outline = (shape: (t: number) => [number, number]) => {
      const m = model();
      const mesh = m.editMesh;
      const c = mesh.addVertex(0, 0, 0);
      const ring: number[] = [];
      const n = 72;
      for (let k = 0; k < n; k++) {
        const [x, y] = shape((2 * Math.PI * k) / n);
        ring.push(mesh.addVertex(x, y, 0));
      }
      for (let k = 0; k < n; k++) {
        const f = mesh.addFace([c, ring[k] as number, ring[(k + 1) % n] as number]);
        if (!f.ok) throw f.error;
      }
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      return m;
    };
    for (const shape of [
      (t: number): [number, number] => [Math.cos(t), Math.sin(t)],
      (t: number): [number, number] => [Math.cos(t) - 0.2, Math.sin(t) * Math.sin(t / 2)],
    ]) {
      const m = outline(shape);
      const before = uvs(m);
      const i = info(m.uv.straighten());
      expect(i.chains).toBe(0);
      expect(i.verdicts.none).toBe(1);
      expect(uvs(m)).toEqual(before);
    }
  });
});

describe('uv.straighten mirror-image islands', () => {
  const mirrored = () => {
    const g = grid(8, 5, wavy);
    const mesh = g.m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const c = mesh.corner('uv0', h) as Float32Array;
        mesh.setCorner('uv0', h, [-(c[0] as number), c[1] as number]);
      }
    }
    return g;
  };

  it('straightens a fully inverted island in its mirrored frame and keeps its handedness', () => {
    const g = mirrored();
    const bottom = () => g.row(0).map((v) => uvAt(g.m, v));
    expect(offLine(bottom())).toBeGreaterThan(0.05);
    const before = measureUv(g.m.editMesh);
    if (!before.ok) throw before.error;
    const i = info(g.m.uv.straighten());
    expect(i.islands[0]?.status).toBe('accepted');
    expect(i.straightened).toBe(i.chains);
    expect(i.maxAngleError).toBeLessThanOrEqual(1);
    expect(offLine(bottom())).toBeLessThan(1e-3);
    const after = measureUv(g.m.editMesh);
    if (!after.ok) throw after.error;
    expect(after.value.flipped).toBe(before.value.flipped);
    expect(after.value.zeroArea).toBe(0);
  });

  it('straightens the same shape as the unmirrored island (mirror of the result)', () => {
    const plain = grid(8, 5, wavy);
    plain.m.uv.straighten();
    const flipped = mirrored();
    flipped.m.uv.straighten();
    const [a, b] = [uvs(plain.m), uvs(flipped.m)];
    for (const [k, p] of a.entries()) {
      expect(-(b[k]?.[0] as number)).toBeCloseTo(p[0] as number, 5);
      expect(b[k]?.[1] as number).toBeCloseTo(p[1] as number, 5);
    }
  });

  it('reports the same stretch before and after as the unmirrored island, not zero', () => {
    const plain = info(grid(8, 5, wavy).m.uv.straighten()).islands[0];
    const flipped = info(mirrored().m.uv.straighten()).islands[0];
    expect(plain?.stretchBefore).toBeGreaterThan(0);
    expect(plain?.stretchAfter).toBeGreaterThan(0);
    expect(flipped?.stretchBefore).toBeCloseTo(plain?.stretchBefore as number, 6);
    expect(flipped?.stretchAfter).toBeCloseTo(plain?.stretchAfter as number, 4);
  });

  it('keeps an island that is already folded under the flipped verdict', () => {
    const g = grid(8, 5, wavy);
    const mesh = g.m.editMesh;
    const knot = g.row(2)[4] as number;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        if (mesh.hVert[h] !== knot) continue;
        const c = mesh.corner('uv0', h) as Float32Array;
        mesh.setCorner('uv0', h, [(c[0] as number) + 3, (c[1] as number) - 5]);
      }
    }
    const before = uvs(g.m);
    const r = g.m.uv.straighten();
    expect(info(r).verdicts.flipped).toBe(1);
    expect(warned(r).some((w) => w.includes('keep their UVs'))).toBe(true);
    expect(uvs(g.m)).toEqual(before);
  });
});

describe('uv.straighten partly folded islands', () => {
  it('names flipped an island with one folded corner, before any chain move', () => {
    const g = grid(8, 5, wavy);
    const mesh = g.m.editMesh;
    const knot = g.row(1)[7] as number;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        if (mesh.hVert[h] !== knot) continue;
        const c = mesh.corner('uv0', h) as Float32Array;
        mesh.setCorner('uv0', h, [c[0] as number, (c[1] as number) - 1.5]);
      }
    }
    const folded = measureUv(mesh);
    if (!folded.ok) throw folded.error;
    expect(folded.value.flipped).toBeGreaterThan(0);
    expect(folded.value.flipped).toBeLessThan(mesh.faces().length);
    const before = uvs(g.m);
    const r = g.m.uv.straighten();
    expect(info(r).islands[0]?.status).toBe('flipped');
    expect(uvs(g.m)).toEqual(before);
  });
});

describe('uv.straighten acceptance on stored values', () => {
  it.each([
    [
      'v',
      (i: number, j: number): [number, number] => [i, j + (j === 0 ? Math.sin(i * 2.1) : 0)],
      (x: number, y: number): [number, number] => [1.3 + x * 1e-2, 1.3 + y * 1.5e-7],
    ],
    [
      'u',
      (i: number, j: number): [number, number] => [-(j + (j === 0 ? Math.sin(i * 2.1) : 0)), i],
      (x: number, y: number): [number, number] => [1.7 + x * 1.5e-7, 1.3 + y * 1e-2],
    ],
  ])('never stores a zero-area triangle for %s spacing at f32 resolution', (_axis, pos, uv) => {
    const g = grid(6, 2, pos);
    const mesh = g.m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const p = mesh.position(mesh.hVert[h] as number);
        mesh.setCorner('uv0', h, uv(p[0] as number, p[1] as number));
      }
    }
    const before = measureUv(mesh);
    if (!before.ok) throw before.error;
    expect(before.value.flipped + before.value.zeroArea).toBe(0);
    g.m.uv.straighten({ maxStretch: 1e12, maxAngle: 89 });
    const after = measureUv(mesh);
    if (!after.ok) throw after.error;
    expect(after.value.flipped + after.value.zeroArea).toBe(0);
  });

  it('reports the chord error of the stored values', () => {
    const g = grid(8, 5, wavy);
    const mesh = g.m.editMesh;
    for (const f of mesh.faces()) {
      for (const h of mesh.faceHalves(f)) {
        const c = mesh.corner('uv0', h) as Float32Array;
        mesh.setCorner('uv0', h, [(c[0] as number) * 1e-2 + 300, (c[1] as number) * 1e-2 + 300]);
      }
    }
    const i = info(g.m.uv.straighten({ maxStretch: 2 }));
    expect(i.islands[0]?.status).toBe('accepted');
    expect(i.maxAngleError).toBeGreaterThan(1e-4);
  });
});
