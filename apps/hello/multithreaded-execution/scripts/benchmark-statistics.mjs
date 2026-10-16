export function quantile(values, q) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function summarize(values) {
  return {
    samples: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    jitter: quantile(values, 0.95) - quantile(values, 0.5),
  };
}

/**
 * Browser benchmarks need a truthful capacity contract. A CPU-container can
 * expose the host's `navigator.hardwareConcurrency` even though Node's cgroup
 * probe sees a smaller quota; comparing treatments in that environment would
 * produce evidence for the wrong machine. Keep this decision pure so the
 * benchmark self-test can exercise it without launching a browser.
 */
export function assessRunnerQualification({
  runnerCpuCount,
  browserHardwareConcurrency,
  containerized,
}) {
  const expected = {
    vcpus: runnerCpuCount,
    browserHardwareConcurrency: runnerCpuCount,
  };
  const actual = {
    vcpus: runnerCpuCount,
    browserHardwareConcurrency,
    containerized,
  };
  if (!Number.isInteger(runnerCpuCount) || runnerCpuCount < 1) {
    return {
      ok: false,
      code: 'runner-unqualified',
      reason: 'runner-cpu-capacity-unavailable',
      expected,
      actual,
    };
  }
  if (!Number.isInteger(browserHardwareConcurrency) || browserHardwareConcurrency < 1) {
    return {
      ok: false,
      code: 'runner-unqualified',
      reason: 'browser-cpu-capacity-unavailable',
      expected,
      actual,
    };
  }
  if (containerized && browserHardwareConcurrency > runnerCpuCount) {
    return {
      ok: false,
      code: 'runner-unqualified',
      reason: 'browser-cpu-exceeds-cgroup',
      expected,
      actual,
    };
  }
  return { ok: true, expected, actual };
}

export function pauseEvidence(samples, thresholdMs = 250) {
  const pauses = samples.filter((sample) => sample >= thresholdMs);
  return {
    thresholdMs,
    count: pauses.length,
    maxMs: pauses.length === 0 ? 0 : Math.max(...pauses),
  };
}

/**
 * Detect an isolated scheduler/host pause without treating a sustained slow
 * workload as runner noise. A frame that is both materially longer than the
 * measured p95 and at least a quarter second long is not useful evidence for
 * the tier comparison; the caller may rerun once in a fresh browser process.
 */
export function detectRunnerPause(
  values,
  { minimumMs = 250, minimumRatio = 10 } = {},
) {
  const p95 = quantile(values, 0.95);
  const maximumMs = Math.max(...values);
  const ratio = p95 > 0 ? maximumMs / p95 : Number.POSITIVE_INFINITY;
  return {
    detected: maximumMs >= minimumMs && ratio >= minimumRatio,
    maximumMs,
    p95Ms: p95,
    ratio,
    minimumMs,
    minimumRatio,
  };
}

export function confidenceInterval(inline, shared) {
  let state = 0x46_6f_72_67;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
  const improvements = [];
  for (let round = 0; round < 2_000; round++) {
    const inlineSample = Array.from(
      { length: inline.length },
      () => inline[Math.floor(random() * inline.length)],
    );
    const sharedSample = Array.from(
      { length: shared.length },
      () => shared[Math.floor(random() * shared.length)],
    );
    improvements.push(1 - quantile(sharedSample, 0.95) / quantile(inlineSample, 0.95));
  }
  return {
    method: 'deterministic-bootstrap-p95-ratio',
    rounds: improvements.length,
    low: quantile(improvements, 0.025),
    high: quantile(improvements, 0.975),
  };
}

export function assessProductImprovement(inline, shared, requiredImprovement = 0.15) {
  const inlineP95 = quantile(inline, 0.95);
  const sharedP95 = quantile(shared, 0.95);
  const confidenceInterval95 = confidenceInterval(inline, shared);
  return {
    requiredImprovement,
    observedImprovement: 1 - sharedP95 / inlineP95,
    confidenceInterval95,
    passed: confidenceInterval95.low >= requiredImprovement,
  };
}
