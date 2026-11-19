#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { cpuPerfettoHtml, perfettoUiUrl } from './cpu_perfetto_view.mjs';
import { cpuProfileGraph } from './cpu_profile.mjs';
import { cpuSampleTimeline } from './cpu_timeline.mjs';
import {
  cpuCallTreeSvg,
  cpuTimelineCallTrees,
  cpuTimelineIntervalSummary,
  cpuTimelineSampleDensity,
  cpuTimelineSvg,
} from './cpu_timeline_view.mjs';
import { analyzeCaptureWindows, analyzeCpuWindow } from './cpu_windows.mjs';
import { loadJson, requireFact } from './lib.mjs';

const category = (frame) => {
  const name = frame.functionName;
  if (name === '(idle)') return 'idle';
  if (name === '(garbage collector)') return 'gc';
  if (name === '(program)' || name === '(root)') return 'unattributed';
  return frame.url ? 'script' : 'native-or-unattributed';
};

// Merge equal call-tree prefixes only across adjacent observed sample intervals.
function stackSlices(samples, graph) {
  const slices = [],
    active = [];
  for (const sample of samples) {
    const stack = graph
      .chainFor(sample.nodeId)
      .slice()
      .reverse()
      .filter((id) => graph.nodes.get(id).callFrame.functionName !== '(root)');
    let common = 0;
    while (
      common < stack.length &&
      common < active.length &&
      active[common].nodeId === stack[common] &&
      active[common].endMs === sample.startMs
    )
      common++;
    active.length = common;
    for (let depth = 0; depth < common; depth++) active[depth].endMs = sample.endMs;
    for (let depth = common; depth < stack.length; depth++) {
      const slice = { nodeId: stack[depth], depth, startMs: sample.startMs, endMs: sample.endMs };
      active.push(slice);
      slices.push(slice);
    }
  }
  return slices;
}

function captureCompletionReceipts(frames) {
  const receipts = [...frames.frames];
  if (
    frames.closingFrame &&
    !receipts.some(
      (r) =>
        r.frameId === frames.closingFrame.frameId &&
        r.worldIdentity === frames.closingFrame.worldIdentity &&
        r.deviceGeneration === frames.closingFrame.deviceGeneration,
    )
  )
    receipts.push(frames.closingFrame);
  return receipts;
}

function completionReceiptTime(receipt, admitted, originUs) {
  requireFact(
    Number.isFinite(receipt.at) &&
      Number.isSafeInteger(receipt.frameId) &&
      typeof receipt.worldIdentity === 'string' &&
      receipt.worldIdentity.length > 0 &&
      Number.isSafeInteger(receipt.deviceGeneration),
    'Invalid completion receipt',
  );
  return receipt.at + admitted.clock.offsetMs - originUs / 1000;
}

function submittedCompletionFacts(frames, receipt) {
  const submitted = frames.submitted?.find(
    (row) =>
      row.frameId === receipt.frameId &&
      row.worldIdentity === receipt.worldIdentity &&
      row.deviceGeneration === receipt.deviceGeneration,
  );
  const submittedFacts =
    submitted === undefined
      ? null
      : { ...submitted, timestampUnit: 'page performance.now milliseconds' };
  if (submittedFacts)
    for (const name of [
      'engineUpdateMs',
      'renderDrawCpuMs',
      'engineCreditWaitMs',
      'renderDrawIntervalMs',
      'renderAwaitMs',
      'renderQueuedMs',
    ])
      requireFact(
        submittedFacts[name] === undefined ||
          submittedFacts[name] === null ||
          (Number.isFinite(submittedFacts[name]) && submittedFacts[name] >= 0),
        'Invalid submitted phase duration',
      );
  return submittedFacts;
}

function associateCpuCompletions(frames, admitted, tracks, originUs, endUs) {
  const completions = [],
    frameIntervals = [];
  if (admitted) {
    const receipts = captureCompletionReceipts(frames);
    const cursors = tracks.map(() => ({ index: 0 }));
    let previous;
    for (const receipt of receipts) {
      const atMs = completionReceiptTime(receipt, admitted, originUs);
      requireFact(
        !previous || atMs > previous.atMs,
        'Completion receipts must be strictly time ordered',
      );
      const current = {
        atMs,
        frameId: receipt.frameId,
        worldIdentity: receipt.worldIdentity,
        deviceGeneration: receipt.deviceGeneration,
        renderSubmitToCompleteMs: receipt.renderSubmitToCompleteMs ?? null,
      };
      const submittedFacts = submittedCompletionFacts(frames, receipt);
      if (atMs >= 0 && atMs <= (endUs - originUs) / 1000) completions.push(current);
      if (
        previous &&
        previous.worldIdentity === current.worldIdentity &&
        previous.deviceGeneration === current.deviceGeneration
      ) {
        requireFact(
          current.frameId > previous.frameId,
          'Completion frame ids must increase within one owner',
        );
        const startMs = Math.max(0, previous.atMs),
          endMs = Math.min((endUs - originUs) / 1000, atMs);
        if (endMs > startMs)
          frameIntervals.push({
            previous,
            current,
            submittedFacts,
            startMs,
            endMs,
            completionGapMs: atMs - previous.atMs,
            coverage: startMs === previous.atMs && endMs === atMs ? 'complete' : 'partial',
            missingIntermediateReceipts: current.frameId - previous.frameId - 1,
            threads: tracks.map((track, index) =>
              cpuTimelineIntervalSummary(track, startMs, endMs, cursors[index]),
            ),
          });
      }
      previous = current;
    }
  }
  return { completions, frameIntervals };
}

export function buildCpuTimeline(raw, { report, frames, maps, rawSha256 } = {}) {
  requireFact(
    (report === undefined) === (frames === undefined),
    'Supply --report and --frames together',
  );
  requireFact(
    maps === undefined || report !== undefined,
    'Symbol maps require the same-capture report and frames',
  );
  const wrapped = Array.isArray(raw.profiles);
  requireFact(
    wrapped || report === undefined,
    'Frame association requires a multi-target capture envelope',
  );
  const entries = wrapped
    ? raw.profiles
    : [{ target: { targetId: 'profile', type: 'unknown', title: 'CPU profile' }, profile: raw }];
  requireFact(entries.length > 0, 'Require at least one CPU profile');
  requireFact(
    entries.length === 1 || report !== undefined,
    'Multiple targets require same-capture report and clock anchors',
  );
  if (wrapped)
    requireFact(Array.isArray(raw.failures) && raw.failures.length === 0, 'Incomplete CPU capture');
  const admitted =
    report === undefined ? null : analyzeCaptureWindows(raw, report, frames, maps, rawSha256);
  const originUs = admitted?.commonCdpMicroseconds.startTime ?? entries[0].profile.startTime;
  const endUs = admitted?.commonCdpMicroseconds.endTime ?? entries[0].profile.endTime;
  const targets = new Set();
  const tracks = entries.map((entry, index) => {
    requireFact(
      typeof entry.target?.targetId === 'string' && !targets.has(entry.target.targetId),
      'Missing or duplicate target',
    );
    targets.add(entry.target.targetId);
    const graph = cpuProfileGraph(entry.profile),
      timeline = cpuSampleTimeline(entry.profile);
    const sourceMap = new Map(
      maps?.profiles
        .find((row) => row.target.targetId === entry.target.targetId)
        ?.symbols.map((row) => [row.nodeId, row.source]) ?? [],
    );
    const samples = [];
    for (const interval of timeline.intervals) {
      graph.chainFor(interval.id); // Validate excluded startup and out-of-window samples too.
      const start = Math.max(originUs, interval.startTime),
        end = Math.min(endUs, interval.endTime);
      if (interval.position === 0 || end <= start) continue;
      samples.push({
        startMs: (start - originUs) / 1000,
        endMs: (end - originUs) / 1000,
        nodeId: interval.id,
        category: category(graph.nodes.get(interval.id).callFrame),
      });
    }
    const realm = admitted?.slices[0].profiles[index].realm;
    const track = {
      target: entry.target,
      name: entry.target.title || realm || entry.target.type || 'CPU profile',
      identityKind: 'CDP target, not OS thread id',
      nodes: [...graph.nodes.values()].map((node) => ({
        nodeId: node.id,
        parentNodeId: graph.chainFor(node.id)[1] ?? null,
        rawWholeProfileHitCount: node.hitCount ?? null,
        rawWholeProfilePositionTicks: node.positionTicks ?? [],
        ...node.callFrame,
        source: sourceMap.get(node.id) ?? null,
      })),
      samples,
      slices: stackSlices(samples, graph),
      audit: timeline.audit,
      analysis: analyzeCpuWindow(
        entry.profile,
        { startTime: originUs, endTime: endUs },
        30,
        sourceMap,
      ),
    };
    track.summary = cpuTimelineIntervalSummary(track, 0, (endUs - originUs) / 1000, { index: 0 });
    track.sampling = {
      ...cpuTimelineSampleDensity(track, 0, (endUs - originUs) / 1000),
      samplesPerSecond: track.samples.length / ((endUs - originUs) / 1000000),
      requestedIntervalUs: report?.method?.samplingIntervalUs ?? null,
    };
    return track;
  });
  const { completions, frameIntervals } = associateCpuCompletions(
    frames,
    admitted,
    tracks,
    originUs,
    endUs,
  );
  return {
    schemaVersion: 1,
    kind: 'sampled-cpu-timeline',
    timeUnit: 'ms',
    originCdpMicroseconds: originUs,
    startMs: 0,
    endMs: (endUs - originUs) / 1000,
    clock: admitted?.clock ?? null,
    identity: {
      game: report?.gameCommit ?? null,
      engine: report?.engineCommit ?? null,
      rawSha256: rawSha256 ?? null,
    },
    completeness: admitted?.completeness ?? 'profile-only',
    producerReportOk: admitted?.producerReportOk ?? null,
    windowAnalysis: admitted,
    captureScope: {
      sampledTargets: entries.map((e) => e.target),
      unsampledTargets: report?.cpu?.unsampledTargets ?? [],
    },
    interpretation: [
      'Time-ordered sampled stack estimates, not measured function entry/exit scopes or OS on-CPU time.',
      'Ending-sample weights can include scheduling delay. First interval and unobserved tail remain unknown.',
      'Completion intervals are time between receipts, not frame execution latency or exclusive ownership of sampled work.',
      'Tracks identify captured JS targets only. Native/GC/browser/GPU threads and scheduler states require other data sources.',
      'Nested slices overlap; do not sum inclusive slices or thread times into a frame duration.',
    ],
    tracks,
    completions,
    frameIntervals,
  };
}

export function cpuTimelineTrace(model) {
  const traceEvents = [];
  const pid = model.tracks.length + 2;
  const metadata = (tid, name) =>
    traceEvents.push({ ph: 'M', name: 'thread_name', pid, tid, args: { name } });
  traceEvents.push({
    ph: 'M',
    name: 'process_name',
    pid,
    args: { name: 'CPU sampled JS targets' },
  });
  metadata(1, 'Completion intervals (not execution scopes)');
  for (const [name, ms] of [
    ['Capture start', model.startMs],
    ['Capture end', model.endMs],
  ])
    traceEvents.push({
      ph: 'i',
      s: 't',
      cat: 'capture-boundary',
      name,
      pid,
      tid: 1,
      ts: ms * 1000,
    });
  for (const frame of model.frameIntervals)
    traceEvents.push({
      ph: 'X',
      cat: 'completion-interval',
      name: `Completion #${frame.current.frameId}`,
      pid,
      tid: 1,
      ts: frame.startMs * 1000,
      dur: (frame.endMs - frame.startMs) * 1000,
      args: {
        ...frame.current,
        coverage: frame.coverage,
        missingIntermediateReceipts: frame.missingIntermediateReceipts,
      },
    });
  for (const [index, track] of model.tracks.entries()) {
    const tid = index + 2,
      nodes = new Map(track.nodes.map((n) => [n.nodeId, n]));
    metadata(tid, `${track.name} [${track.target.targetId}] (sampled JS target)`);
    for (const slice of track.slices) {
      const node = nodes.get(slice.nodeId);
      traceEvents.push({
        ph: 'X',
        cat: 'sampled-stack-estimate',
        name: node.source?.functionName || node.functionName || '(anonymous)',
        pid,
        tid,
        ts: slice.startMs * 1000,
        dur: (slice.endMs - slice.startMs) * 1000,
        args: {
          nodeId: slice.nodeId,
          capturedFunctionName: node.functionName,
          depth: slice.depth,
          url: node.url,
          lineNumber: node.lineNumber,
          columnNumber: node.columnNumber,
          source: node.source,
        },
      });
    }
  }
  return {
    traceEvents,
    displayTimeUnit: 'ms',
    metadata: {
      interpretation: model.interpretation,
      clock: model.clock,
      identity: model.identity,
      captureScope: model.captureScope,
      sampling: model.tracks.map((t) => ({ target: t.target, ...t.sampling })),
    },
  };
}

export function cpuInspectorHtml(model, viewSource, initialView = {}) {
  const json = JSON.stringify(model).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPU sampling inspector</title><body><script type="module">${viewSource.replaceAll('export function ', 'function ')}\nmountCpuInspector(${json}, ${JSON.stringify(initialView)});</script></body></html>`;
}

export function defaultCpuView(model) {
  const track = model.tracks.find((t) => t.name === 'forgeax-render') ?? model.tracks[0];
  const candidates = model.frameIntervals
    .map((frame, index) => ({
      frame,
      index,
      ...cpuTimelineSampleDensity(track, frame.startMs, frame.endMs),
    }))
    .filter((r) => r.activeSamples > 0)
    .sort((a, b) => a.activeSamples - b.activeSamples || a.index - b.index);
  if (!candidates.length)
    return {
      fromMs: model.startMs,
      toMs: model.endMs,
      criterion: 'Full captured interval; no active completion interval selected',
    };
  const selected = candidates[Math.floor(candidates.length / 2)];
  return {
    fromMs: model.frameIntervals[Math.max(0, selected.index - 1)].startMs,
    toMs: model.frameIntervals[Math.min(model.frameIntervals.length - 1, selected.index + 1)].endMs,
    criterion:
      'Three completion intervals around median non-idle sample count; illustrative, not a worst-frame selection',
  };
}

export const CPU_REPORT_OPTIONS = {
  help: { type: 'boolean' },
  report: { type: 'string' },
  frames: { type: 'string' },
  maps: { type: 'string' },
  'out-dir': { type: 'string' },
  width: { type: 'string', default: '2400' },
  'from-ms': { type: 'string' },
  'to-ms': { type: 'string' },
  'perfetto-ui': { type: 'string' },
};

export async function renderCpuTimeline(
  args = process.argv.slice(2),
  { maps: generatedMaps, quiet = false } = {},
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: CPU_REPORT_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node cpu.mjs report PROFILE.json --out-dir NEW_DIRECTORY [--report REPORT.json --frames FRAMES.json [--maps MAPS.json]] [--width 2400] [--from-ms N --to-ms N] [--perfetto-ui HTTP_UI_BASE]\nWrites timeline.json, analysis.json, timeline.html, timeline.svg, call-tree.svg, call-trees.json and timeline.trace.json exclusively. CPU totals and same-capture gap analysis are integrated. Single .cpuprofile or an existing same-capture profiles envelope. timeline.html uses the pinned Perfetto UI over HTTP; run cpu.mjs serve REPORT_DIRECTORY. --perfetto-ui selects a self-hosted build. Initial hosted UI loading needs network; trace data is passed locally to its browser frame with sharing disabled. timeline-inspector.html provides offline call trees, completion/function details and call-tree SVG export. Numeric ranges are milliseconds relative to the common capture origin; they select the static SVG and initial HTML viewport. HTML can return to the full capture and JSON retains all data. Multi-target/frame association uses analyze_cpu_windows admission, including clock anchors. Missing/partial evidence remains explicit; no on-CPU, frame execution or performance acceptance is inferred.\n',
    );
    return;
  }
  requireFact(positionals.length === 1 && values['out-dir'], 'Require input and a new --out-dir');
  const paths = [positionals[0], values.report, values.frames, values.maps].filter(
    (p) => p !== undefined,
  );
  const loaded = await Promise.all(paths.map(loadJson));
  let at = 1;
  const normalized = loaded[0].value.kind === 'sampled-cpu-timeline';
  requireFact(
    !normalized || (loaded[0].value.schemaVersion === 1 && paths.length === 1 && !generatedMaps),
    'Normalized timeline owns its capture metadata; do not supply report/frames/maps',
  );
  const model = normalized
    ? loaded[0].value
    : buildCpuTimeline(loaded[0].value, {
        rawSha256: loaded[0].sha256,
        report: values.report ? loaded[at++].value : undefined,
        frames: values.frames ? loaded[at++].value : undefined,
        maps: values.maps ? loaded[at++].value : generatedMaps,
      });
  model.inputs = [
    ...(model.inputs ?? []),
    ...paths.map((path, index) => ({ path, sha256: loaded[index].sha256 })),
  ];
  model.command = args;
  if (generatedMaps) model.nameRecovery = generatedMaps.nameRecovery;
  model.initialView = defaultCpuView(model);
  const options = {
    width: Number(values.width),
    fromMs:
      values['from-ms'] === undefined
        ? values['to-ms'] === undefined
          ? model.initialView.fromMs
          : model.startMs
        : Number(values['from-ms']),
    toMs:
      values['to-ms'] === undefined
        ? values['from-ms'] === undefined
          ? model.initialView.toMs
          : model.endMs
        : Number(values['to-ms']),
  };
  const svg = cpuTimelineSvg(model, options); // Validate output range before creating any files.
  const ui = perfettoUiUrl(values['perfetto-ui']);
  const trace = cpuTimelineTrace(model);
  const source = await readFile(new URL('./cpu_timeline_view.mjs', import.meta.url), 'utf8');
  await mkdir(values['out-dir']); // No existing directory or input can be overwritten.
  for (const [name, body] of [
    ...(generatedMaps ? [['source-symbols.json', JSON.stringify(generatedMaps)]] : []),
    ['timeline.json', JSON.stringify(model)],
    [
      'analysis.json',
      JSON.stringify({
        identity: model.identity,
        inputs: model.inputs,
        scope: model.captureScope,
        completeness: model.completeness,
        targets: model.tracks.map((t) => ({
          target: t.target,
          sampling: t.sampling,
          ...t.analysis,
        })),
        windows: model.windowAnalysis,
      }),
    ],
    [
      'timeline.html',
      cpuPerfettoHtml(model, trace, {
        ...options,
        ui,
        converterSource: cpuTimelineTrace.toString(),
      }),
    ],
    ['timeline-inspector.html', cpuInspectorHtml(model, source, options)],
    ['timeline.svg', svg],
    ['call-tree.svg', cpuCallTreeSvg(model, options)],
    [
      'call-trees.json',
      JSON.stringify({
        identity: model.identity,
        scope: model.captureScope,
        range: { fromMs: options.fromMs, toMs: options.toMs },
        topDown: cpuTimelineCallTrees(model, options.fromMs, options.toMs),
        bottomUp: cpuTimelineCallTrees(model, options.fromMs, options.toMs, {
          direction: 'bottom-up',
        }),
      }),
    ],
    ['timeline.trace.json', JSON.stringify(trace)],
  ])
    await writeFile(join(values['out-dir'], name), body, { flag: 'wx' });
  if (!quiet)
    process.stdout.write(
      `${JSON.stringify({ status: model.completeness, directory: values['out-dir'], targets: model.tracks.length, completionIntervals: model.frameIntervals.length })}\n`,
    );
  if (model.completeness === 'partial') process.exitCode = 2;
  return { directory: values['out-dir'], completeness: model.completeness };
}
