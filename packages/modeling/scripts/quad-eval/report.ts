// Report assembly for forgeax.modeling.quad-eval/1. Pure: the same inputs give the same JSON bytes.
// Thresholds are the stated (chosen) bar each lane is measured against; they are recorded in `limits`.

import type { CaseEntry } from './cases.ts';
import {
  type Hausdorff,
  SHARP_DIHEDRAL_DEG,
  SHARP_TOL_REL,
  type SharpCoverage,
} from './fidelity.ts';
import type { Evaluation } from './metrics.ts';

export const SCHEMA = 'forgeax.modeling.quad-eval/1';

export const LIMITS = {
  sjMin: 0.3,
  aspectP90: 2.0,
  hausdorffRel: 5e-3,
  sharpCovered: 0.98,
  sharpTolerance: SHARP_TOL_REL,
  sharpDihedralDeg: SHARP_DIHEDRAL_DEG,
} as const;

export interface Fidelity {
  readonly diag: number;
  readonly hausdorff: Hausdorff;
  /** Null only when the case has no sharp reference edges (reported as edges 0, covered null). */
  readonly sharp: SharpCoverage | null;
}

export interface Verdict {
  readonly validity: boolean;
  readonly quality: boolean;
  readonly fidelity: boolean;
  readonly failed: readonly string[];
}

export function verdictOf(ev: Evaluation, fid: Fidelity): Verdict {
  const validityFailed =
    ev.degenerate.count > 0 ||
    ev.inverted.count > 0 ||
    !ev.finite ||
    !ev.euler.ok ||
    ev.topology.nonManifoldEdges > 0;
  const qualityFailed =
    ev.scaledJacobian.min < LIMITS.sjMin ||
    (ev.aspect.p90 !== null && ev.aspect.p90 > LIMITS.aspectP90);
  const hausdorffRel = fid.diag > 0 ? fid.hausdorff.max / fid.diag : 0;
  const fidelityFailed =
    hausdorffRel > LIMITS.hausdorffRel ||
    (fid.sharp !== null && fid.sharp.covered < LIMITS.sharpCovered);
  const failed: string[] = [];
  if (validityFailed) failed.push('validity');
  if (qualityFailed) failed.push('quality');
  if (fidelityFailed) failed.push('fidelity');
  return {
    validity: !validityFailed,
    quality: !qualityFailed,
    fidelity: !fidelityFailed,
    failed,
  };
}

export interface ReportInput {
  readonly entry: CaseEntry & { readonly status: 'ready' };
  readonly producer: { readonly id: 'identity' | 'json'; readonly inputDigest?: string };
  readonly ev: Evaluation;
  readonly fid: Fidelity;
  readonly notes: readonly string[];
}

export function buildReport(input: ReportInput): Record<string, unknown> {
  const { entry, producer, ev, fid, notes } = input;
  const verdict = verdictOf(ev, fid);
  const hausdorffRel = fid.diag > 0 ? fid.hausdorff.max / fid.diag : 0;
  const sjSummary = ev.scaledJacobian;
  return {
    schema: SCHEMA,
    case: { id: entry.id, title: entry.title, status: 'ready' },
    producer:
      producer.inputDigest === undefined
        ? { id: producer.id }
        : { id: producer.id, inputDigest: producer.inputDigest },
    counts: ev.counts,
    validity: {
      degenerate: { count: ev.degenerate.count, ids: ev.degenerate.ids },
      inverted: { count: ev.inverted.count, ids: ev.inverted.ids },
      finite: ev.finite,
      openEdges: ev.topology.boundaryEdges,
      boundaryLoops: ev.topology.boundaryLoops,
      nonManifoldEdges: ev.topology.nonManifoldEdges,
      components: ev.topology.components,
      euler: ev.euler,
    },
    quality: {
      scaledJacobian: {
        min: sjSummary.min,
        p10: sjSummary.p10,
        mean: sjSummary.mean,
        max: sjSummary.max,
        n: sjSummary.n,
      },
      aspect: ev.aspect,
      valence: {
        ideal: ev.valence.ideal,
        interior: { hist: ev.valence.interior },
        boundary: { hist: ev.valence.boundary },
        singularities: ev.valence.singularities,
      },
    },
    fidelity: {
      diag: fid.diag,
      hausdorff: {
        max: fid.hausdorff.max,
        mean: fid.hausdorff.mean,
        samples: fid.hausdorff.samples,
        spacing: fid.hausdorff.spacing,
        relative: hausdorffRel,
      },
      sharp:
        fid.sharp === null
          ? { edges: 0, samples: 0, max: 0, p95: 0, covered: null }
          : {
              edges: fid.sharp.edges,
              samples: fid.sharp.samples,
              max: fid.sharp.max,
              p95: fid.sharp.p95,
              covered: fid.sharp.covered,
            },
    },
    limits: { ...LIMITS },
    verdict: {
      validity: verdict.validity,
      quality: verdict.quality,
      fidelity: verdict.fidelity,
      failed: verdict.failed,
    },
    renders: { wire: 'wire.png', shaded: 'shaded.png', jacobian: 'jacobian.png' },
    notes,
  };
}

export function pendingReport(
  entry: CaseEntry & { readonly status: 'pending' },
): Record<string, unknown> {
  return {
    schema: SCHEMA,
    case: { id: entry.id, title: entry.title, status: 'pending', pendingOn: entry.pendingOn },
    notes: [entry.reason, 'pending case: recorded, not scored'],
  };
}
