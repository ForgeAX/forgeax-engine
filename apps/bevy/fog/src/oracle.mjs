export const FOG_TRACE_SCHEMA_VERSION = 'forgeax-fog-trace-v2';

export const FOG_CASES = Object.freeze([
  'disabled',
  'uniform',
  'change',
  'height',
  'owner-switch',
  'camera-switch',
  'detach-reattach',
  'resize',
  'recovery',
]);

export const FOG_PHASES = Object.freeze([
  'disabled',
  'uniform',
  'change',
  'height',
  'owner-switch',
  'camera-switch',
  'detach-reattach',
  'resize',
  'recovery',
  'disabled',
]);

const CHANNEL_TOLERANCE = 0.02;
const WEAK_ACTIVE_SIGNAL = 0.01;

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every((entry) => Number.isFinite(entry));
}

function vectorDelta(expected, observed) {
  return expected.map((value, index) => Math.abs(value - observed[index]));
}

export function evaluateFogCase(input) {
  const expected = Array.from(input.expected ?? []);
  const observed = Array.from(input.observed ?? []);
  const caseId = String(input.caseId ?? 'unknown');
  const active = input.active !== false;
  const alphaExpected = input.expectedAlpha ?? expected[3];
  const delta = expected.length === observed.length ? vectorDelta(expected, observed) : [];
  let verdict = 'pass';
  let reason = 'linear readback is within the channel tolerance';

  if (!finiteVector(expected, 4) || !finiteVector(observed, 4)) {
    verdict = 'fail';
    reason = 'expected and observed RGBA values must be finite';
  } else if (active && Math.max(observed[0], observed[1], observed[2]) <= WEAK_ACTIVE_SIGNAL) {
    verdict = 'fail';
    reason = 'active Fog readback is black or too weak to prove the producer';
  } else if (
    Math.max(...delta) > (input.channelTolerance ?? CHANNEL_TOLERANCE) ||
    Math.abs(observed[3] - alphaExpected) > (input.alphaTolerance ?? CHANNEL_TOLERANCE)
  ) {
    verdict = 'fail';
    reason = 'linear readback exceeds the channel or alpha tolerance';
  }

  return {
    caseId,
    expected,
    observed,
    delta,
    alpha: observed[3],
    tolerance: input.channelTolerance ?? CHANNEL_TOLERANCE,
    verdict,
    confidence: verdict === 'pass' ? 'high' : 'low',
    reason,
  };
}

export function buildFogTrace(input) {
  const frames = input.frames;
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('frames must be a positive integer');
  if (input.phaseTrace.length !== frames) throw new Error('phaseTrace must cover every frame');
  if (input.resourceTrace.length === 0) throw new Error('resourceTrace must contain sampled frames');
  if (input.visualEvidence.length !== input.resourceTrace.length)
    throw new Error('visualEvidence and resourceTrace must cover the same sampled frames');
  const sampledFrames = input.resourceTrace.map((entry) => entry.frame);
  if (
    sampledFrames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= frames) ||
    new Set(sampledFrames).size !== sampledFrames.length
  )
    throw new Error('sampled frame identities must be unique and within the frame range');
  const cases = input.cases ?? [];
  const caseVerdict = cases.every((entry) => entry.verdict === 'pass');
  const visualVerdict = input.visualEvidence.every(
    (entry) => entry.verdict === 'pass' && (entry.confidence === 'high' || entry.confidence === 'medium'),
  );
  return {
    schemaVersion: FOG_TRACE_SCHEMA_VERSION,
    backend: input.backend,
    frames,
    sampledFrames,
    phaseTrace: input.phaseTrace,
    cases,
    resourceTrace: input.resourceTrace,
    visualEvidence: input.visualEvidence,
    verdict: caseVerdict && visualVerdict ? 'pass' : 'fail',
  };
}
