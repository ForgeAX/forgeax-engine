import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  qualifyGpuResults,
  resolveGpuTiming,
  resolveReferenceRunnerClass,
} from '../../scripts/bench-contract.mjs';

const execFileAsync = promisify(execFile);

describe('volumetric fog qualified volume benchmark', () => {
  it('reports 1080p tile profiles through the Engine receipt seam', async () => {
    const result = await execFileAsync(process.execPath, [
      `${import.meta.dirname}/../../scripts/bench.mjs`,
    ]);
    const receipt = JSON.parse(result.stdout.trim()) as {
      runnerClass: string;
      head: string;
      results: Array<Record<string, unknown>>;
    };
    expect(receipt.runnerClass).toBe('local-node');
    expect(receipt.head).toHaveLength(40);
    expect(receipt.results).toHaveLength(2);
    expect(receipt.results.map((entry) => (entry.profile as { name: string }).name)).toEqual(['low', 'high']);
    for (const entry of receipt.results) {
      const profile = entry.profile as { name: string; tileSize: number; width: number; height: number };
      expect(entry.renderer).toMatchObject({
        source: 'engine-renderer-inspect',
        status: 'unavailable',
      });
      expect((entry.profile as { surfaceWidth: number }).surfaceWidth).toBe(1920);
      expect((entry.profile as { surfaceHeight: number }).surfaceHeight).toBe(1080);
      expect(profile.tileSize).toBe(profile.name === 'low' ? 16 : 4);
      expect(profile.width).toBe(profile.name === 'low' ? 120 : 480);
      expect(profile.height).toBe(profile.name === 'low' ? 68 : 270);
      expect((entry.topology as { sampleCount: number }).sampleCount).toBeGreaterThan(0);
      expect(entry.topology).toMatchObject({
        integrated: true,
        passCount: 4,
        logicalGrid: { width: profile.width, height: profile.height, depth: profile.depth },
        physicalGrid: { width: profile.width, height: profile.height, depth: profile.depth },
        passNames: ['volume-inject', 'volume-integrate', 'volume-temporal', 'volume-composite'],
      });
      expect(entry.resources).toMatchObject({ status: 'unavailable' });
      expect((entry.timing as { kind: string }).kind).toBe('gpu-timestamp');
      expect(['ready', 'unavailable']).toContain((entry.timing as { status: string }).status);
      expect(typeof entry.pass).toBe('boolean');
      if ((entry.timing as { status: string }).status === 'ready') {
        expect(entry.p95Ticks).toBeGreaterThan(0);
        expect(entry.p95Ms).toBeGreaterThan(0);
        expect((entry.timing as { unit: string }).unit).toBe('ms');
      } else {
        expect(entry.p95Ms).toBeNull();
        expect(entry.pass).toBe(false);
      }
      expect(entry.timestamp).toMatch(/^20/);
    }
  });

  it('does not embed a second raw GPU pipeline in the benchmark entrypoint', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(`${import.meta.dirname}/../../scripts/bench.mjs`, 'utf8'),
    );
    expect(source).not.toMatch(/createShaderModule|createTexture|createComputePipeline|createRenderPipeline/);
    expect(source).not.toContain('FORGEAX_GPU_TIMESTAMP_PERIOD_NS');
  });

  it('qualifies measured milliseconds and rejects unqualified measurements', () => {
    expect(resolveGpuTiming({ samples: [1000, 1200, 1100], timestampPeriodNs: 1000, qualified: true, thresholdMs: 2 })).toMatchObject({
      status: 'ready',
      p95Ms: 1.2,
      pass: true,
    });
    expect(resolveGpuTiming({ samples: [1000], timestampPeriodNs: 0, qualified: true, thresholdMs: 2 })).toMatchObject({
      status: 'unavailable',
      p95Ms: null,
      pass: false,
    });
    expect(resolveGpuTiming({ samples: [], timestampPeriodNs: 1000, qualified: true, thresholdMs: 2 })).toMatchObject({
      status: 'unavailable',
      p95Ms: null,
      pass: false,
      reason: 'gpu-timestamp-samples-unavailable',
    });
  });

  it('keeps reference-runner qualification explicit and fail-closed', () => {
    expect(resolveReferenceRunnerClass(undefined)).toMatchObject({
      referenceRunnerClass: null,
      status: 'unqualified',
      reason: 'reference-runner-class-unbound',
    });
    expect(resolveReferenceRunnerClass('  ')).toMatchObject({
      referenceRunnerClass: null,
      status: 'unqualified',
      reason: 'reference-runner-class-unbound',
    });
    expect(resolveReferenceRunnerClass('not a runner')).toMatchObject({
      referenceRunnerClass: null,
      status: 'unqualified',
      reason: 'reference-runner-class-invalid',
    });
    expect(resolveReferenceRunnerClass('forgeax-macos-metal-reference')).toMatchObject({
      referenceRunnerClass: 'forgeax-macos-metal-reference',
      status: 'qualified',
      source: 'FORGEAX_REFERENCE_RUNNER_CLASS',
      reason: null,
    });
  });

  it('derives qualification only from authority, complete samples, and budget', () => {
    const raw = (overrides = {}) => ({
      measurementComplete: true,
      withinBudget: true,
      p95Ms: 1,
      ...overrides,
    });
    const unbound = resolveReferenceRunnerClass(undefined);
    expect(qualifyGpuResults([raw()], unbound)[0]).toMatchObject({
      measurementComplete: true,
      qualified: false,
      pass: false,
    });
    const invalid = resolveReferenceRunnerClass('not a runner');
    expect(qualifyGpuResults([raw()], invalid)[0]).toMatchObject({ qualified: false, pass: false });
    const qualified = resolveReferenceRunnerClass('forgeax-macos-metal-reference');
    expect(qualifyGpuResults([raw()], qualified)[0]).toMatchObject({ qualified: true, pass: true });
    expect(
      qualifyGpuResults([raw({ measurementComplete: false, p95Ms: null, withinBudget: false })], qualified)[0],
    ).toMatchObject({ qualified: false, pass: false, p95Ms: null });
    expect(qualifyGpuResults([raw({ withinBudget: false, p95Ms: 9 })], qualified)[0]).toMatchObject({
      qualified: true,
      pass: false,
      p95Ms: 9,
    });
    expect(
      qualifyGpuResults([raw({ measurementComplete: false, withinBudget: false, p95Ms: null })], qualified)[0],
    ).toMatchObject({ qualified: false, pass: false });
  });
});
