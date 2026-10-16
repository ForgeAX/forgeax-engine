import { describe, expect, it } from 'vitest';
import {
  DARK_GRADIENT_FIXTURE,
  DARK_GRADIENT_REPORT_SCHEMA,
  validateDarkGradientFixtureReport,
  type DarkGradientFixtureReport,
} from '../dark-gradient-fixture';

const WEBGL2_FACTS = {
  format: 'Rgba8Unorm',
  usage: 0x10,
  width: 800,
  height: 600,
  alphaMode: 'Auto',
  presentMode: 'Fifo',
} as const;

const WEBGL2_PROOF = {
  descriptor: true,
  acquisition: true,
  validation: true,
  surfaceIdentity: 'surface-1',
  requested: WEBGL2_FACTS,
  validated: WEBGL2_FACTS,
} as const;

const VALID_REPORT: DarkGradientFixtureReport = {
  schema: DARK_GRADIENT_REPORT_SCHEMA,
  fixture: DARK_GRADIENT_FIXTURE,
  observation: {
    backendId: 'browser-webgpu',
    lane: 'direct',
    sampleFrameCount: 60,
    observationId: 'observation-1',
    frameId: 60,
    rendererInspectionRef: 'inspection-1',
    antialias: 'fxaa',
    surfaceProfile: 'dual-view',
    rgba16floatRenderable: true,
    passNames: ['standard', 'output-transform', 'fxaa'],
    standardOutputColor: {
      format: 'rgba16float',
      domain: 'display-encoded',
      width: 800,
      height: 600,
      sampleCount: 1,
      usage: 0x04,
    },
  },
  referenceObservation: {
    backendId: 'browser-webgpu',
    lane: 'direct',
    sampleFrameCount: 60,
    observationId: 'observation-0',
    frameId: 60,
    rendererInspectionRef: 'inspection-0',
    antialias: 'none',
    surfaceProfile: 'dual-view',
    rgba16floatRenderable: true,
    passNames: ['standard', 'output-transform'],
  },
  surface: {
    storageFormat: 'rgba16float',
    displayFormat: 'rgba8unorm',
    intermediateFormat: 'rgba16float',
    domain: 'display-encoded',
    endpoint: 'surface.storage.raw',
  },
  presentationProof: {
    descriptor: true,
    acquisition: true,
    validation: true,
  },
  pixelReadbackEvidence: {
    fixtureId: 'hello-fxaa/dark-gradient/v1',
    backendId: 'browser-webgpu',
    lane: 'direct',
    observationId: 'observation-1',
    frameId: 60,
    source: {
      endpoint: 'surface.storage.raw',
      method: 'gpu-raw-readback',
    },
    byteLength: 800 * 600 * 4,
    status: 'present',
    metrics: {
      uniqueColorRatio: 0.8,
      levelRatio: 0.75,
      uniqueColorCount: 192,
      referenceUniqueColorCount: 240,
      meanAbsoluteChannelDelta: 1 / 255,
      affectedPixelRatio: 0.01,
      roiMeanLuma: 0.12,
      scanlineLevels: 192,
      referenceScanlineLevels: 240,
      parity: 0.99,
      nonBlackPixels: 100,
      validationErrors: [],
      pixelHash: 'sha256:fixture-hash',
    },
  },
  pixelSource: {
    endpoint: 'surface.storage.raw',
    method: 'gpu-raw-readback',
  },
  metrics: {
    uniqueColorRatio: 0.8,
    levelRatio: 0.75,
    uniqueColorCount: 192,
    referenceUniqueColorCount: 240,
    meanAbsoluteChannelDelta: 1 / 255,
    affectedPixelRatio: 0.01,
    roiMeanLuma: 0.12,
    scanlineLevels: 192,
    referenceScanlineLevels: 240,
    parity: 0.99,
    nonBlackPixels: 100,
    validationErrors: [],
    pixelHash: 'sha256:fixture-hash',
  },
  falsifiers: [
    { mutation: 'eight-bit-intermediate', expectedGate: 'uniqueColorRatio', actualFailedGates: ['uniqueColorRatio'], passed: false },
    { mutation: 'missing-oetf', expectedGate: 'brightness', actualFailedGates: ['brightness'], passed: false },
    { mutation: 'duplicate-oetf', expectedGate: 'meanAbsoluteChannelDelta', actualFailedGates: ['meanAbsoluteChannelDelta'], passed: false },
    { mutation: 'missing-surface-view-capability', expectedGate: 'surface-view-capability', actualFailedGates: ['surface-view-capability'], passed: false },
    { mutation: 'raw-only-overlay-after-transform', expectedGate: 'raw-only-overlay-ordering', actualFailedGates: ['raw-only-overlay-ordering'], passed: false },
  ],
};

function webgl2Report(
  backendId: 'webkit-webgl2' | 'chromium-webgl2',
  method: 'webkit-compositor-rgba8' | 'chromium-compositor-rgba8',
  overrides: {
  presentationProof?: NonNullable<DarkGradientFixtureReport['presentationProof']>;
  pixelReadbackEvidence?: DarkGradientFixtureReport['pixelReadbackEvidence'];
} = {},
): DarkGradientFixtureReport {
  const report: DarkGradientFixtureReport = {
    ...VALID_REPORT,
    observation: { ...VALID_REPORT.observation, backendId },
    referenceObservation: { ...VALID_REPORT.referenceObservation, backendId },
    presentationProof: WEBGL2_PROOF,
    pixelSource: { endpoint: 'surface.display.final', method },
    pixelReadbackEvidence: {
      ...VALID_REPORT.pixelReadbackEvidence,
      backendId,
      source: { endpoint: 'surface.display.final', method },
      surfaceIdentity: 'surface-1',
    },
    ...('presentationProof' in overrides ? { presentationProof: overrides.presentationProof } : {}),
    ...('pixelReadbackEvidence' in overrides ? { pixelReadbackEvidence: overrides.pixelReadbackEvidence } : {}),
  };
  return report;
}

function webkitReport(overrides: {
  presentationProof?: NonNullable<DarkGradientFixtureReport['presentationProof']>;
  pixelReadbackEvidence?: DarkGradientFixtureReport['pixelReadbackEvidence'];
} = {}): DarkGradientFixtureReport {
  return webgl2Report('webkit-webgl2', 'webkit-compositor-rgba8', overrides);
}

describe('M4 dark-gradient fixture contract', () => {
  it('owns one fixed fixture identity and 60-frame low-light parameters', () => {
    expect(DARK_GRADIENT_FIXTURE.id).toBe('hello-fxaa/dark-gradient/v1');
    expect(DARK_GRADIENT_FIXTURE.frameCount).toBe(60);
    expect(DARK_GRADIENT_FIXTURE.scene.lightIntensity).toBeLessThan(0.2);
    expect(DARK_GRADIENT_FIXTURE.camera.position).toEqual([0, 0, 6]);
    expect(DARK_GRADIENT_FIXTURE.lanes).toEqual(['direct', 'clustered']);
    expect(DARK_GRADIENT_FIXTURE.backends).toEqual(['browser-webgpu', 'dawn', 'webkit-webgl2', 'chromium-webgl2']);
    expect(DARK_GRADIENT_FIXTURE.roi.width).toBeGreaterThan(0);
    expect(DARK_GRADIENT_FIXTURE.scanline.y).toBeGreaterThanOrEqual(0);
  });

  it('accepts the complete structured report and keeps metrics outside inspection', () => {
    const result = validateDarkGradientFixtureReport(VALID_REPORT);
    expect(result.ok).toBe(true);
    expect(VALID_REPORT.observation).not.toHaveProperty('pixels');
    expect(VALID_REPORT.observation).not.toHaveProperty('uniqueColorRatio');
  });

  it('rejects a report that has pixels but no configure-time presentation proof', () => {
    const result = validateDarkGradientFixtureReport(webkitReport({
      presentationProof: { descriptor: false, acquisition: false, validation: false },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('presentationProof');
  });

  it.each(['browser-webgpu', 'dawn'] as const)('accepts %s real GPU readback without a synthetic presentation proof', (backendId) => {
    const resultInput: DarkGradientFixtureReport = {
      ...VALID_REPORT,
      observation: { ...VALID_REPORT.observation, backendId },
      referenceObservation: { ...VALID_REPORT.referenceObservation, backendId },
      pixelReadbackEvidence: { ...VALID_REPORT.pixelReadbackEvidence, backendId },
    };
    const { presentationProof: _presentationProof, ...gpuReport } = resultInput;
    expect(validateDarkGradientFixtureReport(gpuReport as DarkGradientFixtureReport).ok).toBe(true);
  });

  it('accepts Chromium WebGL2 compositor evidence without labeling it as WebKit', () => {
    const result = validateDarkGradientFixtureReport(webgl2Report('chromium-webgl2', 'chromium-compositor-rgba8'));
    expect(result.ok).toBe(true);
  });

  it('rejects pixel evidence whose fixture or frame identity does not match', () => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      pixelReadbackEvidence: {
        ...VALID_REPORT.pixelReadbackEvidence,
        fixtureId: 'other-fixture',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('pixelReadbackEvidence identity');
  });

  it('rejects pixel-only evidence without a presentation proof', () => {
    const result = validateDarkGradientFixtureReport(webkitReport({
      presentationProof: { descriptor: true, acquisition: false, validation: false },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('presentationProof');
  });

  it('rejects presentation-only evidence without complete post-frame pixels', () => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      pixelReadbackEvidence: {
        ...VALID_REPORT.pixelReadbackEvidence,
        byteLength: 0,
        status: 'empty',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('pixelReadbackEvidence bytes');
  });

  it('rejects pixel evidence with a mismatched frame identity', () => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      pixelReadbackEvidence: {
        ...VALID_REPORT.pixelReadbackEvidence,
        frameId: 301,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('pixelReadbackEvidence identity');
  });

  it.each([
    ['low ratio', { uniqueColorRatio: 0.74 }],
    ['low levels', { levelRatio: 0.69 }],
    ['mean drift', { meanAbsoluteChannelDelta: 3 / 255 }],
    ['black frame', { nonBlackPixels: 0 }],
  ])('rejects %s metric mutations', (_name, metrics) => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      metrics: { ...VALID_REPORT.metrics, ...metrics },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects missing validation, hash, and falsifier evidence', () => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      metrics: { ...VALID_REPORT.metrics, validationErrors: undefined, pixelHash: '' },
      falsifiers: [],
    } as unknown as DarkGradientFixtureReport);
    expect(result.ok).toBe(false);
  });

  it('rejects parity drift and an eight-bit intermediate even when brightness passes', () => {
    const parity = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      metrics: { ...VALID_REPORT.metrics, parity: 0.94 },
    });
    expect(parity.ok).toBe(false);

    const format = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      surface: { ...VALID_REPORT.surface, intermediateFormat: 'rgba8unorm' },
    });
    expect(format.ok).toBe(false);
  });

  it('keeps affected-pixel ratio diagnostic-only', () => {
    const metrics = { ...VALID_REPORT.metrics, affectedPixelRatio: 1 };
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      metrics,
      pixelReadbackEvidence: { ...VALID_REPORT.pixelReadbackEvidence, metrics },
    });
    expect(result.ok).toBe(true);
  });

  it('keeps inspection surface raw and validates the backend-owned pixel source', () => {
    const finalDisplaySurface = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      surface: { ...VALID_REPORT.surface, endpoint: 'surface.display.final' },
    } as unknown as DarkGradientFixtureReport);
    expect(finalDisplaySurface.ok).toBe(false);

    const webkitResult = validateDarkGradientFixtureReport(webkitReport());
    expect(webkitResult.ok).toBe(true);

    const mixedSource = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      observation: { ...VALID_REPORT.observation, backendId: 'webkit-webgl2' },
      referenceObservation: { ...VALID_REPORT.referenceObservation, backendId: 'webkit-webgl2' },
      pixelSource: { endpoint: 'surface.storage.raw', method: 'gpu-raw-readback' },
    });
    expect(mixedSource.ok).toBe(false);
  });

  it('rejects WebGL2 pixel evidence bound to another surface identity', () => {
    const result = validateDarkGradientFixtureReport(webkitReport({
      pixelReadbackEvidence: { ...webkitReport().pixelReadbackEvidence, surfaceIdentity: 'surface-2' },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('pixelReadbackEvidence identity');
  });

  it('rejects WebGL2 proof whose requested and validated descriptors differ', () => {
    const result = validateDarkGradientFixtureReport(webkitReport({
      presentationProof: {
        ...WEBGL2_PROOF,
        validated: { ...WEBGL2_FACTS, width: 1 },
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.field).toBe('presentationProof');
  });

  it('rejects a flat no-FXAA baseline even when paired ratios look healthy', () => {
    const result = validateDarkGradientFixtureReport({
      ...VALID_REPORT,
      metrics: {
        ...VALID_REPORT.metrics,
        uniqueColorRatio: 1,
        levelRatio: 1,
        referenceUniqueColorCount: DARK_GRADIENT_FIXTURE.thresholds.minimumReferenceUniqueColors - 1,
        referenceScanlineLevels: DARK_GRADIENT_FIXTURE.thresholds.minimumReferenceScanlineLevels - 1,
      },
    });
    expect(result.ok).toBe(false);
  });

  it('keeps the renderer observation identity-only while the fixture owns pixels', () => {
    const observationKeys = Object.keys(VALID_REPORT.observation);
    expect(observationKeys).toEqual([
      'backendId',
      'lane',
      'sampleFrameCount',
      'observationId',
      'frameId',
      'rendererInspectionRef',
      'antialias',
      'surfaceProfile',
      'rgba16floatRenderable',
      'passNames',
      'standardOutputColor',
    ]);
    expect(Object.keys(VALID_REPORT.referenceObservation)).toEqual(observationKeys.filter((key) => key !== 'standardOutputColor'));
    expect(VALID_REPORT.falsifiers.map((entry) => entry.mutation)).toEqual([
      'eight-bit-intermediate',
      'missing-oetf',
      'duplicate-oetf',
      'missing-surface-view-capability',
      'raw-only-overlay-after-transform',
    ]);
    expect(VALID_REPORT.falsifiers[1]).toMatchObject({ expectedGate: 'brightness', actualFailedGates: ['brightness'] });
  });
});
