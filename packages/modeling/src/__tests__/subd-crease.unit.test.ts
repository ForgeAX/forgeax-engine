import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CREASE_INFINITE, edgeSharpness, flagSharpness, markCrease, withCrease } from '../crease';
import { EDGE_SHARP, type EditMesh } from '../mesh';
import { model } from '../model';
import { sel } from '../selectors';
import { type LimitSurface, subdivisionLimit } from '../subd-limit';
import { subdivide } from '../subdivide';

type P = readonly [number, number, number];
const FOLD = (78 * Math.PI) / 180;

function limit(mesh: EditMesh, options?: Parameters<typeof subdivisionLimit>[1]): LimitSurface {
  const out = subdivisionLimit(mesh, options);
  if (!out.ok) throw out.error;
  return out.value;
}

function at(surface: LimitSurface, v: number): P {
  const i = surface.vertices.indexOf(v);
  if (i < 0) throw new Error(`vertex ${v} missing`);
  return [
    surface.position[i * 3] as number,
    surface.position[i * 3 + 1] as number,
    surface.position[i * 3 + 2] as number,
  ];
}

function nearestGap(surface: LimitSurface, target: P): number {
  let best = Infinity;
  for (let i = 0; i < surface.vertices.length; i++) {
    best = Math.min(
      best,
      dist(
        [
          surface.position[i * 3] as number,
          surface.position[i * 3 + 1] as number,
          surface.position[i * 3 + 2] as number,
        ],
        target,
      ),
    );
  }
  return best;
}

function meshGap(mesh: EditMesh, target: P): number {
  let best = Infinity;
  for (const v of mesh.vertices()) best = Math.min(best, dist(mesh.position(v), target));
  return best;
}

function dist(a: P, b: P): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function refine(
  mesh: EditMesh,
  levels: number,
  boundary: 'edgeAndCorner' | 'edgeOnly' = 'edgeAndCorner',
): EditMesh {
  const next = mesh.clone();
  const r = subdivide(
    next,
    next.faces(),
    { levels, boundary },
    { tolerance: 1e-9, policy: 'ts', faceBudget: 5_000_000 },
    [],
  );
  if (!r.ok) throw r.error;
  return next;
}

/** Box cage subdivided once so it has valence-3 corners and valence-4 interior vertices. */
function cage(): EditMesh {
  const m = model();
  m.box({ size: [2, 1.4, 1] });
  m.subdivide(undefined, { levels: 1, scheme: 'simple' });
  return m.editMesh;
}

function setCrease(mesh: EditMesh, edges: readonly number[], s: number): void {
  for (const e of edges) mesh.eFlags[e] = withCrease(mesh.eFlags[e] as number, s);
}

function faceLoop(mesh: EditMesh, f: number): number[] {
  return mesh.faceHalves(mesh.faces()[f] as number).map((h) => h >> 1);
}

describe('byte stability of infinite creases', () => {
  const golden = [
    'all/edgeAndCorner/ok/5a18ea036f0e4439',
    'all/edgeOnly/ok/5a18ea036f0e4439',
    'loop/edgeAndCorner/ok/b17588c1d187234a',
    'loop/edgeOnly/ok/b17588c1d187234a',
    'dart/edgeAndCorner/ok/9303e5986ce70efa',
    'dart/edgeOnly/ok/9303e5986ce70efa',
    'open/edgeAndCorner/ok/6356583bc11429b2',
    'open/edgeOnly/ok/6356583bc11429b2',
  ];
  it('keeps every pre-subdivide result byte-identical', () => {
    const out: string[] = [];
    for (const kind of ['all', 'loop', 'dart', 'open'] as const) {
      for (const boundary of ['edgeAndCorner', 'edgeOnly'] as const) {
        const m = model();
        m.box({ size: [2, 1.4, 1] });
        m.subdivide(undefined, { levels: 1, scheme: 'simple' });
        const mesh = m.editMesh;
        const edges = mesh.edges();
        if (kind === 'all') m.markSharp(sel.edges.all());
        if (kind === 'loop') for (const e of faceLoop(mesh, 5)) mesh.eFlags[e] = EDGE_SHARP;
        if (kind === 'dart') mesh.eFlags[edges[3] as number] = EDGE_SHARP;
        if (kind === 'open') {
          mesh.removeFace(mesh.faces()[7] as number);
          mesh.eFlags[edges[9] as number] = EDGE_SHARP;
        }
        const r = m.subdivide(undefined, { levels: 3, boundary });
        out.push(
          `${kind}/${boundary}/${r.status}/${createHash('sha256').update(m.snapshot()).digest('hex').slice(0, 16)}`,
        );
      }
    }
    expect(out).toEqual(golden);
  });

  it('treats creaseSharpness Infinity as the default', () => {
    const a = cage();
    const b = cage();
    for (const mesh of [a, b]) setCrease(mesh, faceLoop(mesh, 5), Infinity);
    const ra = refine(a, 2);
    const rb = cage();
    setCrease(rb, faceLoop(rb, 5), Infinity);
    const r = subdivide(
      rb,
      rb.faces(),
      { levels: 2, creaseSharpness: Infinity },
      { tolerance: 1e-9, policy: 'ts', faceBudget: 1e6 },
      [],
    );
    expect(r.ok).toBe(true);
    expect(Array.from(rb.eFlags.slice(0, 50))).toEqual(Array.from(ra.eFlags.slice(0, 50)));
  });
});

describe('authoring API', () => {
  it('quantizes to quarter steps, rejects negatives, clears with 0', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const e = m.editMesh.edges().slice(0, 2);
    const diag: never[] = [];
    expect(markCrease(m.editMesh, e, 1.5, diag).ok).toBe(true);
    expect(flagSharpness(m.editMesh.eFlags[e[0] as number] as number)).toBe(1.5);
    expect(edgeSharpness(m.editMesh, e[0] as number)).toBe(1.5);
    expect(markCrease(m.editMesh, e, -1, diag).ok).toBe(false);
    expect(markCrease(m.editMesh, e, Number.NaN, diag).ok).toBe(false);
    expect(markCrease(m.editMesh, e, 0, diag).ok).toBe(true);
    expect(edgeSharpness(m.editMesh, e[0] as number)).toBe(0);
    expect(flagSharpness(withCrease(0, CREASE_INFINITE))).toBe(Infinity);
    const r = m.markCrease(sel.edges.all(), 2);
    expect(r.status).toBe('ok');
    const clean = model();
    clean.box({ size: [1, 1, 1] });
    expect(clean.markCrease(sel.edges.all(), -2).error?.code).toBe('model-invalid-argument');
    expect(m.markSharp(sel.edges.all(), false).status).toBe('ok');
    expect(m.editMesh.edges().map((x) => m.editMesh.eFlags[x])).toEqual(
      m.editMesh.edges().map(() => 0),
    );
  });

  it('warns when a sharpness is not representable', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const r = m.markCrease(sel.edges.all(), 1.1);
    expect(r.status).toBe('ok');
    expect(JSON.stringify(r.diagnostics ?? r)).toMatch(/quantiz|quarter|1\/4/i);
  });
});

describe('semi-sharp refinement', () => {
  it('sharpens monotonically with s = 1, 2, 3, infinity', () => {
    const ring = (s: number): number => {
      const mesh = cage();
      setCrease(mesh, faceLoop(mesh, 5), s);
      const deep = refine(mesh, 4);
      // distance of the refined surface from the smooth one at the crease: larger deviation = smoother
      const smooth = refine(cage(), 4);
      let total = 0;
      for (const v of smooth.vertices().slice(0, 2000))
        total += dist(deep.position(v), smooth.position(v));
      return total;
    };
    const d = [1, 2, 3, Infinity].map(ring);
    expect(d[0] as number).toBeGreaterThan(0);
    for (let i = 1; i < d.length; i++) expect(d[i] as number).toBeGreaterThan(d[i - 1] as number);
  });

  it('rejects negative creaseSharpness', () => {
    const mesh = cage();
    const r = subdivide(
      mesh,
      mesh.faces(),
      { levels: 1, creaseSharpness: -1 },
      { tolerance: 1e-9, policy: 'ts', faceBudget: 1e6 },
      [],
    );
    expect(r.ok).toBe(false);
  });
});

describe('closed-form limit with fractional sharpness', () => {
  it('equals the limit of the refined cage and the six-level brute force', () => {
    for (const s of [0.5, 1, 1.5, 2.25, 3]) {
      const mesh = cage();
      setCrease(mesh, faceLoop(mesh, 5), s);
      const closed = limit(mesh);
      const once = limit(refine(mesh, 1));
      const brute = refine(mesh, 6);
      for (const v of mesh.vertices()) {
        const p = at(closed, v);
        expect(nearestGap(once, p), `s=${s} v=${v} refine-1`).toBeLessThan(1e-11);
        expect(meshGap(brute, p), `s=${s} v=${v} brute`).toBeLessThan(2e-3);
      }
    }
  });

  it('handles a finite dart, mixed-sharpness creases and a corner', () => {
    const mesh = cage();
    const edges = mesh.edges();
    setCrease(mesh, [edges[3] as number], 2);
    const dart = limit(mesh);
    expect(dart.vertices.length).toBe(mesh.vertices().length);
    const [a, b] = mesh.edgeVertices(edges[3] as number);
    const brute = refine(mesh, 6);
    for (const v of [a, b]) expect(meshGap(brute, at(dart, v))).toBeLessThan(2e-3);

    const mixed = cage();
    const loop = faceLoop(mixed, 5);
    setCrease(mixed, [loop[0] as number], 0.5);
    setCrease(mixed, [loop[1] as number], 2.75);
    setCrease(mixed, [loop[2] as number], 1.5);
    setCrease(mixed, [loop[3] as number], 2.25);
    const closed = limit(mixed);
    const once = limit(refine(mixed, 1));
    const deep = refine(mixed, 6);
    for (const v of mixed.vertices()) {
      expect(nearestGap(once, at(closed, v)), `mixed v=${v}`).toBeLessThan(1e-11);
      expect(meshGap(deep, at(closed, v)), `mixed brute v=${v}`).toBeLessThan(3e-3);
    }
  });

  it('lifts the dart precondition only for finite sharpness', () => {
    const finite = cage();
    setCrease(finite, [finite.edges()[3] as number], 1);
    expect(subdivisionLimit(finite).ok).toBe(true);
    const infinite = cage();
    infinite.eFlags[infinite.edges()[3] as number] = EDGE_SHARP;
    const r = subdivisionLimit(infinite);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-precondition');
  });

  it('is bitwise mirror symmetric with half-sharp creases', () => {
    const m = model();
    m.box({ size: [2, 1.4, 1] });
    m.subdivide(undefined, { levels: 1, scheme: 'simple' });
    const mesh = m.editMesh;
    // crease the x = 0 mid-plane loop: edges whose both ends are symmetric about x (|x| equal)
    const mirrored = mesh.clone();
    const flip = (q: P): P => [-q[0], q[1], q[2]];
    const byKey = new Map<string, number>();
    for (const v of mesh.vertices()) byKey.set(flip(mesh.position(v)).join(','), v);
    const pairs = mesh.edges().filter((e) => {
      const [a, b] = mesh.edgeVertices(e);
      return (
        Math.abs(mesh.position(a)[0]) === Math.abs(mesh.position(b)[0]) && mesh.position(a)[0] !== 0
      );
    });
    setCrease(mesh, pairs, 1.75);
    for (const e of mesh.edges()) mirrored.eFlags[e] = mesh.eFlags[e] as number;
    const surface = limit(mesh);
    for (const v of mesh.vertices()) {
      const w = byKey.get(mesh.position(v).join(',')) as number | undefined;
      const twin = byKey.get(mesh.position(v).join(',')) as number | undefined;
      expect(w).toBeDefined();
      if (twin === undefined) continue;
      const p = at(surface, v);
      const q = at(surface, twin);
      expect(p[0] + q[0]).toBe(0);
      expect(p[1]).toBe(q[1]);
      expect(p[2]).toBe(q[2]);
    }
  });
});

describe('neck-seam fold', () => {
  /** Tube of 8-sided rings that folds about 78 degrees at the middle ring, like the F2 neck seam. */
  function neck(): { m: ReturnType<typeof model>; ring: number[] } {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const mesh = m.editMesh;
    for (const f of mesh.faces()) mesh.removeFace(f);
    for (const v of mesh.vertices()) mesh.removeVertex?.(v);
    return { m, ring: [] };
  }
  it('half-sharp lowers the maximum fold angle against full-sharp and smooth', () => {
    void neck;
    const rows = 5;
    const sides = 8;
    const mesh = cage0(rows, sides, FOLD);
    const ringEdges: number[] = [];
    const mid = 2;
    for (const e of mesh.edges()) {
      const [a, b] = mesh.edgeVertices(e);
      if (Math.floor(a / sides) === mid && Math.floor(b / sides) === mid) ringEdges.push(e);
    }
    const maxFold = (s: number | 'smooth'): number => {
      const c = mesh.clone();
      if (s !== 'smooth') setCrease(c, ringEdges, s);
      const deep = refine(c, 3);
      return maxDihedral(deep);
    };
    const smooth = maxFold('smooth');
    const half = maxFold(1);
    const full = maxFold(Infinity);
    expect(half).toBeGreaterThan(smooth);
    expect(half).toBeLessThan(full);
    expect(full).toBeGreaterThan(70);
  });
});

function cage0(rows: number, sides: number, fold: number): EditMesh {
  const m = model();
  const mesh = m.editMesh;
  const id: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = r < 2 ? r : 2 + (r - 2) * Math.cos(fold);
    const z = r < 2 ? 0 : (r - 2) * Math.sin(fold);
    const yy = r < 2 ? r : y;
    for (let i = 0; i < sides; i++) {
      const a = (2 * Math.PI * i) / sides;
      id.push(mesh.addVertex(Math.cos(a) * 0.5, yy, z + Math.sin(a) * 0.5));
    }
  }
  for (let r = 0; r + 1 < rows; r++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const f = mesh.addFace([
        id[r * sides + i] as number,
        id[r * sides + j] as number,
        id[(r + 1) * sides + j] as number,
        id[(r + 1) * sides + i] as number,
      ]);
      if (!f.ok) throw f.error;
    }
  }
  return mesh;
}

function maxDihedral(mesh: EditMesh): number {
  let best = 0;
  const normal = (f: number): P => {
    const vs = mesh.faceHalves(f).map((h) => mesh.position(mesh.hVert[h] as number));
    const a = vs[0] as P;
    const b = vs[1] as P;
    const c = vs[2] as P;
    const u: P = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: P = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const n: P = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const bis: P = [0, (1 + Math.cos(FOLD)) / 2, Math.sin(FOLD) / 2];
  const bl = Math.hypot(...bis);
  for (const e of mesh.edges()) {
    if (mesh.isBoundaryEdge(e)) continue;
    const [ea, eb] = mesh.edgeVertices(e);
    const pa = mesh.position(ea);
    const pb = mesh.position(eb);
    const ev: P = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    if (
      Math.abs(ev[0] * bis[0] + ev[1] * bis[1] + ev[2] * bis[2]) / (bl * (Math.hypot(...ev) || 1)) >
      0.05
    )
      continue;
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    const na = normal(fa);
    const nb = normal(fb);
    const d = Math.acos(Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2])));
    best = Math.max(best, (d * 180) / Math.PI);
  }
  return best;
}
