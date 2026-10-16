import { APP_PHASE_CATALOG } from '@forgeax/engine-app';
import { RENDER_PHASE_CATALOG } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import {
  nearestRankP95,
  settleFrameCredit,
  summarizeOverhead,
  validateOverheadReport,
} from '../profiler-overhead.mjs';

const phaseCatalog = {
  app: [...APP_PHASE_CATALOG],
  render: [...RENDER_PHASE_CATALOG],
};

function validReport() {
  return {
    benchmark: 'profiler-overhead-d6',
    backend: 'rhi-null',
    workload: 'deterministic-app-render',
    environment: {
      node: 'v26.4.0',
      os: 'darwin',
      arch: 'arm64',
      cpu: 'test-cpu',
    },
    warmupFrames: 2000,
    captureWarmupFrames: 1000,
    groups: 15,
    framesPerGroup: 2000,
    quantile: {
      method: 'nearest-rank',
      percentile: 0.95,
      indexFormula: 'sorted[ceil(0.95*n)-1]',
    },
    windows: {
      off: {
        samples: 30000,
        p95FrameDurationMicros: 100,
        groupP95FrameDurationMicros: [
          100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
        ],
      },
      on: {
        samples: 30000,
        p95FrameDurationMicros: 100,
        groupP95FrameDurationMicros: [
          100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
        ],
      },
    },
    overhead: {
      formula: 'median(((groupP95On - groupP95Off) / groupP95Off) * 100)',
      increasePercent: 0,
      thresholdPercent: 20,
      verdict: 'pass',
    },
    allocation: {
      owner: 'profiler-owned',
      profilerEventObjectAllocations: 0,
    },
    phaseCatalog: {
      relation: {
        status: 'pass',
        source: 'AppPhaseCatalog + RenderPhaseCatalog',
        expected: phaseCatalog,
        actual: phaseCatalog,
      },
      ...phaseCatalog,
    },
    overflow: { status: 'complete', bounded: true },
    verdict: 'pass',
  };
}

describe('profiler overhead D-6 report contract', () => {
  it('waits for App-owned frame credit to reach zero through event-loop turns', async () => {
    let reads = 0;
    const app = {
      execution: {
        report: () => ({ frame: { inFlight: reads++ < 2 ? 1 : 0 } }),
      },
    };

    await settleFrameCredit(app);

    expect(reads).toBe(3);
  });

  it('fails when App-owned frame credit never settles', async () => {
    const app = { execution: { report: () => ({ frame: { inFlight: 1 } }) } };

    await expect(settleFrameCredit(app)).rejects.toThrow(
      'App frame credit did not settle after 64 event-loop turns',
    );
  });

  it('uses nearest-rank frame-duration p95 rather than an FPS lower-tail', () => {
    expect(nearestRankP95([10, 20, 30, 40])).toBe(40);
    expect(nearestRankP95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });

  it('uses paired group p95s so one noisy group cannot become the gate result', () => {
    const summary = summarizeOverhead([100, 100, 100, 100, 100], [100, 100, 100, 100, 160]);
    expect(summary.increasePercent).toBe(0);
  });

  it('accepts the complete D-6 report shape', () => {
    expect(validateOverheadReport(validReport())).toMatchObject({ ok: true });
  });

  it('rejects a non-nearest-rank quantile or an FPS p95 source', () => {
    const report = validReport();
    report.quantile.method = 'fps-lower-tail';
    expect(validateOverheadReport(report)).toMatchObject({ ok: false });
  });

  it('rejects missing environment, windows, p95, or formula evidence', () => {
    for (const field of ['environment', 'windows', 'overhead']) {
      const report = validReport();
      delete report[field];
      expect(validateOverheadReport(report)).toMatchObject({ ok: false });
    }
  });

  it('rejects profiler-owned allocation evidence that is non-zero', () => {
    const report = validReport();
    report.allocation.profilerEventObjectAllocations = 1;
    expect(validateOverheadReport(report)).toMatchObject({ ok: false });
  });

  it('rejects phase catalog drift and overhead above the twenty percent threshold', () => {
    const phaseDrift = validReport();
    phaseDrift.phaseCatalog.relation.actual = {
      ...phaseCatalog,
      render: [...phaseCatalog.render, 'private-phase'],
    };
    expect(validateOverheadReport(phaseDrift)).toMatchObject({ ok: false });

    const thresholdFailure = validReport();
    thresholdFailure.overhead.increasePercent = 20.01;
    thresholdFailure.overhead.verdict = 'fail';
    thresholdFailure.verdict = 'fail';
    expect(validateOverheadReport(thresholdFailure)).toMatchObject({ ok: false });
  });
});
