import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
} from '../pipeline/standard-lighting/layout';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';

function makeFrame(local: StandardLightFrame['local']): StandardLightFrame {
  return {
    directional: undefined,
    local,
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: DEFAULT_CLUSTER_GRID,
    lightCount: 32,
    renderPath: 'forward',
  };
}

function coveringLight(kind: 'point' | 'spot' | 'rect-area' = 'point') {
  return { kind, position: vec3.create(0, 0, -4), range: 1000, shadowed: false };
}

describe('Standard CPU membership allocation', () => {
  it('bounds one-light backing storage by the complete membership without shrinking the GPU ABI', () => {
    const result = prepareStandardLighting(makeFrame([coveringLight()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { layout, clusterGrid, lightIndexList, membershipEntryCount } = result.value;
    expect(layout.lightIndexListCapacity).toBe(1_048_576);
    expect(layout.lightIndexListCapacity).toBe(LIGHT_INDEX_LIST_CAPACITY);
    expect(membershipEntryCount).toBe(layout.clusterCount);
    expect(lightIndexList.buffer.byteLength).toBeLessThanOrEqual(layout.clusterCount * 4);
    expect(lightIndexList.length).toBeGreaterThanOrEqual(membershipEntryCount);
    expect(lightIndexList.subarray(0, membershipEntryCount).every((index) => index === 0)).toBe(
      true,
    );
    for (let cluster = 0; cluster < layout.clusterCount; cluster++) {
      expect(clusterGrid[cluster * 2]).toBe(cluster);
      expect(clusterGrid[cluster * 2 + 1]).toBe(1);
    }
  });

  it.each([
    'point',
    'spot',
  ] as const)('keeps no-cutoff %s lights in every cluster beyond 1000 units', (kind) => {
    const distant = { kind, shadowed: false, position: vec3.create(5000, 0, -4), range: Infinity };
    const unlimited = prepareStandardLighting(makeFrame([distant])).unwrap();
    const finite = prepareStandardLighting(makeFrame([{ ...distant, range: 10 }])).unwrap();
    expect(unlimited.membershipEntryCount).toBe(unlimited.layout.clusterCount);
    expect(finite.membershipEntryCount).toBeLessThan(unlimited.layout.clusterCount);
  });

  it('allocates no index storage for zero local lights and keeps the layout capacity', () => {
    const result = prepareStandardLighting(makeFrame([]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.membershipEntryCount).toBe(0);
    expect(result.value.lightIndexList.buffer.byteLength).toBe(0);
    expect(result.value.clusterGrid.every((value) => value === 0)).toBe(true);
    expect(result.value.layout.lightIndexListCapacity).toBe(LIGHT_INDEX_LIST_CAPACITY);
  });

  it('retains complete cluster-major light order with a culled light between different kinds', () => {
    const result = prepareStandardLighting(
      makeFrame([
        coveringLight('point'),
        { ...coveringLight('spot'), range: 0 },
        coveringLight('rect-area'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { layout, clusterGrid, lightIndexList, membershipEntryCount } = result.value;
    expect(membershipEntryCount).toBe(layout.clusterCount * 2);
    for (let cluster = 0; cluster < layout.clusterCount; cluster++) {
      const offset = clusterGrid[cluster * 2] ?? -1;
      expect(offset).toBe(cluster * 2);
      expect(clusterGrid[cluster * 2 + 1]).toBe(2);
      expect(Array.from(lightIndexList.subarray(offset, offset + 2))).toEqual([0, 2]);
    }
  });

  it('preserves the declared-capacity overflow instead of admitting a truncated list', () => {
    const result = prepareStandardLighting({
      ...makeFrame(Array.from({ length: 32 }, () => coveringLight())),
      grid: { x: 32, y: 32, z: 33 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('standard-cluster-index-overflow');
    if (result.error.code !== 'standard-cluster-index-overflow') return;
    expect(result.error.detail).toEqual({ actual: 1_081_344, capacity: 1_048_576 });
  });
});
