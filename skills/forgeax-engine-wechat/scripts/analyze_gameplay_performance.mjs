import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BUDGET = 1000 / 60;
const percentile = (values, fraction) =>
  values.length
    ? values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]
    : null;

/** Exact minimum count in half-open one-second windows contained in the phase. */
export function rollingMinimum(times, start, end) {
  if (end - start < 1000) return null;
  let left = 0;
  while (left < times.length && times[left] < start) left++;
  let right = left;
  while (right < times.length && times[right] - start < 1000) right++;
  let minimum = right - left;
  // A half-open window's count only decreases when its left edge passes a
  // completion. Immediately after t, it contains (t, t + 1000]: coincident
  // completions leave together and those exactly 1000 ms later enter together.
  // Count that limit directly; an epsilon can vanish on native epoch-ms clocks.
  while (left < times.length && end - times[left] > 1000) {
    const at = times[left];
    while (left < times.length && times[left] === at) left++;
    if (right < left) right = left;
    while (right < times.length && times[right] - at <= 1000) right++;
    minimum = Math.min(minimum, right - left);
  }
  return minimum;
}

function windowStats(events, start, end) {
  const completed = events.filter(
    (event) => event.kind === 'completed' && event.atMs >= start && event.atMs < end,
  );
  const times = completed.map((event) => event.atMs);
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  let frameIdGaps = 0;
  for (let index = 1; index < completed.length; index++)
    frameIdGaps += Math.max(0, completed[index].frameId - completed[index - 1].frameId - 1);
  const fps = (times.length * 1000) / (end - start);
  return {
    durationMs: end - start,
    completed: times.length,
    submitted: events.filter(
      (event) => event.kind === 'submitted' && event.atMs >= start && event.atMs < end,
    ).length,
    fps,
    intervalCount: intervals.length,
    intervalMs: {
      p50: percentile(intervals, 0.5),
      p95: percentile(intervals, 0.95),
      p99: percentile(intervals, 0.99),
      max: intervals.length
        ? intervals.reduce((max, value) => Math.max(max, value), -Infinity)
        : null,
    },
    over16_667Ms: intervals.filter((value) => value > BUDGET).length,
    over33_333Ms: intervals.filter((value) => value > BUDGET * 2).length,
    rollingOneSecondMinimum: rollingMinimum(times, start, end),
    boundarySilenceMs: {
      first: times.length ? times[0] - start : end - start,
      last: times.length ? end - times.at(-1) : end - start,
    },
    completionFrameIdGaps: frameIdGaps,
    estimatedMissed60HzSlots: intervals.reduce(
      (sum, value) => sum + Math.max(0, Math.round(value / BUDGET) - 1),
      0,
    ),
    actualDroppedPresentationFrames: null,
    strict60FpsMeanReached: fps >= 60,
  };
}

export function analyzeGameplay(report) {
  const capture = report.capture ?? report;
  const errors = [];
  if (capture?.schemaVersion !== 'forgeax-gameplay-capture/1')
    throw new Error('Unsupported gameplay capture schema');
  if (
    !(
      Number.isFinite(capture.startMs) &&
      Number.isFinite(capture.endMs) &&
      capture.endMs > capture.startMs
    )
  )
    throw new Error('Invalid capture interval');
  if (!Array.isArray(capture.events) || !Array.isArray(capture.phases))
    throw new Error('Missing capture rows');
  let previous = -Infinity,
    frame = -1;
  const submittedIds = new Set(),
    completedIds = new Set();
  for (const event of capture.events) {
    if (
      !Number.isFinite(event.atMs) ||
      event.atMs < previous ||
      event.atMs < capture.startMs ||
      event.atMs >= capture.endMs
    )
      errors.push('invalid-event-time');
    if (!Number.isSafeInteger(event.frameId) || event.frameId < 0) errors.push('invalid-frame-id');
    const expectedPhase = capture.phases.findIndex(
      (phase) =>
        event.atMs >= capture.startMs + phase.startMs && event.atMs < capture.startMs + phase.endMs,
    );
    if (!Number.isInteger(event.phase) || event.phase !== expectedPhase || expectedPhase < 0)
      errors.push('invalid-event-phase');
    if (event.kind === 'completed') {
      if (event.frameId <= frame || completedIds.has(event.frameId))
        errors.push('completion-order');
      completedIds.add(event.frameId);
      frame = event.frameId;
    } else if (event.kind === 'submitted') {
      if (submittedIds.has(event.frameId)) errors.push('duplicate-submission');
      submittedIds.add(event.frameId);
    } else errors.push('invalid-event-kind');
    previous = event.atMs;
  }
  let boundary = 0;
  for (const phase of capture.phases) {
    if (phase.startMs !== boundary || !(phase.endMs > phase.startMs)) errors.push('invalid-phase');
    boundary = phase.endMs;
  }
  if (boundary !== capture.endMs - capture.startMs) errors.push('phase-coverage');
  if (capture.status !== 'complete' || capture.failure)
    errors.push(capture.failure ?? 'partial-capture');
  if (!capture.drain?.success) errors.push('drain-unproven');
  if (capture.drain?.lastSubmittedFrame !== capture.drain?.lastCompletedFrame)
    errors.push('outstanding-frame');
  if (report.errors?.length || report.failure) errors.push('runner-failure');
  if (!report.semanticQualification?.success) errors.push('semantics-unproven');
  const all = windowStats(capture.events, capture.startMs, capture.endMs);
  const phases = capture.phases.map((phase) => ({
    name: phase.name,
    ...windowStats(capture.events, capture.startMs + phase.startMs, capture.startMs + phase.endMs),
  }));
  if (!all.completed || phases.some((phase) => !phase.completed))
    errors.push('missing-completions');
  const input = report.inputDispatch;
  if (!input?.success || input.droppedEvents !== 0) errors.push('input-incomplete');
  const cadencePolicy = {
    name: 'strict-60-without-tolerance',
    minimumMeanFps: 60,
    minimumRollingOneSecondCompletions: 60,
    maximumP99IntervalMs: BUDGET,
    maximumIntervalMs: BUDGET,
  };
  const cadence = phases.map((phase) => ({
    name: phase.name,
    mean: phase.fps >= 60,
    rolling: phase.rollingOneSecondMinimum !== null && phase.rollingOneSecondMinimum >= 60,
    p99: phase.intervalMs.p99 !== null && phase.intervalMs.p99 <= BUDGET,
    maximum: phase.intervalMs.max !== null && phase.intervalMs.max <= BUDGET,
  }));
  return {
    schemaVersion: 'forgeax-gameplay-analysis/1',
    status: errors.length ? 'partial' : 'complete',
    errors: [...new Set(errors)],
    workload: report.workload ?? null,
    source: report.source ?? null,
    driver: report.driver ?? null,
    extent: report.extent ?? null,
    toolVerification: report.toolVerification ?? null,
    diagnostic: report.diagnostic ?? null,
    performanceQualification: report.performanceQualification ?? { status: 'unverified' },
    scope:
      'Actual ready scene completion callback timestamps under trusted multitouch; not GPU execution duration or physical display presentation.',
    all,
    phases,
    target: {
      fps: 60,
      cadencePolicy,
      strict60Cadence: {
        met:
          !errors.length &&
          !report.diagnostic &&
          cadence.every((phase) => phase.mean && phase.rolling && phase.p99 && phase.maximum),
        phases: cadence,
      },
      strictMeanReachedInEveryPhase:
        !errors.length && phases.every((phase) => phase.strict60FpsMeanReached),
      hardwarePerformanceQualified:
        report.performanceQualification?.status === 'qualified' &&
        !report.diagnostic &&
        report.toolVerification === false &&
        !errors.length,
    },
    inputDispatch: input ?? null,
    notes: [
      'Intervals exclude phase boundary crossings; FPS counts every completion inside the explicit window.',
      'Estimated missed 60 Hz slots round interval/budget to the nearest cadence multiple; they are not an Engine or display dropped-frame counter.',
      'Strict 60 FPS comparisons use no rounding tolerance. Inspect intervals and rolling minima as well as means.',
    ],
  };
}

export function formatAnalysis(report) {
  const a = analyzeGameplay(report);
  const table = [a.all && { name: 'all', ...a.all }, ...a.phases].map(
    (row) =>
      `| ${row.name} | ${row.completed} | ${row.fps.toFixed(2)} | ${['p50', 'p95', 'p99', 'max'].map((key) => row.intervalMs[key]?.toFixed(2) ?? 'missing').join(' / ')} | ${row.over16_667Ms} / ${row.over33_333Ms} | ${row.rollingOneSecondMinimum ?? 'missing'} |`,
  );
  return `Gameplay completion benchmark: ${a.status}\n\nWorkload: ${a.workload ?? 'unspecified (legacy)'}\n\n${a.scope}\n\n| Phase | Completions | FPS | Interval p50 / p95 / p99 / max ms | >16.667 / >33.333 ms | Min rolling 1s |\n| --- | ---: | ---: | --- | ---: | ---: |\n${table.join('\n')}\n\n${a.errors.length ? `Failures: ${a.errors.join(', ')}\n\n` : ''}${a.notes.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error('Usage: node analyze_gameplay_performance.mjs REPORT.json OUTPUT_PREFIX');
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const analysis = analyzeGameplay(report);
  await writeFile(`${process.argv[3]}.json`, JSON.stringify(analysis, null, 2));
  await writeFile(`${process.argv[3]}.md`, formatAnalysis(report));
  console.log(
    JSON.stringify({
      status: analysis.status,
      fps: analysis.all.fps,
      strict60: analysis.target.strict60Cadence.met,
    }),
  );
  if (analysis.status !== 'complete') process.exitCode = 1;
}
