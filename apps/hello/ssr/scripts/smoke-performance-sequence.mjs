#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abbaIncrement, projectTimingFrame, summarizeIntervalSet } from './smoke-performance-sequence-aggregation.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(appDir, '../../..');
const artifactDir = resolve(
  rootDir,
  process.env.SSR_SEQUENCE_ARTIFACT_DIR ?? 'artifacts/ssr-fallback/performance-sequence',
);
const totalFrameCount = Number.parseInt(process.env.SSR_SEQUENCE_FRAMES ?? '180', 10);
const STARTUP_WINDOW = { label: 'startup-1-60', startOrdinal: 1, endOrdinal: 60 };
const DIAGNOSTIC_WINDOW = { label: 'post-warmup-121-180', startOrdinal: 121, endOrdinal: 180 };
const timeoutMs = Number.parseInt(process.env.SSR_PERF_TIMEOUT_MS ?? '900000', 10);
if (!Number.isInteger(totalFrameCount) || totalFrameCount < DIAGNOSTIC_WINDOW.endOrdinal) {
  throw new Error(`SSR_SEQUENCE_FRAMES must be an integer >= ${DIAGNOSTIC_WINDOW.endOrdinal}`);
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('SSR_PERF_TIMEOUT_MS must be a positive integer');

const sequence = [
  { mode: 'ssr-off', disableSsr: true },
  { mode: 'ssr-on', disableSsr: false },
  { mode: 'ssr-on', disableSsr: false },
  { mode: 'ssr-off', disableSsr: true },
];
const sequenceId = process.env.SSR_SEQUENCE_ID ?? `ssr-sequence-${Date.now()}`;
const percentile = (values, fraction) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * (sorted.length - 1))));
  return sorted[index];
};
const mean = (values) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values) => percentile(values, 0.5);
const windowMedians = (values) => {
  const result = [];
  for (let start = 0; start < values.length; start += 100) {
    const window = values.slice(start, Math.min(start + 100, values.length));
    if (window.length === 100) result.push(median(window));
  }
  return result;
};

const decimalTick = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

function auditIntervals(passes, timestampPeriodNanoseconds) {
  const intervals = [];
  let durationMismatchCount = 0;
  for (const pass of passes) {
    if (pass.status !== 'measured') continue;
    const beginning = decimalTick(pass.beginningTick);
    const end = decimalTick(pass.endTick);
    if (beginning === null || end === null || end < beginning) {
      return { valid: false, reason: `invalid raw tick range for ${pass.passName}` };
    }
    const durationNanoseconds = Number(end - beginning) * timestampPeriodNanoseconds;
    if (Math.abs(durationNanoseconds - pass.durationNanoseconds) > 1e-9) durationMismatchCount += 1;
    intervals.push({
      passName: pass.passName,
      passKind: pass.passKind,
      executionIndex: pass.executionIndex,
      beginning,
      end,
    });
  }
  const passBoundary = intervals.filter((interval) => interval.passKind !== 'copy');
  const copyEnvelope = intervals.filter((interval) => interval.passKind === 'copy');
  return {
    valid: true,
    measuredPassCount: intervals.length,
    durationMismatchCount,
    all: summarizeIntervalSet(intervals),
    passBoundary: summarizeIntervalSet(passBoundary),
    copyEnvelope: summarizeIntervalSet(copyEnvelope),
  };
}

function summarizeRows(rows) {
  const summarize = (key) => {
    const values = rows.map((row) => row[key]);
    const finiteValues = values.filter((value) => Number.isFinite(value));
    return {
      samplesMs: values,
      sampleCount: finiteValues.length,
      p50Ms: percentile(finiteValues, 0.5),
      p95Ms: percentile(finiteValues, 0.95),
      meanMs: mean(finiteValues),
      windowMediansMs: windowMedians(values),
    };
  };
  const passSamples = new Map();
  for (const row of rows) {
    for (const [passName, durationMs] of Object.entries(row.passDurationsMs)) {
      const samples = passSamples.get(passName) ?? [];
      samples.push(durationMs);
      passSamples.set(passName, samples);
    }
  }
  const passStats = Object.fromEntries(
    [...passSamples.entries()].map(([passName, samplesMs]) => [passName, {
      samplesMs,
      sampleCount: samplesMs.length,
      p50Ms: percentile(samplesMs, 0.5),
      p95Ms: percentile(samplesMs, 0.95),
      meanMs: mean(samplesMs),
    }]),
  );
  return {
    frameCount: rows.length,
    frameIds: rows.map((row) => row.frameId),
    cpuSubmission: summarize('cpuFrameMs'),
    completionWait: summarize('completionWaitMs'),
    endToEnd: summarize('endToEndMs'),
    gpuEnvelope: summarize('gpuEnvelopeMs'),
    gpuUnion: summarize('gpuUnionMs'),
    allPassSum: summarize('allPassSumMs'),
    ssrPassSum: summarize('ssrPassSumMs'),
    composeInterval: summarize('composeIntervalMs'),
    nonComposeSsrPassSum: summarize('nonComposeSsrPassSumMs'),
    passStats,
    intervalAudit: {
      invalidFrameCount: rows.filter((row) => row.intervalAudit.valid !== true).length,
      durationMismatchFrameCount: rows.filter((row) => row.intervalAudit.valid === true && row.intervalAudit.durationMismatchCount > 0).length,
      passBoundaryOverlapFrameCount: rows.filter((row) => row.intervalAudit.valid === true && row.intervalAudit.passBoundary.overlapPairCount > 0).length,
      passBoundaryOverlapPairs: rows.reduce((sum, row) => sum + (row.intervalAudit.valid === true ? row.intervalAudit.passBoundary.overlapPairCount : 0), 0),
      allDuplicatedTicks: rows.reduce((sum, row) => sum + BigInt(row.intervalAudit.valid === true ? row.intervalAudit.all.duplicatedTicks : '0'), 0n).toString(),
      passBoundaryDuplicatedTicks: rows.reduce((sum, row) => sum + BigInt(row.intervalAudit.valid === true ? row.intervalAudit.passBoundary.duplicatedTicks : '0'), 0n).toString(),
    },
  };
}

function summarizeFrames(report) {
  const frames = report?.performanceTiming?.timingFrames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return { valid: false, reason: 'timingFrames missing', frames: [] };
  }
  const cpuSamples = report?.performanceTiming?.cpu?.samples;
  const ids = new Set();
  const rows = [];
  for (const [frameIndex, frame] of frames.entries()) {
    if (!Number.isInteger(frame.frameId) || ids.has(frame.frameId)) {
      return { valid: false, reason: 'timing frame ids are missing or duplicated', frames: [] };
    }
    ids.add(frame.frameId);
    if (!Array.isArray(frame.passes)) {
      return { valid: false, reason: `timing frame ${frame.frameId} has no pass list`, frames: [] };
    }
    let allPassSumMs = 0;
    let ssrPassSumMs = 0;
    let composeIntervalMs = 0;
    let nonComposeSsrPassSumMs = 0;
    const passNames = [];
    const passDurationsMs = {};
    for (const pass of frame.passes) {
      passNames.push(pass.passName);
      if (pass.status !== 'measured') continue;
      const durationMs = pass.durationNanoseconds / 1_000_000;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return { valid: false, reason: `invalid duration in frame ${frame.frameId}`, frames: [] };
      }
      passDurationsMs[pass.passName] = durationMs;
      allPassSumMs += durationMs;
      if (!pass.passName.startsWith('ssr-')) continue;
      ssrPassSumMs += durationMs;
      if (pass.passName === 'ssr-compose') composeIntervalMs += durationMs;
      else nonComposeSsrPassSumMs += durationMs;
    }
    const coverage = projectTimingFrame(frame);
    rows.push({
      ordinal: frameIndex + 1,
      frameId: frame.frameId,
      deviceGeneration: frame.deviceGeneration,
      graphGeneration: frame.graphGeneration,
      drawCpuMs: frame.drawCpuMs ?? null,
      coverage,
      gpuEnvelopeMs: coverage.coverage?.all.envelopeNanoseconds / 1e6,
      gpuUnionMs: coverage.coverage?.all.unionNanoseconds / 1e6,
      completionWaitMs: report.performanceTiming.cpu.completionWaitSamples?.[frameIndex] ?? null,
      endToEndMs: report.performanceTiming.cpu.endToEndSamples?.[frameIndex] ?? null,
      allPassSumMs,
      ssrPassSumMs,
      composeIntervalMs,
      nonComposeSsrPassSumMs,
      passNames,
      passDurationsMs,
      cpuFrameMs: Array.isArray(cpuSamples) ? cpuSamples[frameIndex] ?? null : null,
      intervalAudit: auditIntervals(frame.passes, frame.timestampPeriodNanoseconds),
    });
  }
  const summary = summarizeRows(rows);
  return {
    valid: rows.length >= totalFrameCount && rows.every((row) => row.coverage.status === 'complete'),
    reason: rows.length < totalFrameCount ? `timing frame count=${rows.length} < ${totalFrameCount}` : undefined,
    frames: rows,
    ...summary,
  };
}

function projectWindow(timing, window) {
  const rows = timing.frames.slice(window.startOrdinal - 1, window.endOrdinal);
  const expectedFrameCount = window.endOrdinal - window.startOrdinal + 1;
  return {
    label: window.label,
    startOrdinal: window.startOrdinal,
    endOrdinal: window.endOrdinal,
    expectedFrameCount,
    actualFrameCount: rows.length,
    complete: rows.length === expectedFrameCount,
    summary: summarizeRows(rows),
  };
}

mkdirSync(artifactDir, { recursive: true });
const runs = [];
let failed = false;
for (let orderIndex = 0; orderIndex < sequence.length; orderIndex += 1) {
  const item = sequence[orderIndex];
  const runId = `${sequenceId}-${orderIndex}-${item.mode}`;
  const reportPath = resolve(artifactDir, `${String(orderIndex).padStart(2, '0')}-${item.mode}.json`);
  const startedAt = new Date().toISOString();
  const env = {
    ...process.env,
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST === undefined
      ? undefined : resolve(rootDir, process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST),
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    SMOKE_MIN_FRAMES: String(totalFrameCount),
    SMOKE_PERF_TIMING: '1',
    SMOKE_WIDTH: process.env.SMOKE_WIDTH ?? '1920',
    SMOKE_HEIGHT: process.env.SMOKE_HEIGHT ?? '1080',
    SMOKE_WAIT_DRAW_COMPLETION: '1',
    SMOKE_REPORT_FILE: reportPath,
    SMOKE_QUIET: '1',
    SMOKE_RUN_ID: runId,
    SMOKE_RUN_MODE: item.mode,
    SMOKE_RUN_ORDER_INDEX: String(orderIndex),
    VITE_REFLECTION_PROBE_EVIDENCE: '0',
    VITE_SSR_EVIDENCE: '1',
  };
  if (item.disableSsr) env.SMOKE_DISABLE_SSR = '1';
  else delete env.SMOKE_DISABLE_SSR;
  const child = spawnSync(process.execPath, ['scripts/smoke-dawn.mjs'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  const finishedAt = new Date().toISOString();
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = undefined;
  }
  const timing = summarizeFrames(report);
  const windows = timing.frames.length === 0 ? [] : [
    projectWindow(timing, STARTUP_WINDOW),
    projectWindow(timing, DIAGNOSTIC_WINDOW),
  ];
  const run = {
    orderIndex,
    mode: item.mode,
    runId,
    childStatus: child.status,
    childSignal: child.signal,
    startedAt,
    finishedAt,
    reportPath,
    reportRun: report?.run ?? null,
    runner: report === undefined ? null : {
      backend: report.backend ?? null,
      adapter: report.adapter ?? null,
      host: report.host ?? null,
      frames: report.frames ?? 0,
      readbackBytes: report.readbackBytes ?? 0,
      gpuPassTimingEnabled: report.performanceTiming?.gpuPassTimingEnabled ?? null,
    },
    shaderIdentity: report?.shaderIdentity ?? null,
    timing,
    windows,
    errorCodes: report?.errorCodes ?? [],
    uncapturedGpuErrors: report?.uncapturedGpuErrors ?? [],
  };
  runs.push(run);
  if (child.status !== 0 || report === undefined || !timing.valid || windows.some((window) => !window.complete)) failed = true;
  console.log(`[hello-ssr] sequence-run=${JSON.stringify({
    orderIndex,
    mode: item.mode,
    childStatus: child.status,
    frames: timing.frames.length,
    windows: windows.map((window) => ({ label: window.label, frameCount: window.actualFrameCount })),
    allGpuP50Ms: timing.allPassSum?.p50Ms ?? null,
    ssrGpuP50Ms: timing.ssrPassSum?.p50Ms ?? null,
    composeP50Ms: timing.composeInterval?.p50Ms ?? null,
  })}`);
}

const identity = runs.map((run) => run.shaderIdentity);
const sameIdentity = identity.length > 0 && identity.every((value) => JSON.stringify(value) === JSON.stringify(identity[0]));
const adapters = runs.map((run) => run.runner?.adapter ?? null);
const hosts = runs.map((run) => run.runner?.host ?? null);
const sameAdapter = adapters.length > 0 && adapters.every((value) => JSON.stringify(value) === JSON.stringify(adapters[0]));
const sameHost = hosts.length > 0 && hosts.every((value) => JSON.stringify(value) === JSON.stringify(hosts[0]));
if (!sameIdentity || !sameAdapter || !sameHost) failed = true;

const steadyWindows = runs.map((run) => run.windows.find((window) => window.label === DIAGNOSTIC_WINDOW.label)?.summary);
const artifact = {
  schemaVersion: 'hello-ssr-performance-sequence/1',
  featureId: 'feat-20260831-ssr-probe-environment-fallback',
  status: failed ? 'fail' : 'observed',
  sequence: sequence.map((item, orderIndex) => ({ orderIndex, ...item })),
  totalFrameCount,
  windows: [STARTUP_WINDOW, DIAGNOSTIC_WINDOW].map((window) => ({
    ...window,
    frameCount: window.endOrdinal - window.startOrdinal + 1,
  })),
  identity: {
    shader: sameIdentity ? identity[0] : null,
    adapters: sameAdapter ? adapters[0] : adapters,
    hosts: sameHost ? hosts[0] : hosts,
  },
  runs,
  measurement: { status: failed ? 'fail' : 'pass' },
  budget: { status: 'not-evaluated', reason: 'diagnostic sequence; use smoke:performance for the unchanged numeric budgets' },
  abba: failed ? null : {
    gpuEnvelope: abbaIncrement(steadyWindows, 'gpuEnvelope'),
    cpuSubmission: abbaIncrement(steadyWindows, 'cpuSubmission'),
  },
  nativeOuterQuery: { status: 'unavailable', reason: 'RHI supplies pass boundaries only' },
  interpretation: {
    semantics: 'diagnostic-sequence-only',
    order: 'O-S-S-O',
    allRunsRetained: true,
    ordinalBasis: 'successful submitted frame order within each process; frameId is retained as an observed identity and is not assumed to start at one',
    startupWindow: 'observational projection of ordinals 1-60; it does not rerun or replace the existing smoke:performance gate',
    diagnosticWindow: 'observational projection of ordinals 121-180 after the fixed 120-frame startup interval',
    overlappingOrdinals: 'none; startup and post-warmup windows contain disjoint frame ordinals',
    percentileIndependence: 'each run is summarized separately; adjacent frames are not independent experiments',
    thresholdVerdict: 'not-evaluated',
    gpuSemantics: 'sum is repeated coverage; union includes copy marker overhead; envelope includes gaps; none is exclusive cost or FPS',
    attribution: 'ABBA measures the change in full graph pass envelope, not a native outer query',
  },
};
const outputPath = resolve(artifactDir, 'sequence.json');
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[hello-ssr] sequence-file=${outputPath}`);
process.exitCode = failed ? 1 : 0;
