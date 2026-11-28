import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../errors';
import { checkSurface, surfaceDomain } from '../../nurbs';
import { frameDefect } from '../surfaces';
import { brepFail, deepFreeze } from '../types';
import { dist3, type P3 } from '../vec';
import { Cover } from './cover';
import { fitBranch, withSamples } from './fit';
import { clipToBox } from './hull';
import { implicitProblem } from './implicit-problem';
import { type MarchControl, march } from './march';
import { nurbsNurbsProblem, nurbsNurbsSeeds } from './nurbs-nurbs';
import type { Problem } from './problem';
import { implicitSeeds, type SeedSet } from './seed-implicit';
import { type AnalyticSurface, analyticSide, nurbsSide } from './side';
import type { ParamBox, SsiBranch, SsiFace, SsiIssue, SsiOptions, SsiResult } from './types';

const DEFAULTS = {
  tol: 1e-7,
  minAngle: 1e-3,
  seedResolution: 1 / 512,
  sag: 2e-6,
  maxSteps: 200_000,
};

type Read = typeof DEFAULTS;

function readOptions(o: SsiOptions | undefined): Read | string {
  const r: Read = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Read)[]) {
    const v = o?.[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return key;
    r[key] = v;
  }
  if (r.tol < 1e-9) return 'tol';
  if (r.minAngle >= 1 || r.seedResolution >= 1 || r.sag >= 1) return 'range';
  if (!Number.isInteger(r.maxSteps)) return 'maxSteps';
  return r;
}

function boxError(face: SsiFace): string | undefined {
  const b = face.bounds;
  if (b === undefined) return undefined;
  const pair = (x: unknown) =>
    Array.isArray(x) &&
    x.length === 2 &&
    x.every(Number.isFinite) &&
    (x[0] as number) < (x[1] as number);
  if (!Array.isArray(b) || b.length !== 2 || !pair(b[0]) || !pair(b[1])) return 'bounds';
  if (face.surface.kind !== 'nurbs') return undefined;
  const [[u0, u1], [v0, v1]] = surfaceDomain(face.surface.surface);
  return b[0][0] < u0 || b[0][1] > u1 || b[1][0] < v0 || b[1][1] > v1
    ? 'bounds-outside-domain'
    : undefined;
}

function faceError(face: SsiFace): string | undefined {
  const s = face?.surface;
  if (typeof s !== 'object' || s === null) return 'surface';
  if (s.kind === 'nurbs') {
    if (!checkSurface(s.surface).ok) return 'nurbs-surface';
  } else {
    if (typeof s.frame !== 'object' || s.frame === null) return 'frame';
    const d = frameDefect(s.frame);
    if (d !== undefined) return d;
    const pos = (x: number) => Number.isFinite(x) && x > 0;
    switch (s.kind) {
      case 'plane':
        break;
      case 'cylinder':
      case 'sphere':
        if (!pos(s.radius)) return 'radius';
        break;
      case 'cone':
        if (
          !(
            Number.isFinite(s.radius) &&
            s.radius >= 0 &&
            Math.abs(s.halfAngle) > 0 &&
            Math.abs(s.halfAngle) < Math.PI / 2
          )
        )
          return 'cone-parameters';
        break;
      case 'torus':
        if (!pos(s.major) || !pos(s.minor)) return 'torus-parameters';
        break;
      default:
        return 'surface-kind';
    }
  }
  return boxError(face);
}

function swapBranch(b: SsiBranch): SsiBranch {
  return { ...b, uvA: b.uvB, uvB: b.uvA, onA: b.onB, onB: b.onA };
}

function diagonalOf(points: readonly (readonly P3[])[]): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const row of points) {
    for (const p of row) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
      }
    }
  }
  return dist3(lo as unknown as P3, hi as unknown as P3);
}

/** March every seed not already on a traced branch; fit each branch; collect every stop as an issue. */
export function traceAll(problem: Problem, seeds: SeedSet, scale: number, o: Read): SsiResult {
  const sag = o.sag * scale;
  const control: MarchControl = {
    hMax: scale / 40,
    hMin: 1e-7 * scale,
    sag,
    minAngle: o.minAngle,
    budget: { left: o.maxSteps },
  };
  const resolution = o.seedResolution * scale;
  const cover = new Cover(Math.max(resolution, 64 * sag), 2 * sag + 10 * problem.ptTol);
  const touched = new Cover(resolution, 4 * resolution);
  const branches: SsiBranch[] = [];
  const issues: SsiIssue[] = [];
  const issue = (reason: SsiIssue['reason'], point?: P3, branch?: number) =>
    issues.push({
      code: 'model-partial',
      reason,
      ...(point === undefined ? {} : { point }),
      ...(branch === undefined ? {} : { branch }),
    });
  if (seeds.truncated) issue('ssi-seed-budget');
  let steps = 0;
  for (const seed of seeds.seeds) {
    const p = problem.point(seed);
    if (cover.covers(p) || touched.covers(p)) continue;
    const l = problem.local(seed);
    if (l === undefined || l.sin < o.minAngle) {
      issue(l === undefined ? 'ssi-singular' : 'ssi-tangent-contact', p);
      touched.add([p], false);
      continue;
    }
    if (control.budget.left <= 0) {
      issue('ssi-step-limit', p);
      break;
    }
    const before = control.budget.left;
    const t = march(problem, seed, control);
    steps += before - control.budget.left;
    cover.add(t.points, t.closed);
    const index = branches.length;
    for (const [k, end] of t.ends.entries()) {
      if (end === 'closed' || end === 'boundary') continue;
      const at = k === 0 ? t.points[0] : t.points[t.points.length - 1];
      const reason =
        end === 'near-tangent'
          ? 'ssi-near-tangent'
          : end === 'singular'
            ? 'ssi-singular'
            : 'ssi-step-limit';
      issue(reason, at, index);
      if (at !== undefined) touched.add([at], false);
    }
    if (t.points.length < 2) continue;
    const samples = withSamples(problem, t.xs, t.closed, t.kinks);
    const fitted = fitBranch(problem, samples, o.tol);
    if (fitted === undefined) {
      issue('ssi-fit-tolerance', p, index);
      continue;
    }
    if (!fitted.ok) issue('ssi-fit-tolerance', p, index);
    branches.push({
      closed: t.closed,
      points: samples.points,
      uvA: samples.uvA,
      uvB: samples.uvB,
      curve: fitted.fit.curve,
      onA: fitted.fit.onA,
      onB: fitted.fit.onB,
      bound: fitted.fit.bound,
      ends: t.ends,
    });
  }
  return {
    status: issues.length === 0 ? 'ok' : 'partial',
    branches,
    issues,
    stats: { leaves: seeds.leaves, seeds: seeds.seeds.length, steps },
  };
}

/** Two NURBS faces: the 4-state marcher over both parameter boxes; no window is needed. */
function nurbsNurbs(
  fa: Extract<SsiFace['surface'], { kind: 'nurbs' }>,
  boundsA: ParamBox | undefined,
  fb: Extract<SsiFace['surface'], { kind: 'nurbs' }>,
  boundsB: ParamBox | undefined,
  o: Read,
): Result<SsiResult, ModelingError> {
  const a = nurbsSide(fa.surface, boundsA);
  const b = nurbsSide(fb.surface, boundsB);
  const ca = clipToBox(a.surface, a.box);
  const cb = clipToBox(b.surface, b.box);
  const scale =
    ca === undefined || cb === undefined
      ? 0
      : Math.max(diagonalOf(ca.points), diagonalOf(cb.points));
  if (!(scale > 0)) {
    return brepFail('brep-bad-argument', 'NURBS faces of positive extent', {
      reason: 'degenerate-face',
    });
  }
  const problem = nurbsNurbsProblem(a, b, o.tol / 100);
  const seeds = nurbsNurbsSeeds(a, b, problem, o.seedResolution * scale);
  return ok(deepFreeze(traceAll(problem, seeds, scale, o)));
}

function nurbsAnalytic(
  surface: Extract<SsiFace['surface'], { kind: 'nurbs' }>,
  boundsA: ParamBox | undefined,
  b: AnalyticSurface,
  boundsB: ParamBox | undefined,
  o: Read,
): Result<SsiResult, ModelingError> {
  const side = analyticSide(b, boundsB);
  if ('unbounded' in side) {
    return brepFail('brep-bad-argument', 'an analytic face bounded in every infinite direction', {
      reason: 'unbounded-face',
      direction: side.unbounded,
    });
  }
  const a = nurbsSide(surface.surface, boundsA);
  const clipped = clipToBox(a.surface, a.box);
  const scale = clipped === undefined ? 0 : diagonalOf(clipped.points);
  if (!(scale > 0)) {
    return brepFail('brep-bad-argument', 'a NURBS face of positive extent', {
      reason: 'degenerate-face',
    });
  }
  const problem = implicitProblem(a, side, o.tol / 100);
  const seeds = implicitSeeds(a, side, problem, o.seedResolution * scale);
  return ok(deepFreeze(traceAll(problem, seeds, scale, o)));
}

/**
 * Intersection curves of two untrimmed faces where at least one is NURBS, by subdivision seeding and
 * marching along `n1 x n2` with Newton correction to `tol / 100`. Each branch carries its marched
 * points, a cubic fit and the (u, v) pcurves on both faces with a measured receipt `bound <= tol`.
 * Tangent and near-tangent contacts, singular points and exhausted budgets make the result
 * `partial` with an issue; nothing is dropped silently.
 */
export function intersectFaces(
  fa: SsiFace,
  fb: SsiFace,
  options?: SsiOptions,
): Result<SsiResult, ModelingError> {
  const o = readOptions(options);
  if (typeof o === 'string') {
    return brepFail('brep-bad-argument', 'tol >= 1e-9 and positive finite options below 1', {
      reason: 'options',
      option: o,
    });
  }
  for (const [name, face] of [
    ['a', fa],
    ['b', fb],
  ] as const) {
    const why = faceError(face);
    if (why !== undefined)
      return brepFail('brep-bad-argument', 'a valid face', { face: name, reason: why });
  }
  const a = fa.surface;
  const b = fb.surface;
  if (a.kind === 'nurbs' && b.kind === 'nurbs') return nurbsNurbs(a, fa.bounds, b, fb.bounds, o);
  if (a.kind === 'nurbs' && b.kind !== 'nurbs') return nurbsAnalytic(a, fa.bounds, b, fb.bounds, o);
  if (b.kind === 'nurbs' && a.kind !== 'nurbs') {
    const r = nurbsAnalytic(b, fb.bounds, a, fa.bounds, o);
    if (!r.ok) return r;
    return ok(deepFreeze({ ...r.value, branches: r.value.branches.map(swapBranch) }));
  }
  return ok(
    deepFreeze({
      status: 'partial',
      branches: [],
      issues: [{ code: 'model-partial', reason: 'ssi-pair-unsupported' }],
      stats: { leaves: 0, seeds: 0, steps: 0 },
    }),
  );
}
