import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableLodPerformanceEvidence } from '../run-lod-performance-with-retry.mjs';

const falsification = Array.from({ length: 5 }, () => ({ verdict: 'pass' }));

function evidence(overrides = {}) {
  return {
    verdict: 'not-production-ready',
    falsification,
    metrics: {
      timestampAvailable: true,
      gpuP95Regression: 0.15,
      gpuMedianImprovement: 0.21,
      cpuP95Regression: -0.4,
      lodCoverage: 1,
      submittedInstanceRatio: 0.125,
      geometryWorkReduction: 0.77,
      ...overrides,
    },
  };
}

test('retries only a GPU p95-tail-only admission failure', () => {
  assert.equal(isRetryableLodPerformanceEvidence(evidence()), true);
});

test('does not retry a structural, CPU, or budget failure', () => {
  assert.equal(isRetryableLodPerformanceEvidence(evidence({ cpuP95Regression: 0.06 })), false);
  assert.equal(isRetryableLodPerformanceEvidence(evidence({ gpuMedianImprovement: 0.19 })), false);
  assert.equal(
    isRetryableLodPerformanceEvidence(evidence({ submittedInstanceRatio: 0.21 })),
    false,
  );
  assert.equal(
    isRetryableLodPerformanceEvidence({
      ...evidence(),
      falsification: falsification.map((entry, index) =>
        index === 0 ? { ...entry, verdict: 'fail' } : entry,
      ),
    }),
    false,
  );
});
