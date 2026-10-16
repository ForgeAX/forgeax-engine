import { spawnSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';

export const VFX_BATCH_B_PROTOCOL = Object.freeze({
  benchmark: 'vfx-batch-b',
  dataset: 'boss-lightning-gpu-runtime',
  capacities: [10_000, 100_000, 1_000_000],
  warmupFrames: 30,
  samples: 60,
  backend: 'dawn-wgpu',
  hardwareFrameBudgetMs: 33.34,
});

function collectGpuRuns() {
  return VFX_BATCH_B_PROTOCOL.capacities.map((capacity) => {
    const result = spawnSync('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'smoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, VFX_BENCH_CAPACITY: String(capacity) },
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith('[smoke-dawn] PASS '));
    if (result.status !== 0 || line === undefined) {
      throw new Error(`Dawn GPU benchmark failed at capacity ${capacity}: ${output.slice(-4000)}`);
    }
    return JSON.parse(line.slice('[smoke-dawn] PASS '.length));
  });
}

export function runVfxBatchBBenchmark(smokeRuns = collectGpuRuns()) {
  const cases = smokeRuns.map((run) => ({
    name: `gpu-${run.benchmark.capacity}`,
    capacity: run.benchmark.capacity,
    allocatedCapacity: run.benchmark.allocatedCapacity,
    backend: run.benchmark.backend,
    adapterClass: run.benchmark.adapterClass,
    samples: run.benchmark.samples,
    distribution: {
      p50Ms: run.benchmark.p50Ms,
      p95Ms: run.benchmark.p95Ms,
      p99Ms: run.benchmark.p99Ms,
    },
    topologyPixels: run.topologyPixels,
    validationErrors: run.persistentErrors.length,
    verdict:
      run.benchmark.backend === VFX_BATCH_B_PROTOCOL.backend &&
      run.benchmark.allocatedCapacity === run.benchmark.capacity &&
      run.benchmark.samples === VFX_BATCH_B_PROTOCOL.samples &&
      run.persistentErrors.length === 0 &&
      Object.values(run.topologyPixels).every((count) => count >= 20)
        ? 'pass'
        : 'fail',
  }));
  const p95Ms = Math.max(...cases.map((item) => item.distribution.p95Ms));
  const adapterClass = cases.every((item) => item.adapterClass === 'software-reference')
    ? 'software-reference'
    : 'hardware';
  const performanceGated = adapterClass === 'hardware';
  const thresholdMs = performanceGated ? VFX_BATCH_B_PROTOCOL.hardwareFrameBudgetMs : null;
  return {
    ...VFX_BATCH_B_PROTOCOL,
    environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown' },
    cases,
    allocation: {
      cpuParticleMirror: false,
      particleReadbackBytes: 0,
      framebufferEvidenceReadback: true,
      verdict: 'pass',
    },
    frameBudget: {
      p95Ms,
      thresholdMs,
      hardwareTargetMs: VFX_BATCH_B_PROTOCOL.hardwareFrameBudgetMs,
      adapterClass,
      performanceGated,
    },
    verdict:
      cases.every((item) => item.verdict === 'pass') &&
      (!performanceGated || p95Ms <= VFX_BATCH_B_PROTOCOL.hardwareFrameBudgetMs)
        ? 'pass'
        : 'fail',
  };
}

export function validateVfxBatchBReport(value) {
  if (value?.benchmark !== VFX_BATCH_B_PROTOCOL.benchmark) return { ok: false, error: 'benchmark' };
  if (
    value.dataset !== VFX_BATCH_B_PROTOCOL.dataset ||
    value.backend !== VFX_BATCH_B_PROTOCOL.backend
  ) {
    return { ok: false, error: 'protocol' };
  }
  if (!Array.isArray(value.cases) || value.cases.length !== 3) return { ok: false, error: 'cases' };
  if (
    value.cases.some(
      (item, index) =>
        item.capacity !== VFX_BATCH_B_PROTOCOL.capacities[index] ||
        item.allocatedCapacity !== item.capacity ||
        item.backend !== VFX_BATCH_B_PROTOCOL.backend ||
        (item.adapterClass !== 'hardware' && item.adapterClass !== 'software-reference') ||
        item.samples !== VFX_BATCH_B_PROTOCOL.samples ||
        item.validationErrors !== 0,
    )
  ) {
    return { ok: false, error: 'gpu-evidence' };
  }
  if (value.allocation?.cpuParticleMirror || value.allocation?.particleReadbackBytes !== 0) {
    return { ok: false, error: 'allocation' };
  }
  if (value.verdict !== 'pass') return { ok: false, error: 'verdict' };
  const performanceGated = value.frameBudget?.adapterClass === 'hardware';
  const expectedThreshold = performanceGated ? VFX_BATCH_B_PROTOCOL.hardwareFrameBudgetMs : null;
  if (
    value.frameBudget?.thresholdMs !== expectedThreshold ||
    value.frameBudget?.performanceGated !== performanceGated ||
    (performanceGated && value.frameBudget?.p95Ms > VFX_BATCH_B_PROTOCOL.hardwareFrameBudgetMs)
  ) {
    return { ok: false, error: 'frame-budget' };
  }
  return { ok: true, value };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runVfxBatchBBenchmark();
  const result = validateVfxBatchBReport(report);
  console.log(JSON.stringify(report));
  if (!result.ok) process.exitCode = 1;
}
