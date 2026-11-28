// The E3 spike gate (B-E3-spike verdict, docs/e3-spike-verdict) as a standing test on main: every
// pair of the 25-pair SSI corpus, analytic, G16 and freeform, must recover every reference branch
// within 1e-4 of the pair diagonal. The spike script measured the same numbers; this file keeps them
// executable so a change to the marcher cannot silently lose a class of pairs.
import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../../../geom';
import { intersectFaces } from '../../ssi';
import type { SsiFace } from '../../ssi/types';
import { type SsiPair, ssiCorpus } from './corpus';
import { arcLength, type Branch, recovery, trace } from './truth';
import type { Patch } from './wrap';

/** Dense-sampling resolution of the reference, as in the spike and the committed counts. */
const N = 192;
/** Reference branches shorter than this fraction of the diagonal are sampling noise. */
const MIN_LENGTH = 0.01;
/** Positional bound of the gate, as a fraction of the pair diagonal (plan row B-E3-spike). */
const TOL = 1e-4;
/** Corpus size pinned by the verdict: 17 analytic, 3 G16 and 5 freeform pairs; 42 reference branches. */
const PAIRS = { analytic: 17, g16: 3, freeform: 5 } as const;
const REFERENCE_BRANCHES = 42;
/** Freeform NURBS x NURBS marches take tens of seconds on a loaded runner; the gate is not a speed budget. */
const MARCH_TIMEOUT_MS = 240_000;

type PairClass = keyof typeof PAIRS;

interface Score {
  readonly id: string;
  readonly cls: PairClass;
  readonly reference: number;
  readonly recovered: number;
  /** Largest recovered reference-to-found distance over the diagonal (0 when nothing is recovered). */
  readonly maxError: number;
}

function classOf(pair: SsiPair): PairClass {
  if (pair.kind === 'analytic') return 'analytic';
  return pair.id.startsWith('g16-') ? 'g16' : 'freeform';
}

function boundsOf(p: Patch) {
  switch (p.surface.kind) {
    case 'plane':
      return [
        [-p.half, p.half],
        [-p.half, p.half],
      ] as const;
    case 'cylinder':
    case 'cone':
      return [[0, 2 * Math.PI], p.v] as const;
    default:
      return undefined;
  }
}

function faceB(pair: SsiPair): SsiFace {
  const patch = pair.patches?.b;
  if (patch === undefined) return { surface: { kind: 'nurbs', surface: pair.b } };
  const bounds = boundsOf(patch);
  return bounds === undefined ? { surface: patch.surface } : { surface: patch.surface, bounds };
}

function polylineOf(
  points: readonly (readonly [number, number, number])[],
  closed: boolean,
): Tuple3[] {
  const line: Tuple3[] = points.map((p): Tuple3 => [p[0], p[1], p[2]]);
  const first = line[0];
  if (closed && first !== undefined) line.push([first[0], first[1], first[2]]);
  return line;
}

function referenceOf(pair: SsiPair): Branch[] {
  return trace(pair.truth, N).filter(
    (b) => arcLength(b.points, b.closed) >= MIN_LENGTH * pair.diagonal,
  );
}

/** The marched branches of one pair, as polylines, with the same faces the spike used. */
function foundOf(pair: SsiPair): Tuple3[][] {
  const r = intersectFaces({ surface: { kind: 'nurbs', surface: pair.a } }, faceB(pair));
  if (!r.ok) throw new Error(`intersectFaces failed on ${pair.id}: ${r.error.code}`);
  return r.value.branches.map((b) => polylineOf(b.points, b.closed));
}

function scoreOf(pair: SsiPair, found: readonly (readonly Tuple3[])[]): Score {
  const reference = referenceOf(pair);
  const rec = recovery(reference, found, TOL * pair.diagonal, MIN_LENGTH * pair.diagonal);
  return {
    id: pair.id,
    cls: classOf(pair),
    reference: rec.branches,
    recovered: rec.recovered,
    maxError: rec.recovered > 0 ? rec.maxError / pair.diagonal : 0,
  };
}

const corpus = ssiCorpus();
const measured = new Map<
  string,
  { readonly pair: SsiPair; readonly found: Tuple3[][]; readonly score: Score }
>();

function measure(pair: SsiPair) {
  let entry = measured.get(pair.id);
  if (entry === undefined) {
    const found = foundOf(pair);
    entry = { pair, found, score: scoreOf(pair, found) };
    measured.set(pair.id, entry);
  }
  return entry;
}

describe('E3 spike gate on main: recovery and positional error over the 25-pair SSI corpus', () => {
  it('the corpus is the verdict corpus: 17 analytic, 3 G16 and 5 freeform pairs', () => {
    const counts = { analytic: 0, g16: 0, freeform: 0 };
    for (const pair of corpus) counts[classOf(pair)]++;
    expect(counts).toEqual(PAIRS);
    expect(corpus).toHaveLength(25);
  });

  for (const pair of corpus) {
    it(
      `${pair.id} (${classOf(pair)}): every reference branch recovered within ${TOL} of the diagonal`,
      () => {
        const { score } = measure(pair);
        expect(score.recovered).toBe(score.reference);
        expect(score.reference).toBeGreaterThan(0);
        expect(score.maxError).toBeLessThanOrEqual(TOL);
      },
      MARCH_TIMEOUT_MS,
    );
  }

  it('aggregate: 100 % branch recovery over the 42 reference branches, worst error within the bound', () => {
    const scores = corpus.map((pair) => measure(pair).score);
    const reference = scores.reduce((s, r) => s + r.reference, 0);
    const recovered = scores.reduce((s, r) => s + r.recovered, 0);
    const worst = scores.reduce((m, r) => Math.max(m, r.maxError), 0);
    expect(reference).toBe(REFERENCE_BRANCHES);
    expect(recovered / reference).toBe(1);
    expect(worst).toBeLessThanOrEqual(TOL);
  });

  it('per class: the G16 and freeform pairs are gated, not only the analytic ones', () => {
    const scores = corpus.map((pair) => measure(pair).score);
    for (const cls of ['analytic', 'g16', 'freeform'] as const) {
      const rows = scores.filter((r) => r.cls === cls);
      expect(rows, cls).toHaveLength(PAIRS[cls]);
      expect(
        rows.every((r) => r.recovered === r.reference && r.maxError <= TOL),
        cls,
      ).toBe(true);
    }
  });
});

/**
 * Falsifiers: the gate predicate must reject a result that the spike would have rejected. Each
 * mutation starts from the real marched output of a two-branch pair, so the falsifier exercises the
 * same scoring path as the gate rather than a synthetic curve.
 */
describe('E3 spike gate falsifiers', () => {
  const pair = corpus.find((p) => p.id === 'sphere-cylinder-through');
  if (pair === undefined) throw new Error('corpus pair sphere-cylinder-through is missing');
  const { found } = measure(pair);
  const total = referenceOf(pair).length;

  it('the unmutated marched output passes the gate (control)', () => {
    const s = scoreOf(pair, found);
    expect([s.recovered, s.reference]).toEqual([total, total]);
    expect(s.maxError).toBeLessThanOrEqual(TOL);
  });

  it('a branch displaced beyond the bound is lost, so recovery drops below 100 %', () => {
    const shift = 2 * TOL * pair.diagonal;
    const displaced = found.map((line) => line.map((p): Tuple3 => [p[0] + shift, p[1], p[2]]));
    const s = scoreOf(pair, displaced);
    expect(s.recovered).toBeLessThan(total);
  });

  it('a missing found branch is lost, so recovery drops below 100 %', () => {
    const s = scoreOf(pair, found.slice(0, 1));
    expect(s.recovered).toBeLessThan(total);
  });
});
