import type {
  ReplayBenchmark,
  ReplayComparison,
  ReplaySession,
  RhiDebugError,
} from '@forgeax/engine-rhi-debug';
import type { CommandError, CommandResult } from '../types.js';
import type { ArtifactRef, RhiDebugOperationContext } from './operations.js';
import {
  DEFAULT_TIMING_TIMEOUT_MS,
  type RhiTimingInput,
  type RhiTimingOutput,
  timingBenchmarkOptions,
  timingFromBenchmark,
  withTimingTimeout,
} from './timing.js';
import {
  convergenceCheck,
  coverageCheck,
  cpuLoadCheck,
  DEFAULT_MAX_GPU_PERCENT,
  driftCheck,
  gpuIdleCheck,
  type HostLoadSample,
  invalidReasons,
  measuredValues,
  quantizationCheck,
  type ReplayAdapterInfo,
  type TimedTape,
  type TimestampQuantization,
  type TimingCheck,
} from './timing-environment.js';

/** What `rhi.timing` needs from an opened tape replay. */
export interface OpenedTimingReplay {
  readonly session: ReplaySession;
  readonly byteLength: number;
  readonly adapterInfo?: ReplayAdapterInfo;
  readonly timestampQuantization?: TimestampQuantization;
  readonly close: () => Promise<void>;
}

/** operations.ts helpers, injected so this module never imports operations values (no cycle). */
export interface TimingRunDeps {
  readonly validateArtifactRef: (value: unknown) => CommandResult<ArtifactRef>;
  readonly openTapeReplay: (artifact: ArtifactRef) => Promise<CommandResult<OpenedTimingReplay>>;
  readonly coreError: (error: RhiDebugError) => CommandError;
}

interface Measured {
  readonly benchmark?: ReplayBenchmark;
  readonly comparison?: ReplayComparison;
  readonly tapes: readonly OpenedTimingReplay[];
}

function invalidInput(expected: string, hint: string): CommandResult<never> {
  return { ok: false, error: { code: 'timing-input-invalid', expected, hint, detail: {} } };
}

function tapeOf(artifact: ArtifactRef, opened: OpenedTimingReplay): TimedTape {
  return {
    ...(artifact.path === undefined ? {} : { path: artifact.path }),
    digest: artifact.digest,
    bytes: opened.byteLength,
  };
}

async function measure(
  input: RhiTimingInput,
  artifact: ArtifactRef,
  baseline: ArtifactRef | undefined,
  deps: TimingRunDeps,
  signal: AbortSignal,
  setStage: (stage: string) => void,
): Promise<CommandResult<Measured>> {
  const opened: OpenedTimingReplay[] = [];
  try {
    for (const ref of baseline === undefined ? [artifact] : [artifact, baseline]) {
      setStage(`open ${ref.path ?? ref.digest}`);
      const replay = await deps.openTapeReplay(ref);
      if (!replay.ok) return replay;
      opened.push(replay.value);
    }
    setStage('measure');
    const [candidate, base] = opened as [OpenedTimingReplay, OpenedTimingReplay | undefined];
    if (base === undefined) {
      const benchmark = await candidate.session.benchmarkPasses(
        timingBenchmarkOptions(input),
        signal,
      );
      if (!benchmark.ok) return { ok: false, error: deps.coreError(benchmark.error) };
      return { ok: true, value: { benchmark: benchmark.value, tapes: opened } };
    }
    const comparison = await base.session.compareWith(
      candidate.session,
      timingBenchmarkOptions(input),
      signal,
    );
    if (!comparison.ok) return { ok: false, error: deps.coreError(comparison.error) };
    return { ok: true, value: { comparison: comparison.value, tapes: opened } };
  } finally {
    setStage('close');
    for (const replay of opened) await replay.close();
  }
}

function resultChecks(
  measured: Measured,
  declared: TimestampQuantization,
  before: HostLoadSample | null,
  after: HostLoadSample | null,
  maxGpuPercent: number,
): TimingCheck[] {
  const checks: TimingCheck[] = [
    { name: 'replay-backend', ok: true, severity: 'error', detail: 'fresh replay device opened' },
    {
      name: 'timestamp-query',
      ok: true,
      severity: 'error',
      detail: 'replay device has timestamp-query',
    },
    quantizationCheck(declared, measuredValues(measured)),
    gpuIdleCheck('gpu-idle-before', before, maxGpuPercent),
    gpuIdleCheck('gpu-idle-after', after, maxGpuPercent),
    cpuLoadCheck(before),
  ];
  const { benchmark, comparison } = measured;
  if (benchmark !== undefined) {
    checks.push(
      coverageCheck(benchmark.timestampCoverage),
      driftCheck('base', benchmark.base.drift),
    );
    if (benchmark.convergence !== undefined) checks.push(convergenceCheck(benchmark.convergence));
  }
  if (comparison !== undefined) {
    checks.push(
      coverageCheck(comparison.baseline.timestampCoverage),
      coverageCheck(comparison.candidate.timestampCoverage),
      driftCheck('baseline', comparison.baseline.benchmark.drift),
      driftCheck('candidate', comparison.candidate.benchmark.drift),
    );
    if (comparison.convergence !== undefined) checks.push(convergenceCheck(comparison.convergence));
  }
  return checks;
}

function hasSkipOptions(input: RhiTimingInput): boolean {
  return (
    input.skip !== undefined || input.skipPasses !== undefined || input.skipWorks !== undefined
  );
}

/** The optional comparison baseline; a comparison never takes skip ablations. */
function comparedBaseline(
  input: RhiTimingInput,
  deps: TimingRunDeps,
): CommandResult<ArtifactRef | undefined> {
  if (input.compare === undefined) return { ok: true, value: undefined };
  const ref = deps.validateArtifactRef(input.compare);
  if (!ref.ok) return ref;
  if (hasSkipOptions(input))
    return invalidInput(
      'compare without skip options',
      'A comparison times whole frames; run skip ablations on one tape at a time.',
    );
  return ref;
}

function requiredIdleError(
  input: RhiTimingInput,
  before: HostLoadSample | null,
  maxGpuPercent: number,
): CommandResult<never> | undefined {
  if (input.requireIdle !== true) return undefined;
  if (gpuIdleCheck('gpu-idle-before', before, maxGpuPercent).ok) return undefined;
  return {
    ok: false,
    error: {
      code: 'gpu-busy',
      expected: `GPU utilization below ${maxGpuPercent}% before timing`,
      hint: 'Close other GPU work (browser tabs, headless pages, other benchmarks) or wait for the machine slot, then rerun.',
      detail: { sample: before },
    },
  };
}

/**
 * `rhi.timing`: sample host load, open fresh replay devices, measure one tape
 * or compare two, sample again and mark the result invalid when a check that
 * makes times incomparable failed (busy GPU, quantized timestamps).
 */
export async function runTimingOperation(
  input: RhiTimingInput,
  context: RhiDebugOperationContext,
  deps: TimingRunDeps,
): Promise<CommandResult<RhiTimingOutput>> {
  const startedAt = new Date();
  const artifact = deps.validateArtifactRef(input.artifact);
  if (!artifact.ok) return artifact;
  const compared = comparedBaseline(input, deps);
  if (!compared.ok) return compared;
  const baseline = compared.value;
  const maxGpuPercent = input.maxGpuPercent ?? DEFAULT_MAX_GPU_PERCENT;
  const before = (await context.sampleHostLoad?.('before')) ?? null;
  const busy = requiredIdleError(input, before, maxGpuPercent);
  if (busy !== undefined) return busy;
  let stage = 'start';
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMING_TIMEOUT_MS;
  const measured = await withTimingTimeout(
    (signal) =>
      measure(input, artifact.value, baseline, deps, signal, (next) => {
        stage = next;
      }),
    timeoutMs,
    () => stage,
  );
  if (!measured.ok) return measured;
  const after = (await context.sampleHostLoad?.('after')) ?? null;
  const build = (await context.buildIdentity?.()) ?? null;
  const [candidateTape, baselineTape] = measured.value.tapes as [
    OpenedTimingReplay,
    OpenedTimingReplay | undefined,
  ];
  const declared = candidateTape.timestampQuantization ?? 'unknown';
  const checks = resultChecks(measured.value, declared, before, after, maxGpuPercent);
  const reasons = invalidReasons(checks);
  const { benchmark, comparison } = measured.value;
  return {
    ok: true,
    value: {
      artifact: artifact.value,
      valid: reasons.length === 0,
      invalidReasons: reasons,
      preflight: { checks, before, after, maxGpuPercent },
      environment: {
        device: candidateTape.adapterInfo ?? null,
        timestampQuantization: declared,
        build,
        tape: tapeOf(artifact.value, candidateTape),
        ...(baseline === undefined || baselineTape === undefined
          ? {}
          : { baselineTape: tapeOf(baseline, baselineTape) }),
        startedAt: startedAt.toISOString(),
        elapsedMs: Date.now() - startedAt.getTime(),
      },
      ...(benchmark === undefined ? {} : { timing: timingFromBenchmark(benchmark), benchmark }),
      ...(baseline === undefined || comparison === undefined ? {} : { baseline, comparison }),
    },
  };
}
