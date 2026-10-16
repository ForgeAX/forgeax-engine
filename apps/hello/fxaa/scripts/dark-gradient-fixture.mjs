#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fixture from '../dark-gradient-fixture.json' with { type: 'json' };

export const DARK_GRADIENT_REPORT_SCHEMA = fixture.schema;
export const DARK_GRADIENT_FIXTURE_ID = fixture.id;
export const DARK_GRADIENT_FIXTURE = Object.freeze(fixture);
export const DARK_GRADIENT_FRAME_COUNT = fixture.frameCount;
export const DARK_GRADIENT_RESOLUTION = Object.freeze(fixture.resolution);
export const DARK_GRADIENT_THRESHOLDS = Object.freeze(fixture.thresholds);
const PIXEL_SOURCE_BY_BACKEND = Object.freeze({
  'browser-webgpu': Object.freeze({ endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' }),
  dawn: Object.freeze({ endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' }),
  'webkit-webgl2': Object.freeze({ endpoint: 'surface.display.final', method: 'webkit-compositor-rgba8' }),
  'chromium-webgl2': Object.freeze({ endpoint: 'surface.display.final', method: 'chromium-compositor-rgba8' }),
});

const isWebgl2Backend = (backendId) => backendId === 'webkit-webgl2' || backendId === 'chromium-webgl2';

export function pixelSourceForBackend(backendId) {
  return PIXEL_SOURCE_BY_BACKEND[backendId] ?? { endpoint: '', method: '' };
}
export const DARK_GRADIENT_MUTATIONS = Object.freeze([
  'eight-bit-intermediate',
  'missing-oetf',
  'duplicate-oetf',
  'missing-surface-view-capability',
  'raw-only-overlay-after-transform',
]);
const EXPECTED_FALSIFIER_GATES = Object.freeze({
  'eight-bit-intermediate': 'uniqueColorRatio',
  'missing-oetf': 'brightness',
  'duplicate-oetf': 'meanAbsoluteChannelDelta',
  'missing-surface-view-capability': 'surface-view-capability',
  'raw-only-overlay-after-transform': 'raw-only-overlay-ordering',
});

const ROUTE_FALSIFIER_CASES = Object.freeze([
  Object.freeze({
    mutation: 'missing-surface-view-capability',
    facts: Object.freeze({
      surfaceProfile: 'raw-only',
      surfaceViewFormats: false,
      declaresDisplayView: true,
      overlayStage: 'before-output-transform',
    }),
  }),
  Object.freeze({
    mutation: 'raw-only-overlay-after-transform',
    facts: Object.freeze({
      surfaceProfile: 'raw-only',
      surfaceViewFormats: false,
      declaresDisplayView: false,
      overlayStage: 'after-output-transform',
    }),
  }),
]);

export function failedRouteGates(facts) {
  const failed = [];
  if (!facts.surfaceViewFormats && facts.declaresDisplayView) {
    failed.push('surface-view-capability');
  }
  if (facts.surfaceProfile === 'raw-only' && facts.overlayStage !== 'before-output-transform') {
    failed.push('raw-only-overlay-ordering');
  }
  return Object.freeze(failed);
}

export function runDarkGradientRouteFalsifiers() {
  return Object.freeze(ROUTE_FALSIFIER_CASES.map(({ mutation, facts }) => {
    const actualFailedGates = failedRouteGates(facts);
    return Object.freeze({
      mutation,
      expectedGate: EXPECTED_FALSIFIER_GATES[mutation],
      actualFailedGates,
      passed: actualFailedGates.length === 0,
    });
  }));
}

export const PAIRED_FLOAT_BENCH_SCHEMA = 'forgeax.dark-gradient-paired-float-bench/1';
export const PAIRED_FLOAT_BENCH_BYTES_PER_PIXEL = 8;

function freezeBenchLane(lane) {
  return Object.freeze({
    antialias: lane.antialias,
    extraTargetCount: lane.extraTargetCount,
    standardOutputColor: Object.freeze({
      format: lane.standardOutputColor.format,
      bytes: lane.standardOutputColor.bytes,
      allocationCount: lane.standardOutputColor.allocationCount,
    }),
    bandwidthBytes: lane.bandwidthBytes,
    uploadBytes: lane.uploadBytes,
    frameTimingMs: lane.frameTimingMs,
    timingSource: lane.timingSource,
  });
}

export function createPairedFloatBenchReport({
  deviceId,
  lane,
  frameCount = DARK_GRADIENT_FRAME_COUNT,
  resolution = DARK_GRADIENT_RESOLUTION,
  frameSchedule = 'fixed-60-frame',
  fxaaOff,
  fxaaOn,
}) {
  const expectedBytes = resolution.width * resolution.height * PAIRED_FLOAT_BENCH_BYTES_PER_PIXEL;
  return Object.freeze({
    schema: PAIRED_FLOAT_BENCH_SCHEMA,
    status: 'complete',
    identity: Object.freeze({
      fixtureId: DARK_GRADIENT_FIXTURE_ID,
      deviceId,
      lane,
      resolution: Object.freeze({ width: resolution.width, height: resolution.height }),
      frameCount,
      frameSchedule,
    }),
    expected: Object.freeze({
      format: 'rgba16float',
      standardOutputColorBytes: expectedBytes,
      fxaaOffExtraTargetCount: 0,
      fxaaOnExtraTargetCount: 1,
    }),
    fxaaOff: freezeBenchLane(fxaaOff),
    fxaaOn: freezeBenchLane(fxaaOn),
  });
}

export function validatePairedFloatBenchReport(report) {
  const expectedBytes = report.identity.resolution.width * report.identity.resolution.height * PAIRED_FLOAT_BENCH_BYTES_PER_PIXEL;
  const checks = [
    [report.schema === PAIRED_FLOAT_BENCH_SCHEMA, 'schema'],
    [report.status === 'complete', 'status'],
    [typeof report.identity.deviceId === 'string' && report.identity.deviceId.length > 0, 'identity.deviceId'],
    [report.identity.frameCount === DARK_GRADIENT_FRAME_COUNT, 'identity.frameCount'],
    [report.expected.format === 'rgba16float', 'expected.format'],
    [report.expected.standardOutputColorBytes === expectedBytes, 'expected.standardOutputColorBytes'],
    [report.expected.fxaaOffExtraTargetCount === 0, 'expected.fxaaOffExtraTargetCount'],
    [report.expected.fxaaOnExtraTargetCount === 1, 'expected.fxaaOnExtraTargetCount'],
    [report.fxaaOff.antialias === 'none', 'fxaaOff.antialias'],
    [report.fxaaOff.extraTargetCount === 0, 'fxaaOff.extraTargetCount'],
    [report.fxaaOff.standardOutputColor.format === 'rgba16float', 'fxaaOff.format'],
    [report.fxaaOn.antialias === 'fxaa', 'fxaaOn.antialias'],
    [report.fxaaOn.extraTargetCount === 1, 'fxaaOn.extraTargetCount'],
    [report.fxaaOn.standardOutputColor.format === 'rgba16float', 'fxaaOn.format'],
    [report.fxaaOn.standardOutputColor.bytes === expectedBytes, 'fxaaOn.bytes'],
    [report.fxaaOn.standardOutputColor.allocationCount === 1, 'fxaaOn.allocationCount'],
    [report.fxaaOff.frameTimingMs !== undefined && report.fxaaOn.frameTimingMs !== undefined, 'frameTimingMs'],
    [report.fxaaOff.timingSource !== 'schema-derived' && report.fxaaOn.timingSource !== 'schema-derived', 'timingSource'],
  ];
  const failed = checks.find(([passed]) => !passed);
  return failed === undefined ? { ok: true } : { ok: false, error: `paired float bench contract failed at ${failed[1]}` };
}

export function createInsufficientPairedFloatBenchReport({ deviceId = '', lane = 'direct', reason }) {
  const expectedBytes = DARK_GRADIENT_RESOLUTION.width * DARK_GRADIENT_RESOLUTION.height * PAIRED_FLOAT_BENCH_BYTES_PER_PIXEL;
  return Object.freeze({
    schema: PAIRED_FLOAT_BENCH_SCHEMA,
    status: 'insufficient-evidence',
    identity: Object.freeze({
      fixtureId: DARK_GRADIENT_FIXTURE_ID,
      deviceId,
      lane,
      resolution: DARK_GRADIENT_RESOLUTION,
      frameCount: DARK_GRADIENT_FRAME_COUNT,
      frameSchedule: 'fixed-60-frame',
    }),
    expected: Object.freeze({
      format: 'rgba16float',
      standardOutputColorBytes: expectedBytes,
      fxaaOffExtraTargetCount: 0,
      fxaaOnExtraTargetCount: 1,
    }),
    error: Object.freeze({
      code: 'insufficient-evidence',
      expected: 'same-device paired GPU timing and allocation evidence',
      hint: reason,
      detail: Object.freeze({ backendId: 'dawn', lane, entrypoint: 'dark-gradient-fixture-cli' }),
    }),
  });
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('dark-gradient pixel payload must be a Uint8Array');
}

function hashPixels(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function nonBlackPixelCount(bytes) {
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 0) count += 1;
  }
  return count;
}

function affectedPixelRatio(bytes, referenceBytes) {
  if (referenceBytes === undefined || bytes.length !== referenceBytes.length) return 0;
  let affected = 0;
  let total = 0;
  for (let index = 0; index + 3 < bytes.length; index += 4) {
    total += 1;
    if (
      bytes[index] !== referenceBytes[index] ||
      bytes[index + 1] !== referenceBytes[index + 1] ||
      bytes[index + 2] !== referenceBytes[index + 2]
    ) {
      affected += 1;
    }
  }
  return total === 0 ? 0 : affected / total;
}

function uniqueColorCount(bytes) {
  const colors = new Set();
  for (let index = 0; index + 3 < bytes.length; index += 4) {
    colors.add(`${bytes[index]}:${bytes[index + 1]}:${bytes[index + 2]}:${bytes[index + 3]}`);
  }
  return colors.size;
}

function regionBytes(bytes, region) {
  const result = new Uint8Array(region.width * region.height * 4);
  let out = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    const start = (y * DARK_GRADIENT_RESOLUTION.width + region.x) * 4;
    const end = start + region.width * 4;
    result.set(bytes.subarray(start, end), out);
    out += region.width * 4;
  }
  return result;
}

function scanlineBytes(bytes) {
  const { y, xStart, xEnd } = fixture.scanline;
  const start = (y * DARK_GRADIENT_RESOLUTION.width + xStart) * 4;
  return bytes.subarray(start, start + (xEnd - xStart) * 4);
}

function uniqueLumaLevels(bytes) {
  const levels = new Set();
  for (let index = 0; index + 2 < bytes.length; index += 4) {
    levels.add(Math.round(0.2126 * bytes[index] + 0.7152 * bytes[index + 1] + 0.0722 * bytes[index + 2]));
  }
  return levels.size;
}

function mutate(bytes, mutation) {
  const result = new Uint8Array(bytes);
  for (let index = 0; index + 2 < result.length; index += 4) {
    if (mutation === 'eight-bit-intermediate') {
      result[index] = Math.round(result[index] / 16) * 16;
      result[index + 1] = Math.round(result[index + 1] / 16) * 16;
      result[index + 2] = Math.round(result[index + 2] / 16) * 16;
    } else if (mutation === 'missing-oetf') {
      result[index] = Math.round((result[index] / 255) ** 2 * 255);
      result[index + 1] = Math.round((result[index + 1] / 255) ** 2 * 255);
      result[index + 2] = Math.round((result[index + 2] / 255) ** 2 * 255);
    } else {
      result[index] = Math.round(Math.sqrt(result[index] / 255) * 255);
      result[index + 1] = Math.round(Math.sqrt(result[index + 1] / 255) * 255);
      result[index + 2] = Math.round(Math.sqrt(result[index + 2] / 255) * 255);
    }
  }
  return result;
}

function meanAbsoluteChannelDelta(bytes, referenceBytes) {
  if (referenceBytes === undefined) return 0;
  if (bytes.length !== referenceBytes.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (index % 4 === 3) continue;
    total += Math.abs(bytes[index] - referenceBytes[index]) / 255;
  }
  return total / bytes.length;
}

export function computeDarkGradientMetrics(value, reference) {
  const bytes = asBytes(value);
  const referenceBytes = reference === undefined ? undefined : asBytes(reference);
  const roi = regionBytes(bytes, fixture.roi);
  const referenceRoi = referenceBytes === undefined ? undefined : regionBytes(referenceBytes, fixture.roi);
  const pixelCount = Math.floor(roi.length / 4);
  const colors = uniqueColorCount(roi);
  const referenceColors = referenceRoi === undefined ? undefined : uniqueColorCount(referenceRoi);
  const scanline = scanlineBytes(bytes);
  const referenceScanline = referenceBytes === undefined ? undefined : scanlineBytes(referenceBytes);
  const levels = uniqueLumaLevels(scanline);
  const referenceLevels = referenceScanline === undefined ? undefined : uniqueLumaLevels(referenceScanline);
  return Object.freeze({
    uniqueColorRatio: referenceColors === undefined
      ? (pixelCount === 0 ? 0 : colors / pixelCount)
      : (referenceColors === 0 ? 0 : colors / referenceColors),
    levelRatio: referenceLevels === undefined
      ? levels / 256
      : (referenceLevels === 0 ? 0 : levels / referenceLevels),
    uniqueColorCount: colors,
    referenceUniqueColorCount: referenceColors ?? 0,
    meanAbsoluteChannelDelta: referenceRoi === undefined ? Number.POSITIVE_INFINITY : meanAbsoluteChannelDelta(roi, referenceRoi),
    affectedPixelRatio: affectedPixelRatio(bytes, referenceBytes),
    roiMeanLuma: pixelCount === 0 ? 0 : roi.reduce((sum, value, index) => index % 4 === 3 ? sum : sum + value, 0) / (pixelCount * 3 * 255),
    scanlineLevels: levels,
    referenceScanlineLevels: referenceLevels ?? 0,
    parity: referenceBytes === undefined ? 0 : Math.max(0, 1 - meanAbsoluteChannelDelta(roi, referenceRoi)),
    nonBlackPixels: nonBlackPixelCount(bytes),
    validationErrors: Object.freeze(
      bytes.length === DARK_GRADIENT_RESOLUTION.width * DARK_GRADIENT_RESOLUTION.height * 4
        ? []
        : [`rgba8 readback length ${bytes.length} does not match the fixture resolution`],
    ),
    pixelHash: bytes.length === 0 ? '' : hashPixels(bytes),
  });
}

export function createDarkGradientFalsifiers(results = {}) {
  return Object.freeze(DARK_GRADIENT_MUTATIONS.map((mutation) => Object.freeze({
    mutation,
    expectedGate: EXPECTED_FALSIFIER_GATES[mutation],
    actualFailedGates: Object.freeze([]),
    passed: results[mutation] === true,
  })));
}

export function runDarkGradientFalsifiers(bytes, referenceBytes) {
  const baseline = computeDarkGradientMetrics(bytes, referenceBytes);
  const pixelFalsifiers = DARK_GRADIENT_MUTATIONS.slice(0, 3).map((mutation) => {
    const mutated = computeDarkGradientMetrics(mutate(asBytes(bytes), mutation), referenceBytes);
    const failedGates = [
      [mutated.uniqueColorRatio >= DARK_GRADIENT_THRESHOLDS.uniqueColorRatio, 'uniqueColorRatio'],
      [mutated.levelRatio >= DARK_GRADIENT_THRESHOLDS.levelRatio, 'levelRatio'],
      [mutated.meanAbsoluteChannelDelta <= DARK_GRADIENT_THRESHOLDS.meanAbsoluteChannelDelta, 'meanAbsoluteChannelDelta'],
      [mutated.parity >= DARK_GRADIENT_THRESHOLDS.parity, 'parity'],
      [mutated.roiMeanLuma >= DARK_GRADIENT_THRESHOLDS.minimumRoiMeanLuma && mutated.scanlineLevels > 0, 'brightness'],
    ].filter(([passed]) => !passed).map(([, gate]) => gate);
    return Object.freeze({
      mutation,
      expectedGate: EXPECTED_FALSIFIER_GATES[mutation],
      actualFailedGates: Object.freeze(failedGates),
      passed: failedGates.length === 0 && baseline.uniqueColorRatio >= DARK_GRADIENT_THRESHOLDS.uniqueColorRatio,
    });
  });
  return Object.freeze([...pixelFalsifiers, ...runDarkGradientRouteFalsifiers()]);
}

export function createInsufficientEvidenceReport({ backendId, lane, reason, diagnostics }) {
  return Object.freeze({
    schema: DARK_GRADIENT_REPORT_SCHEMA,
    status: 'insufficient-evidence',
    fixture: {
      id: DARK_GRADIENT_FIXTURE_ID,
      frameCount: DARK_GRADIENT_FRAME_COUNT,
      resolution: DARK_GRADIENT_RESOLUTION,
    },
    observation: {
      backendId,
      lane,
      sampleFrameCount: DARK_GRADIENT_FRAME_COUNT,
      observationId: '',
      frameId: 0,
      surfaceIdentity: '',
      rendererInspectionRef: '',
      antialias: 'fxaa',
      surfaceProfile: 'raw-only',
      rgba16floatRenderable: false,
      passNames: [],
    },
    referenceObservation: {
      backendId,
      lane,
      sampleFrameCount: DARK_GRADIENT_FRAME_COUNT,
      observationId: '',
      frameId: 0,
      rendererInspectionRef: '',
      antialias: 'none',
      surfaceProfile: 'raw-only',
      rgba16floatRenderable: false,
      passNames: [],
    },
    surface: {
      storageFormat: '',
      displayFormat: '',
      intermediateFormat: '',
      domain: 'display-encoded',
      endpoint: 'surface.storage.raw',
    },
    presentationProof: { descriptor: false, acquisition: false, validation: false },
    pixelReadbackEvidence: {
      fixtureId: DARK_GRADIENT_FIXTURE_ID,
      backendId,
      lane,
      observationId: '',
      frameId: 0,
      surfaceIdentity: '',
      source: pixelSourceForBackend(backendId),
      byteLength: 0,
      status: 'empty',
      metrics: {},
    },
    pixelSource: pixelSourceForBackend(backendId),
    metrics: {
      uniqueColorRatio: 0,
      levelRatio: 0,
      uniqueColorCount: 0,
      referenceUniqueColorCount: 0,
      meanAbsoluteChannelDelta: Number.POSITIVE_INFINITY,
      affectedPixelRatio: 0,
      parity: 0,
      scanlineLevels: 0,
      referenceScanlineLevels: 0,
      nonBlackPixels: 0,
      validationErrors: Object.freeze([reason]),
      pixelHash: '',
    },
    falsifiers: createDarkGradientFalsifiers(),
    ...(diagnostics === undefined ? {} : { diagnostics: Object.freeze(diagnostics) }),
    errors: Object.freeze([{
      code: 'insufficient-evidence',
      expected: 'real backend readback',
      hint: reason,
      detail: Object.freeze({ backendId, lane, entrypoint: 'dark-gradient-fixture-browser', state: diagnostics?.state ?? 'unknown' }),
    }]),
  });
}

export function createDarkGradientFixtureReport({ backendId, lane, bytes, referenceBytes, surface, presentationProof, identity, referenceIdentity, captureEvidence, sampleFrameCount = DARK_GRADIENT_FRAME_COUNT }) {
  const metrics = computeDarkGradientMetrics(bytes, referenceBytes);
  const falsifiers = runDarkGradientFalsifiers(bytes, referenceBytes);
  const pixelSource = pixelSourceForBackend(backendId);
  const hasIdentity = (value) => typeof value?.observationId === 'string' && value.observationId.length > 0 &&
    Number.isInteger(value.frameId) && value.frameId >= sampleFrameCount &&
    typeof value.rendererInspectionRef === 'string' && value.rendererInspectionRef.length > 0;
  const failures = [
    [Number.isSafeInteger(sampleFrameCount) && sampleFrameCount >= DARK_GRADIENT_FRAME_COUNT, 'sampleFrameCount'],
    [referenceBytes !== undefined, 'referenceReadback'],
    [metrics.uniqueColorRatio >= DARK_GRADIENT_THRESHOLDS.uniqueColorRatio, 'uniqueColorRatio'],
    [metrics.levelRatio >= DARK_GRADIENT_THRESHOLDS.levelRatio, 'levelRatio'],
    [metrics.referenceUniqueColorCount >= DARK_GRADIENT_THRESHOLDS.minimumReferenceUniqueColors, 'referenceUniqueColorCount'],
    [metrics.referenceScanlineLevels >= DARK_GRADIENT_THRESHOLDS.minimumReferenceScanlineLevels, 'referenceScanlineLevels'],
    [metrics.meanAbsoluteChannelDelta <= DARK_GRADIENT_THRESHOLDS.meanAbsoluteChannelDelta, 'meanAbsoluteChannelDelta'],
    [metrics.parity >= DARK_GRADIENT_THRESHOLDS.parity, 'parity'],
    [metrics.roiMeanLuma >= DARK_GRADIENT_THRESHOLDS.minimumRoiMeanLuma && metrics.scanlineLevels > 0, 'brightness'],
    [metrics.nonBlackPixels > 0, 'nonBlackPixels'],
    [metrics.validationErrors.length === 0, 'validationErrors'],
    [metrics.pixelHash.length > 0, 'pixelHash'],
    [falsifiers.every((entry) => entry.passed === false), 'falsifiers'],
    [surface.intermediateFormat === 'rgba16float', 'surface.intermediateFormat'],
    [surface.domain === 'display-encoded', 'surface.domain'],
    [surface.endpoint === 'surface.storage.raw', 'surface.endpoint'],
    [!isWebgl2Backend(backendId) || (presentationProof?.descriptor === true && presentationProof?.acquisition === true && presentationProof?.validation === true && typeof presentationProof?.surfaceIdentity === 'string' && presentationProof.surfaceIdentity.length > 0 && JSON.stringify(presentationProof.requested) === JSON.stringify(presentationProof.validated)), 'presentationProof'],
    [pixelSource.endpoint.length > 0 && pixelSource.method.length > 0, 'pixelSource'],
    [hasIdentity(identity), 'observationIdentity'],
    [hasIdentity(referenceIdentity), 'referenceObservationIdentity'],
    [identity?.antialias === 'fxaa', 'observation.antialias'],
    [referenceIdentity?.antialias === 'none', 'referenceObservation.antialias'],
    [identity?.surfaceProfile === 'dual-view' || identity?.surfaceProfile === 'raw-only', 'observation.surfaceProfile'],
    [referenceIdentity?.surfaceProfile === 'dual-view' || referenceIdentity?.surfaceProfile === 'raw-only', 'referenceObservation.surfaceProfile'],
    [identity?.rgba16floatRenderable === true, 'observation.rgba16floatRenderable'],
    [referenceIdentity?.rgba16floatRenderable === true, 'referenceObservation.rgba16floatRenderable'],
    [Array.isArray(identity?.passNames) && identity.passNames.includes('output-transform') && identity.passNames.includes('fxaa'), 'observation.passNames'],
    [Array.isArray(referenceIdentity?.passNames), 'referenceObservation.passNames'],
    [identity?.standardOutputColor?.format === 'rgba16float' && identity.standardOutputColor?.domain === 'display-encoded', 'observation.standardOutputColor'],
    [identity?.observationId !== referenceIdentity?.observationId || identity?.frameId !== referenceIdentity?.frameId, 'pairedObservationIdentity'],
  ].filter(([passed]) => !passed).map(([, field]) => field);
  const status = failures.length === 0 ? 'complete' : 'insufficient-evidence';
  return Object.freeze({
    schema: DARK_GRADIENT_REPORT_SCHEMA,
    status,
    fixture: {
      id: DARK_GRADIENT_FIXTURE_ID,
      frameCount: DARK_GRADIENT_FRAME_COUNT,
      resolution: DARK_GRADIENT_RESOLUTION,
    },
    observation: {
      backendId,
      lane,
      sampleFrameCount,
      observationId: identity?.observationId ?? '',
      frameId: identity?.frameId ?? 0,
      rendererInspectionRef: identity?.rendererInspectionRef ?? '',
      antialias: identity?.antialias ?? 'fxaa',
      surfaceProfile: identity?.surfaceProfile ?? '',
      rgba16floatRenderable: identity?.rgba16floatRenderable === true,
      passNames: identity?.passNames ?? [],
      ...(identity?.standardOutputColor === undefined ? {} : { standardOutputColor: identity.standardOutputColor }),
    },
    referenceObservation: {
      backendId,
      lane,
      sampleFrameCount,
      observationId: referenceIdentity?.observationId ?? '',
      frameId: referenceIdentity?.frameId ?? 0,
      rendererInspectionRef: referenceIdentity?.rendererInspectionRef ?? '',
      antialias: referenceIdentity?.antialias ?? 'none',
      surfaceProfile: referenceIdentity?.surfaceProfile ?? '',
      rgba16floatRenderable: referenceIdentity?.rgba16floatRenderable === true,
      passNames: referenceIdentity?.passNames ?? [],
      ...(referenceIdentity?.standardOutputColor === undefined ? {} : { standardOutputColor: referenceIdentity.standardOutputColor }),
    },
    surface: { ...surface, endpoint: 'surface.storage.raw' },
    presentationProof: presentationProof ?? { descriptor: false, acquisition: false, validation: false },
    pixelReadbackEvidence: {
      fixtureId: DARK_GRADIENT_FIXTURE_ID,
      backendId,
      lane,
      observationId: identity?.observationId ?? '',
      frameId: identity?.frameId ?? 0,
      ...(typeof presentationProof?.surfaceIdentity === 'string' ? { surfaceIdentity: presentationProof.surfaceIdentity } : {}),
      source: pixelSource,
      byteLength: bytes?.byteLength ?? bytes?.length ?? 0,
      status: (bytes?.byteLength ?? bytes?.length ?? 0) > 0 ? 'present' : 'empty',
      metrics,
    },
    pixelSource,
    metrics,
    falsifiers,
    ...(captureEvidence === undefined ? {} : { captureEvidence: Object.freeze(captureEvidence) }),
    errors: Object.freeze([
      ...metrics.validationErrors.map((detail) => ({ code: 'validation-error', expected: 'valid RGBA readback', hint: detail })),
      ...failures.map((field) => ({
        code: 'insufficient-evidence',
        expected: `dark-gradient threshold ${field}`,
        hint: `real producer evidence did not satisfy ${field}`,
        detail: { backendId, lane, entrypoint: 'dark-gradient-dawn-smoke' },
      })),
    ]),
  });
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    args.set(token.slice(2), argv[index + 1]);
    index += 1;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (args.has('bench')) {
    const report = createInsufficientPairedFloatBenchReport({ reason: args.get('reason') ?? 'GPU timing provider was not supplied' });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
  } else {
    const backendId = args.get('backend') ?? 'browser-webgpu';
    const lane = args.get('lane') ?? 'direct';
    const reason = args.get('reason') ?? 'real browser/Dawn readback entry was not supplied';
    const report = createInsufficientEvidenceReport({ backendId, lane, reason });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
  }
}
