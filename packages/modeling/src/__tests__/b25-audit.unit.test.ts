import { describe, expect, it } from 'vitest';
import {
  CREASE_INFINITE,
  flagSharpness,
  markCrease,
  mergeFlags,
  setFlag,
  withCrease,
} from '../crease';
import { smoothAcross } from '../finish';
import { EDGE_SEAM, EDGE_SHARP, EditMesh } from '../mesh';
import { model } from '../model';
import type { OpDiagnostic } from '../ops';
import { sel } from '../selectors';
import { subdivisionLimit } from '../subd-limit';
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

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
}

/** Asymmetric cap: apex of valence n, perturbed inner ring (open outer boundary). */
function cap(n: number, amp: number, seed: number): EditMesh {
  const rnd = lcg(seed);
  const points: P[] = [[0.1 * amp, -0.05 * amp, 0.6]];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + amp * 0.5 * rnd();
    const r = 1 + amp * rnd();
    points.push([r * Math.cos(a), r * Math.sin(a), amp * rnd()]);
  }
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / n;
    points.push([2.2 * Math.cos(a), 2.2 * Math.sin(a), -1 + amp * rnd()]);
  }
  return build(
    points,
    Array.from({ length: n }, (_, i) => [0, 1 + i, 1 + n + i, 1 + ((i + 1) % n)]),
  );
}

function refineOnce(mesh: EditMesh): EditMesh {
  const next = mesh.clone();
  const r = subdivide(
    next,
    next.faces(),
    { levels: 1 },
    { tolerance: 1e-9, policy: 'ts', faceBudget: 50_000_000 },
    [],
  );
  if (!r.ok) throw r.error;
  return next;
}

/** Area-weighted (Newell) normal of the faces around vertex `v`. */
function newell(mesh: EditMesh, v: number): P {
  const n = [0, 0, 0];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    if (!vs.includes(v)) continue;
    const ps = vs.map((x) => mesh.position(x));
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i] as P;
      const b = ps[(i + 1) % ps.length] as P;
      n[0] = (n[0] as number) + (a[1] - b[1]) * (a[2] + b[2]);
      n[1] = (n[1] as number) + (a[2] - b[2]) * (a[0] + b[0]);
      n[2] = (n[2] as number) + (a[0] - b[0]) * (a[1] + b[1]);
    }
  }
  const length = Math.hypot(n[0] as number, n[1] as number, n[2] as number);
  return [(n[0] as number) / length, (n[1] as number) / length, (n[2] as number) / length];
}

function apexNear(mesh: EditMesh, at: readonly number[]): number {
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  for (const v of mesh.vertices()) {
    const q = mesh.position(v);
    const g = Math.hypot(
      q[0] - (at[0] as number),
      q[1] - (at[1] as number),
      q[2] - (at[2] as number),
    );
    if (g < gap) {
      gap = g;
      best = v;
    }
  }
  return best;
}

function degrees(a: P, b: P): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

describe('B25 audit A1: Halstead tangent mask at irregular vertices', () => {
  for (const n of [3, 5, 6]) {
    it(`valence ${n}: the closed-form normal sits inside the geometric tail of the refinement`, () => {
      const mesh = cap(n, 0.3, 100 + n);
      const surface = subdivisionLimit(mesh, { vertices: [0] });
      if (!surface.ok) throw surface.error;
      const closed: P = [
        surface.value.normal[0] as number,
        surface.value.normal[1] as number,
        surface.value.normal[2] as number,
      ];
      const levels: P[] = [];
      let refined = mesh;
      for (let level = 1; level <= 6; level++) {
        refined = refineOnce(refined);
        levels.push(newell(refined, apexNear(refined, Array.from(surface.value.position))));
      }
      const gaps = levels.map((x) => degrees(x, closed));
      const steps = levels.slice(1).map((x, i) => degrees(x, levels[i] as P));
      // Every level closes on the closed form by a constant factor, and the last remaining
      // gap is within the tail of the level-to-level steps (a geometric series).
      for (let k = 3; k < gaps.length; k++) {
        expect(gaps[k] as number).toBeLessThan(0.8 * (gaps[k - 1] as number));
      }
      expect(gaps[5] as number).toBeLessThanOrEqual(steps[4] as number);
    });
  }

  it('the limit normal is invariant under one more refinement of the cage', () => {
    for (const n of [3, 5, 6]) {
      const mesh = cap(n, 0.3, 300 + n);
      const a = subdivisionLimit(mesh, { vertices: [0] });
      if (!a.ok) throw a.error;
      const finer = refineOnce(mesh);
      const b = subdivisionLimit(finer, {
        vertices: [apexNear(finer, Array.from(a.value.position))],
      });
      if (!b.ok) throw b.error;
      const read = (s: typeof a.value): P => [
        s.normal[0] as number,
        s.normal[1] as number,
        s.normal[2] as number,
      ];
      expect(degrees(read(a.value), read(b.value))).toBeLessThan(1e-6);
    }
  });
});

describe('B25 audit A2: half-sharp edges keep smooth export normals', () => {
  it('only an infinite crease splits the render vertices', () => {
    const counts = [0, 0.25, 1.75, 9.75, Infinity].map((s) => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
      m.markCrease(sel.edges.all(), s);
      const out = m.toMesh({ normals: { mode: 'smooth' } });
      if (!out.ok) throw out.error;
      return out.value.report.gpuVertices;
    });
    expect(counts).toEqual([8, 8, 8, 8, 24]);
  });

  it('smoothAcross is false only on an infinite crease', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const mesh = m.editMesh;
    const e = mesh.edges()[0] as number;
    mesh.eFlags[e] = withCrease(0, 0.5);
    expect(smoothAcross(mesh, e, { mode: 'smooth' })).toBe(true);
    mesh.eFlags[e] = withCrease(0, Infinity);
    expect(smoothAcross(mesh, e, { mode: 'smooth' })).toBe(false);
  });
});

describe('B25 audit A3: every flag merge keeps the larger sharpness', () => {
  it('mergeFlags never lowers an infinite crease or adds finite ones', () => {
    const half = withCrease(0, 0.5);
    const three = withCrease(0, 0.75);
    expect(flagSharpness(mergeFlags(withCrease(0, 1), three))).toBe(1);
    expect(flagSharpness(mergeFlags(EDGE_SHARP, half))).toBe(Infinity);
    expect(flagSharpness(mergeFlags(half, EDGE_SHARP))).toBe(Infinity);
    expect(flagSharpness(mergeFlags(half, three))).toBe(0.75);
    expect(flagSharpness(mergeFlags(0, half))).toBe(0.5);
    expect(mergeFlags(EDGE_SEAM, half) & EDGE_SEAM).toBe(EDGE_SEAM);
    expect(flagSharpness(mergeFlags(half, EDGE_SEAM))).toBe(0.5);
  });

  it('setFlag clears the level with the crease and never resurrects it', () => {
    const half = withCrease(EDGE_SEAM, 0.5);
    const off = setFlag(half, EDGE_SHARP, false);
    expect(off).toBe(EDGE_SEAM);
    expect(flagSharpness(setFlag(off, EDGE_SHARP, true))).toBe(Infinity);
    expect(flagSharpness(setFlag(half, EDGE_SHARP, true))).toBe(Infinity);
  });

  it('markSharp off then on yields an infinite crease, not the old level', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markCrease(sel.edges.all(), 0.5);
    m.markSharp(sel.edges.all(), false);
    const mesh = m.editMesh;
    expect(mesh.edges().every((e) => mesh.eFlags[e] === 0)).toBe(true);
    m.markSharp(sel.edges.all(), true);
    expect(mesh.edges().every((e) => flagSharpness(mesh.eFlags[e] as number) === Infinity)).toBe(
      true,
    );
    m.markCrease(sel.edges.all(), 0.5);
    m.markSharp(sel.edges.all(), true);
    expect(mesh.edges().every((e) => flagSharpness(mesh.eFlags[e] as number) === Infinity)).toBe(
      true,
    );
  });

  it('remesh carries a half-sharp crease through unchanged', { timeout: 120000 }, () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markCrease(sel.edges.dihedral('>', 40), 0.5);
    const r = m.remesh(undefined, { targetEdgeLength: 0.2, iterations: 3 });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    const flagged = mesh.edges().filter((e) => (mesh.eFlags[e] as number) !== 0);
    expect(flagged.length).toBeGreaterThan(12);
    expect(flagged.every((e) => flagSharpness(mesh.eFlags[e] as number) === 0.5)).toBe(true);
  });
});

describe('B25 audit A4: the journal serializes an infinite sharpness', () => {
  it('survives a JSON round trip and replays to the same crease', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.markCrease(sel.edges.all(), Infinity);
    m.markCrease(sel.edges.all(), 1.5);
    const journal = JSON.parse(JSON.stringify(m.journal.slice(-2))) as {
      op: string;
      args: { sharpness: number | string };
    }[];
    expect(journal.map((entry) => entry.args.sharpness)).toEqual(['Infinity', 1.5]);
    const replay = model();
    replay.box({ size: [1, 1, 1] });
    const first = journal[0] as (typeof journal)[number];
    replay.markCrease(sel.edges.all(), Number(first.args.sharpness));
    const mesh = replay.editMesh;
    expect(mesh.edges().every((e) => flagSharpness(mesh.eFlags[e] as number) === Infinity)).toBe(
      true,
    );
  });
});

describe('B25 audit A5: finite sharpness on an open boundary is reported', () => {
  it('warns once with the edge count and still stores the flag', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const mesh = m.editMesh;
    mesh.removeFace(mesh.faces()[0] as number);
    const open = mesh.edges().filter((e) => mesh.isBoundaryEdge(e));
    const diagnostics: OpDiagnostic[] = [];
    const r = markCrease(mesh, mesh.edges(), 0.5, diagnostics);
    expect(r.ok).toBe(true);
    const warn = diagnostics.filter((d) => d.message.includes('open-boundary'));
    expect(warn.length).toBe(1);
    expect((warn[0] as OpDiagnostic).detail).toEqual({
      sharpness: 0.5,
      boundaryEdges: open.length,
    });
    const quiet: OpDiagnostic[] = [];
    markCrease(mesh, mesh.edges(), Infinity, quiet);
    markCrease(mesh, mesh.edges(), CREASE_INFINITE, quiet);
    expect(quiet).toEqual([]);
  });
});

describe('B25 audit A6: mirrored cages give bitwise mirrored limit normals', () => {
  it('a reversed, mirrored copy of an irregular cage mirrors positions and normals', () => {
    const base = cap(5, 0.3, 77);
    const ids = base.vertices();
    const order = ids.slice().reverse();
    const index = new Map(order.map((v, i) => [v, i]));
    const flip = build(
      order.map((v) => {
        const p = base.position(v);
        return [-p[0], p[1], p[2]] as P;
      }),
      base
        .faces()
        .slice()
        .reverse()
        .map((f) =>
          base
            .faceVertices(f)
            .slice()
            .reverse()
            .map((v) => index.get(v) as number),
        ),
    );
    const a = subdivisionLimit(base);
    const b = subdivisionLimit(flip);
    if (!a.ok || !b.ok) throw new Error('limit failed');
    for (const v of ids) {
      const i = a.value.vertices.indexOf(v);
      const j = b.value.vertices.indexOf(index.get(v) as number);
      const [px, py, pz] = [0, 1, 2].map((k) => a.value.position[i * 3 + k] as number);
      const [qx, qy, qz] = [0, 1, 2].map((k) => b.value.position[j * 3 + k] as number);
      expect([px, py, pz]).toEqual([-(qx as number), qy, qz]);
      const [nx, ny, nz] = [0, 1, 2].map((k) => a.value.normal[i * 3 + k] as number);
      const [mx, my, mz] = [0, 1, 2].map((k) => b.value.normal[j * 3 + k] as number);
      expect([(nx as number) + 0, (ny as number) + 0, (nz as number) + 0]).toEqual([
        -(mx as number) + 0,
        (my as number) + 0,
        (mz as number) + 0,
      ]);
    }
  });
});
