// E3 spike gate measurement: runs intersectFaces on every pair of the 25-pair SSI corpus and scores
// the marched branches against the dense-sampling reference (the same reference and tolerances the
// corpus tests use). Bundle and run:
//   esbuild scripts/ssi-spike/measure.ts --bundle --platform=node --format=esm --packages=external \
//     --outfile=dist/ssi-spike/measure.mjs && node dist/ssi-spike/measure.mjs [--json <path>]

import { writeFileSync } from 'node:fs';
import { type SsiPair, ssiCorpus } from '../../src/brep/__tests__/ssi/corpus';
import {
  arcLength,
  type Branch,
  distanceToPolylines,
  recovery,
  trace,
} from '../../src/brep/__tests__/ssi/truth';
import type { Patch } from '../../src/brep/__tests__/ssi/wrap';
import { intersectFaces } from '../../src/brep/ssi';
import type { SsiFace, SsiResult } from '../../src/brep/ssi/types';
import type { Surface } from '../../src/brep/types';
import type { Tuple3 } from '../../src/geom';

const N = 192;
const MIN_LENGTH = 0.01;
const TOL = 1e-4;
const GATE_RECOVERY = 0.9;

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

function analyticFace(p: Patch): SsiFace {
  const bounds = boundsOf(p);
  return bounds === undefined ? { surface: p.surface } : { surface: p.surface, bounds };
}

function faceB(pair: SsiPair): SsiFace {
  if (pair.patches?.b !== undefined) return analyticFace(pair.patches.b);
  return { surface: { kind: 'nurbs', surface: pair.b } as Surface };
}

function polylineOf(b: Branch): Tuple3[] {
  const pts = [...b.points];
  if (b.closed && pts.length > 0) pts.push(pts[0] as Tuple3);
  return pts as Tuple3[];
}

interface PairResult {
  readonly id: string;
  readonly class: 'analytic' | 'g16' | 'freeform';
  readonly diagonal: number;
  readonly refBranches: number;
  readonly foundBranches: number;
  readonly recovered: number;
  /** Largest reference-to-found distance over recovered reference branches, over the diagonal. */
  readonly maxRecoveredError: number | null;
  /** Largest found-to-reference distance over all found points, over the diagonal (spurious-curve check). */
  readonly maxFoundError: number | null;
  readonly status: string;
  readonly issues: number;
  readonly measured: boolean;
  readonly note: string;
}

function classOf(pair: SsiPair): PairResult['class'] {
  if (pair.kind === 'analytic') return 'analytic';
  return pair.id.startsWith('g16-') ? 'g16' : 'freeform';
}

function measure(pair: SsiPair): PairResult {
  const base = {
    id: pair.id,
    class: classOf(pair),
    diagonal: pair.diagonal,
  };
  const reference = trace(pair.truth, N).filter(
    (b) => arcLength(b.points, b.closed) >= MIN_LENGTH * pair.diagonal,
  );
  const faceA: SsiFace = {
    surface: { kind: 'nurbs', surface: pair.a } as Surface,
  };
  const r = intersectFaces(faceA, faceB(pair));
  if (!r.ok) {
    return {
      ...base,
      refBranches: reference.length,
      foundBranches: 0,
      recovered: 0,
      maxRecoveredError: null,
      maxFoundError: null,
      status: 'error',
      issues: 0,
      measured: false,
      note: `intersectFaces failed: ${r.error.code}`,
    };
  }
  const res: SsiResult = r.value;
  const found = res.branches.map((b) => polylineOf(b as unknown as Branch));
  const rec = recovery(reference, found, TOL * pair.diagonal, MIN_LENGTH * pair.diagonal);
  const refLines = reference.map(polylineOf);
  let maxFound = 0;
  for (const line of found) {
    for (const p of line) maxFound = Math.max(maxFound, distanceToPolylines(p, refLines));
  }
  return {
    ...base,
    refBranches: rec.branches,
    foundBranches: res.branches.length,
    recovered: rec.recovered,
    maxRecoveredError: rec.recovered > 0 ? rec.maxError / pair.diagonal : null,
    maxFoundError: found.length > 0 ? maxFound / pair.diagonal : null,
    status: res.status,
    issues: res.issues.length,
    measured: true,
    note: res.issues.map((i) => `${i.code}/${i.reason}`).join(';'),
  };
}

const jsonArg = process.argv.indexOf('--json');
const jsonPath = jsonArg >= 0 ? process.argv[jsonArg + 1] : undefined;

const corpus = ssiCorpus();
const rows: PairResult[] = [];
for (const pair of corpus) {
  const t0 = Date.now();
  const row = measure(pair);
  rows.push(row);
  const rec =
    row.refBranches === 0 ? 'n/a' : `${((100 * row.recovered) / row.refBranches).toFixed(1)}%`;
  console.log(
    [
      row.id.padEnd(24),
      row.class.padEnd(8),
      `ref=${row.refBranches}`,
      `found=${row.foundBranches}`,
      `recovered=${row.recovered}/${row.refBranches} (${rec})`,
      `maxRecErr=${row.maxRecoveredError === null ? 'n/a' : row.maxRecoveredError.toExponential(2)}`,
      `maxFoundErr=${row.maxFoundError === null ? 'n/a' : row.maxFoundError.toExponential(2)}`,
      `status=${row.status}`,
      `issues=${row.issues}`,
      `ms=${Date.now() - t0}`,
    ].join('  '),
  );
}

function summary(filter: (r: PairResult) => boolean) {
  const sel = rows.filter(filter);
  const ref = sel.reduce((s, r) => s + r.refBranches, 0);
  const rec = sel.reduce((s, r) => s + r.recovered, 0);
  const worstRec = sel.reduce((m, r) => Math.max(m, r.maxRecoveredError ?? 0), 0);
  const unmeasured = sel.filter((r) => !r.measured).map((r) => r.id);
  return {
    pairs: sel.length,
    refBranches: ref,
    recovered: rec,
    recoveryRatio: ref === 0 ? null : rec / ref,
    pairsFullyRecovered: sel.filter(
      (r) => r.measured && r.refBranches > 0 && r.recovered === r.refBranches,
    ).length,
    worstRecoveredError: worstRec,
    unmeasured,
  };
}

const summaries = {
  all: summary(() => true),
  analytic: summary((r) => r.class === 'analytic'),
  g16: summary((r) => r.class === 'g16'),
  freeform: summary((r) => r.class === 'freeform'),
  nonAnalytic: summary((r) => r.class !== 'analytic'),
};
console.log(JSON.stringify(summaries, null, 1));

if (jsonPath !== undefined)
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ N, MIN_LENGTH, TOL, GATE_RECOVERY, rows, summaries }, null, 1)}\n`,
  );
