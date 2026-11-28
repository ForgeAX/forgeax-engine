import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cos, sin } from '../../dmath';
import { curvePoint } from '../curves';
import { branchPCurvePoint, type IntersectionBranch } from '../intersect';
import { type BranchSpans, cutBranch, type SpanCut } from '../trim-span';
import type { Surface } from '../types';
import { dot3, type P3, sub3, TWO_PI } from '../vec';
import { buildE1Corpus, E1_TOL, type RefBranch } from './e1/corpus';
import { run } from './e1/match';

const fixture = JSON.parse(
  readFileSync(new URL('./e1/fixtures/e1-corpus.json', import.meta.url), 'utf8'),
) as {
  labels: Record<string, string>;
  seams: Record<string, Record<'a' | 'b' | 'aV' | 'bV', number[]>>;
};

const pairs = buildE1Corpus();

/**
 * Oracle quirks, each explained rather than tolerated silently:
 * - great-circle-poles: the committed oracle counts one sphere u-seam crossing at a pole passage;
 *   the pole itself is authored as a pole cut here, so the u-seam total is 0.
 * - hyperbola-two-nappes: the committed oracle reads the lx > 0 half-plane on the lower nappe too;
 *   the parametric rule (lx < 0 below the apex) gives one crossing per nappe that actually crosses.
 */
const QUIRK_SEAM_TOTAL: Record<string, Partial<Record<'a' | 'b' | 'aV' | 'bV', number>>> = {
  'plane-sphere/great-circle-poles': { b: 0 },
  'plane-cone/hyperbola-two-nappes': { b: 1 },
};

function dist(a: P3, b: P3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
}

function sum(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + Math.max(0, x), 0);
}

/** Independent reference: the parametric seam side of each surface, counted on the authored reference curve. */
function sideOf(s: Surface, kind: 'u' | 'v', p: P3): { s: number; ok: boolean } | undefined {
  if (s.kind === 'plane' || s.kind === 'nurbs') return undefined;
  const d = sub3(p, s.frame.o);
  const lx = dot3(d, s.frame.x);
  const ly = dot3(d, s.frame.y);
  const lz = dot3(d, s.frame.z);
  if (kind === 'v') {
    if (s.kind !== 'torus') return undefined;
    return { s: lz, ok: Math.sqrt(lx * lx + ly * ly) > s.major };
  }
  if (s.kind === 'cone') {
    const lower = lz * sin(s.halfAngle) + s.radius * cos(s.halfAngle) < 0;
    return { s: ly, ok: lower ? lx < 0 : lx > 0 };
  }
  return { s: ly, ok: lx > 0 };
}

function singularPoints(s: Surface): P3[] {
  if (s.kind === 'sphere') {
    return [
      [
        s.frame.o[0] + s.radius * s.frame.z[0],
        s.frame.o[1] + s.radius * s.frame.z[1],
        s.frame.o[2] + s.radius * s.frame.z[2],
      ],
      [
        s.frame.o[0] - s.radius * s.frame.z[0],
        s.frame.o[1] - s.radius * s.frame.z[1],
        s.frame.o[2] - s.radius * s.frame.z[2],
      ],
    ];
  }
  if (s.kind === 'cone') {
    const k = (-s.radius * cos(s.halfAngle)) / sin(s.halfAngle);
    return [
      [
        s.frame.o[0] + k * s.frame.z[0],
        s.frame.o[1] + k * s.frame.z[1],
        s.frame.o[2] + k * s.frame.z[2],
      ],
    ];
  }
  return [];
}

/**
 * Independent reference count of seam crossings on the authored curve. Each sample is +, -, on the
 * seam plane (zero) or at a pole/apex (pole). Zero and pole samples are skipped; a sign change between
 * consecutive remaining samples counts when both are on the open side of the seam. A sign change whose
 * gap holds a pole is a pole passage, not a seam crossing. A closed curve is walked cyclically, so a
 * crossing at its start (a zero sample at t0) counts once.
 */
const POLE_EXCLUDE = 1e-3;

function referenceCount(s: Surface, kind: 'u' | 'v', branch: RefBranch, n = 4096): number {
  const scale =
    s.kind === 'torus'
      ? s.major + s.minor
      : Math.max(s.kind === 'plane' ? 1 : (s as { radius: number }).radius, 1);
  const poles = singularPoints(s);
  const m = branch.closed ? n : n + 1;
  const samples: { sg: number; ok: boolean; pole: boolean }[] = [];
  for (let i = 0; i < m; i++) {
    const p = branch.at(branch.t0 + ((branch.t1 - branch.t0) * i) / n);
    const pole = poles.some((q) => dist(p, q) < POLE_EXCLUDE * scale);
    const side = sideOf(s, kind, p);
    const zero = side === undefined || Math.abs(side.s) <= 1e-12 * scale;
    samples.push({
      sg: zero || side === undefined ? 0 : side.s < 0 ? -1 : 1,
      ok: side?.ok ?? false,
      pole,
    });
  }
  const marks: number[] = [];
  for (let i = 0; i < m; i++) {
    const x = samples[i] as (typeof samples)[number];
    if (!x.pole && x.sg !== 0) marks.push(i);
  }
  let count = 0;
  for (let k = 0; k < marks.length; k++) {
    if (!branch.closed && k + 1 >= marks.length) break;
    const ia = marks[k] as number;
    const ib = marks[(k + 1) % marks.length] as number;
    const a = samples[ia] as (typeof samples)[number];
    const b = samples[ib] as (typeof samples)[number];
    // Walk the gap from ia to ib (cyclically) for a pole sample.
    let passes = false;
    for (let j = (ia + 1) % m; j !== ib; j = (j + 1) % m) {
      if ((samples[j] as (typeof samples)[number]).pole) passes = true;
    }
    if (passes) continue;
    if (a.sg !== b.sg && a.ok && b.ok) count++;
  }
  return count;
}

function totals(branches: readonly IntersectionBranch[], cuts: readonly (readonly SpanCut[])[]) {
  const got = { a: 0, b: 0, aV: 0, bV: 0, poleA: 0, poleB: 0 };
  branches.forEach((_, i) => {
    for (const k of cuts[i] ?? []) {
      if (k.kind === 'u-seam') got[k.on] += 1;
      else if (k.kind === 'v-seam') got[k.on === 'a' ? 'aV' : 'bV'] += 1;
      else got[k.on === 'a' ? 'poleA' : 'poleB'] += 1;
    }
  });
  return got;
}

describe('E1b: spans of the E1 corpus', () => {
  const nonTangent = pairs.filter((p) => p.expected === 'full');
  const tangent = pairs.filter((p) => p.expected === 'tangent-partial');

  it('the corpus splits into full and tangent pairs with the committed labels', () => {
    for (const p of pairs) expect(fixture.labels[p.id]).toBe(p.expected);
    expect(nonTangent.length + tangent.length).toBe(pairs.length);
    expect(tangent.length).toBeGreaterThan(0);
  });

  it.each(
    nonTangent.map((p) => [p.id, p] as const),
  )('%s: seam and pole cuts match the oracle', (_id, p) => {
    const r = run(p);
    expect(r.partials).toEqual([]);
    expect(r.branches.length).toBeGreaterThan(0);
    const cuts = r.branches.map((b) => cutBranch(p.a, p.b, b, E1_TOL).cuts);
    const got = totals(r.branches, cuts);
    const want = fixture.seams[p.id] as Record<'a' | 'b' | 'aV' | 'bV', number[]>;
    const quirk = QUIRK_SEAM_TOTAL[p.id] ?? {};
    for (const k of ['a', 'b', 'aV', 'bV'] as const) {
      expect(got[k], `${p.id} ${k}`).toBe(quirk[k] ?? sum(want[k]));
    }
    expect(got.poleA, `${p.id} pole on a`).toBe(p.poles.filter((q) => q.on === 'a').length);
    expect(got.poleB, `${p.id} pole on b`).toBe(p.poles.filter((q) => q.on === 'b').length);
  });

  it.each(
    nonTangent.map((p) => [p.id, p] as const),
  )('%s: u-seam totals agree with the independent reference', (_id, p) => {
    const r = run(p);
    const cuts = r.branches.map((b) => cutBranch(p.a, p.b, b, E1_TOL).cuts);
    const got = totals(r.branches, cuts);
    for (const on of ['a', 'b'] as const) {
      const want = p.branches.reduce(
        (n, ref) => n + referenceCount(on === 'a' ? p.a : p.b, 'u', ref),
        0,
      );
      if (QUIRK_SEAM_TOTAL[p.id]?.[on] === undefined)
        expect(got[on], `${p.id} u on ${on}`).toBe(want);
    }
  });

  it.each(
    nonTangent.map((p) => [p.id, p] as const),
  )('%s: every span maps into the principal domain', (_id, p) => {
    const r = run(p);
    r.branches.forEach((b) => {
      const spans: BranchSpans = cutBranch(p.a, p.b, b, E1_TOL);
      for (const span of spans.spans) {
        for (const [on, s, shift] of [
          ['a', p.a, span.shiftA],
          ['b', p.b, span.shiftB],
        ] as const) {
          const pc = on === 'a' ? b.onA : b.onB;
          for (let k = 1; k < 8; k++) {
            const t = span.t0 + ((span.t1 - span.t0) * k) / 8;
            const uv = branchPCurvePoint(pc, t);
            const at = curvePoint(b.curve, t);
            if (singularPoints(s).some((q) => dist(at, q) < 1e-6)) continue;
            const u = uv[0] + shift[0];
            if (s.kind !== 'plane') {
              expect(u, `${p.id} ${on} u`).toBeGreaterThanOrEqual(-1e-9);
              expect(u, `${p.id} ${on} u`).toBeLessThan(TWO_PI + 1e-9);
            }
          }
        }
      }
    });
  });

  it.each(
    tangent.map((p) => [p.id, p] as const),
  )('%s: tangent pairs are one partial with ids [3, 7]', (_id, p) => {
    const r = run(p);
    expect(r.branches).toEqual([]);
    expect(r.partials).toHaveLength(1);
    expect(r.partials[0]?.code).toBe('brep-ssi-tangent');
    expect(r.partials[0]?.surfaces).toEqual([3, 7]);
  });
});
