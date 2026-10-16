export function resolveGpuTiming({ samples, timestampPeriodNs, qualified, thresholdMs }) {
  if (!Number.isFinite(timestampPeriodNs) || timestampPeriodNs <= 0) {
    return {
      status: 'unavailable',
      unit: 'ms',
      qualified: false,
      p95Ms: null,
      pass: false,
      reason: 'timestamp-period-unavailable',
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      status: 'unavailable',
      unit: 'ms',
      qualified: false,
      p95Ms: null,
      pass: false,
      reason: 'gpu-timestamp-samples-unavailable',
    };
  }
  const p95Ticks = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const p95Ms = (p95Ticks * timestampPeriodNs) / 1_000_000;
  return { status: 'ready', unit: 'ms', qualified, p95Ticks, p95Ms, pass: qualified && p95Ms <= thresholdMs };
}

const REFERENCE_RUNNER_CLASS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Qualification is injected by the evidence owner, not inferred from the
 * browser transport.  Keep malformed or absent values explicitly unbound so
 * a local timestamp receipt remains useful raw evidence without becoming an
 * AC-23 pass by accident.
 */
export function resolveReferenceRunnerClass(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '') {
    return {
      referenceRunnerClass: null,
      status: 'unqualified',
      source: null,
      reason: 'reference-runner-class-unbound',
    };
  }
  if (!REFERENCE_RUNNER_CLASS.test(normalized)) {
    return {
      referenceRunnerClass: null,
      status: 'unqualified',
      source: null,
      reason: 'reference-runner-class-invalid',
    };
  }
  return {
    referenceRunnerClass: normalized,
    status: 'qualified',
    source: 'FORGEAX_REFERENCE_RUNNER_CLASS',
    reason: null,
  };
}

/** Derive final acceptance flags from raw renderer measurements and authority. */
export function qualifyGpuResults(results, qualification) {
  const runnerQualified = qualification.status === 'qualified';
  return results.map((result) => ({
    ...result,
    qualified: runnerQualified && result.measurementComplete === true,
    pass:
      runnerQualified &&
      result.measurementComplete === true &&
      result.withinBudget === true,
  }));
}
