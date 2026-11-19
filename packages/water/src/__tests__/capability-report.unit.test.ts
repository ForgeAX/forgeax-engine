import { describe, expect, it } from 'vitest';
import { createWaterCapabilityReport, type WaterCapabilityRequest } from '../capability-report.js';
import {
  estimateWaterResourceBudget,
  type WaterBudgetResource,
  WaterQualityBudgetPolicy,
} from '../resource-budget.js';

const request = (): WaterCapabilityRequest => ({
  quality: 'Q0',
  configuration: 'surface',
  parameterIdentity: 'coast-seed-8',
  format: 'rgba16float',
  width: 256,
  height: 128,
  layers: 2,
  device: {
    version: 2,
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
    version: 2,
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
});

describe('Water capability combination', () => {
  it('publishes current configuration support without benchmark or rollout fields', () => {
    const report = createWaterCapabilityReport(request());
    expect(report.version).toBe(2);
    expect(report.implementation).toBe('supported');
    expect(report).not.toHaveProperty('validation');
    expect(report).not.toHaveProperty('comparison');
    expect(report).not.toHaveProperty('fidelity');
  });
  it('keeps unavailable CPU mesh publication facts explicit for Q3', () => {
    const input = request();
    const report = createWaterCapabilityReport({
      ...input,
      quality: 'Q3',
      renderer: { ...input.renderer, cpuMesh: 'unavailable' },
    });
    expect(report.requirements.find((row) => row.name === 'cpu-mesh')?.status).toBe('unavailable');
    expect(report.implementation).toBe('unavailable');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: 'Q3',
        renderer: { ...input.renderer, cpuMesh: 'unavailable', gpuMesh: true },
      }).implementation,
    ).toBe('unsupported');
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
        configuration: 'surface-without-ssr',
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
        configuration: 'gpu-mesh',
        subfeature: 'gpu-mesh',
        renderer: { ...input.renderer, gpuMesh: true },
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'async-buoyancy',
        subfeature: 'async-buoyancy',
        physics: { ...input.physics, solverParticipant: true, solverClock: true },
        solverExecution: 'worker-solver',
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'fluid-simulation',
        subfeature: 'fluid-simulation',
        renderer: { ...input.renderer, fluidSimulation: true },
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({
        ...input,
        quality: null,
        configuration: 'advanced-simulation',
        subfeature: 'ocean-fft',
        renderer: { ...input.renderer, oceanFft: true },
      }).implementation,
    ).toBe('supported');
    expect(
      createWaterCapabilityReport({ ...input, quality: 'Q2', configuration: 'surface' } as never)
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
    ).toMatchObject({ version: 2, implementation: 'supported' });
    expect(
      createWaterCapabilityReport({ ...input, quality: 'Q4', configuration: null }).implementation,
    ).toBe('unsupported');
    expect(
      createWaterCapabilityReport({ ...input, configuration: 'gpu-mesh' } as WaterCapabilityRequest)
        .implementation,
    ).toBe('unsupported');
    const fft = {
      ...input,
      quality: null,
      configuration: 'advanced-simulation',
      subfeature: 'advanced-shallow',
      renderer: { ...input.renderer, oceanFft: true },
    } as const;
    expect(createWaterCapabilityReport(fft).implementation).toBe('unsupported');
    expect(
      createWaterCapabilityReport({
        ...fft,
        renderer: { ...fft.renderer, advancedShallow: true },
      }).implementation,
    ).toBe('supported');
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
            rgba16float: { ...input.device.formats.rgba16float, arrayRenderSample: 'unavailable' },
          },
        },
      }).implementation,
    ).toBe('unavailable');
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
