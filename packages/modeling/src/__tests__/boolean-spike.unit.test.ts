import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OpReport } from '../model';
import { type IdentityCheck, SPIKE_CASES } from './boolean-cases';

const REPORT = new URL('../../reports/boolean-spike.json', import.meta.url);

interface CaseResult {
  readonly name: string;
  readonly family: string;
  readonly legal: boolean;
  readonly problems: readonly string[];
  readonly ops: number;
  readonly mapped: number;
  readonly faces: number;
  readonly withinBound: boolean;
  /** Largest number of result faces over the bound in one operation of the case. */
  readonly excess: number;
  readonly retried: number;
  readonly ms: number;
}

function metricsOf(report: OpReport): Record<string, number> | undefined {
  const info = report.diagnostics?.find((d) => d.severity === 'info' && d.detail?.cacheKey);
  const detail = (info?.detail ?? report.error?.detail) as
    | { metrics?: Record<string, number> }
    | undefined;
  return detail?.metrics;
}

function runCase(c: (typeof SPIKE_CASES)[number]): CaseResult {
  const problems: string[] = [];
  let ops = 0;
  let mapped = 0;
  let faces = 0;
  let excess = 0;
  let retried = 0;
  const identities: IdentityCheck[] = [];
  const started = performance.now();
  let built: ReturnType<typeof c.build> | undefined;
  try {
    built = c.build((report: OpReport, identity?: IdentityCheck) => {
      ops++;
      if (report.status !== 'ok') problems.push(`${report.op}: ${report.error?.code}`);
      const m = metricsOf(report);
      if (m !== undefined && (m.attempts ?? 1) > 1) retried++;
      if (m !== undefined && m.provenanceFaces !== undefined) {
        mapped += m.provenanceMapped as number;
        faces += m.provenanceFaces as number;
        const over = (m.resultFaces as number) - (m.inputFaces as number) - (m.cutFaces as number);
        excess = Math.max(excess, over);
      }
      if (identity !== undefined && report.status === 'ok') identities.push(identity);
    });
  } catch (error) {
    problems.push(`threw: ${(error as Error).message.slice(0, 160)}`);
  }
  const ms = performance.now() - started;
  if (built !== undefined && problems.length === 0) {
    const v = built.model.validate();
    if (!v.closed) problems.push('open');
    for (const issue of v.issues) {
      if (issue.severity === 'error') problems.push(issue.code);
      if (issue.code === 'self-intersection' && issue.detail.certainty === 'confirmed') {
        problems.push('self-intersection');
      }
    }
    if (built.volume !== undefined && Math.abs(v.volume - built.volume) > built.volume * 1e-6) {
      problems.push(`volume ${v.volume} != ${built.volume}`);
    }
    for (const { before, after, shared } of identities) {
      if (!(Math.abs(before - after - shared) <= before * 1e-6)) {
        problems.push(`split identity ${before} != ${after} + ${shared}`);
      }
    }
  }
  return {
    name: c.name,
    family: c.family,
    legal: problems.length === 0,
    problems,
    ops,
    mapped,
    faces,
    withinBound: excess === 0,
    excess,
    retried,
    ms: Math.round(ms * 10) / 10,
  };
}

describe('boolean spike gate set (design 16)', () => {
  it('records legality, provenance completeness, the n-gon bound and timing over >= 200 cases', {
    timeout: 600000,
  }, () => {
    expect(SPIKE_CASES.length).toBeGreaterThanOrEqual(200);
    const results = SPIKE_CASES.map(runCase);
    const legal = results.filter((r) => r.legal).length;
    const mapped = results.reduce((n, r) => n + r.mapped, 0);
    const faces = results.reduce((n, r) => n + r.faces, 0);
    const bound = results.filter((r) => r.withinBound).length;
    const families = [...new Set(results.map((r) => r.family))].map((family) => {
      const of = results.filter((r) => r.family === family);
      return {
        family,
        cases: of.length,
        legal: of.filter((r) => r.legal).length,
        withinBound: of.filter((r) => r.withinBound).length,
      };
    });
    const times = results.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      backend: 'ts',
      quality: 'baseline',
      cases: results.length,
      operations: results.reduce((n, r) => n + r.ops, 0),
      legalityRate: legal / results.length,
      provenanceCompleteness: faces === 0 ? 0 : mapped / faces,
      ngonBoundRate: bound / results.length,
      retriedOperations: results.reduce((n, r) => n + r.retried, 0),
      families,
      illegal: results.filter((r) => !r.legal).map((r) => ({ name: r.name, problems: r.problems })),
      overBound: results
        .filter((r) => !r.withinBound)
        .map((r) => ({ name: r.name, excess: r.excess })),
    };
    const timing = {
      totalMs: Math.round(times.reduce((a, b) => a + b, 0)),
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      maxMs: times[times.length - 1],
    };
    // Design 16 exit: provenance >= 99% and the n-gon bound hold; legality (target 90%) is recorded.
    expect(summary.provenanceCompleteness).toBeGreaterThanOrEqual(0.99);
    // The bound (inputFaces counts surviving operand faces only) is the exit criterion for
    // the design's hard-surface families; the freeform family (arbitrary angles) is
    // recorded only, as reference/booleans.md states.
    for (const f of summary.families.filter((f) => f.family !== 'freeform')) {
      expect([f.family, f.withinBound]).toEqual([f.family, f.cases]);
    }
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(REPORT, `${JSON.stringify({ ...summary, timing }, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(REPORT, 'utf8')) as Record<string, unknown>;
    delete committed.timing;
    expect(summary).toEqual(committed);
  });
});
