#!/usr/bin/env node

/**
 * Real Browser/Dawn adapter for the auto-exposure timing host.
 *
 * This file owns process orchestration only. The Renderer remains the timing
 * producer: each smoke child opts into gpuPassTiming, submits real receipts,
 * and serializes the receipt-bound `observe(..., { include: ['timings'] })`
 * frame facts. The host's collectRendererPassTiming callback consumes those
 * facts and keeps all capability, frame-window, pass, and budget checks in one
 * place. A missing physical/timestamp capability is returned as BLOCKED.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FRAME_COUNT = 180;
const WORKLOADS = Object.freeze(['auto', 'positive-lut']);
const RESOLUTIONS = Object.freeze([
  Object.freeze({ id: '1080p', width: 1920, height: 1080 }),
  Object.freeze({ id: '4K', width: 3840, height: 2160 }),
]);
const REQUIRED_PASSES = Object.freeze({
  meter: Object.freeze(['meter', 'standard-output/meter', 'auto-exposure-meter']),
  lut: Object.freeze(['lut', 'standard-output/lut', 'standard-color-lut']),
});
const WORKLOAD_PASS_NAMES = Object.freeze({
  auto: Object.freeze(['meter']),
  'positive-lut': Object.freeze(['lut']),
});

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function childCommand(backend) {
  if (backend === 'browser') return ['smoke:browser'];
  if (backend === 'dawn') return ['smoke'];
  throw new Error(`FORGEAX_AUTO_EXPOSURE_TIMING_BACKEND must be browser or dawn, got ${backend}`);
}

function childTimingReport(backend, workload, resolution) {
  const scratch = mkdtempSync(resolve(tmpdir(), 'forgeax-auto-exposure-timing-'));
  const output = resolve(scratch, 'timing.json');
  const env = {
    ...process.env,
    SMOKE_TIMING_MODE: workload === 'manual' ? 'manual' : '1',
    SMOKE_TIMING_WORKLOAD: workload,
    SMOKE_WORKLOAD: workload,
    SMOKE_TIMING_RESOLUTION: resolution.id,
    SMOKE_TIMING_WIDTH: String(resolution.width),
    SMOKE_TIMING_HEIGHT: String(resolution.height),
    SMOKE_TIMING_DEVICE_SCALE_FACTOR: '1',
    SMOKE_TIMING_OUTPUT: output,
    SMOKE_CASE: 'static',
    SMOKE_BROWSER_WAIT_MS: '180000',
  };
  const [script] = childCommand(backend);
  const result = spawnSync(
    'pnpm',
    ['--filter', '@forgeax/hello-taa', script],
    {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const report = readJson(output);
  return {
    report,
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output,
  };
}

function contextFromReport(run) {
  const report = run?.report;
  if (report === undefined) return undefined;
  const rawFixture = report.fixture;
  const fixture = rawFixture && typeof rawFixture.id === 'string'
    ? rawFixture
    : {
        id: 'auto-exposure-scene-identity-v1',
        asset: rawFixture?.asset?.id ?? '',
        camera: rawFixture?.camera?.id ?? '',
        light: rawFixture?.light?.id ?? '',
        input: rawFixture?.input?.id ?? '',
      };
  return {
    testedRevision: report.testedRevision,
    source: report.source,
    build: report.build,
    runner: report.runner,
    fixture,
    backend: report.backend,
  };
}

/** A ready JSON file is not enough: the child must have exited successfully. */
export function childRunReady(run) {
  return run?.exitCode === 0 && run?.report?.status === 'ready';
}

function blockedFromRun(run, fallback) {
  const context = contextFromReport(run) ?? {};
  return {
    ...context,
    backend: {
      ...(context.backend ?? { kind: 'unknown', physicalGpu: false, timestampQuery: false, timestampPeriodNanoseconds: null }),
      driver: context.backend?.driver || 'renderer-backend',
      browser: context.backend?.browser || 'dawn-node',
    },
    workloads: {},
    manual: null,
    adapterError: run?.report?.error ?? fallback,
    adapterDiagnostics: {
      backend: run?.report?.workload ?? null,
      childExitCode: run?.exitCode ?? null,
      childOutput: run?.stderr?.trim() || run?.stdout?.trim() || null,
    },
  };
}

function sameCaptureContext(left, right) {
  return (
    left?.testedRevision === right?.testedRevision &&
    JSON.stringify(left?.source) === JSON.stringify(right?.source) &&
    JSON.stringify(left?.build) === JSON.stringify(right?.build) &&
    JSON.stringify(left?.backend) === JSON.stringify(right?.backend) &&
    JSON.stringify(left?.fixture) === JSON.stringify(right?.fixture)
  );
}

function timingFrames(run) {
  const frames = run?.report?.frames;
  return Array.isArray(frames) ? frames : [];
}

function measuredPass(frame, aliases) {
  const passes = Array.isArray(frame?.passes) ? frame.passes : [];
  return passes.find(
    (pass) => aliases.includes(pass?.passName) && pass?.status === 'measured',
  );
}

function captureGeneration(frame) {
  if (!Number.isSafeInteger(frame?.deviceGeneration) || !Number.isSafeInteger(frame?.graphGeneration)) return undefined;
  return `device-${frame.deviceGeneration}:graph-${frame.graphGeneration}`;
}

function frameWindow(frames) {
  const sampled = frames.slice(FRAME_COUNT - 60);
  const first = sampled[0];
  const last = sampled.at(-1);
  const generation = captureGeneration(first);
  if (
    generation === undefined ||
    !Number.isSafeInteger(first?.frameId) ||
    !Number.isSafeInteger(last?.frameId)
  ) return undefined;
  return {
    generation,
    firstFrame: first.frameId,
    lastFrame: last.frameId,
    frames: sampled,
  };
}

export function workloadPassNames(kind) {
  const names = WORKLOAD_PASS_NAMES[kind];
  if (names === undefined) throw new Error(`unsupported timing workload: ${kind}`);
  return [...names];
}

function workloadFromRun(kind, resolution, run) {
  const frames = timingFrames(run);
  const window = frameWindow(frames);
  const passNames = workloadPassNames(kind);
  return {
    frame: window === undefined ? null : {
      generation: window.generation,
      firstFrame: window.firstFrame,
      lastFrame: window.lastFrame,
    },
    passes: passNames.map((name) => {
      const passFrames = window?.frames ?? [];
      const aliases = REQUIRED_PASSES[name];
      const samples = passFrames.map((frame) => measuredPass(frame, aliases));
      return {
        passName: name,
        passIdentity: `standard-output/${name}`,
        windows: [{
          width: resolution.width,
          height: resolution.height,
          measurementSource: 'gpu-timestamp',
          captureGeneration: window?.generation,
          firstFrame: window?.firstFrame,
          lastFrame: window?.lastFrame,
          beginTicks: samples.map((pass) => pass?.beginningTick),
          endTicks: samples.map((pass) => pass?.endTick),
        }],
      };
    }),
  };
}

/**
 * Pure adapter projection used by the process runner and its contract test.
 * It intentionally returns the exact frame array; no durations, wall-clock
 * values, pass names, or capability facts are invented here.
 */
export function createRendererObservationQueue(run) {
  return timingFrames(run).slice(0, FRAME_COUNT);
}

export async function collectAutoExposureTiming() {
  const backendName = process.env.FORGEAX_AUTO_EXPOSURE_TIMING_BACKEND ?? 'browser';
  const first = childTimingReport(backendName, 'auto', RESOLUTIONS[0]);
  const firstContext = contextFromReport(first);
  if (firstContext === undefined) {
    return blockedFromRun(first, `the ${backendName} timing adapter did not publish a renderer report`);
  }
  if (!childRunReady(first)) {
    return blockedFromRun(first, first.report?.error ?? `${backendName} timing adapter is blocked`);
  }

  const runs = new Map();
  runs.set('auto/1080p', first);
  for (const workload of WORKLOADS) {
    for (const resolution of RESOLUTIONS) {
      const key = `${workload}/${resolution.id}`;
      if (runs.has(key)) continue;
      const run = childTimingReport(backendName, workload, resolution);
      const context = contextFromReport(run);
      if (context === undefined || !childRunReady(run)) {
        return blockedFromRun(run, run.report?.error ?? `renderer timing capture blocked for ${key}`);
      }
      if (!sameCaptureContext(firstContext, context)) {
        return blockedFromRun(run, `renderer timing context changed between ${key} and auto/1080p`);
      }
      runs.set(key, run);
    }
  }

  const manual = childTimingReport(backendName, 'manual', RESOLUTIONS[0]);
  const manualReceipt = manual.report?.manual;
  if (
    !childRunReady(manual) ||
    manualReceipt?.executed !== true ||
    manualReceipt.zeroCost !== true ||
    manualReceipt.timestampSlots !== 0 ||
    !Number.isSafeInteger(manualReceipt.receipt?.frameId)
  ) {
    return blockedFromRun(manual, 'manual/LUT0 zero-cost receipt was not observed from the renderer');
  }

  return {
    ...firstContext,
    manual: manualReceipt,
    workloads: Object.fromEntries(
      WORKLOADS.map((workload) => [
        workload,
        {
          ...workloadFromRun(workload, RESOLUTIONS[0], runs.get(`${workload}/1080p`)),
          passes: workloadFromRun(workload, RESOLUTIONS[0], runs.get(`${workload}/1080p`)).passes.map((pass, index) => ({
            ...pass,
            windows: RESOLUTIONS.map((resolution) => workloadFromRun(workload, resolution, runs.get(`${workload}/${resolution.id}`)).passes[index].windows[0]),
          })),
        },
      ]),
    ),
  };
}

export default collectAutoExposureTiming;
