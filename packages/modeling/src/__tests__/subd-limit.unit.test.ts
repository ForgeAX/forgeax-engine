import { describe, expect, it } from 'vitest';
import { EDGE_SHARP, EditMesh } from '../mesh';
import { model } from '../model';
import { sel } from '../selectors';
import { exactSum, type LimitSurface, subdivisionLimit } from '../subd-limit';
import { subdivide } from '../subdivide';

type P = readonly [number, number, number];

function build(points: readonly P[], faces: readonly (readonly number[])[]): EditMesh {
  const mesh = new EditMesh();
  for (const p of points) mesh.addVertex(...p);
  for (const f of faces) {
    const added = mesh.addFace(f);
    if (!added.ok) throw added.error;
  }
  return mesh;
}

function limit(mesh: EditMesh, options?: Parameters<typeof subdivisionLimit>[1]): LimitSurface {
  const out = subdivisionLimit(mesh, options);
  if (!out.ok) throw out.error;
  return out.value;
}

function at(surface: LimitSurface, v: number): { p: P; n: P; kind: string; valence: number } {
  const i = surface.vertices.indexOf(v);
  if (i < 0) throw new Error(`vertex ${v} missing`);
  const read = (a: Float64Array): P => [
    a[i * 3] as number,
    a[i * 3 + 1] as number,
    a[i * 3 + 2] as number,
  ];
  return {
    p: read(surface.position),
    n: read(surface.normal),
    kind: surface.kind[i] as string,
    valence: surface.valence[i] as number,
  };
}

function distance(a: P, b: P): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function nearest(surface: LimitSurface, target: P): { index: number; gap: number } {
  let best = { index: -1, gap: Infinity };
  for (let i = 0; i < surface.vertices.length; i++) {
    const gap = distance(
      [
        surface.position[i * 3] as number,
        surface.position[i * 3 + 1] as number,
        surface.position[i * 3 + 2] as number,
      ],
      target,
    );
    if (gap < best.gap) best = { index: i, gap };
  }
  return best;
}

function degrees(a: P, b: P): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Quad cap: apex of valence n, inner ring at z = 0 radius 1, outer ring at z = -1 radius 2. */
function cap(n: number, apexHeight: number): EditMesh {
  const points: P[] = [[0, 0, apexHeight]];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push([Math.cos(a), Math.sin(a), 0]);
  }
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / n;
    points.push([2.2 * Math.cos(a), 2.2 * Math.sin(a), -1]);
  }
  const faces = Array.from({ length: n }, (_, i) => [0, 1 + i, 1 + n + i, 1 + ((i + 1) % n)]);
  return build(points, faces);
}

function cubeMesh(): EditMesh {
  const m = model();
  m.box({ size: [2, 2, 2] });
  return m.editMesh;
}

describe('limit evaluation', () => {
  it('matches the bicubic B-spline mask on a regular region', () => {
    const points: P[] = [];
    const size = 6;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        points.push([i, j, Math.sin(i * 0.9) * Math.cos(j * 0.7) + 0.1 * i * j]);
      }
    }
    const faces: number[][] = [];
    for (let j = 0; j + 1 < size; j++) {
      for (let i = 0; i + 1 < size; i++) {
        faces.push([j * size + i, j * size + i + 1, (j + 1) * size + i + 1, (j + 1) * size + i]);
      }
    }
    const mesh = build(points, faces);
    const surface = limit(mesh);
    let checked = 0;
    for (let j = 1; j + 1 < size; j++) {
      for (let i = 1; i + 1 < size; i++) {
        const v = j * size + i;
        const w = [1, 4, 1];
        const expected: number[] = [0, 0, 0];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const q = points[(j + dj) * size + i + di] as P;
            for (let k = 0; k < 3; k++) {
              expected[k] =
                (expected[k] as number) +
                ((w[di + 1] as number) * (w[dj + 1] as number) * (q[k] as number)) / 36;
            }
          }
        }
        const got = at(surface, v);
        expect(got.kind).toBe('smooth');
        expect(got.valence).toBe(4);
        expect(distance(got.p, expected as unknown as P)).toBeLessThan(1e-12);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it('puts every cube corner at (1/2)(+-1, +-1, +-1) with the outward diagonal normal', () => {
    const mesh = cubeMesh();
    const surface = limit(mesh);
    expect(surface.vertices.length).toBe(8);
    for (const v of mesh.vertices()) {
      const q = mesh.position(v);
      const got = at(surface, v);
      expect(got.valence).toBe(3);
      expect(got.kind).toBe('smooth');
      expect(distance(got.p, [q[0] * 0.5, q[1] * 0.5, q[2] * 0.5])).toBeLessThan(1e-14);
      const s = Math.sqrt(3);
      expect(distance(got.n, [q[0] / s, q[1] / s, q[2] / s])).toBeLessThan(1e-14);
    }
  });

  it('is closed form on valence 3, 5 and 6 poles', () => {
    for (const n of [3, 5, 6]) {
      const h = 0.7;
      const mesh = cap(n, h);
      const apex = at(limit(mesh), 0);
      expect(apex.valence).toBe(n);
      const z = (n * n * h + n * -1) / (n * (n + 5));
      expect(distance(apex.p, [0, 0, z])).toBeLessThan(1e-12);
      expect(distance(apex.n, [0, 0, 1])).toBeLessThan(1e-12);
    }
  });

  it('agrees with six subdivision levels at the poles (finite-level residual bound; the closed form is the extrapolated limit)', () => {
    for (const mesh of [cubeMesh(), cap(5, 0.4), cap(3, -0.3)]) {
      const exact = limit(mesh);
      const probe = mesh.vertices().find((v) => at(exact, v).valence !== 4) as number;
      const reference = at(exact, probe);
      let refined = mesh;
      for (let level = 0; level < 6; level++) {
        const next = refined.clone();
        const result = subdivide(
          next,
          next.faces(),
          { levels: 1 },
          { tolerance: 1e-9, policy: 'ts', faceBudget: 1_000_000 },
          [],
        );
        if (!result.ok) throw result.error;
        refined = next;
      }
      const deepSurface = limit(refined);
      const match = nearest(deepSurface, reference.p);
      expect(match.gap).toBeLessThan(1e-9);
      const deep = at(deepSurface, deepSurface.vertices[match.index] as number);
      expect(
        distance(refined.position(deepSurface.vertices[match.index] as number), reference.p),
      ).toBeLessThan(1e-3);
      expect(deep.valence).toBe(reference.valence);
      expect(degrees(deep.n, reference.n)).toBeLessThan(0.5);
    }
  });

  it('keeps the limit of a cage equal to the limit of its refinement, creases and boundary included', () => {
    const m = model();
    m.box({ size: [2, 1.4, 1] });
    const mesh = m.editMesh;
    const pre = subdivide(
      mesh,
      mesh.faces(),
      { levels: 1 },
      { tolerance: 1e-9, policy: 'ts', faceBudget: 100_000 },
      [],
    );
    if (!pre.ok) throw pre.error;
    const faces = mesh.faces();
    const loop = mesh.faceHalves(faces[5] as number).map((h) => h >> 1);
    for (const e of loop) mesh.eFlags[e] = EDGE_SHARP;
    const open = faces[faces.length - 1] as number;
    mesh.removeFace(open);
    for (const boundary of ['edgeAndCorner', 'edgeOnly'] as const) {
      const before = limit(mesh, { boundary });
      const next = mesh.clone();
      const result = subdivide(
        next,
        next.faces(),
        { levels: 1, boundary },
        { tolerance: 1e-9, policy: 'ts', faceBudget: 100_000 },
        [],
      );
      if (!result.ok) throw result.error;
      const after = limit(next, { boundary });
      const kinds = new Set(before.kind);
      expect(kinds.size).toBeGreaterThanOrEqual(2);
      for (const [i, v] of before.vertices.entries()) {
        const got = at(before, v);
        const match = nearest(after, got.p);
        expect(match.gap, `vertex ${v} (${before.kind[i]})`).toBeLessThan(1e-12);
        expect(after.kind[match.index]).toBe(got.kind);
      }
    }
  });

  it('classifies creases and corners, leaves their normal zero, and rejects a lone dart', () => {
    const mesh = cubeMesh();
    const edges = mesh.edges();
    const first = edges[0] as number;
    mesh.eFlags[first] = EDGE_SHARP;
    const [a] = mesh.edgeVertices(first);
    const dart = subdivisionLimit(mesh);
    expect(dart.ok ? undefined : dart.error.code).toBe('model-precondition');
    const second = edges.find((e) => e !== first && mesh.edgeVertices(e).includes(a)) as number;
    mesh.eFlags[second] = EDGE_SHARP;
    const third = edges.find(
      (e) => e !== first && e !== second && mesh.edgeVertices(e).includes(a),
    ) as number;
    mesh.eFlags[third] = EDGE_SHARP;
    const corner = limit(mesh, { vertices: [a] });
    expect(at(corner, a).kind).toBe('corner');
    expect(at(corner, a).p).toEqual([...mesh.position(a)]);
    const open = cubeMesh();
    open.removeFace(open.faces()[0] as number);
    const surface = limit(open);
    const kinds = new Set(surface.kind);
    expect(kinds.has('crease')).toBe(true);
    const c = surface.kind.indexOf('crease');
    expect([...surface.normal.slice(c * 3, c * 3 + 3)]).toEqual([0, 0, 0]);
  });

  it('gives bitwise mirrored limit points for a cage symmetric about x = 0', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const m = model();
    m.box({ size: [2, 2, 2] });
    const seed0 = m.editMesh;
    const sub = seed0.clone();
    const done = subdivide(
      sub,
      sub.faces(),
      { levels: 2 },
      { tolerance: 1e-9, policy: 'ts', faceBudget: 100_000 },
      [],
    );
    if (!done.ok) throw done.error;
    const points = new Map<number, P>();
    const key = (p: P) => `${p[0]}|${p[1]}|${p[2]}`;
    const ids = sub.vertices();
    const shifts = new Map<string, P>();
    for (const v of ids) {
      const p = sub.position(v);
      const mirrored: P = [-p[0], p[1], p[2]];
      const a = key(p);
      const b = key(mirrored);
      if (!shifts.has(a)) {
        const s: P = [rand() * 0.2, rand() * 0.2, rand() * 0.2];
        shifts.set(a, s);
        shifts.set(b, [p[0] === 0 ? 0 : -s[0], s[1], s[2]]);
      }
      const s = shifts.get(a) as P;
      points.set(v, [p[0] + s[0], p[1] + s[1], p[2] + s[2]]);
    }
    const faces = sub.faces().map((f) => sub.faceVertices(f));
    const original = build(
      ids.map((v) => points.get(v) as P),
      faces.map((f) => f.map((v) => ids.indexOf(v))),
    );
    const flipped = build(
      [...ids].reverse().map((v) => {
        const p = points.get(v) as P;
        return [-p[0], p[1], p[2]] as P;
      }),
      [...faces]
        .reverse()
        .map((f) => f.map((v) => ids.length - 1 - ids.indexOf(v)))
        .map((f) => [...f].reverse()),
    );
    const left = limit(original);
    const right = limit(flipped);
    const byKey = new Map<string, P>();
    for (const [i, v] of right.vertices.entries()) {
      const p = flipped.position(v);
      byKey.set(key(p), [
        right.position[i * 3] as number,
        right.position[i * 3 + 1] as number,
        right.position[i * 3 + 2] as number,
      ]);
    }
    let onPlane = 0;
    for (const [i, v] of left.vertices.entries()) {
      const p = original.position(v);
      const mirror = byKey.get(key([-p[0], p[1], p[2]])) as P;
      const x = left.position[i * 3] as number;
      expect(Object.is(-x + 0, mirror[0] + 0)).toBe(true);
      expect(Object.is(left.position[i * 3 + 1], mirror[1])).toBe(true);
      expect(Object.is(left.position[i * 3 + 2], mirror[2])).toBe(true);
      if (p[0] === 0) {
        onPlane++;
        expect(Object.is(x, 0)).toBe(true);
      }
    }
    expect(onPlane).toBeGreaterThan(0);
  });

  it('is deterministic and bounded, and reports structured errors', () => {
    const mesh = cubeMesh();
    const a = limit(mesh);
    const b = limit(mesh);
    expect([...a.position]).toEqual([...b.position]);
    const only = limit(mesh, { vertices: [5, 2, 2] });
    expect([...only.vertices]).toEqual([2, 5]);
    const budget = subdivisionLimit(mesh, { budget: 10 });
    expect(budget.ok ? undefined : budget.error.code).toBe('model-work-budget');
    const missing = subdivisionLimit(mesh, { vertices: [99] });
    expect(missing.ok ? undefined : missing.error.code).toBe('model-invalid-argument');
    const pillow = build(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 2, 3],
        [3, 2, 1, 0],
      ],
    );
    const pole = subdivisionLimit(pillow);
    expect(pole.ok ? undefined : pole.error.code).toBe('model-precondition');
    const boundary = subdivisionLimit(mesh, { boundary: 'nope' as never });
    expect(boundary.ok ? undefined : boundary.error.code).toBe('model-invalid-argument');
  });

  it('sums exactly whatever the order', () => {
    expect(exactSum([1e16, 1, -1e16])).toBe(1);
    expect(exactSum([0.1, 0.2, 0.3])).toBe(exactSum([0.3, 0.1, 0.2]));
    expect(Object.is(exactSum([-0, 0]), 0)).toBe(true);
    const terms = [1e300, 3.5, -1e300, 2 ** -60, 7, -7.25, 1e-30];
    const reversed = [...terms].reverse();
    expect(exactSum(terms)).toBe(exactSum(reversed));
  });
});

describe('model surface', () => {
  it('queries and snaps through the session', () => {
    const m = model();
    m.box({ size: [2, 2, 2] });
    const direct = m.limit();
    expect(direct.ok).toBe(true);
    const picked = m.limit(sel.all(), {});
    expect(picked.ok).toBe(true);
    const report = m.snapToLimit(sel.all());
    expect(report.status).toBe('ok');
    for (const v of m.editMesh.vertices()) {
      const q = m.editMesh.position(v);
      expect(Math.abs(Math.abs(q[0]) - 0.5)).toBeLessThan(1e-14);
    }
  });
});
