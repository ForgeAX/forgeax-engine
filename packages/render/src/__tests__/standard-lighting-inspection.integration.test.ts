import { mat4, vec3 } from '@forgeax/engine-math';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import {
  inspectStandardClusterTransport,
  inspectStandardLighting,
} from '../pipeline/standard-lighting/inspection';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import { selectTestStandardClusterTransport as selectStandardClusterTransport } from './cluster-test-abi';

function prepared(localCount: number) {
  const frame: StandardLightFrame = {
    directional: undefined,
    local: Array.from({ length: localCount }, (_, index) => ({
      kind: index % 2 === 0 ? ('point' as const) : ('spot' as const),
      shadowed: false,
      position: vec3.create((index % 4) - 1.5, 0, -4 - (index % 8)),
      range: 2,
    })),
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: 256,
    renderPath: 'forward',
  };
  const result = prepareStandardLighting(frame);
  if (!result.ok) throw result.error;
  return result.value;
}

function aoGraph(): CompiledRenderGraphInfo {
  return {
    generation: 41,
    passes: [
      {
        name: 'standard-scene-surface-data',
        kind: 'raster',
        executionIndex: 0,
        dependencies: [],
        accesses: [
          { resource: 'standard-scene-surface-normal', usage: 'color-attachment' },
          { resource: 'standard-scene-surface-depth', usage: 'depth-attachment' },
        ],
      },
      {
        name: 'gtao-calc-compute',
        kind: 'compute',
        executionIndex: 1,
        dependencies: ['standard-scene-surface-data'],
        accesses: [
          { resource: 'standard-scene-surface-normal', usage: 'sampled-read' },
          { resource: 'standard-scene-surface-depth', usage: 'sampled-read' },
          { resource: 'ssao-raw', usage: 'storage-write' },
        ],
      },
      {
        name: 'ssao-blur',
        kind: 'raster',
        executionIndex: 2,
        dependencies: ['gtao-calc-compute'],
        accesses: [
          { resource: 'ssao-raw', usage: 'sampled-read' },
          { resource: 'ssao-blurred', usage: 'color-attachment' },
        ],
      },
      {
        name: 'ssao-cluster-pack',
        kind: 'raster',
        executionIndex: 3,
        dependencies: ['ssao-blur'],
        accesses: [
          { resource: 'ssao-blurred', usage: 'sampled-read' },
          { resource: 'standard-cluster-tables', usage: 'color-attachment' },
        ],
      },
    ],
    resources: [
      {
        label: 'standard-scene-surface-normal',
        extent: { width: 128, height: 128, depthOrArrayLayers: 1 },
        byteSize: 128 * 128 * 4,
      },
      {
        label: 'standard-scene-surface-depth',
        extent: { width: 128, height: 128, depthOrArrayLayers: 1 },
        byteSize: 128 * 128 * 8,
      },
      {
        label: 'ssao-raw',
        extent: { width: 64, height: 64, depthOrArrayLayers: 1 },
        byteSize: 64 * 64 * 4,
      },
      {
        label: 'ssao-blurred',
        extent: { width: 64, height: 64, depthOrArrayLayers: 1 },
        byteSize: 64 * 64,
      },
    ],
  } as unknown as CompiledRenderGraphInfo;
}

describe('Standard lighting inspection provenance', () => {
  it('reports facts from the selected prepared transport, not a profile constant', () => {
    const preparedFrame = prepared(33);
    const selected = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      preparedFrame,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(inspectStandardClusterTransport(selected.value, preparedFrame)).toEqual({
      renderPath: 'forward',
      transport: 'cpu-storage',
      producer: 'cpu',
      requested: 33,
      admitted: 33,
      shadowed: 0,
      maxLights: 256,
      indexCount: preparedFrame.membershipEntryCount,
      occupied: selected.value.occupiedClusterCount,
      clusterGridBytes: preparedFrame.layout.clusterGridU32Length * 4,
      lightIndexListBytes: preparedFrame.membershipEntryCount * 4,
      lightDataBytes: 33 * 96,
      lightBoundsBytes: preparedFrame.lightBounds.byteLength,
      grid: preparedFrame.layout.grid,
    });
  });

  it('publishes an explicit not-required inspection for a successful zero-local frame', () => {
    const result = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 1,
      renderPath: 'forward',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = inspectStandardLighting({ kind: 'no-local-lights', prepared: result.value });
    expect(inspection).toMatchObject({
      renderPath: 'forward',
      transport: 'not-required',
      producer: 'none',
      requested: 0,
      admitted: 0,
      shadowed: 0,
      maxLights: 1,
      indexCount: 0,
      occupied: 0,
      clusterGridBytes: 0,
      lightIndexListBytes: 0,
      lightDataBytes: 0,
      lightBoundsBytes: 0,
      grid: result.value.layout.grid,
      ambientOcclusion: {
        requested: false,
        status: 'off',
        algorithm: 'gtao',
        execution: 'none',
        reason: 'disabled',
      },
    });
    expect(inspection.ambientOcclusion.work).toEqual({
      rawPixels: 0,
      filterTapBudget: 0,
      depthCandidateBudget: 0,
    });
    expect(inspection.ambientOcclusion.output.clusterRegionBytes).toBe(0);
    expect(inspection.ambientOcclusion.passes).toEqual([]);
  });

  it('projects AO inputs, costs, bindings and execution from the active graph', () => {
    const input = prepared(0);
    const inspected = inspectStandardLighting(
      { kind: 'no-local-lights', prepared: input },
      {
        config: {
          enabled: true,
          algorithm: 'gtao',
          quality: 'high',
          directLightingStrength: 0.4,
          resolutionScale: 0.5,
        },
        graph: aoGraph(),
        installedGraphGeneration: 52,
        deviceGeneration: 7,
        clusterAoExtent: { width: 64, height: 64 },
      },
    );

    expect(inspected.ambientOcclusion).toMatchObject({
      requested: true,
      status: 'active',
      algorithm: 'gtao',
      execution: 'compute',
      producerId: 'forgeax::standard::surface-data',
      input: {
        normalSchema: 'forgeax::scene-data::standard-surface-normal-v1',
        normalSpace: 'world',
        normalEncoding: 'octahedral-normal-x12-y12-roughness-u8',
        normalFormat: 'r32uint',
        depthSchema: 'forgeax::scene-data::standard-surface-depth-v1',
        depthSpace: 'camera-device-depth',
        depthEncoding: 'rhi-zero-to-one',
        depthFormat: 'depth32float-stencil8',
        coverage: 'opaque-alpha-mask',
        extent: { width: 128, height: 128 },
        bytes: 128 * 128 * 12,
        additionalBytes: 128 * 128 * 12,
      },
      numerical: {
        radius: 0.25,
        bias: 0,
        intensity: 1,
        thickness: 1,
        distanceExponent: 1,
        distanceFallOff: 1,
        resolutionScale: 0.5,
        quality: 'high',
        sampleBudget: 16,
        directLightingStrength: 0.4,
        rawIntensityApplication: 'once-before-filter',
        filter: '5x5-depth-normal-bilateral',
      },
      output: {
        rawFormat: 'rgba8unorm',
        filteredFormat: 'r8unorm',
        extent: { width: 64, height: 64 },
        rawBytes: 64 * 64 * 4,
        filteredBytes: 64 * 64,
        clusterRegionBytes: 16 * 64 * 16,
      },
      work: {
        rawPixels: 64 * 64,
        filterTapBudget: 64 * 64 * 25,
        depthCandidateBudget: 64 * 64 * 36,
      },
      passes: [
        'standard-scene-surface-data',
        'gtao-calc-compute',
        'ssao-blur',
        'ssao-cluster-pack',
      ],
      graphGeneration: 52,
      deviceGeneration: 7,
    });
    expect(inspected.ambientOcclusion.graphGeneration).not.toBe(aoGraph().generation);
    expect(Object.isFrozen(inspected.ambientOcclusion)).toBe(true);
    expect(Object.isFrozen(inspected.ambientOcclusion.input)).toBe(true);
    expect(Object.isFrozen(inspected.ambientOcclusion.passes)).toBe(true);
  });

  it('names an unavailable requested pass set and reports recovery without planned work', () => {
    const inspected = inspectStandardLighting(
      { kind: 'no-local-lights', prepared: prepared(0) },
      {
        config: { enabled: true, algorithm: 'ssao' },
        graph: { generation: 5, passes: [], resources: [] } as unknown as CompiledRenderGraphInfo,
        deviceGeneration: 3,
        clusterAoExtent: { width: 16, height: 16 },
      },
    );

    expect(inspected.ambientOcclusion).toMatchObject({
      requested: true,
      status: 'requested-unavailable',
      algorithm: 'ssao',
      execution: 'none',
      reason: 'requested-passes-not-in-active-graph',
      failure: {
        stage: 'active-graph',
        code: 'requested-passes-not-in-active-graph',
        recovery: 'retry-or-rebuild-standard-pipeline',
      },
      work: { rawPixels: 0, filterTapBudget: 0, depthCandidateBudget: 0 },
      output: { clusterRegionBytes: 0 },
      passes: [],
    });
  });

  it('preserves deferred path, shadow admission, and profile light budget', () => {
    const frame: StandardLightFrame = {
      directional: undefined,
      local: [
        {
          kind: 'point',
          shadowed: true,
          position: vec3.create(0, 0, -4),
          range: 2,
        },
      ],
      view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
      projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 32,
      renderPath: 'deferred',
    };
    const preparedFrame = prepareStandardLighting(frame);
    expect(preparedFrame.ok).toBe(true);
    if (!preparedFrame.ok) return;
    const selected = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      preparedFrame.value,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(
      inspectStandardLighting({
        kind: 'clustered',
        prepared: preparedFrame.value,
        transport: selected.value,
      }),
    ).toMatchObject({
      renderPath: 'deferred',
      transport: 'compute-storage',
      producer: 'gpu',
      shadowed: 1,
      maxLights: 32,
    });
  });
});
