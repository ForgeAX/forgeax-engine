#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(appDir, '../../..');
const artifactDir = resolve(
  rootDir,
  process.env.SSR_CPU_OVERHEAD_ARTIFACT_DIR ?? 'artifacts/ssr-fallback',
);
const frameCount = Number.parseInt(process.env.SSR_CPU_OVERHEAD_FRAMES ?? '60', 10);
const timeoutMs = Number.parseInt(process.env.SSR_PERF_TIMEOUT_MS ?? '900000', 10);
if (!Number.isInteger(frameCount) || frameCount < 24) throw new Error('SSR_CPU_OVERHEAD_FRAMES must be an integer >= 24');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('SSR_PERF_TIMEOUT_MS must be a positive integer');

const cases = [
  { key: 'ssr-off-no-timestamp', mode: 'ssr-off', disableSsr: true, gpuPassTiming: false },
  { key: 'ssr-off-timestamp', mode: 'ssr-off', disableSsr: true, gpuPassTiming: true },
  { key: 'ssr-on-no-timestamp', mode: 'ssr-on', disableSsr: false, gpuPassTiming: false },
  { key: 'ssr-on-timestamp', mode: 'ssr-on', disableSsr: false, gpuPassTiming: true },
];

const percentile = (values, fraction) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * (sorted.length - 1))));
  return sorted[index];
};
const mean = (values) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const summarize = (samples) => ({
  samples,
  sampleCount: samples.filter((value) => Number.isFinite(value)).length,
  p50Ms: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  meanMs: mean(samples.filter((value) => Number.isFinite(value))),
});

const readReport = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

mkdirSync(artifactDir, { recursive: true });
const runs = [];
let failed = false;
for (let orderIndex = 0; orderIndex < cases.length; orderIndex += 1) {
  const item = cases[orderIndex];
  const reportPath = resolve(artifactDir, `performance-cpu-overhead-${item.key}.json`);
  const env = {
    ...process.env,
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    SMOKE_MIN_FRAMES: String(frameCount),
    SMOKE_PERF_TIMING: '1',
    SMOKE_GPU_PASS_TIMING: item.gpuPassTiming ? '1' : '0',
    SMOKE_WAIT_DRAW_COMPLETION: '1',
    SMOKE_WIDTH: '1920',
    SMOKE_HEIGHT: '1080',
    SMOKE_REPORT_FILE: reportPath,
    SMOKE_QUIET: '1',
    SMOKE_RUN_ID: `ssr-cpu-overhead-${Date.now()}-${item.key}`,
    SMOKE_RUN_MODE: item.key,
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
  const report = readReport(reportPath);
  const performance = report?.performanceTiming;
  const callbackSamples = performance?.cpu?.samples ?? [];
  const drawSamples = performance?.cpu?.drawSamples ?? [];
  const drawAttemptSamples = performance?.cpu?.drawAttemptSamples ?? [];
  const residualSamples = Array.from({ length: Math.min(callbackSamples.length, drawSamples.length) }, (_, index) =>
    callbackSamples[index] - drawSamples[index],
  );
  const run = {
    ...item,
    orderIndex,
    childStatus: child.status,
    childSignal: child.signal,
    reportPath,
    reportRun: report?.run ?? null,
    frames: report?.frames ?? 0,
    adapter: report?.adapter ?? null,
    host: report?.host ?? null,
    shaderIdentity: report?.shaderIdentity ?? null,
    performanceTiming: performance === undefined ? null : {
      gpuPassTimingEnabled: performance.gpuPassTimingEnabled ?? null,
      waitDrawCompletion: performance.waitDrawCompletion ?? null,
      drawAttemptCount: performance.cpu?.drawAttemptCount ?? null,
      drawSuccessfulCount: performance.cpu?.drawSuccessfulCount ?? null,
      callback: summarize(callbackSamples),
      draw: summarize(drawSamples),
      drawAttempts: summarize(drawAttemptSamples),
      callbackMinusDraw: summarize(residualSamples),
      gpu: performance.gpu ?? null,
    },
    errorCodes: report?.errorCodes ?? [],
  };
  runs.push(run);
  if (child.status !== 0 || report === undefined || report.frames !== frameCount
    || run.adapter === null || run.host === null
    || ['traceShaderSha256', 'composeShaderSha256', 'shaderManifestSha256'].some((key) =>
      typeof run.shaderIdentity?.[key] !== 'string' || !/^[a-f0-9]{64}$/.test(run.shaderIdentity[key]))
    || performance?.gpuPassTimingEnabled !== item.gpuPassTiming
    || performance?.waitDrawCompletion !== true
    || performance?.cpu?.drawAttemptCount !== frameCount
    || performance?.cpu?.drawSuccessfulCount !== frameCount
    || callbackSamples.length !== frameCount
    || drawSamples.length !== frameCount
    || drawAttemptSamples.length !== frameCount) {
    failed = true;
  }
  console.log(`[hello-ssr] cpu-overhead-run=${JSON.stringify({
    orderIndex,
    key: item.key,
    childStatus: child.status,
    frames: report?.frames ?? 0,
    callbackP50Ms: run.performanceTiming?.callback.p50Ms ?? null,
    drawP50Ms: run.performanceTiming?.draw.p50Ms ?? null,
    drawAttemptP50Ms: run.performanceTiming?.drawAttempts.p50Ms ?? null,
    gpuPassTimingEnabled: run.performanceTiming?.gpuPassTimingEnabled ?? null,
  })}`);
}

const byKey = new Map(runs.map((run) => [run.key, run]));
const identities = runs.map((run) => JSON.stringify({ adapter: run.adapter, host: run.host, shader: run.shaderIdentity }));
const sameIdentity = identities.length > 0 && identities.every((value) => value === identities[0]);
if (!sameIdentity) failed = true;

const pair = (mode, noTimestampKey, timestampKey) => {
  const noTimestamp = byKey.get(noTimestampKey);
  const timestamp = byKey.get(timestampKey);
  const noCallback = noTimestamp?.performanceTiming?.callback.samples ?? [];
  const timestampCallback = timestamp?.performanceTiming?.callback.samples ?? [];
  const noDraw = noTimestamp?.performanceTiming?.draw.samples ?? [];
  const timestampDraw = timestamp?.performanceTiming?.draw.samples ?? [];
  const callbackDelta = Array.from({ length: Math.min(noCallback.length, timestampCallback.length) }, (_, index) =>
    timestampCallback[index] - noCallback[index],
  );
  const drawDelta = Array.from({ length: Math.min(noDraw.length, timestampDraw.length) }, (_, index) =>
    timestampDraw[index] - noDraw[index],
  );
  return {
    mode,
    noTimestampKey,
    timestampKey,
    callbackDelta: summarize(callbackDelta),
    drawDelta: summarize(drawDelta),
    sampleCount: Math.min(callbackDelta.length, drawDelta.length),
  };
};
const comparisons = [
  pair('ssr-off', 'ssr-off-no-timestamp', 'ssr-off-timestamp'),
  pair('ssr-on', 'ssr-on-no-timestamp', 'ssr-on-timestamp'),
];

const artifact = {
  schemaVersion: 'hello-ssr-performance-cpu-overhead/1',
  featureId: 'feat-20260831-ssr-probe-environment-fallback',
  status: failed ? 'fail' : 'observed',
  frameCount,
  resolution: { width: 1920, height: 1080 },
  identity: sameIdentity ? JSON.parse(identities[0]) : null,
  runs,
  comparisons,
  interpretation: {
    semantics: 'diagnostic-only',
    callback: 'item.callback(now) wall time, including App/World work and synchronous renderer.draw',
    draw: 'synchronous renderer.draw wall time associated with the returned frame receipt',
    instrumentationDelta: 'timestamp-query instrumentation-enabled draw/callback samples minus disabled samples at matching ordinal',
    thresholdVerdict: 'not-evaluated',
  },
};
const outputPath = resolve(artifactDir, 'performance-cpu-overhead.json');
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[hello-ssr] cpu-overhead-file=${outputPath}`);
process.exitCode = failed ? 1 : 0;
