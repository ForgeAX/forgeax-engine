import { gpuTimelineFrame } from './analyze_gpu_timeline.mjs';
import { perfettoHtml } from './perfetto_view.mjs';

/** One measured Renderer frame; lanes prevent overlaps from becoming invented nested calls. */
export function gpuTimingReport(frame, identity = {}) {
  const coverage = gpuTimelineFrame(frame);
  const pid = frame.passes.length + 2;
  const traceEvents = [
    {
      ph: 'M',
      pid,
      tid: 0,
      name: 'process_name',
      args: { name: `LIVE GPU · Renderer frame ${frame.frameId} · independent clock` },
    },
  ];
  const executions = coverage.executions ?? [];
  for (const [i, e] of executions.entries()) {
    const tid = i + 1;
    traceEvents.push({
      ph: 'M',
      pid,
      tid,
      name: 'thread_name',
      args: { name: `${e.passName} · execution ${e.executionIndex}` },
    });
    traceEvents.push({
      ph: 'X',
      cat: 'gpu.pass',
      pid,
      tid,
      name: e.passName,
      ts: e.beginRelativeToFirstMeasuredMs * 1000,
      dur: (e.endRelativeToFirstMeasuredMs - e.beginRelativeToFirstMeasuredMs) * 1000,
      args: {
        ...e,
        frameId: frame.frameId,
        deviceGeneration: frame.deviceGeneration,
        graphGeneration: frame.graphGeneration,
        backendKind: frame.backendKind,
        clock: 'GPU device ticks; not calibrated to CPU',
        track: 'synthetic display lane; not a hardware queue',
        workIndexMapping: 'unavailable',
      },
    });
  }
  const interpretation = [
    'Actual begin/end device ticks; one synthetic display lane per measured pass. Overlap is preserved, not a call stack or hardware queue assignment.',
    'Sum, union and envelope describe measured timestamp coverage. They do not establish whole-frame latency, hardware occupancy, busy/idle time or removable cost.',
    'No CPU clock alignment or cross-capture resource/pass mapping is inferred. Equal ticks and unmeasured passes retain their status.',
    'Copy boundaries are envelopes, not isolated copy cost. LIVE observations are separate from replay benchmarks.',
  ];
  return {
    kind: 'gpu-timing-report',
    schemaVersion: 1,
    identity,
    frame,
    coverage,
    interpretation,
    trace: { traceEvents, displayTimeUnit: 'ms' },
  };
}
export function gpuTimingHtml(report, options = {}) {
  if (!report.coverage.timed)
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>GPU timing unavailable</title><style>body{background:#101a28;color:#dfebfb;font:16px system-ui;padding:28px}pre{white-space:pre-wrap}a{color:#80d2c6}</style><h1>GPU timing unavailable</h1><p>No measured pass boundaries. Unmeasured values are unknown, not zero.</p><a href="timing.json">AI data and original pass statuses</a><pre>${escape(JSON.stringify({ identity: report.identity, coverage: report.coverage, passes: report.frame.passes }, null, 2))}</pre></html>`;
  const endMs = report.coverage.measuredTimestampEnvelopeMs ?? 0;
  return perfettoHtml(
    {
      title: 'GPU pass timeline',
      identity: report.identity,
      captureScope: {
        frameId: report.frame.frameId,
        deviceGeneration: report.frame.deviceGeneration,
        graphGeneration: report.frame.graphGeneration,
      },
      startMs: 0,
      endMs,
      fromMs: 0,
      toMs: endMs,
      frames: [],
      interpretation: report.interpretation,
      links: [
        ['gpu-timing.svg', 'Static GPU intervals'],
        ['timing.json', 'Timing / AI data'],
        ['timeline.trace.json', 'Download trace'],
      ],
      hint: `Measured ${report.frame.measuredPassCount}/${report.frame.executedPassCount} passes · union ${(report.coverage.measuredIntervalUnionMs ?? 0).toFixed(3)} ms · envelope ${endMs.toFixed(3)} ms · ${report.coverage.equalTickExecutions} equal-tick entries (resolution limited). Independent GPU clock; unmeasured is not zero.`,
    },
    report.trace,
    options,
  );
}
const escape = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export function gpuTimingSvg(report) {
  const rows = report.coverage.executions ?? [],
    width = 1600,
    height = 160 + rows.length * 34;
  const span = report.coverage.measuredTimestampEnvelopeMs ?? 0;
  const x = (ms) => 430 + (ms / Math.max(span, 1e-12)) * 1040;
  const ms = (v) => (v === undefined ? 'unavailable' : v.toFixed(3) + ' ms');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#101a28"/><g fill="#e2ebf8" font-family="system-ui"><text x="24" y="35" font-size="25">GPU pass timestamp intervals · Renderer frame ${report.frame.frameId}</text><text x="24" y="65" font-size="16">Union ${ms(report.coverage.measuredIntervalUnionMs)} · Envelope ${ms(report.coverage.measuredTimestampEnvelopeMs)} · Repeated coverage ${ms(report.coverage.repeatedCoverageMs)}</text><text x="24" y="92" font-size="14">Independent GPU clock · synthetic lanes · ${report.coverage.equalTickExecutions ?? 0} equal-tick markers · not occupancy or whole-frame latency</text>${Array.from(
    { length: 5 },
    (_, i) => {
      const v = (span * i) / 4;
      return `<line x1="${x(v)}" x2="${x(v)}" y1="125" y2="${height - 25}" stroke="#2a3f57"/><text x="${x(v)}" y="116" font-size="11" text-anchor="middle">${v.toFixed(3)} ms</text>`;
    },
  ).join('')}<text x="1500" y="116" font-size="11">Duration</text>${rows
    .map((e, i) => {
      const y = 125 + i * 34;
      return `<text x="24" y="${y + 19}" font-size="14">${escape(e.passName.length > 48 ? e.passName.slice(0, 45) + '…' : e.passName)}</text><rect x="${x(e.beginRelativeToFirstMeasuredMs)}" y="${y}" width="${Math.max(1, x(e.endRelativeToFirstMeasuredMs) - x(e.beginRelativeToFirstMeasuredMs))}" height="24" rx="4" fill="${e.passKind === 'compute' ? '#ad87e8' : '#47bfae'}"/><text x="1500" y="${y + 17}" font-size="12">${ms(e.durationMs)}</text>`;
    })
    .join('')}</g></svg>`;
}
