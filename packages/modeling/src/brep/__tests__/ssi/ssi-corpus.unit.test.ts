// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../../../geom';
import { nurbs, surfaceDomain, surfacePoint } from '../../../nurbs';
import { hullSkin, innerSkin, type SsiPair, ssiCorpus } from './corpus';
import { g16MeshUnion } from './g16-mesh';
import { prng } from './prng';
import { arcLength, recovery, trace } from './truth';
import { wrap } from './wrap';

const COUNTS = fileURLToPath(new URL('./fixtures/ssi-counts.json', import.meta.url));
/** Sampling resolution of the committed counts; the stability test doubles it. */
const N = 192;
/** Branches shorter than this fraction of the pair diagonal are sampling noise, not corpus members. */
const MIN = 0.01;

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly seed: number;
  readonly branches: number;
  readonly closed: number;
  /** Branch lengths over the pair diagonal, ascending, 3 digits. */
  readonly lengths: readonly number[];
}

const corpus = ssiCorpus();

function rowOf(pair: SsiPair, n: number): Row {
  const kept = trace(pair.truth, n)
    .map((b) => ({ closed: b.closed, length: arcLength(b.points, b.closed) / pair.diagonal }))
    .filter((b) => b.length >= MIN);
  return {
    id: pair.id,
    kind: pair.kind,
    seed: pair.seed,
    branches: kept.length,
    closed: kept.filter((b) => b.closed).length,
    lengths: kept.map((b) => Number(b.length.toFixed(3))).sort((x, y) => x - y),
  };
}

const rows = new Map<string, Row>();
const rowFor = (pair: SsiPair): Row => {
  let row = rows.get(pair.id);
  if (row === undefined) {
    row = rowOf(pair, N);
    rows.set(pair.id, row);
  }
  return row;
};

describe('seeded generator', () => {
  it('repeats a seed, separates seeds and stays in range', () => {
    const a = prng(7);
    const b = prng(7);
    const c = prng(8);
    const xs = Array.from({ length: 64 }, () => a.next());
    expect(Array.from({ length: 64 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 64 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBe(64);
  });

  it('draws ranges, integers and unit directions', () => {
    const r = prng(3);
    for (let i = 0; i < 200; i++) {
      const x = r.range(-2, 5);
      expect(x).toBeGreaterThanOrEqual(-2);
      expect(x).toBeLessThan(5);
      const k = r.int(2, 4);
      expect([2, 3, 4]).toContain(k);
      const d = r.direction();
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
    }
    const seen = new Set(Array.from({ length: 300 }, () => r.int(2, 4)));
    expect(seen.size).toBe(3);
  });

  it('is a fixed stream (a changed generator would reshuffle the whole corpus)', () => {
    const r = prng(1);
    expect([r.next(), r.next()].map((x) => Number(x.toFixed(6)))).toEqual([0.627074, 0.002736]);
  });
});

describe('corpus shape', () => {
  it('has 25 pairs with unique ids and at least 5 genuinely non-analytic ones', () => {
    expect(corpus.length).toBe(25);
    expect(new Set(corpus.map((p) => p.id)).size).toBe(25);
    expect(corpus.filter((p) => p.kind === 'freeform').length).toBeGreaterThanOrEqual(5);
    expect(corpus.filter((p) => p.id.startsWith('g16-')).length).toBe(3);
  });

  it('is deterministic: building twice gives identical control nets', () => {
    const again = ssiCorpus();
    for (let k = 0; k < corpus.length; k++) {
      expect(again[k]!.a).toEqual(corpus[k]!.a);
      expect(again[k]!.b).toEqual(corpus[k]!.b);
    }
  });

  it('covers closed loops, multi-branch pairs (2-3 or more curves) and open curves', () => {
    const analytic = corpus.filter((p) => p.designed);
    expect(analytic.filter((p) => p.designed!.closed > 0).length).toBeGreaterThanOrEqual(8);
    expect(analytic.filter((p) => p.designed!.branches >= 2).length).toBeGreaterThanOrEqual(6);
    expect(
      analytic.filter((p) => p.designed!.closed < p.designed!.branches).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      corpus.filter((p) => p.kind === 'freeform' && rowFor(p).branches >= 5).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('NURBS wrappers reproduce the analytic surfaces', () => {
  for (const pair of corpus.filter((p) => p.implicits)) {
    it(pair.id, () => {
      let worst = 0;
      for (const [nurbsSurface, fn] of [
        [pair.a, pair.implicits!.a],
        [pair.b, pair.implicits!.b],
      ] as const) {
        const [[u0, u1], [v0, v1]] = surfaceDomain(nurbsSurface);
        for (let i = 0; i <= 16; i++) {
          for (let j = 0; j <= 16; j++) {
            const q = surfacePoint(
              nurbsSurface,
              u0 + ((u1 - u0) * i) / 16,
              v0 + ((v1 - v0) * j) / 16,
            );
            worst = Math.max(worst, Math.abs(fn.f(q)));
            expect(fn.inside(q) || Math.abs(fn.f(q)) < 1e-9).toBe(true);
          }
        }
      }
      expect(worst).toBeLessThan(1e-9);
    });
  }
});

describe('dense-sampling ground truth', () => {
  for (const pair of corpus) {
    it(`${pair.id}: counts at ${N} samples match the committed counts and a doubled grid`, () => {
      const row = rowFor(pair);
      const committed = JSON.parse(readFileSync(COUNTS, 'utf8')) as Row[];
      if (process.env.FORGEAX_UPDATE_GOLDEN === '1') return;
      const want = committed.find((r) => r.id === pair.id);
      expect(want).toBeDefined();
      expect(row.branches).toBe(want!.branches);
      expect(row.closed).toBe(want!.closed);
      expect(row.lengths).toEqual(want!.lengths);
      const fine = rowOf(pair, 2 * N);
      expect(fine.branches).toBe(row.branches);
      expect(fine.closed).toBe(row.closed);
      for (let k = 0; k < row.lengths.length; k++) {
        expect(fine.lengths[k]! / row.lengths[k]!).toBeGreaterThan(0.97);
      }
    }, 120_000);
  }

  it('analytic pairs match the branch counts fixed by construction', () => {
    for (const pair of corpus.filter((p) => p.designed)) {
      const row = rowFor(pair);
      expect([pair.id, row.branches, row.closed]).toEqual([
        pair.id,
        pair.designed!.branches,
        pair.designed!.closed,
      ]);
    }
  });

  it('circles measure their closed-form length', () => {
    for (const pair of corpus.filter((p) => p.exactLengths)) {
      const got = trace(pair.truth, 2 * N)
        .map((b) => arcLength(b.points, b.closed))
        .sort((x, y) => x - y);
      expect(got.length).toBe(pair.exactLengths!.length);
      for (let k = 0; k < got.length; k++) {
        expect(Math.abs(got[k]! / pair.exactLengths![k]! - 1)).toBeLessThan(2e-4);
      }
    }
  });

  it('every traced point lies on both surfaces of an analytic pair', () => {
    for (const pair of corpus.filter((p) => p.implicits)) {
      const worst = Math.max(
        ...trace(pair.truth, N).flatMap((b) =>
          b.points.map((p) =>
            Math.max(Math.abs(pair.implicits!.a.f(p)), Math.abs(pair.implicits!.b.f(p))),
          ),
        ),
      );
      expect([pair.id, worst < 1e-9]).toEqual([pair.id, true]);
    }
  });

  it('a pair moved out of contact has no branch (the counter can return 0)', () => {
    const sphere = corpus.find((p) => p.id === 'plane-sphere')!;
    const far = {
      ...sphere.truth,
      g: (q: Tuple3) => (sphere.truth.g(q) === undefined ? undefined : 50),
    };
    expect(trace(far, 64)).toEqual([]);
  });

  it('seams are identified: a loop crossing the periodic seam is one closed branch, not two arcs', () => {
    const cyl = corpus.find((p) => p.id === 'plane-cylinder-oblique')!;
    const found = trace(cyl.truth, N);
    expect(found.length).toBe(1);
    expect(found[0]!.closed).toBe(true);
    const [[u0, u1]] = surfaceDomain(cyl.a);
    const ring = found[0]!.points.map((p) => nurbs.closest(cyl.a, p, 24).u);
    expect(Math.min(...ring)).toBeLessThan(u0 + 0.1 * (u1 - u0));
    expect(Math.max(...ring)).toBeGreaterThan(u1 - 0.1 * (u1 - u0));
  });
});

describe('marching squares saddle', () => {
  it('a hyperbola xy = c whose saddle sits inside one cell stays two branches', () => {
    const sheet = wrap({
      surface: { kind: 'plane', frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } },
      v: [0, 0],
      half: 1,
    });
    const truth = {
      grid: sheet,
      periodicU: false,
      periodicV: false,
      g: (q: Tuple3) => q[0] * q[1] - 1e-4,
    };
    const found = trace(truth, 65);
    expect(found.length).toBe(2);
    expect(found.every((b) => !b.closed)).toBe(true);
    const sides = found.map((b) => Math.sign(b.points[0]![0])).sort();
    expect(sides).toEqual([-1, 1]);
  });
});

describe('recovery score for the E3 spike', () => {
  const pair = corpus.find((p) => p.id === 'sphere-cylinder-through')!;
  const reference = trace(pair.truth, N);
  const polylines = reference.map((b) => [...b.points, ...(b.closed ? [b.points[0]!] : [])]);

  it('scores the reference against itself as fully recovered with zero error', () => {
    const r = recovery(reference, polylines, 1e-6 * pair.diagonal, 0.01 * pair.diagonal);
    expect(r).toEqual({ branches: 2, recovered: 2, maxError: 0 });
  });

  it('counts a missing branch as lost', () => {
    const r = recovery(
      reference,
      polylines.slice(0, 1),
      1e-4 * pair.diagonal,
      0.01 * pair.diagonal,
    );
    expect([r.branches, r.recovered]).toEqual([2, 1]);
  });

  it('counts a branch displaced beyond the tolerance as lost, and within it as recovered', () => {
    const shifted = (d: number) =>
      polylines.map((line) => line.map((p): Tuple3 => [p[0] + d, p[1], p[2]]));
    const tol = 1e-4 * pair.diagonal;
    expect(recovery(reference, shifted(2 * tol), tol, 0).recovered).toBe(0);
    const near = recovery(reference, shifted(0.5 * tol), tol, 0);
    expect(near.recovered).toBe(2);
    expect(near.maxError).toBeLessThanOrEqual(0.5 * tol + 1e-12);
    expect(near.maxError).toBeGreaterThan(0);
  });
});

describe('G16 reduction (P2-A11)', () => {
  // Failing by design: the carrier-hull G16 repro, self-contained. The mesh pipeline cannot union the
  // 0.16 m ring plate at station 60 into the 0.15 m shell (model-partial). When an exact SSI path
  // takes this case the expectation below must flip to ok, and that flip is the E3 acceptance.
  it('mesh pipeline: the plate at station 60 fails with model-partial; stations 35 and 100 pass', () => {
    const bad = g16MeshUnion(60);
    expect([bad.status, bad.code]).toEqual(['failed', 'model-partial']);
    expect(bad.reasons.length).toBeGreaterThan(0);
    expect(g16MeshUnion(35).status).toBe('ok');
    expect(g16MeshUnion(100).status).toBe('ok');
  }, 120_000);

  const skin = hullSkin();

  it('the skin is the 13 feature lines of the carrier hull over 52 stations', () => {
    expect(skin.points.length).toBe(52);
    expect(skin.points[0]!.length).toBe(13);
    const [[u0, u1], [v0, v1]] = surfaceDomain(skin);
    const bow = surfacePoint(skin, u0, v0);
    const stern = surfacePoint(skin, u1, v1);
    expect(bow[2]).toBeGreaterThan(130);
    expect(stern[2]).toBeLessThan(-140);
  });

  it('the 0.15 m inner skin sits 0.15 m (to 1 mm, it offsets the control net) inside the outer one', () => {
    const inner = innerSkin(skin, 0.15);
    const [[u0, u1], [v0, v1]] = surfaceDomain(skin);
    for (const [fu, fv] of [
      [0.3, 0.2],
      [0.5, 0.5],
      [0.7, 0.8],
      [0.4, 0.6],
    ] as const) {
      const u = u0 + (u1 - u0) * fu;
      const v = v0 + (v1 - v0) * fv;
      const p = surfacePoint(skin, u, v);
      const q = surfacePoint(inner, u, v);
      expect(Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) - 0.15)).toBeLessThan(1e-3);
    }
  });

  it('each plate station meets the skin in one open curve from the keel to the deck centreline', () => {
    for (const pair of corpus.filter((p) => p.id.startsWith('g16-'))) {
      const found = trace(pair.truth, N);
      expect(found.length).toBe(1);
      expect(found[0]!.closed).toBe(false);
      const ends = [found[0]!.points[0]!, found[0]!.points[found[0]!.points.length - 1]!];
      expect(Math.min(...ends.map((p) => Math.abs(p[1])))).toBeLessThan(0.5);
      expect(Math.max(...ends.map((p) => p[1]))).toBeGreaterThan(30);
    }
  });
});

if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
  describe('regenerate committed counts', () => {
    it('writes fixtures/ssi-counts.json', () => {
      const all = corpus.map(rowFor);
      writeFileSync(COUNTS, `${JSON.stringify(all, null, 1)}\n`);
      expect(all.length).toBe(25);
    }, 300_000);
  });
}
