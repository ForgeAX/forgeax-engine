import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeSnapshot } from '../fxem';
import { faceCentroid, type Tuple3, triangulateLoop, windingNumber } from '../geom';
import { components, pointTriangleDistance, reachesInto } from '../intersect';
import type { EditMesh } from '../mesh';
import { type Model, model } from '../model';

// Winding evaluations are counted through the module boundary, so the prefilter is
// proven by how much winding work runs, not by timing.
vi.mock('../geom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../geom')>();
  return { ...actual, windingNumber: vi.fn(actual.windingNumber) };
});

/** The verdict before the prefilter: every sample is tested against the whole outer part. */
function referenceReachesInto(
  mesh: EditMesh,
  inner: readonly number[],
  outer: readonly number[],
  triangles: readonly (readonly Tuple3[])[],
  tolerance: number,
): boolean {
  return samplesOf(mesh, inner).some(
    (p) =>
      windingNumber(mesh, outer, p) > 0.5 &&
      triangles.every((t) => pointTriangleDistance(p, t) > tolerance),
  );
}

function samplesOf(mesh: EditMesh, faces: readonly number[]): Tuple3[] {
  const samples: Tuple3[] = [];
  const seen = new Set<number>();
  for (const f of faces) {
    samples.push(faceCentroid(mesh, f));
    for (const v of mesh.faceVertices(f)) {
      if (seen.has(v)) continue;
      seen.add(v);
      samples.push(mesh.position(v));
    }
  }
  return samples;
}

function solidOf(mesh: EditMesh, faces: readonly number[]): Tuple3[][] {
  const triangles: Tuple3[][] = [];
  for (const f of faces) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const indices = triangulateLoop(points) ?? [];
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]] as number[];
      triangles.push(corners.map((k) => points[k] as Tuple3));
    }
  }
  return triangles;
}

/** Fast and reference verdicts for every ordered pair of distinct closed components. */
function verdictsOf(
  mesh: EditMesh,
  tolerance: number,
): { pair: [number, number]; fast: boolean; reference: boolean }[] {
  const parts = components(mesh);
  const out: { pair: [number, number]; fast: boolean; reference: boolean }[] = [];
  for (let a = 0; a < parts.faces.length; a++) {
    for (let b = 0; b < parts.faces.length; b++) {
      if (a === b || !parts.closed[a] || !parts.closed[b]) continue;
      const inner = parts.faces[a] as number[];
      const outer = parts.faces[b] as number[];
      const triangles = solidOf(mesh, outer);
      out.push({
        pair: [a, b],
        fast: reachesInto(mesh, inner, outer, triangles, tolerance),
        reference: referenceReachesInto(mesh, inner, outer, triangles, tolerance),
      });
    }
  }
  return out;
}

/** Deterministic corpus generator (mulberry32), so every run sees the same pairs. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'box' | 'sphere';

function shape(kind: Kind, size: Tuple3, center: Tuple3): Model {
  const m = model();
  if (kind === 'sphere') {
    m.sphere({ radius: (size[0] as number) / 2, widthSegments: 10, heightSegments: 6, center });
  } else {
    m.box({ size, center });
  }
  return m;
}

function pair(a: Model, b: Model): Model {
  const m = model();
  m.append(a);
  m.append(b);
  return m;
}

interface Case {
  category: 'outside' | 'nested' | 'touching' | 'sunk' | 'crossing' | 'random';
  mesh: EditMesh;
  tolerance: number;
}

/** Closed-component pairs covering outside, nested, touching, sunk, crossing and random placements. */
function corpus(): Case[] {
  const rand = seeded(0x5eed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const range = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const cases: Case[] = [];
  const add = (category: Case['category'], m: Model, tolerance: number) =>
    cases.push({ category, mesh: m.editMesh, tolerance });

  for (let i = 0; i < 12; i++) {
    const tol = pick([1e-6, 1e-3]);
    const kind = pick<Kind>(['box', 'sphere']);
    const s = range(0.4, 1.2);
    const far = (s + 1) * 4;
    add(
      'outside',
      pair(
        shape('box', [1, 1, 1], [0, 0, 0]),
        shape(kind, [s, s, s], [far * (i % 2 ? 1 : -1), 0.2 * i, 0]),
      ),
      tol,
    );
  }

  for (let i = 0; i < 24; i++) {
    const tol = pick([1e-6, 1e-3, 1e-2]);
    const outerKind = pick<Kind>(['box', 'sphere']);
    const innerKind = pick<Kind>(['box', 'sphere']);
    const big = range(1, 2);
    const small = big * range(0.2, 0.45);
    const offset = big * range(-0.05, 0.05);
    add(
      'nested',
      pair(
        shape(outerKind, [big, big, big], [0, 0, 0]),
        shape(innerKind, [small, small, small], [offset, offset, offset]),
      ),
      tol,
    );
  }

  for (let i = 0; i < 40; i++) {
    const tol = pick([1e-6, 1e-3]);
    const a = pick<Kind>(['box', 'sphere']);
    const b = pick<Kind>(['box', 'sphere']);
    const w = range(0.6, 1.4);
    const h = range(0.6, 1.4);
    const bw = range(0.2, 0.8);
    // B rests flush on the top of A: contact at exactly y = h / 2.
    add(
      'touching',
      pair(shape(a, [w, h, w], [0, 0, 0]), shape(b, [bw, bw, bw], [0.1 * bw, h / 2 + bw / 2, 0])),
      tol,
    );
  }

  for (let i = 0; i < 40; i++) {
    const tol = pick([1e-3, 1e-2]);
    const a = pick<Kind>(['box', 'sphere']);
    const b = pick<Kind>(['box', 'sphere']);
    const w = range(0.8, 1.4);
    const bw = range(0.2, 0.6);
    // B's bottom sits a fraction of the tolerance, or a few tolerances, below A's top.
    const depth = tol * pick([0.25, 0.5, 2, 4]);
    add(
      'sunk',
      pair(shape(a, [w, w, w], [0, 0, 0]), shape(b, [bw, bw, bw], [0, w / 2 + bw / 2 - depth, 0])),
      tol,
    );
  }

  for (let i = 0; i < 40; i++) {
    const tol = pick([1e-6, 1e-3]);
    const a = pick<Kind>(['box', 'sphere']);
    const b = pick<Kind>(['box', 'sphere']);
    const s = range(0.8, 1.2);
    const t = range(0.3, 0.7);
    add(
      'crossing',
      pair(shape(a, [s, s, s], [0, 0, 0]), shape(b, [s, s, s], [t * s, t * s * 0.6, t * s * 0.3])),
      tol,
    );
  }

  for (let i = 0; i < 40; i++) {
    const tol = pick([1e-6, 1e-3, 1e-2]);
    const a = pick<Kind>(['box', 'sphere']);
    const b = pick<Kind>(['box', 'sphere']);
    const sa = range(0.2, 1.5);
    const sb = range(0.2, 1.5);
    const c = (): Tuple3 => [range(-1, 1), range(-1, 1), range(-1, 1)];
    add('random', pair(shape(a, [sa, sa, sa], c()), shape(b, [sb, sb, sb], c())), tol);
  }
  return cases;
}

describe('reachesInto matches the unfiltered reference on every closed-pair verdict', () => {
  it('agrees on a seeded corpus of inside, outside, touching, sunk, crossing and random pairs', () => {
    const cases = corpus();
    const seen = new Map<string, number>();
    const tally = { true: 0, false: 0 };
    for (const c of cases) {
      const verdicts = verdictsOf(c.mesh, c.tolerance);
      expect(verdicts.length, c.category).toBe(2);
      for (const v of verdicts) {
        expect([c.category, v.pair, v.fast], c.category).toEqual([c.category, v.pair, v.reference]);
        tally[v.fast ? 'true' : 'false'] += 1;
      }
      seen.set(c.category, (seen.get(c.category) ?? 0) + verdicts.length);
    }
    expect([...seen.keys()].sort()).toEqual(
      ['crossing', 'nested', 'outside', 'random', 'sunk', 'touching'].sort(),
    );
    // Each verdict polarity occurs in the corpus, so equality is not vacuous.
    expect(tally.true).toBeGreaterThan(0);
    expect(tally.false).toBeGreaterThan(0);
  });

  it('pins the designed verdicts of the outside and nested cases', () => {
    const far = verdictsOf(
      pair(shape('box', [1, 1, 1], [0, 0, 0]), shape('sphere', [1, 1, 1], [6, 0, 0])).editMesh,
      1e-6,
    );
    expect(far.map((v) => v.fast)).toEqual([false, false]);
    const nested = verdictsOf(
      pair(shape('box', [2, 2, 2], [0, 0, 0]), shape('box', [0.6, 0.6, 0.6], [0, 0, 0])).editMesh,
      1e-3,
    );
    // The inner box reaches into the outer one; the outer box does not reach into the inner.
    expect(nested.find((v) => v.pair[0] === 1)?.fast).toBe(true);
    expect(nested.find((v) => v.pair[0] === 0)?.fast).toBe(false);
  });

  it('agrees on the real frozen suspension corner (C-104), every closed-pair direction', () => {
    const bytes = new Uint8Array(
      gunzipSync(readFileSync(new URL('./fixtures/suspension.fxem.gz', import.meta.url))),
    );
    // Decoded through the source module: the frozen-build fixture returns the package's Model type.
    const suspension = decodeSnapshot(bytes);
    if (!suspension.ok) throw new Error(`suspension.fxem.gz: ${suspension.error.code}`);
    const verdicts = verdictsOf(suspension.value, 1e-3);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.map((v) => [v.pair, v.fast])).toEqual(
      verdicts.map((v) => [v.pair, v.reference]),
    );
  });
});

describe('reachesInto triangle-box reject keeps the tolerance boundary exact', () => {
  it('agrees with the reference for sample depths straddling the tolerance by one part in 1e9', () => {
    const tolerance = 1e-3;
    for (const factor of [1 - 1e-9, 1, 1 + 1e-9]) {
      const depth = tolerance * factor;
      const mesh = pair(
        shape('box', [2, 2, 2], [0, 0, 0]),
        // The inner top sits `depth` below the outer top at y = 1.
        shape('box', [0.5, 0.5, 0.5], [0, 0.75 - depth, 0]),
      ).editMesh;
      const parts = components(mesh);
      const inner = parts.faces[1] as number[];
      const outer = parts.faces[0] as number[];
      const triangles = solidOf(mesh, outer);
      expect(reachesInto(mesh, inner, outer, triangles, tolerance)).toBe(
        referenceReachesInto(mesh, inner, outer, triangles, tolerance),
      );
    }
  });
});

describe('reachesInto prefilter skips winding work outside the outer part', () => {
  it('evaluates no winding number for a far-apart inner part, while the reference evaluates each sample', () => {
    const mesh = pair(
      shape('box', [1, 1, 1], [0, 0, 0]),
      shape('box', [1, 1, 1], [10, 0, 0]),
    ).editMesh;
    const parts = components(mesh);
    const inner = parts.faces[1] as number[];
    const outer = parts.faces[0] as number[];
    const triangles = solidOf(mesh, outer);
    const samples = samplesOf(mesh, inner).length;
    expect(samples).toBeGreaterThan(0);

    vi.mocked(windingNumber).mockClear();
    expect(reachesInto(mesh, inner, outer, triangles, 1e-6)).toBe(false);
    const fastEvaluations = vi.mocked(windingNumber).mock.calls.length;

    vi.mocked(windingNumber).mockClear();
    expect(referenceReachesInto(mesh, inner, outer, triangles, 1e-6)).toBe(false);
    const referenceEvaluations = vi.mocked(windingNumber).mock.calls.length;

    expect(referenceEvaluations).toBe(samples);
    expect(fastEvaluations).toBe(0);
  });

  it('still evaluates winding for samples inside the outer part', () => {
    const mesh = pair(
      shape('box', [2, 2, 2], [0, 0, 0]),
      shape('box', [0.6, 0.6, 0.6], [0, 0, 0]),
    ).editMesh;
    const parts = components(mesh);
    const inner = parts.faces[1] as number[];
    const outer = parts.faces[0] as number[];
    vi.mocked(windingNumber).mockClear();
    expect(reachesInto(mesh, inner, outer, solidOf(mesh, outer), 1e-3)).toBe(true);
    expect(vi.mocked(windingNumber).mock.calls.length).toBeGreaterThan(0);
  });
});
