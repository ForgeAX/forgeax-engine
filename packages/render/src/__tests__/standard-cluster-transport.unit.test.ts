import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  type PreparedStandardLighting,
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import {
  type StandardClusterCapabilities,
  selectStandardClusterTransport,
} from '../pipeline/standard-lighting/transport';

function frame(localCount: number): StandardLightFrame {
  return {
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
}

function prepared(localCount: number): PreparedStandardLighting {
  const result = prepareStandardLighting(frame(localCount));
  if (!result.ok) throw result.error;
  return result.value;
}

const STORAGE_FIXTURES: readonly [string, StandardClusterCapabilities, 'cpu' | 'gpu'][] = [
  [
    'compute + storage',
    { compute: true, storageBuffer: true, membershipPipelineReady: true },
    'gpu',
  ],
  [
    'storage without compute',
    { compute: false, storageBuffer: true, membershipPipelineReady: false },
    'cpu',
  ],
];

describe('Standard Cluster transport capability closure', () => {
  it('admits all 256 lights and the identical CPU membership through a baseline integer texture', () => {
    const corpus = prepared(256);
    const result = selectStandardClusterTransport(
      {
        compute: true,
        storageBuffer: false,
        membershipPipelineReady: true,
        maxTextureDimension2D: 2048,
      },
      corpus,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      kind: 'cpu-texture',
      producer: 'cpu',
      requestedLightCount: 256,
      admittedLightCount: 256,
      membershipEntryCount: corpus.membershipEntryCount,
      lightDataBytes: 256 * 96,
    });
    expect(
      selectStandardClusterTransport(
        {
          compute: false,
          storageBuffer: false,
          membershipPipelineReady: false,
          maxTextureDimension2D: 1023,
        },
        corpus,
      ).ok,
    ).toBe(false);
  });
  it.each(STORAGE_FIXTURES)('selects %s from the prepared corpus', (_name, caps, producer) => {
    const preparedFrame = prepared(33);
    const selected = selectStandardClusterTransport(caps, preparedFrame);

    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.requestedLightCount).toBe(33);
    expect(selected.value.admittedLightCount).toBe(33);
    expect(selected.value.membershipEntryCount).toBe(preparedFrame.membershipEntryCount);
    expect(selected.value.lightBoundsBytes).toBe(preparedFrame.lightBounds.byteLength);
    expect(selected.value.layout).toBe(preparedFrame.layout);
    expect(selected.value.kind).toBe(producer === 'gpu' ? 'compute-storage' : 'cpu-storage');
    expect(selected.value.producer).toBe(producer);
  });

  it('keeps CPU and GPU preparation on the same cluster corpus', () => {
    const canonical = prepared(33);
    const cpuTransport = selectStandardClusterTransport(
      { compute: false, storageBuffer: true, membershipPipelineReady: false },
      canonical,
    );
    const gpuTransport = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      canonical,
    );
    expect(cpuTransport.ok && gpuTransport.ok).toBe(true);
    if (!cpuTransport.ok || !gpuTransport.ok) return;
    expect(Array.from(canonical.clusterGrid)).not.toEqual([]);
    expect(Array.from(canonical.lightBounds)).not.toEqual([]);
    expect(canonical.membershipEntryCount).toBeGreaterThan(0);
    expect(cpuTransport.value.membershipEntryCount).toBe(gpuTransport.value.membershipEntryCount);
    expect(cpuTransport.value.requestedLightCount).toBe(gpuTransport.value.requestedLightCount);
  });

  it('does not forge a GPU producer when the membership pipeline is not ready', () => {
    const result = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: false },
      prepared(33),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.producer).toBe('cpu');
    expect(result.value.kind).toBe('cpu-storage');
  });

  it('fails closed when no proven storage transport exists', () => {
    const result = selectStandardClusterTransport(
      { compute: true, storageBuffer: false, membershipPipelineReady: false },
      prepared(33),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-cluster-transport-unavailable') return;
    expect(result.error.detail).toEqual({ requested: 33, admitted: 0 });
    expect(result.error.hint).toContain('storage');
    expect(JSON.stringify(result.error)).not.toContain('four');
  });

  it('rejects even an empty frame without storage so no second cluster ABI exists', () => {
    const result = selectStandardClusterTransport(
      { compute: false, storageBuffer: false, membershipPipelineReady: false },
      prepared(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-cluster-transport-unavailable') return;
    expect(result.error.detail).toEqual({ requested: 0, admitted: 0 });
  });
});
