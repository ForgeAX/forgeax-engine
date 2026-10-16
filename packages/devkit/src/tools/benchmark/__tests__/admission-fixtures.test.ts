import { describe, expect, it } from 'vitest';
import { runBenchmarkAdmission } from '../harness.js';
import { type BenchmarkRecipe, createAdmissionReport } from '../report.js';

const recipe: BenchmarkRecipe = {
  snapshotDigest: 'sha256:snapshot',
  backend: 'webgpu',
  viewport: [640, 360],
  inputDigest: 'sha256:input',
  frameCount: 300,
  rhiDebug: true,
  profiler: true,
  carrierRendezvous: false,
  digest: 'sha256:recipe',
};

describe('tool service benchmark admission', () => {
  it('alternates private and service measurements and admits a qualifying recipe', async () => {
    const report = await runBenchmarkAdmission({
      recipe,
      measure: (mode, _phase, index) => ({
        durationMs: mode === 'private' ? 100 + (index % 2) : 70 + (index % 2),
        peakRssBytes: mode === 'private' ? 1000 : 1100,
        exclusivePhasesMs: { execute: mode === 'private' ? 100 : 70 },
        cleanupPassed: true,
        evictionPassed: true,
      }),
    });

    expect(report.admitted).toBe(true);
    expect(report.valid).toBe(true);
    expect(report.private.samples).toBe(60);
    expect(report.service.samples).toBe(60);
    expect(report.order.slice(0, 6)).toEqual([
      'private',
      'service',
      'private',
      'service',
      'private',
      'service',
    ]);
    expect(report.recipe).toEqual(recipe);
  });

  it('marks incomplete or dirty samples invalid instead of treating cache hits as admission', () => {
    const report = createAdmissionReport(
      recipe,
      [
        {
          mode: 'private',
          phase: 'cold',
          durationMs: 10,
          peakRssBytes: 100,
          exclusivePhasesMs: {},
          rhiDebugOverheadMs: 0,
          carrierRendezvousMs: 0,
          cleanupPassed: true,
          evictionPassed: true,
          recipeDigest: 'sha256:other-recipe',
        },
      ],
      {
        sampleCountPerPhase: 1,
        medianImprovement: 0.2,
        p95Improvement: 0.1,
        maxRegression: 0.1,
        peakRssMultiplier: 1.25,
      },
    );

    expect(report.valid).toBe(false);
    expect(report.admitted).toBe(false);
    expect(report.reasons).toContain('recipe identity drifted');
  });
});
