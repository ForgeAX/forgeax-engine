#!/usr/bin/env node

/**
 * Feature timing host for hello-taa.
 *
 * This module is deliberately a consumer of the renderer-owned receipt timing
 * primitive. It does not create a query set, add timestamp markers, or infer
 * GPU time from wall clocks. A Browser or Dawn adapter supplies `runFrame` and
 * the renderer observation is projected into this raw, observation-only
 * report. CI admission remains owned by the renderer timing admission and the
 * feature evidence join.
 */

import { access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HOST_DIR, '..', '..', '..', '..');

export const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
export const TIMING_SCHEMA_VERSION = 'forgeax-auto-exposure-gpu-pass-timing/1';
export const TIMING_SOURCE = 'renderer-gpu-pass-timing';
export const TIMING_SAMPLING = Object.freeze({
  warmupFrames: 120,
  framesPerWindow: 60,
  quantile: 'nearest-rank-p95',
});
export const REQUIRED_TIMING_PASSES = Object.freeze(['meter', 'lut']);
export const REQUIRED_LOGICAL_STAGES = Object.freeze(['clear', 'histogram', 'adapt']);
export const REQUIRED_RESOLUTIONS = Object.freeze([
  Object.freeze({ width: 1920, height: 1080, id: '1080p', limitMs: 0.35 }),
  Object.freeze({ width: 3840, height: 2160, id: '4K', limitMs: 0.8 }),
]);
export const REQUIRED_WORKLOADS = Object.freeze(['auto', 'positive-lut']);

const SOFTWARE_PROVENANCE_PATTERN =
  /swiftshader|lavapipe|llvmpipe|rhi[-_ ]?null|rhinull|software|fallback|paravirtual/i;
const DECIMAL_TICK = /^(0|[1-9][0-9]*)$/;
const FRAME_COUNT = TIMING_SAMPLING.framesPerWindow;
const PASS_ALIASES = Object.freeze({
  meter: Object.freeze(['meter', 'standard-output/meter', 'auto-exposure-meter']),
  lut: Object.freeze(['lut', 'standard-output/lut', 'standard-color-lut']),
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value) => Number.isSafeInteger(value);
const positiveInteger = (value) => integer(value) && value > 0;
const finitePositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const clone = (value) => (value === undefined ? null : structuredClone(value));

function checkoutRevision() {
  const configured = process.env.FORGEAX_AUTO_EXPOSURE_TIMING_REVISION;
  if (typeof configured === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(configured)) {
    return configured;
  }
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

function issue(code, path, detail, hint = 'recapture the renderer-owned raw timestamp window') {
  return { code, path, detail, hint };
}

/** Return the exact nearest-rank P95 without filtering invalid samples away. */
export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!values.every((value) => finitePositive(value))) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function resolutionFor(value) {
  if (!isRecord(value) || !integer(value.width) || !integer(value.height)) return undefined;
  return REQUIRED_RESOLUTIONS.find(
    (resolution) => resolution.width === value.width && resolution.height === value.height,
  );
}

function canonicalPassName(value) {
  if (!nonEmpty(value)) return undefined;
  return REQUIRED_TIMING_PASSES.find((name) => PASS_ALIASES[name].includes(value));
}

function passIdentity(name) {
  return `standard-output/${name}`;
}

/**
 * Capability preflight is intentionally stricter than a backend kind check.
 * `realGpu`, a provider label, or a non-empty adapter string cannot substitute
 * for an observed physical adapter and timestamp-query capability.
 */
export function capabilityPreflight(backend) {
  const missing = [];
  if (!isRecord(backend) || backend.kind !== 'webgpu') missing.push('webgpu backend');
  if (!isRecord(backend) || backend.physicalGpu !== true) missing.push('physicalGpu=true');
  if (!isRecord(backend) || backend.timestampQuery !== true) missing.push('timestampQuery=true');
  if (!isRecord(backend) || !finitePositive(backend.timestampPeriodNanoseconds)) {
    missing.push('positive timestampPeriodNanoseconds');
  }
  const adapterText = isRecord(backend)
    ? [backend.adapter, backend.driver, backend.browser, backend.device]
        .filter((value) => typeof value === 'string')
        .join(' ')
    : '';
  if (SOFTWARE_PROVENANCE_PATTERN.test(adapterText)) {
    missing.push('non-software physical adapter');
  }
  if (missing.length > 0) {
    return {
      status: 'blocked',
      missing: [...new Set(missing)],
      reason: `timing capability preflight failed: ${[...new Set(missing)].join(', ')}`,
    };
  }
  return {
    status: 'ready',
    missing: [],
    reason: 'physical WebGPU timestamp-query capability is present',
    timestampPeriodNanoseconds: backend.timestampPeriodNanoseconds,
  };
}

// Long names make the ownership boundary clear to callers that do not import
// this module's shorter test-facing helper.
export const preflightGpuTimingCapabilities = capabilityPreflight;

function validateFrameIdentity(value, path, errors) {
  if (
    !isRecord(value) ||
    !nonEmpty(value.generation) ||
    !value.generation.startsWith('device-') ||
    !positiveInteger(value.firstFrame) ||
    !positiveInteger(value.lastFrame) ||
    value.lastFrame - value.firstFrame + 1 !== FRAME_COUNT
  ) {
    errors.push(
      issue(
        'frame-identity-invalid',
        path,
        'generation plus one contiguous 60-frame window',
      ),
    );
    return false;
  }
  return true;
}

function validateContext(input, errors) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input?.testedRevision ?? '')) {
    errors.push(
      issue(
        'revision-invalid',
        '/testedRevision',
        'the exact 40-character checkout revision used by the renderer capture',
      ),
    );
  }
  for (const name of ['source', 'build']) {
    const value = input?.[name];
    if (
      !isRecord(value) ||
      !nonEmpty(value.path) ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      errors.push(issue('identity-invalid', `/${name}`, 'path and lowercase SHA-256 digest'));
    }
  }
  for (const name of ['runner', 'fixture']) {
    if (!isRecord(input?.[name])) {
      errors.push(issue('identity-missing', `/${name}`, 'complete runner and fixture identity'));
    }
  }
  if (
    isRecord(input?.runner) &&
    (!nonEmpty(input.runner.kind) || !nonEmpty(input.runner.id))
  ) {
    errors.push(issue('runner-identity-invalid', '/runner', 'non-empty runner kind and id'));
  }
  if (isRecord(input?.runner)) {
    const runnerText = [input.runner.kind, input.runner.id, input.runner.browser]
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (SOFTWARE_PROVENANCE_PATTERN.test(runnerText)) {
      errors.push(issue('runner-identity-invalid', '/runner', 'software and fallback runner identities are ineligible'));
    }
  }
  if (isRecord(input?.backend)) {
    for (const name of ['kind', 'adapter', 'driver', 'browser']) {
      if (!nonEmpty(input.backend[name])) {
        errors.push(issue('backend-identity-invalid', `/backend/${name}`, 'non-empty backend identity'));
      }
    }
  } else {
    errors.push(issue('backend-identity-missing', '/backend', 'complete backend identity'));
  }
  if (isRecord(input?.fixture)) {
    for (const name of ['id', 'asset', 'camera', 'light', 'input']) {
      if (!nonEmpty(input.fixture[name])) {
        errors.push(issue('fixture-identity-invalid', `/fixture/${name}`, 'non-empty identity'));
      }
    }
  }
  if (isRecord(input?.frame)) validateFrameIdentity(input.frame, '/frame', errors);
  return errors.length === 0;
}

function tick(value) {
  return typeof value === 'string' && DECIMAL_TICK.test(value);
}

function timestampDelta(begin, end, path, errors) {
  if (!tick(begin) || !tick(end)) {
    errors.push(issue('timestamp-invalid', path, 'decimal raw begin/end timestamp ticks'));
    return undefined;
  }
  let delta;
  try {
    delta = BigInt(end) - BigInt(begin);
  } catch {
    errors.push(issue('timestamp-invalid', path, 'raw timestamp ticks must fit unsigned decimal form'));
    return undefined;
  }
  if (delta < 0n) {
    errors.push(issue('timestamp-invalid', path, 'end tick must be greater than or equal to begin tick'));
    return undefined;
  }
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    errors.push(issue('timestamp-invalid', path, 'raw timestamp delta must fit a safe integer'));
    return undefined;
  }
  return delta;
}

function normalizeWindow(window, path, period, expectedFrame, seenSamples, errors) {
  const resolution = resolutionFor(window);
  if (resolution === undefined) {
    errors.push(issue('resolution-invalid', path, 'exactly 1920x1080 or 3840x2160'));
    return undefined;
  }
  if (!isRecord(window) || !['gpu-timestamp', 'pass-boundary'].includes(window.measurementSource)) {
    errors.push(
      issue(
        'measurement-source-invalid',
        `${path}/measurementSource`,
        'renderer GPU timestamp or pass-boundary raw samples; wall-time/FPS/TAA is forbidden',
      ),
    );
  }
  const beginTicks = window.beginTicks;
  const endTicks = window.endTicks;
  if (
    !Array.isArray(beginTicks) ||
    !Array.isArray(endTicks) ||
    beginTicks.length !== FRAME_COUNT ||
    endTicks.length !== FRAME_COUNT
  ) {
    errors.push(issue('window-incomplete', path, '60 raw begin/end timestamp pairs'));
    return undefined;
  }
  const captureGeneration = window.captureGeneration;
  const firstFrame = window.firstFrame;
  const lastFrame = window.lastFrame;
  if (
    !nonEmpty(captureGeneration) ||
    !captureGeneration.startsWith('device-') ||
    !positiveInteger(firstFrame) ||
    !positiveInteger(lastFrame) ||
    lastFrame - firstFrame + 1 !== FRAME_COUNT
  ) {
    errors.push(
      issue(
        'frame-identity-invalid',
        path,
        'captureGeneration and one contiguous 60-frame window',
      ),
    );
  }
  if (
    isRecord(expectedFrame) &&
    (captureGeneration !== expectedFrame.generation ||
      firstFrame !== expectedFrame.firstFrame ||
      lastFrame !== expectedFrame.lastFrame)
  ) {
    errors.push(
      issue(
        'frame-identity-mismatch',
        path,
        'every pass and resolution window must retain its owning frame generation',
      ),
    );
  }
  const deltas = [];
  let previousBegin;
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const begin = beginTicks[index];
    const end = endTicks[index];
    if (previousBegin !== undefined && tick(begin) && BigInt(begin) <= previousBegin) {
      errors.push(issue('timestamp-order-invalid', `${path}/beginTicks/${index}`, 'raw samples must be in strictly increasing frame order'));
    }
    if (tick(begin)) previousBegin = BigInt(begin);
    deltas.push(timestampDelta(begin, end, `${path}/beginTicks/${index}`, errors));
  }
  if (deltas.length !== FRAME_COUNT || deltas.some((delta) => delta === undefined)) return undefined;
  const validDeltas = deltas;
  const positiveDeltas = validDeltas.filter((delta) => delta > 0n);
  const equalTickSamples = validDeltas.length - positiveDeltas.length;
  const minimumPositiveDelta = positiveDeltas.reduce(
    (minimum, delta) => (minimum === undefined || delta < minimum ? delta : minimum),
    undefined,
  );
  const quantizationUpperBoundNanoseconds =
    minimumPositiveDelta === undefined ? undefined : Number(minimumPositiveDelta) * period;
  // Dawn on Apple Metal can quantize a short pass to equal begin/end ticks.
  // Preserve that raw pair and use the smallest positive delta from the same
  // physical window as a conservative upper bound; never drop or replace the
  // sample with wall time. A window with no positive observation remains
  // blocked because it cannot establish a trustworthy bound.
  if (equalTickSamples > 0 && !finitePositive(quantizationUpperBoundNanoseconds)) {
    errors.push(
      issue(
        'timestamp-quantum-unavailable',
        path,
        'equal GPU timestamp ticks require a positive same-window timestamp quantum upper bound',
      ),
    );
    return undefined;
  }
  const durations = validDeltas.map((delta) => {
    if (delta === 0n) return quantizationUpperBoundNanoseconds;
    return Number(delta) * period;
  });
  if (!durations.every((duration) => finitePositive(duration))) {
    errors.push(issue('timestamp-invalid', path, 'finite positive timestamp duration'));
    return undefined;
  }
  const sampleKey = JSON.stringify([beginTicks, endTicks]);
  if (seenSamples.has(sampleKey)) {
    errors.push(
      issue(
        'samples-reused',
        path,
        'each renderer pass and resolution must own a distinct raw timestamp sample set',
      ),
    );
  }
  seenSamples.add(sampleKey);
  const p95Nanoseconds = nearestRankP95(durations);
  if (p95Nanoseconds === null) {
    errors.push(issue('window-invalid', path, 'finite positive nearest-rank P95 duration'));
    return undefined;
  }
  return {
    width: resolution.width,
    height: resolution.height,
    resolution: resolution.id,
    measurementSource: 'gpu-timestamp',
    rawMeasurementSource: window.measurementSource,
    captureGeneration,
    firstFrame,
    lastFrame,
    beginTicks: [...beginTicks],
    endTicks: [...endTicks],
    durationsNanoseconds: durations,
    p95Nanoseconds,
    p95Ms: p95Nanoseconds / 1_000_000,
    ...(equalTickSamples === 0
      ? {}
      : {
          timestampQuantization: {
            mode: 'equal-ticks-upper-bound',
            equalTickSamples,
            quantumNanoseconds: quantizationUpperBoundNanoseconds,
            source: 'renderer-receipt-timestamp',
          },
        }),
  };
}

function workloadFrame(workload) {
  if (isRecord(workload?.frame)) return workload.frame;
  return undefined;
}

function expectedPassesFor(kind) {
  // Keep the workload matrix orthogonal: auto owns the meter passes while
  // positive-lut owns only the independent LUT cost.  Requiring the meter
  // again on the LUT workload would turn two observations into one composite
  // workload and make the LUT-only control impossible to audit.
  return kind === 'auto' ? ['meter'] : ['lut'];
}

function blockedWorkload(kind) {
  return {
    kind,
    status: 'blocked',
    frame: null,
    passes: [],
    passNames: [],
    p95Ms: { '1080p': null, '4K': null },
    passP95Ms: { '1080p': {}, '4K': {} },
  };
}

function normalizeWorkload(kind, workload, input, seenSamples, errors) {
  if (!REQUIRED_WORKLOADS.includes(kind)) {
    errors.push(issue('workload-invalid', `/workloads/${kind}`, 'auto or positive-lut workload'));
    return blockedWorkload(kind);
  }
  if (!isRecord(workload)) {
    errors.push(issue('workload-missing', `/workloads/${kind}`, 'a renderer workload capture'));
    return blockedWorkload(kind);
  }
  const expectedNames = expectedPassesFor(kind);
  const passes = Array.isArray(workload.passes) ? workload.passes : [];
  const workloadErrorStart = errors.length;
  const frame = workloadFrame(workload);
  const frameErrors = [];
  if (!validateFrameIdentity(frame, `/workloads/${kind}/frame`, frameErrors)) {
    errors.push(...frameErrors);
  }
  const normalized = [];
  const names = new Set();
  for (const [index, pass] of passes.entries()) {
    if (!isRecord(pass)) {
      errors.push(issue('pass-invalid', `/workloads/${kind}/passes/${index}`, 'pass object'));
      continue;
    }
    const rawName = pass.passName ?? pass.name ?? pass.passIdentity;
    const name = canonicalPassName(rawName);
    if (
      name === undefined ||
      !expectedNames.includes(name) ||
      names.has(name) ||
      pass.passIdentity !== passIdentity(name)
    ) {
      errors.push(
        issue(
          'pass-invalid',
          `/workloads/${kind}/passes/${index}/passName`,
          `the exact ${expectedNames.join(', ')} renderer pass set; TAA/wall-time/FPS are forbidden`,
        ),
      );
      continue;
    }
    names.add(name);
    const windows = Array.isArray(pass.windows) ? pass.windows : [];
    if (windows.length !== REQUIRED_RESOLUTIONS.length) {
      errors.push(
        issue(
          'resolution-window-missing',
          `/workloads/${kind}/passes/${index}/windows`,
          'one complete 1080p and one complete 4K window',
        ),
      );
    }
    const normalizedWindows = windows
      .map((window, windowIndex) =>
        normalizeWindow(
          window,
          `/workloads/${kind}/passes/${index}/windows/${windowIndex}`,
          input.backend?.timestampPeriodNanoseconds,
          frame,
          seenSamples,
          errors,
        ),
      )
      .filter((window) => window !== undefined);
    const resolutionIds = new Set(normalizedWindows.map((window) => window.resolution));
    if (resolutionIds.size !== REQUIRED_RESOLUTIONS.length) {
      errors.push(
        issue(
          'resolution-window-duplicate',
          `/workloads/${kind}/passes/${index}/windows`,
          'exactly one complete raw timestamp window per required resolution',
        ),
      );
    }
    for (const resolution of REQUIRED_RESOLUTIONS) {
      if (!resolutionIds.has(resolution.id)) {
        errors.push(
          issue(
            'resolution-window-missing',
            `/workloads/${kind}/passes/${index}/windows`,
            `a complete ${resolution.id} raw timestamp window`,
          ),
        );
      }
    }
    normalized.push({
      passName: name,
      passIdentity: passIdentity(name),
      rawPassName: rawName,
      windows: normalizedWindows,
    });
  }
  for (const name of expectedNames) {
    if (!names.has(name)) {
      errors.push(
        issue(
          'pass-missing',
          `/workloads/${kind}/passes`,
          `the renderer-owned ${name} pass must be measured independently`,
        ),
      );
    }
  }
  const passP95Ms = Object.fromEntries(
    REQUIRED_RESOLUTIONS.map((resolution) => [
      resolution.id,
      Object.fromEntries(
        normalized.map((pass) => [
          pass.passName,
          pass.windows.find((window) => window.resolution === resolution.id)?.p95Ms ?? null,
        ]),
      ),
    ]),
  );
  const p95Ms = Object.fromEntries(
    REQUIRED_RESOLUTIONS.map((resolution) => {
      const values = normalized
        .map((pass) => pass.windows.find((window) => window.resolution === resolution.id)?.p95Ms)
        .filter((value) => finitePositive(value));
      return [resolution.id, values.length === normalized.length ? Math.max(...values) : null];
    }),
  );
  const complete =
    errors.length === workloadErrorStart &&
    normalized.length === expectedNames.length &&
    normalized.every((pass) => pass.windows.length === REQUIRED_RESOLUTIONS.length);
  return {
    kind,
    status: complete ? 'observation' : 'blocked',
    frame: isRecord(frame) ? clone(frame) : null,
    passes: normalized,
    passNames: normalized.map((pass) => pass.passName),
    p95Ms,
    passP95Ms,
  };
}

function manualReceipt(input, errors) {
  const value = input?.manual ?? input?.manualZeroCost;
  const receiptValid =
    isRecord(value?.receipt) && positiveInteger(value.receipt.frameId);
  if (
    !isRecord(value) ||
    value.executed !== true ||
    value.zeroCost !== true ||
    value.timestampSlots !== 0 ||
    !receiptValid
  ) {
    errors.push(
      issue(
        'manual-zero-cost-invalid',
        '/manual',
        'manual/LUT0 must carry an executed zero-cost receipt object with exactly zero timing slots',
      ),
    );
    return {
      status: 'blocked',
      executed: value?.executed === true,
      zeroCost: value?.zeroCost === true,
      timestampSlots: Number.isSafeInteger(value?.timestampSlots) ? value.timestampSlots : null,
    };
  }
  return {
    status: 'observation',
    executed: true,
    zeroCost: true,
    timestampSlots: 0,
    receipt: clone(value.receipt),
  };
}

function reportShell(input, preflight, status, errors, reason) {
  const report = {
    schemaVersion: TIMING_SCHEMA_VERSION,
    featureId: FEATURE_ID,
    status,
    verdictSource: 'renderer-gpu-timing-host',
    testedRevision: input?.testedRevision ?? null,
    source: clone(input?.source),
    build: clone(input?.build),
    runner: clone(input?.runner),
    backend: clone(input?.backend),
    fixture: clone(input?.fixture),
    frame: clone(input?.frame),
    sampling: { ...TIMING_SAMPLING },
    required: {
      passes: [...REQUIRED_TIMING_PASSES],
      logicalStages: [...REQUIRED_LOGICAL_STAGES],
      resolutions: REQUIRED_RESOLUTIONS.map(({ id, width, height, limitMs }) => ({
        id,
        width,
        height,
        limitMs,
      })),
      workloads: [...REQUIRED_WORKLOADS],
    },
    capability: clone(preflight),
    workloads: {},
    manual: null,
    timing: {
      source: TIMING_SOURCE,
      measurementSource: 'gpu-timestamp',
      passes: [],
      logicalStages: [...REQUIRED_LOGICAL_STAGES],
      windows: [],
      p95Ms: { '1080p': null, '4K': null },
      thresholdsMs: { '1080p': 0.35, '4K': 0.8 },
    },
    qualification: { status: 'blocked' },
    errors: [...errors],
    reason,
    hint:
      'only a renderer-owned physical timestamp-query capture with complete 1080p and 4K windows may proceed to CI timing admission',
  };
  return report;
}

/**
 * Create a raw feature timing report. The top-level status is observation or
 * blocked; this function never emits `pass`, `accepted`, or `qualified`.
 */
export function createTimingReport(input = {}) {
  const normalizedInput = {
    ...input,
    testedRevision: input.testedRevision ?? checkoutRevision(),
  };
  const errors = [];
  const preflight = capabilityPreflight(normalizedInput.backend);
  validateContext(normalizedInput, errors);
  if (preflight.status !== 'ready') {
    errors.push(issue('timing-capability-ineligible', '/backend', preflight.reason));
  }
  const seenSamples = new Set();
  const workloadInput = isRecord(normalizedInput.workloads) ? normalizedInput.workloads : {};
  const workloads = {};
  for (const kind of REQUIRED_WORKLOADS) {
    workloads[kind] = normalizeWorkload(
      kind,
      workloadInput[kind],
      normalizedInput,
      seenSamples,
      errors,
    );
  }
  const manual = manualReceipt(normalizedInput, errors);
  const report = reportShell(
    normalizedInput,
    preflight,
    'blocked',
    errors,
    'feature timing is incomplete',
  );
  report.workloads = workloads;
  report.manual = manual;
  if (report.frame === null) {
    const frame = workloads.auto.frame ?? workloads['positive-lut'].frame;
    if (isRecord(frame)) report.frame = clone(frame);
  }
  const timingWorkloadForPass = (passName) => (passName === 'lut' ? 'positive-lut' : 'auto');
  const timingPasses = REQUIRED_TIMING_PASSES.flatMap((passName) => {
    const workload = workloads[timingWorkloadForPass(passName)];
    return workload.passes.filter((pass) => pass.passName === passName);
  });
  // Project only observed stages.  The required list remains the contract,
  // while this field must not manufacture a complete pass set for a blocked
  // or partial capture.
  report.timing.passes = timingPasses.map((pass) => pass.passName);
  report.timing.windows = timingPasses.flatMap((pass) => {
    const workload = workloads[timingWorkloadForPass(pass.passName)];
    return pass.windows.map((window) => ({
      workload: workload.kind,
      passName: pass.passName,
      passIdentity: pass.passIdentity,
      rawPassName: pass.rawPassName,
      ...window,
    }));
  });
  report.timing.p95Ms = Object.fromEntries(
    REQUIRED_RESOLUTIONS.map((resolution) => [
      resolution.id,
      workloads.auto.p95Ms[resolution.id] ?? null,
    ]),
  );

  const budgetErrors = [];
  for (const resolution of REQUIRED_RESOLUTIONS) {
    const p95 = report.timing.p95Ms[resolution.id];
    if (!finitePositive(p95) || p95 > resolution.limitMs) {
      budgetErrors.push(
        issue(
          'timing-budget-invalid',
          `/timing/p95Ms/${resolution.id}`,
          `complete nearest-rank P95 at or below ${resolution.limitMs}ms`,
        ),
      );
    }
  }
  const workloadReady = REQUIRED_WORKLOADS.every(
    (kind) => workloads[kind]?.status === 'observation',
  );
  const completeCandidate =
    errors.length === 0 &&
    budgetErrors.length === 0 &&
    preflight.status === 'ready' &&
    workloadReady &&
    manual.status === 'observation';
  if (completeCandidate) {
    report.status = 'observation';
    report.qualification = {
      status: 'eligible-candidate',
      source: TIMING_SOURCE,
      physicalGpu: true,
      timestampQuery: true,
      resolutions: {
        '1080p': { p95Ms: report.timing.p95Ms['1080p'], windowComplete: true },
        '4K': { p95Ms: report.timing.p95Ms['4K'], windowComplete: true },
      },
      note: 'raw timing candidate only; CI timing admission and exact-head join still own qualification',
    };
    report.reason = 'renderer-owned raw timestamp windows are complete and within the timing ceiling';
  } else {
    report.status = 'blocked';
    report.errors = [...errors, ...budgetErrors];
    report.qualification = {
      status: 'blocked',
      missing: [
        ...(preflight.status === 'ready' ? [] : ['physicalGpu/timestampQuery capability']),
        ...(workloads.auto.status === 'observation' ? [] : ['auto workload']),
        ...(workloads['positive-lut'].status === 'observation' ? [] : ['positive-lut workload']),
        ...(manual.status === 'observation' ? [] : ['manual/LUT0 zero-cost receipt']),
        ...(budgetErrors.length === 0 ? [] : ['timing ceiling']),
      ],
    };
    report.reason =
      report.errors[0]?.detail ??
      'missing physical capability, raw stage, complete resolution window, or timing ceiling';
  }
  return report;
}

export const createAutoExposureGpuTimingReport = createTimingReport;

export function createBlockedTimingReport(input = {}, reason = 'timing host is unavailable') {
  const normalizedInput = {
    ...input,
    testedRevision: input.testedRevision ?? checkoutRevision(),
  };
  const preflight = capabilityPreflight(normalizedInput.backend);
  const errors = [issue('timing-host-blocked', '/', reason)];
  const report = reportShell(normalizedInput, preflight, 'blocked', errors, reason);
  report.qualification = { status: 'blocked', missing: [reason] };
  return report;
}

export const createBlockedAutoExposureTimingReport = createBlockedTimingReport;

function frameFactFromObservation(result) {
  const payload =
    isRecord(result) && result.ok === true && isRecord(result.value) ? result.value : result;
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.frame)) return payload.frame;
  if (isRecord(payload.timings?.frame)) return payload.timings.frame;
  if (isRecord(payload.observation?.frame)) return payload.observation.frame;
  return undefined;
}

function observationStatus(result) {
  const payload =
    isRecord(result) && result.ok === true && isRecord(result.value) ? result.value : result;
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.timings) && typeof payload.timings.status === 'string') {
    return payload.timings.status;
  }
  if (isRecord(payload.observation) && typeof payload.observation.status === 'string') {
    return payload.observation.status;
  }
  return typeof payload.status === 'string' ? payload.status : undefined;
}

function frameIdentityFromFact(frame) {
  if (!isRecord(frame)) return undefined;
  const generation =
    frame.generation ??
    `device-${frame.deviceGeneration ?? 'unknown'}:graph-${frame.graphGeneration ?? 'unknown'}`;
  if (!nonEmpty(generation) || !generation.startsWith('device-') || !positiveInteger(frame.frameId)) {
    return undefined;
  }
  return { generation, frameId: frame.frameId };
}

function measuredPasses(frame) {
  if (!isRecord(frame) || !Array.isArray(frame.passes)) return [];
  return frame.passes.filter(
    (pass) => isRecord(pass) && pass.status === 'measured' && tick(pass.beginningTick) && tick(pass.endTick),
  );
}

/**
 * Collect the fixed warmup/window contract from any Browser or Dawn adapter.
 * The callback must return the actual renderer receipt observation; a frame
 * duration or a TAA-only helper is intentionally not accepted as a substitute.
 */
export async function collectRendererPassTiming({
  testedRevision,
  backend,
  source,
  build,
  runner,
  fixture,
  manual,
  runFrame,
}) {
  const base = {
    testedRevision: testedRevision ?? checkoutRevision(),
    backend,
    source,
    build,
    runner,
    fixture,
    manual,
  };
  if (typeof runFrame !== 'function') {
    return createBlockedTimingReport(base, 'renderer timing adapter did not provide runFrame');
  }
  const preflight = capabilityPreflight(backend);
  if (preflight.status !== 'ready') {
    return createBlockedTimingReport(base, preflight.reason);
  }
  const workloads = {};
  const captureErrors = [];
  for (const kind of REQUIRED_WORKLOADS) {
    const passNames = expectedPassesFor(kind);
    const byResolution = [];
    let workloadFrame;
    for (const resolution of REQUIRED_RESOLUTIONS) {
      const samplesByPass = new Map(passNames.map((name) => [name, { beginTicks: [], endTicks: [] }]));
      let captureGeneration;
      let previousFrameId;
      let firstSampleFrame;
      let resolutionFrame;
      for (let index = 0; index < TIMING_SAMPLING.warmupFrames + TIMING_SAMPLING.framesPerWindow; index += 1) {
        let result;
        try {
          result = await runFrame({
            workload: kind,
            resolution: { width: resolution.width, height: resolution.height },
            phase: index < TIMING_SAMPLING.warmupFrames ? 'warmup' : 'sample',
            frameIndex: index,
          });
        } catch (error) {
          captureErrors.push(
            issue(
              'renderer-frame-failed',
              `/workloads/${kind}/${resolution.id}/${index}`,
              error instanceof Error ? error.message : String(error),
            ),
          );
          continue;
        }
        const status = observationStatus(result);
        if (
          status !== undefined &&
          status !== 'complete' &&
          status !== 'observation'
        ) {
          captureErrors.push(
            issue(
              'renderer-observation-incomplete',
              `/workloads/${kind}/${resolution.id}/${index}`,
              `renderer receipt timing observation was ${status}; complete observations are required`,
            ),
          );
          continue;
        }
        const frame = frameFactFromObservation(result);
        const identity = frameIdentityFromFact(frame);
        if (frame !== undefined && identity === undefined) {
          captureErrors.push(
            issue(
              'renderer-frame-identity-invalid',
              `/workloads/${kind}/${resolution.id}/${index}/frame`,
              'renderer timing observation must include a positive frameId and device-scoped generation',
            ),
          );
          continue;
        }
        if (identity !== undefined) {
          if (captureGeneration !== undefined && identity.generation !== captureGeneration) {
            captureErrors.push(
              issue(
                'renderer-frame-generation-changed',
                `/workloads/${kind}/${resolution.id}/${index}/frame`,
                'one device/graph generation must own the complete warmup and 60-frame sample window',
              ),
            );
            continue;
          }
          captureGeneration ??= identity.generation;
          if (previousFrameId !== undefined && identity.frameId !== previousFrameId + 1) {
            captureErrors.push(
              issue(
                'renderer-frame-sequence-invalid',
                `/workloads/${kind}/${resolution.id}/${index}/frame/frameId`,
                'renderer receipts must form one contiguous frame sequence',
              ),
            );
            continue;
          }
          previousFrameId = identity.frameId;
        }
        if (
          frame !== undefined &&
          frame.backendKind !== undefined &&
          frame.backendKind !== backend.kind
        ) {
          captureErrors.push(
            issue(
              'renderer-backend-mismatch',
              `/workloads/${kind}/${resolution.id}/${index}/backendKind`,
              `renderer timing frame backend must be ${backend.kind}`,
            ),
          );
          continue;
        }
        if (
          frame !== undefined &&
          frame.timestampPeriodNanoseconds !== undefined &&
          (!finitePositive(frame.timestampPeriodNanoseconds) ||
            frame.timestampPeriodNanoseconds !== backend.timestampPeriodNanoseconds)
        ) {
          captureErrors.push(
            issue(
              'renderer-timestamp-period-mismatch',
              `/workloads/${kind}/${resolution.id}/${index}/timestampPeriodNanoseconds`,
              'renderer timing frame period must equal the observed backend period',
            ),
          );
          continue;
        }
        if (identity !== undefined && index >= TIMING_SAMPLING.warmupFrames) {
          firstSampleFrame ??= identity.frameId;
          const expectedFrameId = firstSampleFrame + index - TIMING_SAMPLING.warmupFrames;
          if (identity.frameId !== expectedFrameId) {
            captureErrors.push(
              issue(
                'renderer-sample-window-invalid',
                `/workloads/${kind}/${resolution.id}/${index}/frame/frameId`,
                'the 60 sampled receipts must be contiguous after the warmup window',
              ),
            );
            continue;
          }
          resolutionFrame = {
            generation: identity.generation,
            firstFrame: firstSampleFrame,
            lastFrame: identity.frameId,
          };
        }
        if (index < TIMING_SAMPLING.warmupFrames) continue;
        const measured = measuredPasses(frame);
        for (const pass of measured) {
          const name = canonicalPassName(pass.passName ?? pass.name);
          const sample = name === undefined ? undefined : samplesByPass.get(name);
          if (sample === undefined) continue;
          sample.beginTicks.push(pass.beginningTick);
          sample.endTicks.push(pass.endTick);
        }
      }
      if (resolutionFrame !== undefined) {
        if (
          workloadFrame !== undefined &&
          (workloadFrame.generation !== resolutionFrame.generation ||
            workloadFrame.firstFrame !== resolutionFrame.firstFrame ||
            workloadFrame.lastFrame !== resolutionFrame.lastFrame)
        ) {
          captureErrors.push(
            issue(
              'renderer-resolution-frame-mismatch',
              `/workloads/${kind}/${resolution.id}/frame`,
              'all required resolutions must retain the same renderer frame-generation window',
            ),
          );
        } else {
          workloadFrame ??= resolutionFrame;
        }
      }
      byResolution.push({
        resolution,
        passes: passNames.map((name) => ({
          passName: name,
          passIdentity: passIdentity(name),
          windows: [
            {
              width: resolution.width,
              height: resolution.height,
              measurementSource: 'gpu-timestamp',
              captureGeneration: resolutionFrame?.generation,
              firstFrame: resolutionFrame?.firstFrame,
              lastFrame: resolutionFrame?.lastFrame,
              beginTicks: samplesByPass.get(name)?.beginTicks ?? [],
              endTicks: samplesByPass.get(name)?.endTicks ?? [],
            },
          ],
        })),
      });
    }
    const passMap = new Map();
    for (const passName of passNames) {
      passMap.set(passName, {
        passName,
        passIdentity: passIdentity(passName),
        windows: byResolution.flatMap((entry) =>
          entry.passes.find((pass) => pass.passName === passName)?.windows ?? [],
        ),
      });
    }
    workloads[kind] = { frame: workloadFrame, passes: [...passMap.values()] };
  }
  const report = createTimingReport({ ...base, workloads });
  if (captureErrors.length > 0) {
    report.status = 'blocked';
    report.errors = [...captureErrors, ...(report.errors ?? [])];
    report.qualification = { status: 'blocked', missing: ['complete renderer receipt observations'] };
    report.reason = captureErrors[0].detail;
  }
  return report;
}

export const collectFeatureTiming = collectRendererPassTiming;

async function resolveProducer(path) {
  if (!nonEmpty(path)) return undefined;
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    await access(absolute);
  } catch {
    throw new Error(`timing producer does not exist: ${absolute}`);
  }
  return import(pathToFileURL(absolute).href);
}

async function runCli() {
  const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice(9);
  const producerPath = process.env.FORGEAX_AUTO_EXPOSURE_TIMING_PRODUCER;
  let report;
  try {
    const producerModule = await resolveProducer(producerPath);
    const producer = producerModule?.collectAutoExposureTiming ?? producerModule?.default;
    if (typeof producer !== 'function') {
      report = createBlockedTimingReport(
        {},
        'no renderer timing producer was provided; set FORGEAX_AUTO_EXPOSURE_TIMING_PRODUCER to a Browser or Dawn adapter',
      );
    } else {
      const result = await producer({
        featureId: FEATURE_ID,
        sampling: TIMING_SAMPLING,
        workloads: [...REQUIRED_WORKLOADS],
        passes: [...REQUIRED_TIMING_PASSES],
        resolutions: REQUIRED_RESOLUTIONS.map(({ id, width, height, limitMs }) => ({
          id,
          width,
          height,
          limitMs,
        })),
      });
      report = createTimingReport(result);
    }
  } catch (error) {
    report = createBlockedTimingReport(
      {},
      error instanceof Error ? error.message : String(error),
    );
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output !== undefined) {
    await writeFile(resolve(process.cwd(), output), serialized, 'utf8');
  } else {
    process.stdout.write(serialized);
  }
  process.stderr.write(
    `auto-exposure GPU timing: ${report.status}; ${report.reason ?? 'no reason recorded'}\n`,
  );
  if (report.status === 'blocked') process.exitCode = 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runCli();
}
