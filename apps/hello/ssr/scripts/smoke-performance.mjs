#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { abbaIncrement, summarizePerformanceWindow } from './smoke-performance-sequence-aggregation.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(appDir, '../../..');
const WIDTH = 1920;
const HEIGHT = 1080;
const MIN_FRAMES = 180;
const WARMUP_FRAMES = 120;
const SAMPLED_FRAMES = 60;
const FEATURE_ID = 'feat-20260831-ssr-probe-environment-fallback';
const BUDGET_BYTES = 45_088_768;
const CPU_INCREMENT_BUDGET_MS = 0.25;
const artifactDir = resolve(rootDir, process.env.SSR_PERF_ARTIFACT_DIR ?? 'artifacts/maturity/performance-evidence/ssr-budget');

function deriveIndependentDescriptor(width, height) {
  // Keep this arithmetic independent from Render's implementation while
  // following the same admitted descriptor: all spatial intermediates use
  // the half-resolution extent, and each reflection mip is floor-halved.
  const halfWidth = Math.max(1, Math.floor(width / 2));
  const halfHeight = Math.max(1, Math.floor(height / 2));
  let mipWidth = halfWidth;
  let mipHeight = halfHeight;
  let mipLevels = 0;
  let depthPyramidBytes = 0;
  let resolvedBytes = 0;
  const levels = [];
  while (true) {
    levels.push({ level: mipLevels, width: mipWidth, height: mipHeight });
    depthPyramidBytes += mipWidth * mipHeight * 4;
    resolvedBytes += mipWidth * mipHeight * 8;
    mipLevels += 1;
    if (mipWidth === 1 && mipHeight === 1) break;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
  const traceBytes = halfWidth * halfHeight * 8;
  const hitReactivityBytes = halfWidth * halfHeight * 4;
  // Two history slots each carry rgba16f radiance + rgba8 surface metadata.
  const historyBytes = halfWidth * halfHeight * 12 * 2;
  const temporalParamsBytes = 32;
  const fallbackInputBytes = width * height * 8;
  const ssrOwnedBytes =
    depthPyramidBytes +
    traceBytes +
    hitReactivityBytes +
    resolvedBytes +
    historyBytes +
    temporalParamsBytes +
    fallbackInputBytes;
  return {
    width,
    height,
    halfWidth,
    halfHeight,
    mipLevels: levels,
    depthPyramidBytes,
    traceBytes,
    hitReactivityBytes,
    resolvedBytes,
    historyBytes,
    temporalParamsBytes,
    fallbackInputBytes,
    ssrOwnedBytes,
    budgetBytes: BUDGET_BYTES,
    withinBudget: ssrOwnedBytes <= BUDGET_BYTES,
  };
}

const descriptorProjection = (descriptor) => ({
  width: descriptor.width,
  height: descriptor.height,
  halfWidth: descriptor.halfWidth,
  halfHeight: descriptor.halfHeight,
  depthPyramidBytes: descriptor.depthPyramidBytes,
  traceBytes: descriptor.traceBytes,
  hitReactivityBytes: descriptor.hitReactivityBytes,
  resolvedBytes: descriptor.resolvedBytes,
  historyBytes: descriptor.historyBytes,
  temporalParamsBytes: descriptor.temporalParamsBytes,
  fallbackInputBytes: descriptor.fallbackInputBytes,
  ssrOwnedBytes: descriptor.ssrOwnedBytes,
  budgetBytes: descriptor.budgetBytes,
  withinBudget: descriptor.withinBudget,
});

const independentDescriptor = deriveIndependentDescriptor(WIDTH, HEIGHT);
const render = await import('@forgeax/engine-render/internal');
const ownerDescriptor = render.estimateSsrSpatialMemory({ width: WIDTH, height: HEIGHT }, { temporal: true });
const descriptorMatchesOwner =
  JSON.stringify(descriptorProjection(ownerDescriptor)) ===
  JSON.stringify(descriptorProjection(independentDescriptor));

const identity = {
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  lockSha256: createHash('sha256').update(readFileSync(resolve(rootDir, 'pnpm-lock.yaml'))).digest('hex'),
  buildSha256: createHash('sha256').update(readFileSync(resolve(rootDir, 'packages/render/dist/index.mjs'))).digest('hex'),
};
const sourceClean = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: rootDir, encoding: 'utf8' }).trim() === '';

const runs = [];
mkdirSync(artifactDir, { recursive: true });
for (const [orderIndex, disableSsr] of [true, false, false, true].entries()) {
  const reportPath = resolve(artifactDir, `${orderIndex}-${disableSsr ? 'off' : 'on'}.json`);
  const env = {
    ...process.env,
    FORGEAX_SHARED_APP_INPUTS_MANIFEST: process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST === undefined
      ? undefined : resolve(rootDir, process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST), FORGEAX_SKIP_HARNESS_SYNC: '1', SMOKE_MIN_FRAMES: String(MIN_FRAMES),
    SMOKE_PERF_TIMING: '1', SMOKE_WAIT_DRAW_COMPLETION: '1',
    SMOKE_WIDTH: String(WIDTH), SMOKE_HEIGHT: String(HEIGHT), SMOKE_QUIET: '1',
    SMOKE_REPORT_FILE: reportPath, VITE_REFLECTION_PROBE_EVIDENCE: '0', VITE_SSR_EVIDENCE: '1',
    SMOKE_RUN_ORDER_INDEX: String(orderIndex), SMOKE_RUN_MODE: disableSsr ? 'ssr-off' : 'ssr-on',
  };
  if (disableSsr) env.SMOKE_DISABLE_SSR = '1';
  else delete env.SMOKE_DISABLE_SSR;
  const child = spawnSync(process.execPath, ['scripts/smoke-dawn.mjs'], {
    cwd: appDir, encoding: 'utf8', timeout: Number(process.env.SSR_PERF_TIMEOUT_MS ?? 900_000),
    maxBuffer: 32 * 1024 * 1024, env,
  });
  writeFileSync(resolve(artifactDir, `${orderIndex}.log`), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* preserved child log owns failure */ }
  runs.push({ orderIndex, disableSsr, childStatus: child.status, childSignal: child.signal,
    childError: child.error?.message ?? null, reportPath, report,
    window: summarizePerformanceWindow(report, WARMUP_FRAMES, SAMPLED_FRAMES) });
  console.log(`[hello-ssr] ABBA ${orderIndex}: exit=${child.status}, envelope p50=${runs.at(-1).window.gpuEnvelope.p50Ms}`);
}
const measurementErrors = [];
for (const run of runs) {
  if (run.childStatus !== 0 || !run.window.complete) measurementErrors.push(`incomplete run ${run.orderIndex}`);
  if (run.report?.ssr?.status !== (run.disableSsr ? 'not-requested' : 'admitted')) measurementErrors.push(`feature state ${run.orderIndex}`);
  if (run.report?.frames !== MIN_FRAMES) measurementErrors.push(`frame count ${run.orderIndex}`);
}
for (const field of ['adapter', 'host', 'shaderIdentity', 'backend', 'antialias', 'sceneFixture']) {
  const values = runs.map((run) => run.report?.[field]);
  if (!values[0] || !values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))) measurementErrors.push(`mismatched ${field}`);
}
for (const run of runs) {
  if (JSON.stringify(run.report?.ssrDependencies?.identity) !== JSON.stringify(identity)) measurementErrors.push(`source/build identity ${run.orderIndex}`);
}
if (!sourceClean || execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: rootDir, encoding: 'utf8' }).trim() !== '' ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim() !== identity.sourceHead) measurementErrors.push('tracked source changed during measurement');
if (!descriptorMatchesOwner) measurementErrors.push('owner/independent descriptor mismatch');
const measurementComplete = measurementErrors.length === 0;
const adapter = runs[0]?.report?.adapter;
const physicalGpu = adapter?.isFallbackAdapter === false && typeof adapter?.device === 'string' &&
  adapter.device.length > 0 && !/software|swiftshader|llvmpipe|lavapipe|basic renderer/i.test(JSON.stringify(adapter));
const windows = runs.map((run) => run.window);
const gpu = measurementComplete ? abbaIncrement(windows, 'gpuEnvelope') : null;
const cpu = measurementComplete ? abbaIncrement(windows, 'cpuSubmission') : null;
const thresholds = { gpuIncrementMs: { p50: 3, p95: 5 }, cpuSubmissionIncrementMs: { p50: CPU_INCREMENT_BUDGET_MS }, ssrDescriptorBytes: BUDGET_BYTES };
const budgetFailures = [];
if (gpu !== null && (gpu.p50Ms > thresholds.gpuIncrementMs.p50 || gpu.p95Ms > thresholds.gpuIncrementMs.p95)) budgetFailures.push('GPU increment');
if (cpu !== null && cpu.p50Ms > thresholds.cpuSubmissionIncrementMs.p50) budgetFailures.push('CPU submission increment');
if (!ownerDescriptor.withinBudget || !independentDescriptor.withinBudget) budgetFailures.push('active logical SSR descriptor bytes');
const budgetStatus = !measurementComplete || !physicalGpu ? 'not-evaluated' : budgetFailures.length ? 'fail' : 'pass';
const artifact = {
  schemaVersion: 'hello-ssr-performance/2', featureId: FEATURE_ID,
  status: measurementComplete && budgetStatus === 'pass' ? 'pass' : budgetStatus === 'not-evaluated' ? 'blocked' : 'fail',
  measurement: { status: measurementComplete ? 'pass' : 'fail', errors: measurementErrors },
  budget: { status: budgetStatus, physicalGpu, thresholds, failures: budgetFailures,
    gpuIncrement: gpu, cpuSubmissionIncrement: cpu,
    semantics: 'ABBA whole-graph pass envelope increment; p95 is the shift of per-run p95, paired ordinal deltas are diagnostic only',
    numericThresholdSource: 'unchanged previous SSR 1080p gate: GPU 3/5 ms, CPU 0.25 ms, descriptor 45088768 bytes',
    limitation: 'descriptor budget is active logical payload only; native lifecycle peak is reported separately and has no invented budget' },
  identity,
  protocol: { order: 'ABBA', warmupFrames: WARMUP_FRAMES, sampledFramesPerRun: SAMPLED_FRAMES,
    percentile: 'sorted zero-based ceil(p*(n-1))', resolution: { width: WIDTH, height: HEIGHT },
    nativeOuterQuery: { status: 'unavailable', reason: 'portable RHI has pass-boundary queries only' },
    gpuPassSum: 'diagnostic repeated coverage; never frame latency, exclusive feature cost, or FPS' },
  descriptor: { owner: ownerDescriptor, independent: independentDescriptor, matchesOwner: descriptorMatchesOwner },
  runs: runs.map(({ report, ...run }) => ({ ...run, adapter: report?.adapter, host: report?.host, shaderIdentity: report?.shaderIdentity })),
};
const output = resolve(artifactDir, 'performance.json');
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[hello-ssr] measurement=${artifact.measurement.status} budget=${budgetStatus} artifact=${output}`);
process.exitCode = artifact.status === 'pass' ? 0 : artifact.status === 'blocked' ? 2 : 1;
