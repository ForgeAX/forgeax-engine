import { describe, expect, it } from 'vitest';
import { createWaterCapabilityReport, type WaterCapabilityRequest } from '../capability-report.js';
import {
  estimateWaterResourceBudget,
  type WaterBudgetResource,
  WaterQualityBudgetPolicy,
} from '../resource-budget.js';

const request = (): WaterCapabilityRequest => ({
  quality: 'Q0',
  configuration: 'UE-R0',
  parameterIdentity: 'coast-seed-8',
  format: 'rgba16float',
  width: 256,
  height: 128,
  layers: 2,
  basicDiOrBeachFoam: false,
  device: {
    version: 1,
    compute: 'supported',
    storageBuffer: 'supported',
    indirectDraw: 'supported',
    formats: {
      rgba16float: {
        renderSample: 'supported',
        arrayRenderSample: 'supported',
        storageSample: 'supported',
      },
      rgba32float: {
        renderSample: 'supported',
        arrayRenderSample: 'supported',
        storageSample: 'supported',
      },
      depth32float: { renderSample: 'supported' },
      rg16float: { renderSample: 'supported' },
    },
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
  },
  renderer: {
    version: 1,
    deviceGeneration: 2,
    frameId: 90,
    ready: true,
    noWaterSceneCopy: true,
    singleLayerOptics: true,
    waterSurfaceDepthNormalVelocity: true,
    waterSurfaceSsr: true,
    captureSky: true,
    underwater: { available: true, active: false, execution: 'inactive' },
    waterInfo: { available: true, active: true, execution: 'retained' },
    gpuMesh: false,
    cpuMesh: true,
    deferredLighting: true,
    passes: [],
  },
  physics: {
    version: 1,
    pointForce: true,
    bodyDynamics: true,
    sphereSweepAll: true,
    sensorOverlap: true,
    solverParticipant: false,
    solverClock: false,
  },
  evidence: [],
});

describe('Water capability combination', () => {
  it('keeps deferred optional Terrain tooling outside the required R0 fidelity gates', () => {
    const input = request();
    const baseline = createWaterCapabilityReport(input);
    expect(baseline.validation.map((row) => row.id)).not.toContain('V-06');
    const evidence = baseline.validation
      .filter((row) => row.id !== 'V-06')
      .map((row) => ({
        ...row,
        configuration: 'UE-R0' as const,
        parameterIdentity: input.parameterIdentity,
        comparison: 'matched' as const,
        artifact: `ue-pair/${row.id}`,
      }));
    expect(
      createWaterCapabilityReport({
        ...input,
        evidence: [
          ...evidence,
          {
            id: 'V-06',
            configuration: 'UE-R0',
            parameterIdentity: input.parameterIdentity,
            comparison: 'unvalidated',
            artifact: 'deferred-editor-tooling',
          },
        ],
      }).fidelity,
    ).toBe('faithful');
  });
  it('keeps unavailable CPU mesh publication facts unvalidated for Q3', () => {
    const input = request();
    const report = createWaterCapabilityReport({
      ...input,
      quality: 'Q3',
      renderer: { ...input.renderer, cpuMesh: 'unvalidated' },
    });
    expect(report.requirements.find((row) => row.name === 'cpu-mesh')?.status).toBe('unvalidated');
    expect(report.implementation).toBe('unvalidated');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: 'Q3',
        renderer: { ...input.renderer, cpuMesh: 'unvalidated', gpuMesh: true },
      }).implementation,
    ).toBe('unsupported');
  });
  it('keeps implementation and paired comparison independent', () => {
    const result = createWaterCapabilityReport(request());
    expect(result.implementation).toBe('supported');
    expect(result.comparison).toBe('unvalidated');
    expect(result.fidelity).toBe('appearance-only');
    const evidence = result.validation.map((row) => ({
      ...row,
      configuration: 'UE-R0' as const,
      parameterIdentity: 'coast-seed-8',
      comparison: 'matched' as const,
      artifact: `ue-pair/${row.id}`,
    }));
    expect(createWaterCapabilityReport({ ...request(), evidence }).fidelity).toBe('faithful');
    expect(
      createWaterCapabilityReport({
        ...request(),
        quality: 'Q1',
        parameterIdentity: 'coast-q1',
        evidence,
      }).comparison,
    ).toBe('unvalidated');
    expect(
      createWaterCapabilityReport({
        ...request(),
        evidence: evidence.map((row) => ({ ...row, configuration: 'UE-R2' })),
      }).comparison,
    ).toBe('unvalidated');
  });
  it('requires the complete R0 SSR chain and keeps R2 independent', () => {
    const input = request();
    const renderer = { ...input.renderer, waterSurfaceSsr: false };
    expect(createWaterCapabilityReport({ ...input, renderer }).implementation).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...input,
        renderer,
        quality: 'Q2',
        configuration: 'UE-R2',
        reflectionMode: 'disabled',
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({ ...input, quality: 'Q2' } as WaterCapabilityRequest)
        .implementation,
    ).toBe('unsupported');
  });
  it('preserves independently selected feature branches and explicit appearance deviations', () => {
    const input = request();
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'UE-R1',
        subfeature: 'gpu-mesh',
        renderer: { ...input.renderer, gpuMesh: true },
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'UE-R5',
        subfeature: 'async-buoyancy',
        physics: { ...input.physics, solverParticipant: true, solverClock: true },
        solverExecution: 'worker-solver',
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'UE-R6',
        subfeature: 'fluid-simulation',
        renderer: { ...input.renderer, fluidSimulation: true },
      }).validation.at(-1)?.id,
    ).toBe('V-12');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'UE-R7',
        subfeature: 'ocean-fft',
        renderer: { ...input.renderer, oceanFft: true },
      }).validation.at(-1)?.id,
    ).toBe('V-14');
    expect(
      createWaterCapabilityReport({ ...input, quality: null, configuration: 'UE-R3' })
        .implementation,
    ).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: 'Q4',
        configuration: null,
        renderer: {
          ...input.renderer,
          appearanceAdapter: {
            kind: 'flat-transparent',
            composed: true,
            sourceVersion: 'adapter-v1',
          },
        },
      }),
    ).toMatchObject({ fidelity: 'appearance-only', comparison: 'deviation' });
    expect(
      createWaterCapabilityReport({ ...input, quality: 'Q4', configuration: null }).implementation,
    ).toBe('unsupported');
    expect(
      createWaterCapabilityReport({ ...input, configuration: 'UE-R1' } as WaterCapabilityRequest)
        .implementation,
    ).toBe('unsupported');
    const fft = {
      ...input,
      quality: null,
      configuration: 'UE-R7',
      subfeature: 'advanced-shallow',
      renderer: { ...input.renderer, oceanFft: true },
    } as const;
    expect(createWaterCapabilityReport(fft).implementation).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...fft,
        renderer: { ...fft.renderer, advancedShallow: true },
      }).validation.at(-1)?.id,
    ).toBe('V-13');
    expect(
      createWaterCapabilityReport({
        ...fft,
        subfeature: 'river-bake',
        renderer: { ...fft.renderer, advancedShallow: true },
      }).implementation,
    ).toBe('unsupported');
  });
  it('does not promote unprobed arrays, missing Physics, or CPU mesh without WaterInfo compute', () => {
    const input = request();
    expect(
      createWaterCapabilityReport({
        ...input,
        device: {
          ...input.device,
          formats: {
            ...input.device.formats,
            rgba16float: { ...input.device.formats.rgba16float, arrayRenderSample: 'unvalidated' },
          },
        },
      }).implementation,
    ).toBe('unvalidated');
    expect(
      createWaterCapabilityReport({
        ...input,
        physics: { ...input.physics, sphereSweepAll: false },
      }).implementation,
    ).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: 'Q3',
        device: { ...input.device, compute: 'unsupported' },
      }).implementation,
    ).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: 'Q3',
        renderer: { ...input.renderer, cpuMesh: false },
      }).implementation,
    ).toBe('unsupported');
    expect(createWaterCapabilityReport({ ...input, layers: 257 }).implementation).toBe(
      'unsupported',
    );
    expect(
      createWaterCapabilityReport({ ...input, basicDiOrBeachFoam: true }).validation.at(-1)?.id,
    ).toBe('V-16');
  });
});

describe('Water resource closure budget', () => {
  const base = {
    feature: 'water-info',
    deviceGeneration: 2,
    graphResourceVersion: 'graph-9',
    copies: 1,
    lastUseFence: null,
    state: 'active',
  } as const;
  it('includes all mips, slices, MSAA, resolves, alignment, history and uncompleted old generations', () => {
    const resources = [
      {
        ...base,
        key: 'array',
        kind: 'texture',
        format: 'rgba16float',
        width: 8,
        height: 4,
        layers: 3,
        mips: 4,
        samples: 1,
        copies: 2,
      },
      {
        ...base,
        key: 'msaa',
        kind: 'texture',
        format: 'rgba32float',
        width: 8,
        height: 4,
        layers: 1,
        mips: 1,
        samples: 4,
      },
      {
        ...base,
        key: 'resolve',
        kind: 'texture',
        format: 'rgba32float',
        width: 8,
        height: 4,
        layers: 1,
        mips: 1,
        samples: 1,
        state: 'candidate',
      },
      {
        ...base,
        key: 'old-buffer',
        kind: 'buffer',
        size: 257,
        alignment: 256,
        state: 'retiring',
        deviceGeneration: 1,
        lastUseFence: 89,
      },
    ] as const satisfies readonly WaterBudgetResource[];
    const result = estimateWaterResourceBudget(resources).unwrap();
    expect(result.activeBytes).toBe((32 + 8 + 2 + 1) * 3 * 8 * 2 + 32 * 16 * 4);
    expect(result.candidateBytes).toBe(512);
    expect(result.retiringBytes).toBe(512);
    expect(result.concurrentBytes).toBe(5136);
    expect(result.physicalVram).toBe('unmeasured');
    expect(estimateWaterResourceBudget([...resources, resources[0]]).ok).toBe(false);
    expect(estimateWaterResourceBudget([{ ...resources[3], lastUseFence: null }]).ok).toBe(false);
  });
  it('uses explicit consecutive observations and separate up/down thresholds', () => {
    const policy = new WaterQualityBudgetPolicy({
      lowerBytes: 100,
      upperBytes: 200,
      consecutiveFrames: 3,
    });
    expect([201, 220, 150, 220, 220, 220].map((value) => policy.observe(value))).toEqual([
      'hold',
      'hold',
      'hold',
      'hold',
      'hold',
      'lower-quality',
    ]);
    expect([99, 99, NaN, 99, 99, 99].map((value) => policy.observe(value))).toEqual([
      'hold',
      'hold',
      'hold',
      'hold',
      'hold',
      'raise-quality',
    ]);
  });
});
