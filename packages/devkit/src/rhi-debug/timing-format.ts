import type {
  ConfidenceInterval,
  DriftStats,
  PassBenchmark,
  ReplayBenchmark,
  ReplayComparison,
  ReplayRestore,
  TimestampCoverage,
  TimingStats,
} from '@forgeax/engine-rhi-debug';
import type { RhiTimingOutput } from './timing.js';
import type { TimedTape, TimingCheck } from './timing-environment.js';

const TOP_PASSES = 10;

function ms(ns: number | null | undefined, digits = 2): string {
  return ns === null || ns === undefined || Number.isNaN(ns) ? '-' : (ns / 1e6).toFixed(digits);
}

function interval(ci: ConfidenceInterval): string {
  return `[${ms(ci.low)}, ${ms(ci.high)}]`;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

function driftLabel(drift: DriftStats): string {
  return drift.stable
    ? 'stable'
    : `DRIFT half ${(drift.halfShift * 100).toFixed(1)}% lag1 ${drift.lag1Autocorrelation.toFixed(2)}`;
}

function tapeLine(name: string, tape: TimedTape): string {
  return `${name} ${tape.path ?? '(no path)'}  ${tape.digest.slice(0, 16)}  ${(tape.bytes / 1e6).toFixed(1)} MB`;
}

function restoreLine(restore: ReplayRestore): string {
  const steady = restore.steady;
  const detail =
    restore.mode === 'steady' && steady !== undefined
      ? ` (${steady.buffers} buffers, ${steady.textures} textures, ${(steady.bytes / 1e6).toFixed(1)} MB GPU copies${steady.unrestored.length === 0 ? '' : `; not restored: ${steady.unrestored.join(', ')}`})`
      : restore.fallbackReason === undefined
        ? ''
        : ` (steady unavailable: ${restore.fallbackReason})`;
  return `restore ${restore.mode}${detail}, pipeline depth ${restore.pipelineDepth}`;
}

function statsRow(name: string, stats: TimingStats, ci?: ConfidenceInterval, drift?: string) {
  return [
    name,
    ms(stats.p50),
    ci === undefined ? '' : interval(ci),
    ms(stats.min),
    ms(stats.p95),
    ms(stats.stddev),
    drift ?? '',
  ];
}

function coverageLines(coverage: TimestampCoverage, side = ''): string[] {
  if (coverage.complete) return [];
  return [
    `${side}passes without timestamps (not in union):`,
    ...coverage.missingPasses.map(
      (pass) =>
        `  ${pass.label ?? `#${pass.passIndex}`} [${pass.passIndex}] ${pass.variant} ${pass.reason} in ${pass.replays} replays`,
    ),
  ];
}

function passRows(passes: readonly PassBenchmark[], ablated: boolean): string[] {
  const ranked = passes
    .filter((pass) => pass.gpu !== null)
    .sort((a, b) => (b.gpu?.p50 ?? 0) - (a.gpu?.p50 ?? 0))
    .slice(0, TOP_PASSES);
  if (ranked.length === 0) return [];
  return [
    `top ${ranked.length} passes by p50 (ms; passes overlap, so they do not add up to the union)`,
    ...table([
      ['  #', 'label', 'p50', 'p95', 'min', ...(ablated ? ['ablated p50'] : [])],
      ...ranked.map((pass) => [
        `  ${pass.passIndex}`,
        pass.label ?? '-',
        ms(pass.gpu?.p50, 3),
        ms(pass.gpu?.p95, 3),
        ms(pass.gpu?.min, 3),
        ...(ablated ? [pass.skipped ? 'skipped' : ms(pass.ablatedGpu?.p50, 3)] : []),
      ]),
    ]),
  ];
}

function verdictLine(
  name: string,
  delta: TimingStats,
  ci: ConfidenceInterval,
  significant: boolean,
) {
  return `${name} ${ms(delta.p50, 3)} ms ${interval(ci)}  ${significant ? 'significant' : 'not significant (interval includes 0)'}`;
}

function benchmarkLines(benchmark: ReplayBenchmark): string[] {
  const { base, ablated } = benchmark;
  const lines = [
    `${restoreLine(benchmark.restore)}; warmup ${benchmark.warmup}, repeat ${benchmark.repeat}${benchmark.isolate ? ', isolated per pass' : ''}`,
    '',
    ...table([
      ['frame (ms)', 'p50', '95% CI', 'min', 'p95', 'sd', 'trend'],
      statsRow('union', base.frame.union, base.unionP50Interval, driftLabel(base.drift)),
      statsRow('envelope', base.frame.envelope),
      statsRow('sum', base.frame.sum),
      ...(ablated === undefined
        ? []
        : [
            statsRow(
              'ablated union',
              ablated.frame.union,
              ablated.unionP50Interval,
              driftLabel(ablated.drift),
            ),
          ]),
    ]),
  ];
  if (ablated !== undefined)
    lines.push(
      verdictLine(
        `skip saves (base - ablated, paired, ${ablated.passIndices.length} passes, ${ablated.workIndices.length} works): union p50`,
        ablated.delta.union,
        ablated.unionVerdict.ci,
        ablated.unionVerdict.significant,
      ),
    );
  lines.push('', ...passRows(benchmark.passes, ablated !== undefined));
  lines.push(...coverageLines(benchmark.timestampCoverage));
  return lines;
}

function comparisonLines(comparison: ReplayComparison): string[] {
  const { baseline, candidate } = comparison;
  const changed = comparison.passes
    .filter((pass) => pass.deltaP50 !== null)
    .sort((a, b) => Math.abs(b.deltaP50 ?? 0) - Math.abs(a.deltaP50 ?? 0))
    .slice(0, TOP_PASSES);
  const unmatched = comparison.unmatchedPasses;
  return [
    `baseline ${restoreLine(baseline.restore)}`,
    `candidate ${restoreLine(candidate.restore)}`,
    `interleaved in chunks of ${comparison.chunk} (A B B A ...); warmup ${comparison.warmup}, repeat ${comparison.repeat} per tape`,
    '',
    ...table([
      ['frame (ms)', 'p50', '95% CI', 'min', 'p95', 'sd', 'trend'],
      statsRow(
        'baseline union',
        baseline.benchmark.frame.union,
        baseline.benchmark.unionP50Interval,
        driftLabel(baseline.benchmark.drift),
      ),
      statsRow(
        'candidate union',
        candidate.benchmark.frame.union,
        candidate.benchmark.unionP50Interval,
        driftLabel(candidate.benchmark.drift),
      ),
    ]),
    verdictLine(
      'candidate - baseline union p50 (paired)',
      comparison.delta.union,
      comparison.unionVerdict.ci,
      comparison.unionVerdict.significant,
    ),
    '',
    ...(changed.length === 0
      ? []
      : [
          `top ${changed.length} pass changes by |delta p50| (ms)`,
          ...table([
            ['  label', 'baseline', 'candidate', 'delta'],
            ...changed.map((pass) => [
              `  ${pass.label ?? `#${pass.baselinePassIndex}`}${pass.occurrence === 0 ? '' : ` (${pass.occurrence + 1})`}`,
              ms(pass.baselineP50, 3),
              ms(pass.candidateP50, 3),
              ms(pass.deltaP50, 3),
            ]),
          ]),
        ]),
    ...(unmatched.baseline.length === 0
      ? []
      : [`only in baseline: ${unmatched.baseline.join(', ')}`]),
    ...(unmatched.candidate.length === 0
      ? []
      : [`only in candidate: ${unmatched.candidate.join(', ')}`]),
    ...coverageLines(baseline.timestampCoverage, 'baseline '),
    ...coverageLines(candidate.timestampCoverage, 'candidate '),
  ];
}

function checkLines(checks: readonly TimingCheck[]): string[] {
  return [
    'preflight',
    ...table(
      checks.map((check) => [
        `  ${check.ok ? 'ok' : check.severity === 'error' ? 'FAIL' : 'warn'}`,
        check.name,
        check.detail,
      ]),
    ),
  ];
}

/** The default `forgeax rhi timing` output: one screen a human reads before trusting the numbers. */
export function formatTimingTable(output: RhiTimingOutput): string {
  const { environment, preflight } = output;
  const device = environment.device;
  const build = environment.build;
  const head = [
    output.valid
      ? 'VALID'
      : `INVALID: ${output.invalidReasons.join('; ')}\n(do not compare these numbers; fix the cause and rerun)`,
    tapeLine(output.comparison === undefined ? 'tape' : 'candidate', environment.tape),
    ...(environment.baselineTape === undefined
      ? []
      : [tapeLine('baseline', environment.baselineTape)]),
    `device ${device === null ? 'unknown' : [device.vendor, device.architecture, device.device || device.description].filter((part) => part !== '').join(' / ')}; timestamps ${environment.timestampQuantization === 'disabled' ? 'raw' : `quantization ${environment.timestampQuantization}`}`,
    `build ${
      build === null
        ? 'unknown'
        : Object.entries(build)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')
    }`,
  ];
  const body =
    output.comparison !== undefined
      ? comparisonLines(output.comparison)
      : output.benchmark !== undefined
        ? benchmarkLines(output.benchmark)
        : [];
  return [
    ...head,
    ...body,
    '',
    ...checkLines(preflight.checks),
    `took ${(environment.elapsedMs / 1000).toFixed(1)} s; --json for every pass, sample and interval`,
    '',
  ].join('\n');
}

/** True for an `rhi timing` result value, so the CLI can print the table instead of JSON. */
export function isTimingOutput(value: unknown): value is RhiTimingOutput {
  return (
    value !== null &&
    typeof value === 'object' &&
    'preflight' in value &&
    'environment' in value &&
    'valid' in value
  );
}
