import type {
  DriftStats,
  ReplayBenchmark,
  ReplayComparison,
  ReplaySession,
  TimingStats,
} from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ArtifactRef, RhiDebugOperationContext } from '../rhi-debug/operations';
import { withTimingTimeout } from '../rhi-debug/timing';
import {
  coverageCheck,
  gpuIdleCheck,
  type HostLoadSample,
  quantizationCheck,
} from '../rhi-debug/timing-environment';
import { formatTimingTable } from '../rhi-debug/timing-format';
import {
  type OpenedTimingReplay,
  runTimingOperation,
  type TimingRunDeps,
} from '../rhi-debug/timing-run';

const artifact: ArtifactRef = { kind: 'rhi-tape', source: 'cli', path: 'b.rhitape', digest: 'b' };
const baseline: ArtifactRef = { kind: 'rhi-tape', source: 'cli', path: 'a.rhitape', digest: 'a' };

function stats(p50: number, stddev = 0): TimingStats {
  return { count: 20, min: p50 - 1, p50, p95: p50 + 1, max: p50 + 2, mean: p50, stddev };
}

const stable: DriftStats = {
  slopePerSample: 0,
  relativeDrift: 0,
  firstHalfP50: 1,
  secondHalfP50: 1,
  halfShift: 0,
  lag1Autocorrelation: 0,
  stable: true,
};

function variant(union: number) {
  return {
    frame: { sum: stats(union * 3), union: stats(union, 200_000), envelope: stats(union) },
    unionP50Interval: {
      confidence: 0.95,
      low: union - 10_000,
      high: union + 10_000,
      width: 20_000,
    },
    drift: stable,
    samples: [],
  };
}

const benchmark: ReplayBenchmark = {
  warmup: 3,
  repeat: 20,
  isolate: false,
  restore: {
    mode: 'steady',
    pipelineDepth: 4,
    steady: { buffers: 3, textures: 2, bytes: 4_000_000, unrestored: [] },
  },
  timestampCoverage: {
    complete: false,
    missingPasses: [
      {
        passIndex: 2,
        label: 'cull',
        kind: 'compute',
        variant: 'base',
        reason: 'zero',
        replays: 20,
      },
    ],
  },
  passes: [
    {
      passIndex: 0,
      kind: 'render',
      label: 'shadow',
      workIndices: [0],
      gpu: stats(3_123_457),
      skipped: false,
    },
    {
      passIndex: 1,
      kind: 'render',
      label: 'main',
      workIndices: [1],
      gpu: stats(7_500_001),
      skipped: false,
    },
    { passIndex: 2, kind: 'compute', label: 'cull', workIndices: [2], gpu: null, skipped: false },
  ],
  base: variant(11_300_000),
};

const comparison: ReplayComparison = {
  warmup: 3,
  repeat: 24,
  isolate: false,
  chunk: 8,
  baseline: {
    restore: benchmark.restore,
    timestampCoverage: { complete: true, missingPasses: [] },
    passes: benchmark.passes,
    benchmark: variant(11_300_000),
  },
  candidate: {
    restore: benchmark.restore,
    timestampCoverage: { complete: true, missingPasses: [] },
    passes: benchmark.passes,
    benchmark: variant(10_800_000),
  },
  delta: { sum: stats(-500_000), union: stats(-500_000), envelope: stats(-500_000) },
  unionVerdict: {
    ci: { confidence: 0.95, low: -540_000, high: -460_000, width: 80_000 },
    significant: true,
  },
  passes: [
    {
      label: 'main',
      occurrence: 0,
      baselinePassIndex: 1,
      candidatePassIndex: 1,
      baselineP50: 7_500_000,
      candidateP50: 7_000_000,
      deltaP50: -500_000,
    },
  ],
  unmatchedPasses: { baseline: [], candidate: ['fog'] },
};

function sample(gpu: number | null, load1 = 1): HostLoadSample {
  return { at: '2026-11-04T00:00:00.000Z', load1, gpuUtilizationPercent: gpu };
}

interface Harness {
  readonly deps: TimingRunDeps;
  readonly context: RhiDebugOperationContext;
  readonly opened: string[];
  readonly closed: string[];
  readonly calls: string[];
}

function harness(
  options: {
    readonly before?: number | null;
    readonly after?: number | null;
    readonly hang?: boolean;
    readonly quantization?: 'disabled' | 'enabled' | 'unknown';
  } = {},
): Harness {
  const opened: string[] = [];
  const closed: string[] = [];
  const calls: string[] = [];
  const session = (name: string) =>
    ({
      async benchmarkPasses() {
        calls.push(`benchmark ${name}`);
        if (options.hang) await new Promise(() => undefined);
        return ok(benchmark);
      },
      async compareWith(candidate: { readonly name?: string }) {
        calls.push(`compare ${name} with ${candidate.name}`);
        return ok(comparison);
      },
      name,
    }) as unknown as ReplaySession;
  const deps: TimingRunDeps = {
    validateArtifactRef: (value) => ({ ok: true, value: value as ArtifactRef }),
    coreError: (error) => ({ code: error.code, expected: '', hint: '', detail: {} }),
    async openTapeReplay(ref): Promise<{ ok: true; value: OpenedTimingReplay }> {
      const name = ref.path ?? ref.digest;
      opened.push(name);
      return {
        ok: true,
        value: {
          session: session(name),
          byteLength: 1_000_000,
          adapterInfo: { vendor: 'apple', architecture: 'metal-3', device: '', description: 'M4' },
          timestampQuantization: options.quantization ?? 'disabled',
          close: async () => {
            closed.push(name);
          },
        },
      };
    },
  };
  const context: RhiDebugOperationContext = {
    captureFrame: async () => {
      throw new Error('not used');
    },
    readArtifact: async () => ({ ok: true, value: new Uint8Array() }),
    sampleHostLoad: async (phase) =>
      sample(phase === 'before' ? (options.before ?? 0) : (options.after ?? 0)),
    buildIdentity: async () => ({ revision: 'abc', dirty: false }),
  };
  return { deps, context, opened, closed, calls };
}

describe('rhi.timing preflight and environment', () => {
  it('reports a valid result with environment, checks and named missing passes', async () => {
    const h = harness();
    const result = await runTimingOperation({ artifact }, h.context, h.deps);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.valid).toBe(true);
    expect(result.value.environment).toMatchObject({
      device: { vendor: 'apple' },
      timestampQuantization: 'disabled',
      build: { revision: 'abc' },
      tape: { path: 'b.rhitape', digest: 'b', bytes: 1_000_000 },
    });
    const names = result.value.preflight.checks.map((check) => check.name);
    expect(names).toEqual([
      'replay-backend',
      'timestamp-query',
      'timestamp-quantization',
      'gpu-idle-before',
      'gpu-idle-after',
      'cpu-load',
      'timestamp-coverage',
      'clock-drift',
    ]);
    const coverage = result.value.preflight.checks.find((c) => c.name === 'timestamp-coverage');
    expect(coverage).toMatchObject({ ok: false, severity: 'warning' });
    expect(coverage?.detail).toContain('cull (base, zero, 20 replays)');
    expect(result.value.timing?.totalGpuNanoseconds).toBe(benchmark.base.frame.sum.p50);
    expect(h.closed).toEqual(['b.rhitape']);
  });

  it('marks the result invalid when the GPU was busy before or after', async () => {
    const busy = harness({ before: 17 });
    const result = await runTimingOperation({ artifact }, busy.context, busy.deps);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.valid).toBe(false);
    expect(result.value.invalidReasons[0]).toMatch(/^gpu-idle-before: GPU 17% >= 5%/);
    const after = harness({ after: 40 });
    const late = await runTimingOperation(
      { artifact, maxGpuPercent: 50 },
      after.context,
      after.deps,
    );
    expect(late.ok && late.value.valid).toBe(true);
  });

  it('refuses to measure on a busy GPU with requireIdle and opens nothing', async () => {
    const h = harness({ before: 30 });
    const result = await runTimingOperation({ artifact, requireIdle: true }, h.context, h.deps);
    expect(result).toMatchObject({ ok: false, error: { code: 'gpu-busy' } });
    expect(h.opened).toEqual([]);
  });

  it('flags quantized timestamps from the provider or from the data', async () => {
    const h = harness({ quantization: 'enabled' });
    const result = await runTimingOperation({ artifact }, h.context, h.deps);
    expect(result.ok && result.value.invalidReasons[0]).toMatch(/^timestamp-quantization/);
    expect(quantizationCheck('unknown', [65_536, 131_072, 196_608, 655_360]).ok).toBe(false);
    expect(quantizationCheck('unknown', [65_536, 131_072, 196_608, 655_361]).ok).toBe(true);
    expect(quantizationCheck('unknown', [65_536]).ok).toBe(true);
  });

  it('treats an unreadable GPU meter as a warning, not a failure', () => {
    expect(gpuIdleCheck('gpu-idle-before', sample(null), 5)).toMatchObject({
      ok: true,
      severity: 'warning',
    });
    expect(coverageCheck({ complete: true, missingPasses: [] }).ok).toBe(true);
  });
});

describe('rhi.timing timeout', () => {
  it('fails with timing-timeout naming the stage and elapsed time', async () => {
    const h = harness({ hang: true });
    const result = await runTimingOperation({ artifact, timeoutMs: 20 }, h.context, h.deps);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'timing-timeout', detail: { timeoutMs: 20, stage: 'measure' } },
    });
    if (!result.ok) expect(result.error.detail.elapsedMs).toBeGreaterThanOrEqual(15);
  });

  it('passes the result through when work finishes first and aborts the signal on timeout', async () => {
    expect(
      await withTimingTimeout(
        async () => ({ ok: true, value: 1 }),
        1000,
        () => 'x',
      ),
    ).toEqual({
      ok: true,
      value: 1,
    });
    let aborted = false;
    await withTimingTimeout(
      (signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      5,
      () => 'x',
    );
    expect(aborted).toBe(true);
  });
});

describe('rhi.timing compare', () => {
  it('opens both tapes, times the baseline session against the candidate and closes both', async () => {
    const h = harness();
    const result = await runTimingOperation(
      { artifact, compare: baseline, ciMs: 0.1 },
      h.context,
      h.deps,
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(h.calls).toEqual(['compare a.rhitape with b.rhitape']);
    expect(h.closed.sort()).toEqual(['a.rhitape', 'b.rhitape']);
    expect(result.value.baseline).toEqual(baseline);
    expect(result.value.comparison?.unionVerdict.significant).toBe(true);
    expect(result.value.benchmark).toBeUndefined();
    expect(result.value.environment.baselineTape).toMatchObject({ path: 'a.rhitape' });
  });

  it('rejects skip options with compare', async () => {
    const h = harness();
    expect(
      await runTimingOperation({ artifact, compare: baseline, skip: 'x' }, h.context, h.deps),
    ).toMatchObject({ ok: false, error: { code: 'timing-input-invalid' } });
  });
});

describe('rhi.timing table', () => {
  it('prints validity, the union with its interval, top passes, missing passes and checks', async () => {
    const h = harness({ before: 12 });
    const result = await runTimingOperation({ artifact }, h.context, h.deps);
    if (!result.ok) throw new Error(result.error.code);
    const text = formatTimingTable(result.value);
    expect(text).toMatch(/^INVALID: gpu-idle-before/);
    expect(text).toMatch(/union\s+11\.30\s+\[11\.29, 11\.31\]/);
    expect(text).toContain(
      'restore steady (3 buffers, 2 textures, 4.0 MB GPU copies), pipeline depth 4',
    );
    expect(text.indexOf('main')).toBeLessThan(text.indexOf('shadow  '));
    expect(text).toContain('cull [2] base zero in 20 replays');
    expect(text).toMatch(/FAIL\s+gpu-idle-before/);
  });

  it('prints the paired verdict and pass changes for a comparison', async () => {
    const h = harness();
    const result = await runTimingOperation({ artifact, compare: baseline }, h.context, h.deps);
    if (!result.ok) throw new Error(result.error.code);
    const text = formatTimingTable(result.value);
    expect(text).toMatch(/^VALID/);
    expect(text).toContain(
      'candidate - baseline union p50 (paired) -0.500 ms [-0.54, -0.46]  significant',
    );
    expect(text).toMatch(/main\s+7\.500\s+7\.000\s+-0\.500/);
    expect(text).toContain('only in candidate: fog');
  });
});
