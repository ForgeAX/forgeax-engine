import { describe, expect, it } from 'vitest';
import { runVfxBatchBBenchmark, validateVfxBatchBReport } from '../../bench/vfx-batch-b.mjs';

describe('VFX Batch B performance report contract', () => {
  const smokeRuns = [10_000, 100_000, 1_000_000].map((capacity) => ({
    benchmark: {
      backend: 'dawn-wgpu',
      capacity,
      allocatedCapacity: capacity,
      adapterClass: 'hardware',
      samples: 60,
      p50Ms: 4,
      p95Ms: 8,
      p99Ms: 10,
    },
    topologyPixels: { ribbon: 20, trail: 20, beam: 20 },
    persistentErrors: [],
  }));

  it('validates fixed protocol, p95/p99 distributions, and bounded resources', () => {
    const report = runVfxBatchBBenchmark(smokeRuns);
    expect(validateVfxBatchBReport(report)).toMatchObject({ ok: true });
    expect(report.cases).toHaveLength(3);
    expect(report.cases.map((item) => item.capacity)).toEqual([10_000, 100_000, 1_000_000]);
    expect(report.cases.every((item) => item.allocatedCapacity === item.capacity)).toBe(true);
    expect(report.cases.every((item) => item.backend === 'dawn-wgpu')).toBe(true);
    expect(report.allocation.particleReadbackBytes).toBe(0);
    expect(report.frameBudget).toMatchObject({ adapterClass: 'hardware', thresholdMs: 33.34 });
  });

  it('records software-adapter throughput without presenting it as a hardware FPS gate', () => {
    const softwareRuns = smokeRuns.map((run) => ({
      ...run,
      benchmark: { ...run.benchmark, adapterClass: 'software-reference', p95Ms: 120 },
    }));
    const report = runVfxBatchBBenchmark(softwareRuns);
    expect(validateVfxBatchBReport(report)).toMatchObject({ ok: true });
    expect(report.frameBudget).toMatchObject({
      adapterClass: 'software-reference',
      thresholdMs: null,
      hardwareTargetMs: 33.34,
      performanceGated: false,
    });
    const hardwareReport = runVfxBatchBBenchmark(
      softwareRuns.map((run) => ({
        ...run,
        benchmark: { ...run.benchmark, adapterClass: 'hardware' },
      })),
    );
    expect(validateVfxBatchBReport(hardwareReport)).toMatchObject({
      ok: false,
      error: 'verdict',
    });
  });

  it('rejects a report that hides CPU readback or a missing topology case', () => {
    const report = runVfxBatchBBenchmark(smokeRuns);
    expect(validateVfxBatchBReport({ ...report, cases: report.cases.slice(0, 2) }).ok).toBe(false);
    expect(
      validateVfxBatchBReport({
        ...report,
        allocation: { ...report.allocation, particleReadbackBytes: 4 },
      }).ok,
    ).toBe(false);
    expect(
      validateVfxBatchBReport({
        ...report,
        cases: report.cases.map((item, index) =>
          index === 2 ? { ...item, allocatedCapacity: item.capacity + 1 } : item,
        ),
      }).ok,
    ).toBe(false);
  });
});
