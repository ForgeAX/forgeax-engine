import { mat4, vec3 } from '@forgeax/engine-math';
import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import { measureClusterOccupancy } from '../cluster-binner';
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
        name: 'gbuffer',
        kind: 'raster',
        executionIndex: 0,
        dependencies: [],
        accesses: [
          { resource: 'gbuffer-a', usage: 'color-attachment' },
          { resource: 'scene-depth', usage: 'depth-attachment' },
        ],
      },
      {
        name: 'gtao-calc-compute',
        kind: 'compute',
        executionIndex: 1,
        dependencies: ['gbuffer'],
        accesses: [
          { resource: 'gbuffer-a', usage: 'sampled-read' },
          { resource: 'scene-depth', usage: 'sampled-read' },
          { resource: 'gtao-calc', usage: 'storage-write' },
        ],
      },
      {
        name: 'gtao-resolve',
        kind: 'raster',
        executionIndex: 2,
        dependencies: ['gtao-calc-compute'],
        accesses: [
          { resource: 'gtao-calc', usage: 'sampled-read' },
          { resource: 'gtao-resolve', usage: 'color-attachment' },
        ],
      },
    ],
    resources: [
      {
        label: 'gbuffer-a',
        format: 'r32uint',
        extent: { width: 128, height: 128, depthOrArrayLayers: 1 },
        byteSize: 128 * 128 * 4,
      },
      {
        label: 'scene-depth',
        format: 'depth32float-stencil8',
        extent: { width: 128, height: 128, depthOrArrayLayers: 1 },
        byteSize: 128 * 128 * 8,
      },
      {
        label: 'gtao-calc',
        format: 'rgba8unorm',
        extent: { width: 64, height: 64, depthOrArrayLayers: 1 },
        byteSize: 64 * 64 * 4,
      },
      {
        label: 'gtao-resolve',
        format: 'r8unorm',
        extent: { width: 128, height: 128, depthOrArrayLayers: 1 },
        byteSize: 128 * 128,
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

    const inspection = inspectStandardClusterTransport(selected.value, preparedFrame);
    const { lightsPerCluster, ...facts } = inspection;
    // Lazy occupancy diagnostic: the box view agrees with the prepared counts.
    expect(lightsPerCluster?.box.entries).toBe(preparedFrame.membershipEntryCount);
    expect(lightsPerCluster?.box.occupied).toBe(selected.value.occupiedClusterCount);
    expect(lightsPerCluster?.exact?.entries ?? 0).toBeLessThanOrEqual(
      preparedFrame.membershipEntryCount,
    );
    expect(facts).toEqual({
      renderPath: 'forward',
      transport: 'cpu-storage',
      producer: 'cpu',
      requested: 33,
      admitted: 33,
      droppedLocalLights: 0,
      clusterEntryCapK: null,
      droppedClusterEntries: 0,
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

  it('keeps submitted occupancy and shadow admission when the next frame reuses camera and layout inputs', () => {
    const source = prepared(3);
    if (source.camera === undefined) throw new Error('expected a prepared camera');
    const shadows = source.local.map((light, index) => ({ ...light, shadowed: index === 1 }));
    const grid = { ...source.layout.grid };
    const layout = { ...source.layout, grid };
    const camera = { ...source.camera };
    const frame = { ...source, local: shadows, layout, camera };
    const selected = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      frame,
    ).unwrap();
    let graphReads = 0;
    const expected = measureClusterOccupancy(
      shadows.length,
      source.lightBounds,
      grid,
      camera.near,
      camera.far,
    );
    const report = inspectStandardLighting(
      { kind: 'clustered', transport: selected, prepared: frame },
      {
        config: undefined,
        get graph() {
          graphReads++;
          return undefined;
        },
        deviceGeneration: 1,
      },
    );
    grid.x = 1;
    camera.near = 30;
    camera.far = 31;
    shadows.length = 0;
    if (report.transport === 'not-required') throw new Error('expected a clustered report');
    expect(report.grid.x).toBe(4);
    expect(report.shadowed).toBe(1);
    expect(report.lightsPerCluster).toEqual(expected);
    expect(report.lightsPerCluster).toBe(report.lightsPerCluster);
    expect(graphReads).toBe(0);
    expect(report.ambientOcclusion.status).toBe('off');
    expect(graphReads).toBe(1);
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
      droppedLocalLights: 0,
      clusterEntryCapK: null,
      droppedClusterEntries: 0,
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
        algorithm: 'ssao',
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
    const input = { ...prepared(0), renderPath: 'deferred' as const };
    const inspected = inspectStandardLighting(
      { kind: 'no-local-lights', prepared: input },
      {
        config: {
          enabled: true,
          method: 'gtao',
          quality: 100,
          gtao: { useNormals: true, downsample: true },
        },
        graph: aoGraph(),
        installedGraphGeneration: 52,
        deviceGeneration: 7,
      },
    );

    expect(inspected.ambientOcclusion).toMatchObject({
      requested: true,
      status: 'active',
      algorithm: 'gtao',
      execution: 'compute',
      producerId: 'forgeax::standard::surface-data',
      input: {
        normalSchema: 'standard-gbuffer/4',
        normalSpace: 'world',
        normalEncoding: 'xyz10',
        normalFormat: 'r32uint',
        depthSchema: 'forgeax::scene-data::standard-surface-depth-v1',
        depthSpace: 'camera-device-depth',
        depthEncoding: 'rhi-zero-to-one',
        depthFormat: 'depth32float-stencil8',
        coverage: 'opaque-alpha-mask',
        extent: { width: 128, height: 128 },
        bytes: 128 * 128 * 12,
        additionalBytes: 0,
      },
      numerical: {
        radius: 2,
        bias: 3,
        intensity: 0.5,
        thickness: 1,
        distanceExponent: 1,
        distanceFallOff: 1,
        resolutionScale: 1,
        quality: 100,
        sampleBudget: 20,
        rawIntensityApplication: 'gtao-spatial',
        filter: 'gtao-depth-plane',
      },
      output: {
        rawFormat: 'rgba8unorm',
        filteredFormat: 'r8unorm',
        extent: { width: 128, height: 128 },
        rawBytes: 64 * 64 * 4,
        filteredBytes: 128 * 128,
        clusterRegionBytes: 0,
      },
      work: {
        rawPixels: 64 * 64,
        filterTapBudget: 64 * 64 * 25,
        depthCandidateBudget: 64 * 64 * 80,
      },
      passes: ['gtao-calc-compute', 'gtao-resolve'],
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
        config: { enabled: true, method: 'ssao' },
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
