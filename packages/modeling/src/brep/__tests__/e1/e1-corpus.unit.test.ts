// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { surfaceInverse, surfaceNormal, surfacePoint } from '../../surfaces';
import type { Surface } from '../../types';
import { cross3, dist3, madd3, type P3 } from '../../vec';
import {
  corpusProblems,
  ON_SEAM,
  referenceGap,
  referenceResidual,
  seamCounts,
  tangentGap,
} from './check';
import {
  buildE1Corpus,
  classify,
  E1_BUILDERS,
  E1_TOL,
  E1_WINDOW,
  type E1Pair,
  type RefBranch,
} from './corpus';

const FIXTURE = new URL('./fixtures/e1-corpus.json', import.meta.url);

interface Fixture {
  readonly schema: string;
  readonly labels: Record<string, string>;
  readonly seams: Record<string, ReturnType<typeof seamCounts>>;
}

const pairs = buildE1Corpus();
// Test-only falsifier margin for the omitted branch, not a corpus or design tolerance.
const MISSING_BRANCH_FALSIFIER_GAP = 4e-2;

function pick(id: string): E1Pair {
  const p = pairs.find((q) => q.id === id);
  if (p === undefined) throw new Error(id);
  return p;
}

describe('E1 analytic-intersection corpus', () => {
  it('records the fixture', () => {
    if (process.env.FORGEAX_UPDATE_GOLDEN !== '1') return;
    const fixture: Fixture = {
      schema: 'forgeax-modeling-brep-e1-corpus/1',
      labels: Object.fromEntries(pairs.map((p) => [p.id, p.expected])),
      seams: Object.fromEntries(pairs.map((p) => [p.id, seamCounts(p, 4096)])),
    };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  });

  const committed = (): Fixture => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

  it('has 40 unique pairs: 36 full pass and 4 tangent partial', () => {
    expect(pairs).toHaveLength(40);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(40);
    expect(pairs.filter((p) => p.expected === 'tangent-partial').map((p) => p.id)).toEqual([
      'plane-sphere/tangent',
      'plane-cylinder/tangent',
      'plane-torus/node-tangent',
      'cylinder-cylinder/perpendicular-equal-steinmetz',
    ]);
  });

  it('every surface kind pair of the analytic set is represented', () => {
    const kinds = new Set(pairs.map((p) => [p.a.kind, p.b.kind].sort().join('-')));
    expect([...kinds].sort()).toEqual([
      'cone-cone',
      'cone-cylinder',
      'cone-plane',
      'cone-sphere',
      'cone-torus',
      'cylinder-cylinder',
      'cylinder-plane',
      'cylinder-sphere',
      'cylinder-torus',
      'plane-sphere',
      'plane-torus',
      'sphere-sphere',
      'sphere-torus',
    ]);
  });

  it('is deterministic: the same seeds give bit-identical surfaces and reference samples', () => {
    const again = buildE1Corpus();
    for (let i = 0; i < pairs.length; i++) {
      expect(again[i]?.a).toEqual(pairs[i]?.a);
      expect(again[i]?.b).toEqual(pairs[i]?.b);
      for (const [k, b] of (pairs[i]?.branches ?? []).entries()) {
        expect(again[i]?.branches[k]?.at(b.t0 + 0.37 * (b.t1 - b.t0))).toEqual(
          b.at(b.t0 + 0.37 * (b.t1 - b.t0)),
        );
      }
    }
    expect(E1_BUILDERS).toHaveLength(40);
  });

  it('the committed corpus is consistent: labels, discriminants, residuals, completeness, poles', () => {
    expect(corpusProblems(pairs, committed().labels)).toEqual([]);
  });

  it('the three labeled tangencies have touching surface equations and parallel normals', () => {
    for (const id of [
      'plane-sphere/tangent',
      'plane-cylinder/tangent',
      'plane-torus/node-tangent',
    ]) {
      const p = pick(id);
      const touch = p.branches[0] as RefBranch;
      const q = touch.at(touch.t0);
      const a = surfaceInverse(p.a, q);
      const b = surfaceInverse(p.b, q);
      const pa = surfacePoint(p.a, a.u, a.v);
      const pb = surfacePoint(p.b, b.u, b.v);
      const na = surfaceNormal(p.a, a.u, a.v);
      const nb = surfaceNormal(p.b, b.u, b.v);
      expect(dist3(pa, pb), `${id} surface gap`).toBeLessThan(1e-9);
      expect(Math.hypot(...cross3(na, nb)), `${id} normal cross`).toBeLessThan(1e-10);
      expect(
        Math.abs(Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) - 1),
        `${id} normal alignment`,
      ).toBeLessThan(1e-8);
    }
  });

  it('the independent discriminant agrees with the builder gap wherever a tangent family applies', () => {
    let checked = 0;
    for (const p of pairs) {
      const g = tangentGap(p);
      if (g === null || p.gap === null) continue;
      checked++;
      expect(Math.abs(g), p.id).toBeCloseTo(Math.abs(p.gap), 9);
    }
    expect(checked).toBeGreaterThanOrEqual(24);
  });

  it('a near-tangent pair is full pass and an exact tangent is partial: the window is |gap| <= tol', () => {
    expect(classify(0, E1_TOL)).toBe('tangent-partial');
    expect(classify(E1_TOL, E1_TOL)).toBe('tangent-partial');
    expect(classify(-E1_TOL, E1_TOL)).toBe('tangent-partial');
    expect(classify(E1_TOL * 1.5, E1_TOL)).toBe('full');
    expect(classify(null, E1_TOL)).toBe('full');
    const near = pairs.filter((p) => p.id.includes('near'));
    expect(near.length).toBeGreaterThanOrEqual(8);
    for (const p of near) expect(p.expected, p.id).toBe('full');
  });

  it('periodic coverage: reference curves cross cylinder, cone, sphere and torus seams', () => {
    const seams = committed().seams;
    const total = (key: 'a' | 'b' | 'aV' | 'bV') =>
      Object.values(seams).reduce((n, s) => n + s[key].reduce((x, y) => x + y, 0), 0);
    expect(total('a') + total('b')).toBeGreaterThan(40);
    expect(total('aV') + total('bV')).toBeGreaterThan(0);
    expect(seams['plane-torus/meridian-on-seam']?.b).toEqual([ON_SEAM, 0]);
    const hit = (pred: (id: string) => boolean) =>
      Object.entries(seams).some(([id, s]) => pred(id) && [...s.a, ...s.b].some((n) => n > 0));
    for (const kind of ['plane-cylinder', 'plane-cone', 'plane-sphere', 'plane-torus'])
      expect(
        hit((id) => id.startsWith(kind)),
        kind,
      ).toBe(true);
    expect(
      Object.values(seams).some((s) => s.a.some((n) => n >= 2) || s.b.some((n) => n >= 2)),
    ).toBe(true);
  });

  it('seam crossing counts are stable under resampling and match the committed counts', () => {
    const seams = committed().seams;
    for (const p of pairs) {
      for (const n of [4096, 8192, 4097, 3001, 5003]) {
        expect(seamCounts(p, n), `${p.id} at ${n} samples`).toEqual(seams[p.id]);
      }
    }
    expect(seamCounts(pick('plane-torus/spiric-loop'), 4096).bV).toEqual([2]);
  });

  it('a seam sign change inside the final sample segment is counted: the crossing scan covers the closing segment', () => {
    const cyl = pick('plane-cylinder/circle').b;
    const n = 64;
    const f = cyl.frame;
    const at = (t: number): P3 => {
      const s = t > (n - 1) / n ? 1 : -1;
      return madd3(madd3(f.o, f.x, 0.5), f.y, s);
    };
    const pair = {
      ...pick('plane-cylinder/circle'),
      branches: [{ kind: 'line', closed: false, t0: 0, t1: 1, at }],
      a: cyl,
    } as unknown as E1Pair;
    expect(seamCounts(pair, n).a).toEqual([1]);
  });

  it('an exact zero seam sample is not a sign change: a touch counts 0, a pass through zero counts 1', () => {
    // Axis-aligned cylinder so the seam value of sample p is exactly p[1]; the zero samples are exact.
    const axisCyl = {
      kind: 'cylinder',
      frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      radius: 1,
    } as unknown as Surface;
    const branch = (ys: number[]): RefBranch => ({
      kind: 'line',
      closed: false,
      t0: 0,
      t1: 1,
      at: (t: number) => [0.5, ys[Math.round(t * (ys.length - 1))] as number, 0],
    });
    const pairOf = (b: RefBranch) =>
      ({ ...pick('plane-cylinder/circle'), branches: [b], a: axisCyl }) as unknown as E1Pair;
    const touch = branch([-1, -1, 0, -1, -1]);
    const through = branch([-1, -1, 0, 1, 1]);
    for (const n of [4, 64]) {
      expect(seamCounts(pairOf(touch), n).a, `touch at ${n}`).toEqual([0]);
      expect(seamCounts(pairOf(through), n).a, `through at ${n}`).toEqual([1]);
    }
  });

  it('off-grid sample sizes reproduce the committed seam counts on every pair, not only grid-aligned ones', () => {
    const seams = committed().seams;
    const offGrid = [4097, 3001, 5003];
    for (const p of pairs) {
      for (const n of offGrid) {
        expect(seamCounts(p, n), `${p.id} at off-grid ${n}`).toEqual(seams[p.id]);
      }
    }
  });

  it('a sample exactly on a seam crossing counts once: the sign test is half-open', () => {
    const p = pick('plane-torus/spiric-loop');
    expect(seamCounts(p, 4096).bV).toEqual([2]);
    expect(seamCounts(p, 8192).bV).toEqual([2]);
  });

  it('great-circle poles: the circle passes both poles and the claims name each one', () => {
    const p = pick('plane-sphere/great-circle-poles');
    const poles = p.poles.map((c) => c.t);
    expect(poles).toHaveLength(2);
    const sphere = p.b;
    if (sphere.kind !== 'sphere') throw new Error('sphere expected');
    const north = madd3(sphere.frame.o, sphere.frame.z, sphere.radius);
    const south = madd3(sphere.frame.o, sphere.frame.z, -sphere.radius);
    const hit = new Set(
      p.poles.map((c) => {
        const q = p.branches[c.branch]!.at(c.t);
        if (dist3(q, north) < 1e-9) return 'north';
        if (dist3(q, south) < 1e-9) return 'south';
        return 'none';
      }),
    );
    expect([...hit].sort()).toEqual(['north', 'south']);
  });

  it('the production scan finds crossings on every full pair with a reference curve', () => {
    for (const p of pairs.filter(
      (q) => q.expected === 'full' && q.branches.some((b) => b.t1 > b.t0),
    )) {
      expect(referenceGap(p).crossings, p.id).toBeGreaterThan(0);
    }
  });

  it('the window radius is pinned and the in-window crossing counts follow from it', () => {
    expect(E1_WINDOW).toBe(4);
    // A grid node that touches a tangent surface has value zero with no sign change on either side:
    // a graze is not a crossing. Tangent spheres and cylinders have no crossing at all.
    expect(referenceGap(pick('plane-sphere/tangent'), 160).crossings).toBe(0);
    expect(referenceGap(pick('plane-cylinder/tangent'), 160).crossings).toBe(0);
    expect(referenceGap(pick('plane-torus/node-tangent'), 160).crossings).toBe(222);
    expect(referenceGap(pick('plane-sphere/circle')).crossings).toBe(276);
    expect(referenceGap(pick('plane-cone/circle')).crossings).toBe(60);
    expect(referenceGap(pick('sphere-sphere/circle')).crossings).toBe(161);
  });

  it('the apex chord discriminant gives the near-apex pair its full length gap', () => {
    const p = pick('plane-cone/near-tangent-apex');
    expect(p.gap).toBeCloseTo(20 * E1_TOL, 15);
    expect(tangentGap(p)).toBeCloseTo(20 * E1_TOL, 10);
    expect(classify(tangentGap(p), E1_TOL)).toBe('full');
  });

  it('pole and apex passages are authored on both cone nappes and the sphere pole', () => {
    const claims = pairs.flatMap((p) => p.poles.map((c) => c.feature));
    expect(claims.filter((c) => c === 'apex').length).toBeGreaterThanOrEqual(4);
    expect(claims.filter((c) => c === 'pole').length).toBeGreaterThanOrEqual(1);
  });

  describe('falsifiers', () => {
    it('a deliberately wrong expected label fails the corpus check', () => {
      const labels = { ...committed().labels };
      const flipped = pairs.map((p) =>
        p.id === 'plane-sphere/tangent' ? { ...p, expected: 'full' as const } : p,
      );
      expect(corpusProblems(flipped, labels).join('\n')).toMatch(/plane-sphere\/tangent/);
      const wrongFixture = { ...labels, 'plane-cylinder/near-tangent': 'tangent-partial' };
      expect(corpusProblems(pairs, wrongFixture).join('\n')).toMatch(
        /plane-cylinder\/near-tangent: committed label/,
      );
      const relabel = pairs.map((p) =>
        p.id === 'plane-cylinder/near-tangent' ? { ...p, expected: 'tangent-partial' as const } : p,
      );
      expect(
        corpusProblems(relabel, {
          ...labels,
          'plane-cylinder/near-tangent': 'tangent-partial',
        }).join('\n'),
      ).toMatch(/near-tangent: (builder|discriminant) gap/);
    });

    it('a perturbed reference curve fails the residual check', () => {
      const p = pick('plane-sphere/circle');
      const bad = {
        ...p,
        branches: p.branches.map((b) => ({
          ...b,
          at: (t: number) => {
            const q = b.at(t);
            return [q[0] + 1e-6, q[1], q[2]] as const;
          },
        })),
      };
      expect(referenceResidual(p)).toBeLessThan(1e-10);
      expect(referenceResidual(bad)).toBeGreaterThan(1e-8);
      expect(corpusProblems([bad], committed().labels).join('\n')).toMatch(/reference residual/);
    });

    it('a reference missing a branch exceeds the falsifier gap threshold', () => {
      const p = pick('plane-cylinder/near-tangent');
      expect(p.branches).toHaveLength(2);
      const half = { ...p, branches: p.branches.slice(0, 1) };
      expect(referenceGap(half).worst).toBeGreaterThan(MISSING_BRANCH_FALSIFIER_GAP);
      expect(corpusProblems([half], committed().labels).join('\n')).toMatch(/crossing/);
    });

    it('a reference that omits a branch fails the completeness check', () => {
      const p = pick('plane-cone/hyperbola-two-nappes');
      expect(p.branches).toHaveLength(2);
      expect(referenceGap(p).worst).toBeLessThan(4e-3);
      const half = { ...p, branches: p.branches.slice(0, 1) };
      expect(referenceGap(half).worst).toBeGreaterThan(0.1);
      expect(corpusProblems([half], committed().labels).join('\n')).toMatch(/crossing/);
    });

    it('a wrong pole claim fails', () => {
      const p = pick('plane-cone/apex-lines');
      const bad = {
        ...p,
        poles: [{ on: 'b' as const, branch: 0, t: 1, feature: 'apex' as const }],
      };
      expect(corpusProblems([bad], committed().labels).join('\n')).toMatch(/pole claim/);
    });
  });
});
