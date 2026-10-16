import { err, ok, type Result } from '@forgeax/engine-types';
import { nearestRankP95 } from './statistics.js';

export const GPU_PASS_TIMING_ADMISSION_SCHEMA_VERSION = '1.0' as const;

export const GPU_PASS_TIMING_ADMISSION_SAMPLING = Object.freeze({
  warmupFrames: 120,
  framesPerWindow: 60,
  quantile: 'nearest-rank-p95' as const,
});

export type GpuPassTimingAdmissionPassName = 'meter' | 'lut';

export interface GpuPassTimingAdmissionSourceIdentity {
  sourceHead: string;
  buildId: string;
}

export interface GpuPassTimingAdmissionRunnerIdentity {
  name: string;
  version: string;
  os: string;
  browser: string;
}

export interface GpuPassTimingAdmissionBackendIdentity {
  kind: string;
  adapter: string;
  driver: string;
  physicalGpu: boolean;
  timestampQuery: boolean;
  timestampPeriodNanoseconds: number;
}

export interface GpuPassTimingAdmissionFixtureIdentity {
  id: string;
  asset: string;
  camera: string;
  light: string;
  input: string;
}

export interface GpuPassTimingAdmissionFrameIdentity {
  generation: string;
  firstFrame: number;
  lastFrame: number;
}

export interface GpuPassTimingAdmissionWindow {
  width: number;
  height: number;
  beginTicks: string[];
  endTicks: string[];
  measurementSource: 'gpu-timestamp';
  captureGeneration: string;
  firstFrame: number;
  lastFrame: number;
  timestampQuantization?: {
    mode: 'equal-ticks-upper-bound';
    equalTickSamples: number;
    quantumNanoseconds: number;
    source: 'renderer-receipt-timestamp';
  };
}

export interface GpuPassTimingAdmissionPass {
  passName: GpuPassTimingAdmissionPassName;
  passIdentity: string;
  windows: GpuPassTimingAdmissionWindow[];
}

export interface GpuPassTimingAdmissionArtifact {
  schemaVersion: typeof GPU_PASS_TIMING_ADMISSION_SCHEMA_VERSION;
  source: GpuPassTimingAdmissionSourceIdentity;
  runner: GpuPassTimingAdmissionRunnerIdentity;
  backend: GpuPassTimingAdmissionBackendIdentity;
  fixture: GpuPassTimingAdmissionFixtureIdentity;
  frame: GpuPassTimingAdmissionFrameIdentity;
  sampling: typeof GPU_PASS_TIMING_ADMISSION_SAMPLING;
  passes: GpuPassTimingAdmissionPass[];
}

export interface GpuPassTimingAdmissionWindowResult extends GpuPassTimingAdmissionWindow {
  durationsNanoseconds: number[];
  p95Nanoseconds: number;
}

export interface GpuPassTimingAdmissionPassResult
  extends Omit<GpuPassTimingAdmissionPass, 'windows'> {
  windows: GpuPassTimingAdmissionWindowResult[];
}

export interface GpuPassTimingAdmissionResult
  extends Omit<GpuPassTimingAdmissionArtifact, 'passes'> {
  passes: GpuPassTimingAdmissionPassResult[];
}

export type GpuPassTimingAdmissionErrorCode =
  | 'admission-schema-invalid'
  | 'admission-identity-invalid'
  | 'admission-capability-invalid'
  | 'admission-sampling-invalid'
  | 'admission-pass-invalid'
  | 'admission-window-invalid'
  | 'admission-samples-reused';

export interface GpuPassTimingAdmissionError {
  code: GpuPassTimingAdmissionErrorCode;
  path: string;
  expected: string;
  hint: string;
}

function failure(
  code: GpuPassTimingAdmissionErrorCode,
  path: string,
  expected: string,
  hint: string,
): Result<never, GpuPassTimingAdmissionError> {
  return err({ code, path, expected, hint });
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function sourceSha(value: string, { allowContentDigest = false } = {}): boolean {
  return allowContentDigest ? /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) : /^[0-9a-f]{40}$/.test(value);
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function tick(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function windowKey(window: GpuPassTimingAdmissionWindow): string {
  return JSON.stringify([window.beginTicks, window.endTicks]);
}

function validateIdentity(
  artifact: GpuPassTimingAdmissionArtifact,
): Result<void, GpuPassTimingAdmissionError> {
  if (!sourceSha(artifact.source.sourceHead)) {
    return failure('admission-identity-invalid', '/source/sourceHead', 'a 40-character source SHA', 'record the exact source HEAD');
  }
  if (!sourceSha(artifact.source.buildId, { allowContentDigest: true })) {
    return failure('admission-identity-invalid', '/source/buildId', 'a 40- or 64-character build identity', 'record the exact build identity without truncating a content digest');
  }
  const requiredStrings: readonly [string, string][] = [
    ['/runner/name', artifact.runner.name],
    ['/runner/version', artifact.runner.version],
    ['/runner/os', artifact.runner.os],
    ['/runner/browser', artifact.runner.browser],
    ['/backend/adapter', artifact.backend.adapter],
    ['/backend/driver', artifact.backend.driver],
    ['/fixture/id', artifact.fixture.id],
    ['/fixture/asset', artifact.fixture.asset],
    ['/fixture/camera', artifact.fixture.camera],
    ['/fixture/light', artifact.fixture.light],
    ['/fixture/input', artifact.fixture.input],
    ['/frame/generation', artifact.frame.generation],
  ];
  for (const [path, value] of requiredStrings) {
    if (!nonEmpty(value)) {
      return failure('admission-identity-invalid', path, 'a non-empty provenance identity', 'record the exact identity instead of a placeholder');
    }
  }
  if (
    !positiveInteger(artifact.frame.firstFrame) ||
    !positiveInteger(artifact.frame.lastFrame) ||
    artifact.frame.lastFrame - artifact.frame.firstFrame + 1 !==
      GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow
  ) {
    return failure('admission-identity-invalid', '/frame', 'a contiguous 60-frame generation window', 'recapture one complete frame-generation window');
  }
  if (
    !Number.isFinite(artifact.backend.timestampPeriodNanoseconds) ||
    artifact.backend.timestampPeriodNanoseconds <= 0
  ) {
    return failure('admission-capability-invalid', '/backend/timestampPeriodNanoseconds', 'a finite positive timestamp period in nanoseconds', 'record the adapter timestamp period');
  }
  return ok(undefined);
}

function validateWindow(
  window: GpuPassTimingAdmissionWindow,
  path: string,
  timestampPeriodNanoseconds: number,
): Result<GpuPassTimingAdmissionWindowResult, GpuPassTimingAdmissionError> {
  if (
    (window.width !== 1920 || window.height !== 1080) &&
    (window.width !== 3840 || window.height !== 2160)
  ) {
    return failure('admission-window-invalid', path, '1920x1080 or 3840x2160', 'capture both required render resolutions');
  }
  if (window.measurementSource !== 'gpu-timestamp') {
    return failure('admission-window-invalid', `${path}/measurementSource`, 'gpu-timestamp raw begin/end samples', 'reject wall-time, FPS, and other non-GPU timing sources');
  }
  if (
    !nonEmpty(window.captureGeneration) ||
    !window.captureGeneration.startsWith('device-')
  ) {
    return failure('admission-identity-invalid', `${path}/captureGeneration`, 'a complete 60-frame capture identity per resolution window', 'bind each raw window to its own frame generation');
  }
  if (!positiveInteger(window.firstFrame) || !positiveInteger(window.lastFrame)) {
    return failure('admission-identity-invalid', `${path}/firstFrame`, 'positive frame bounds for a capture window', 'record the exact first and last frame');
  }
  if (window.lastFrame - window.firstFrame + 1 !== GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow) {
    return failure('admission-identity-invalid', `${path}/firstFrame`, 'a contiguous 60-frame capture identity per resolution window', 'bind each raw window to one complete frame generation');
  }
  if (
    window.beginTicks.length !== GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow ||
    window.endTicks.length !== GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow
  ) {
    return failure('admission-window-invalid', path, '60 raw begin/end timestamp pairs', 'discard incomplete or reused frame windows');
  }
  const durationsNanoseconds: number[] = [];
  let equalTickSamples = 0;
  for (let index = 0; index < window.beginTicks.length; index += 1) {
    const begin = window.beginTicks[index];
    const end = window.endTicks[index];
    if (begin === undefined || end === undefined || !tick(begin) || !tick(end)) {
      return failure('admission-window-invalid', `${path}/beginTicks/${index}`, 'decimal raw GPU timestamp ticks', 'preserve raw GPU timestamp values');
    }
    const duration = Number(BigInt(end) - BigInt(begin));
    if (!Number.isSafeInteger(duration) || duration < 0) {
      return failure('admission-window-invalid', `${path}/${index}`, 'an increasing finite GPU timestamp pair', 'reject invalid timestamp ranges');
    }
    if (duration === 0) {
      equalTickSamples += 1;
      const quantization = window.timestampQuantization;
      if (
        quantization?.mode !== 'equal-ticks-upper-bound' ||
        quantization.source !== 'renderer-receipt-timestamp' ||
        !Number.isSafeInteger(quantization.equalTickSamples) ||
        quantization.equalTickSamples < 1 ||
        !Number.isSafeInteger(quantization.quantumNanoseconds) ||
        quantization.quantumNanoseconds <= 0
      ) {
        return failure('admission-window-invalid', `${path}/${index}`, 'positive timestamp duration or an explicit equal-tick upper bound', 'preserve the renderer timestamp quantization metadata');
      }
    }
    const durationNanoseconds = duration === 0
      ? window.timestampQuantization.quantumNanoseconds
      : duration * timestampPeriodNanoseconds;
    if (!Number.isFinite(durationNanoseconds) || durationNanoseconds <= 0) {
      return failure('admission-window-invalid', `${path}/${index}`, 'a finite positive timestamp duration in nanoseconds', 'reject timestamp periods that overflow the raw tick duration');
    }
    durationsNanoseconds.push(durationNanoseconds);
  }
  if (equalTickSamples > 0 && window.timestampQuantization?.equalTickSamples !== equalTickSamples) {
    return failure('admission-window-invalid', `${path}/timestampQuantization/equalTickSamples`, 'the exact number of equal-tick samples', 'do not alter the raw quantization count');
  }
  const p95Nanoseconds = nearestRankP95(durationsNanoseconds);
  if (p95Nanoseconds === null) {
    return failure('admission-window-invalid', path, 'a non-empty raw timestamp window', 'recapture raw GPU timestamps');
  }
  return ok({ ...window, durationsNanoseconds, p95Nanoseconds });
}

export function validateGpuPassTimingAdmission(
  artifact: GpuPassTimingAdmissionArtifact,
): Result<GpuPassTimingAdmissionResult, GpuPassTimingAdmissionError> {
  if (artifact.schemaVersion !== GPU_PASS_TIMING_ADMISSION_SCHEMA_VERSION) {
    return failure('admission-schema-invalid', '/schemaVersion', GPU_PASS_TIMING_ADMISSION_SCHEMA_VERSION, 'use the supported admission schema');
  }
  const identity = validateIdentity(artifact);
  if (!identity.ok) return identity;
  if (
    artifact.backend.kind !== 'webgpu' ||
    artifact.backend.physicalGpu !== true ||
    artifact.backend.timestampQuery !== true
  ) {
    return failure('admission-capability-invalid', '/backend', 'webgpu with physicalGpu=true and timestampQuery=true', 'run on an eligible physical timestamp-query adapter');
  }
  const softwareIdentity = `${artifact.backend.adapter} ${artifact.backend.driver}`.toLowerCase();
  if (['swiftshader', 'lavapipe', 'llvmpipe', 'rhi-null', 'rhinull', 'paravirtual'].some((token) => softwareIdentity.includes(token))) {
    return failure('admission-capability-invalid', '/backend', 'a physical hardware adapter, not a software rasterizer', 'reject SwiftShader, lavapipe, llvmpipe, and RhiNull even when physicalGpu is misreported');
  }
  if (
    artifact.sampling.warmupFrames !== GPU_PASS_TIMING_ADMISSION_SAMPLING.warmupFrames ||
    artifact.sampling.framesPerWindow !== GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow ||
    artifact.sampling.quantile !== GPU_PASS_TIMING_ADMISSION_SAMPLING.quantile
  ) {
    return failure('admission-sampling-invalid', '/sampling', '120 warmup frames, 60-frame windows, nearest-rank-p95', 'rerun with the fixed sampling contract');
  }
  const requiredPasses = ['meter', 'lut'] as const;
  if (
    artifact.passes.length !== requiredPasses.length ||
    new Set(artifact.passes.map((pass) => pass.passName)).size !== requiredPasses.length ||
    requiredPasses.some((name) => !artifact.passes.some((pass) => pass.passName === name))
  ) {
    return failure('admission-pass-invalid', '/passes', 'exactly one fused meter and one independent LUT pass', 'record every required renderer-owned pass');
  }
  const seenWindows = new Set<string>();
  const captureByResolution = new Map<string, string>();
  const passes: GpuPassTimingAdmissionPassResult[] = [];
  for (const [passIndex, pass] of artifact.passes.entries()) {
    if (
      !nonEmpty(pass.passIdentity) ||
      pass.passIdentity.includes('taa') ||
      pass.passIdentity.includes('motion') ||
      pass.passIdentity.includes('wall') ||
      pass.passIdentity.includes('fps') ||
      pass.passIdentity !== `standard-output/${pass.passName}`
    ) {
      return failure('admission-pass-invalid', `/passes/${passIndex}/passIdentity`, 'the renderer-owned standard-output pass identity', 'do not substitute TAA, wall-time, FPS, or helper timing');
    }
    if (pass.windows.length !== 2) {
      return failure('admission-window-invalid', `/passes/${passIndex}/windows`, 'one 1080p and one 4K raw timestamp window', 'capture both required resolutions');
    }
    const windows: GpuPassTimingAdmissionWindowResult[] = [];
    for (const [windowIndex, window] of pass.windows.entries()) {
      const key = windowKey(window);
      if (seenWindows.has(key)) {
        return failure('admission-samples-reused', `/passes/${passIndex}/windows/${windowIndex}`, 'a unique raw GPU timestamp sample set', 'recapture each pass instead of reusing another pass sample');
      }
      seenWindows.add(key);
      const validated = validateWindow(
        window,
        `/passes/${passIndex}/windows/${windowIndex}`,
        artifact.backend.timestampPeriodNanoseconds,
      );
      if (!validated.ok) return validated;
      if (window.captureGeneration !== artifact.frame.generation) {
        return failure('admission-identity-invalid', `/passes/${passIndex}/windows/${windowIndex}/captureGeneration`, 'the top-level artifact frame generation', 'bind every resolution window to the same artifact frame owner');
      }
      if (
        window.firstFrame !== artifact.frame.firstFrame ||
        window.lastFrame !== artifact.frame.lastFrame
      ) {
        return failure('admission-identity-invalid', `/passes/${passIndex}/windows/${windowIndex}/firstFrame`, 'the top-level artifact frame bounds', 'bind every resolution window to the same artifact frame owner');
      }
      const resolution = `${window.width}x${window.height}`;
      const existingCapture = captureByResolution.get(resolution);
      if (existingCapture !== undefined && existingCapture !== window.captureGeneration) {
        return failure('admission-identity-invalid', `/passes/${passIndex}/windows/${windowIndex}/captureGeneration`, 'one shared capture frame identity for both passes at each resolution', 'join only windows captured in the same frame generation');
      }
      captureByResolution.set(resolution, window.captureGeneration);
      windows.push(validated.value);
    }
    const resolutions = new Set(windows.map((window) => `${window.width}x${window.height}`));
    if (!resolutions.has('1920x1080') || !resolutions.has('3840x2160')) {
      return failure('admission-window-invalid', `/passes/${passIndex}/windows`, 'both 1920x1080 and 3840x2160', 'capture the missing required resolution');
    }
    passes.push({ ...pass, windows });
  }
  return ok({ ...artifact, passes });
}
