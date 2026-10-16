/**
 * Engine-owned dark-gradient fixture facts shared by browser and Dawn entry
 * points. Pixel payloads belong to the fixture report producer, not Renderer.
 */

import fixture from '../dark-gradient-fixture.json';
import type { Antialias } from '@forgeax/engine-render';

export const DARK_GRADIENT_REPORT_SCHEMA = fixture.schema;
export const DARK_GRADIENT_FIXTURE_ID = fixture.id;
export const DARK_GRADIENT_FIXTURE = Object.freeze(fixture);

export type DarkGradientLane = (typeof DARK_GRADIENT_FIXTURE.lanes)[number];
export type DarkGradientBackend = (typeof DARK_GRADIENT_FIXTURE.backends)[number];

/**
 * RHI backend identity observed by the renderer inspection. The provider
 * label used for browser pixels is valid only after this identity is checked.
 */
export type DarkGradientRhiBackendKind = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';

/**
 * Resolve a browser provider label from an observed RHI backend and the
 * explicit route hint. A fallback route is evidence-producing only when the
 * renderer reports the WebGL2 RHI; a normal route is evidence-producing only
 * when it reports browser WebGPU and carries no fallback hint.
 */
export function resolveDarkGradientBrowserBackend(
  actualBackendKind: DarkGradientRhiBackendKind,
  backendHint: DarkGradientBackend | undefined,
): DarkGradientBackend | undefined {
  if (actualBackendKind === 'webgpu') {
    return backendHint === undefined ? 'browser-webgpu' : undefined;
  }
  if (
    actualBackendKind === 'wgpu-webgl2' &&
    (backendHint === 'chromium-webgl2' || backendHint === 'webkit-webgl2')
  ) {
    return backendHint;
  }
  return undefined;
}

export interface DarkGradientObservationRef {
  readonly backendId: DarkGradientBackend;
  readonly lane: DarkGradientLane;
  readonly sampleFrameCount: number;
  readonly observationId: string;
  readonly frameId: number;
  readonly rendererInspectionRef: string;
  readonly antialias: Antialias;
  readonly surfaceProfile: 'dual-view' | 'raw-only';
  readonly rgba16floatRenderable: boolean;
  readonly passNames: readonly string[];
  readonly standardOutputColor?: {
    readonly format: string;
    readonly domain?: string;
    readonly width: number;
    readonly height: number;
    readonly sampleCount: number;
    readonly usage: number;
  };
}

export interface DarkGradientSurfaceFacts {
  readonly storageFormat: string;
  readonly displayFormat: string;
  readonly intermediateFormat: string;
  readonly domain: 'display-encoded';
  readonly endpoint: 'surface.storage.raw';
}

export interface DarkGradientPixelSourceFacts {
  readonly endpoint: 'surface.storage.raw' | 'surface.display.final';
  readonly method: 'gpu-raw-readback' | 'webkit-compositor-rgba8' | 'chromium-compositor-rgba8';
}

export interface DarkGradientPresentationProof {
  readonly descriptor: boolean;
  readonly acquisition: boolean;
  readonly validation: boolean;
  readonly surfaceIdentity?: string;
  readonly requested?: DarkGradientSurfaceDescriptorFacts;
  readonly validated?: DarkGradientSurfaceDescriptorFacts;
}

export interface DarkGradientSurfaceDescriptorFacts {
  readonly format: string;
  readonly usage: number;
  readonly width: number;
  readonly height: number;
  readonly alphaMode: string;
  readonly presentMode: string;
}

export interface DarkGradientPixelReadbackEvidence {
  readonly fixtureId: string;
  readonly backendId: DarkGradientBackend;
  readonly lane: DarkGradientLane;
  readonly observationId: string;
  readonly frameId: number;
  readonly surfaceIdentity?: string;
  readonly source: DarkGradientPixelSourceFacts;
  readonly byteLength: number;
  readonly status: 'present' | 'empty';
  readonly metrics: DarkGradientPixelMetrics;
}

export interface DarkGradientPixelMetrics {
  readonly uniqueColorRatio: number;
  readonly levelRatio: number;
  readonly uniqueColorCount: number;
  readonly referenceUniqueColorCount: number;
  readonly meanAbsoluteChannelDelta: number;
  /** Diagnostic only; visual acceptance is owned by the independent fixture gates below. */
  readonly affectedPixelRatio: number;
  readonly roiMeanLuma: number;
  readonly scanlineLevels: number;
  readonly referenceScanlineLevels: number;
  readonly parity: number;
  readonly nonBlackPixels: number;
  readonly validationErrors: readonly string[];
  readonly pixelHash: string;
}

export type DarkGradientMutation =
  | 'eight-bit-intermediate'
  | 'missing-oetf'
  | 'duplicate-oetf'
  | 'missing-surface-view-capability'
  | 'raw-only-overlay-after-transform';

export interface DarkGradientFalsifier {
  readonly mutation: DarkGradientMutation;
  readonly expectedGate: string;
  readonly actualFailedGates: readonly string[];
  readonly passed: boolean;
}

export interface DarkGradientFixtureReport {
  readonly schema: typeof DARK_GRADIENT_REPORT_SCHEMA;
  readonly fixture: typeof DARK_GRADIENT_FIXTURE;
  readonly observation: DarkGradientObservationRef;
  readonly referenceObservation: DarkGradientObservationRef;
  readonly surface: DarkGradientSurfaceFacts;
  readonly presentationProof?: DarkGradientPresentationProof;
  readonly pixelReadbackEvidence: DarkGradientPixelReadbackEvidence;
  readonly pixelSource: DarkGradientPixelSourceFacts;
  readonly metrics: DarkGradientPixelMetrics;
  readonly falsifiers: readonly DarkGradientFalsifier[];
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly captureEvidence?: readonly Readonly<Record<string, unknown>>[];
}

export interface DarkGradientFixtureFailure {
  readonly code: 'dark-gradient-fixture-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly actual: unknown };
}

export type DarkGradientFixtureValidation =
  | { readonly ok: true; readonly value: undefined }
  | { readonly ok: false; readonly error: DarkGradientFixtureFailure };

function failure(field: string, actual: unknown, expected: string): DarkGradientFixtureValidation {
  return {
    ok: false,
    error: {
      code: 'dark-gradient-fixture-invalid',
      expected,
      hint: `rebuild the Engine-owned ${DARK_GRADIENT_FIXTURE_ID} report with ${field}`,
      detail: { field, actual },
    },
  };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateDarkGradientFixtureReport(
  report: DarkGradientFixtureReport,
): DarkGradientFixtureValidation {
  if (report.schema !== DARK_GRADIENT_REPORT_SCHEMA) {
    return failure('schema', report.schema, DARK_GRADIENT_REPORT_SCHEMA);
  }
  if (report.fixture.id !== DARK_GRADIENT_FIXTURE_ID || report.fixture.frameCount !== 60) {
    return failure('fixture identity/frameCount', report.fixture, 'the frozen M4 fixture identity and 60 frames');
  }
  if (!DARK_GRADIENT_FIXTURE.lanes.includes(report.observation.lane)) {
    return failure('observation.lane', report.observation.lane, 'direct or clustered');
  }
  if (!DARK_GRADIENT_FIXTURE.backends.includes(report.observation.backendId)) {
    return failure('observation.backendId', report.observation.backendId, 'a concrete M4 backend');
  }
  for (const [name, observation] of [
    ['observation', report.observation],
    ['referenceObservation', report.referenceObservation],
  ] as const) {
    if (observation.sampleFrameCount !== DARK_GRADIENT_FIXTURE.frameCount) {
      return failure(`${name}.sampleFrameCount`, observation.sampleFrameCount, 'the fixture 60-frame sample count');
    }
    if (!Number.isInteger(observation.frameId) || observation.frameId < observation.sampleFrameCount) {
      return failure(`${name}.frameId`, observation.frameId, 'the actual final renderer frame at or after the 60-frame sample');
    }
    if (!isNonEmpty(observation.observationId) || !isNonEmpty(observation.rendererInspectionRef)) {
      return failure(`${name} identity refs`, observation, 'non-empty stable identity references');
    }
    const expectedAntialias = name === 'observation' ? 'fxaa' : 'none';
    if (observation.antialias !== expectedAntialias) {
      return failure(`${name}.antialias`, observation.antialias, expectedAntialias);
    }
    if (observation.surfaceProfile !== 'dual-view' && observation.surfaceProfile !== 'raw-only') {
      return failure(`${name}.surfaceProfile`, observation.surfaceProfile, 'dual-view or raw-only');
    }
    if (observation.rgba16floatRenderable !== true) {
      return failure(`${name}.rgba16floatRenderable`, observation.rgba16floatRenderable, 'true');
    }
    if (!Array.isArray(observation.passNames)) {
      return failure(`${name}.passNames`, observation.passNames, 'the committed graph pass names');
    }
    if (name === 'observation') {
      if (!observation.passNames.includes('output-transform') || !observation.passNames.includes('fxaa')) {
        return failure(`${name}.passNames`, observation.passNames, 'output-transform and fxaa');
      }
      if (
        observation.standardOutputColor?.format !== 'rgba16float' ||
        observation.standardOutputColor.domain !== 'display-encoded'
      ) {
        return failure(
          `${name}.standardOutputColor`,
          observation.standardOutputColor,
          'rgba16float/display-encoded',
        );
      }
    }
  }
  if (
    report.observation.observationId === report.referenceObservation.observationId &&
    report.observation.frameId === report.referenceObservation.frameId
  ) {
    return failure('paired observation identity', report.observation, 'distinct no-FXAA and FXAA renderer observations');
  }
  if (report.surface.intermediateFormat !== 'rgba16float') {
    return failure('surface.intermediateFormat', report.surface.intermediateFormat, 'rgba16float');
  }
  if (report.surface.domain !== 'display-encoded' || report.surface.endpoint !== 'surface.storage.raw') {
    return failure('surface domain/endpoint', report.surface, 'display-encoded inspection facts through surface.storage.raw');
  }
  const requiresPresentationProof = report.observation.backendId === 'webkit-webgl2' || report.observation.backendId === 'chromium-webgl2';
  if (
    requiresPresentationProof &&
    (report.presentationProof === undefined ||
      report.presentationProof.descriptor !== true ||
      report.presentationProof.acquisition !== true ||
      report.presentationProof.validation !== true ||
      !isNonEmpty(report.presentationProof.surfaceIdentity) ||
      report.presentationProof.requested === undefined ||
      report.presentationProof.validated === undefined ||
      JSON.stringify(report.presentationProof.requested) !== JSON.stringify(report.presentationProof.validated))
  ) {
    return failure('presentationProof', report.presentationProof, 'WebGL2 descriptor, acquisition, validation, identity, and matching descriptor facts');
  }
  if (
    report.pixelReadbackEvidence === undefined ||
    report.pixelReadbackEvidence.fixtureId !== DARK_GRADIENT_FIXTURE_ID ||
    report.pixelReadbackEvidence.backendId !== report.observation.backendId ||
    report.pixelReadbackEvidence.lane !== report.observation.lane ||
    report.pixelReadbackEvidence.observationId !== report.observation.observationId ||
    report.pixelReadbackEvidence.frameId !== report.observation.frameId ||
    ((report.observation.backendId === 'webkit-webgl2' || report.observation.backendId === 'chromium-webgl2') &&
      report.pixelReadbackEvidence.surfaceIdentity !== report.presentationProof?.surfaceIdentity)
  ) {
    return failure('pixelReadbackEvidence identity', report.pixelReadbackEvidence, 'post-frame pixels matching fixture, backend, lane, observation, and WebGL2 surface identity');
  }
  if (
    report.pixelReadbackEvidence.status !== 'present' ||
    report.pixelReadbackEvidence.byteLength !==
      DARK_GRADIENT_FIXTURE.resolution.width * DARK_GRADIENT_FIXTURE.resolution.height * 4
  ) {
    return failure('pixelReadbackEvidence bytes', report.pixelReadbackEvidence, 'a complete non-empty RGBA8 readback');
  }
  const expectedPixelSource = {
    'browser-webgpu': { endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' },
    dawn: { endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' },
    'webkit-webgl2': { endpoint: 'surface.display.final', method: 'webkit-compositor-rgba8' },
    'chromium-webgl2': { endpoint: 'surface.display.final', method: 'chromium-compositor-rgba8' },
  }[report.observation.backendId];
  if (
    expectedPixelSource === undefined ||
    report.pixelSource.endpoint !== expectedPixelSource.endpoint ||
    report.pixelSource.method !== expectedPixelSource.method
  ) {
    return failure('pixelSource', report.pixelSource, `the ${report.observation.backendId} pixel source contract`);
  }
  if (
    report.pixelReadbackEvidence.source.endpoint !== report.pixelSource.endpoint ||
    report.pixelReadbackEvidence.source.method !== report.pixelSource.method ||
    JSON.stringify(report.pixelReadbackEvidence.metrics) !== JSON.stringify(report.metrics)
  ) {
    return failure('pixelReadbackEvidence source/metrics', report.pixelReadbackEvidence, 'the single producer-owned pixel source and metric set');
  }
  const metrics = report.metrics;
  if (metrics.uniqueColorRatio < DARK_GRADIENT_FIXTURE.thresholds.uniqueColorRatio) {
    return failure('metrics.uniqueColorRatio', metrics.uniqueColorRatio, 'ratio >= 0.75');
  }
  if (metrics.levelRatio < DARK_GRADIENT_FIXTURE.thresholds.levelRatio) {
    return failure('metrics.levelRatio', metrics.levelRatio, 'ratio >= 0.70');
  }
  if (metrics.referenceUniqueColorCount < DARK_GRADIENT_FIXTURE.thresholds.minimumReferenceUniqueColors) {
    return failure('metrics.referenceUniqueColorCount', metrics.referenceUniqueColorCount, 'the no-FXAA baseline minimum diversity');
  }
  if (metrics.referenceScanlineLevels < DARK_GRADIENT_FIXTURE.thresholds.minimumReferenceScanlineLevels) {
    return failure('metrics.referenceScanlineLevels', metrics.referenceScanlineLevels, 'the no-FXAA baseline minimum scanline diversity');
  }
  if (metrics.meanAbsoluteChannelDelta > DARK_GRADIENT_FIXTURE.thresholds.meanAbsoluteChannelDelta) {
    return failure('metrics.meanAbsoluteChannelDelta', metrics.meanAbsoluteChannelDelta, 'delta <= 2/255');
  }
  if (metrics.roiMeanLuma < DARK_GRADIENT_FIXTURE.thresholds.minimumRoiMeanLuma || metrics.scanlineLevels <= 0) {
    return failure('metrics.roiMeanLuma/scanlineLevels', metrics, 'real ROI brightness and scanline level evidence');
  }
  if (metrics.parity < DARK_GRADIENT_FIXTURE.thresholds.parity) {
    return failure('metrics.parity', metrics.parity, 'cross-backend parity >= 0.95');
  }
  if (metrics.nonBlackPixels <= 0) return failure('metrics.nonBlackPixels', metrics.nonBlackPixels, 'a non-black frame');
  if (!Array.isArray(metrics.validationErrors) || metrics.validationErrors.length !== 0) {
    return failure('metrics.validationErrors', metrics.validationErrors, 'zero validation errors');
  }
  if (!isNonEmpty(metrics.pixelHash)) return failure('metrics.pixelHash', metrics.pixelHash, 'a producer-owned pixel hash');
  const expectedMutations: readonly DarkGradientMutation[] = [
    'eight-bit-intermediate',
    'missing-oetf',
    'duplicate-oetf',
    'missing-surface-view-capability',
    'raw-only-overlay-after-transform',
  ];
  if (
    report.falsifiers.length !== expectedMutations.length ||
    expectedMutations.some((mutation, index) => {
      const falsifier = report.falsifiers[index];
      return falsifier?.mutation !== mutation || falsifier.passed !== false ||
        !falsifier.actualFailedGates.includes(falsifier.expectedGate);
    })
  ) {
    return failure('falsifiers', report.falsifiers, 'all five mutation gates must fail');
  }
  return { ok: true, value: undefined };
}
