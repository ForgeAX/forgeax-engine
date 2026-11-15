import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLUSTER_GRID } from '../pipeline/standard-lighting/layout';
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

/**
 * Additional DirectionalLights take the slots after the binned lights and are
 * kept out of the light grid; the shader loops them separately with their
 * own count.
 */
describe('additional DirectionalLight outside the light grid', () => {
  const point = {
    kind: 'point' as const,
    position: vec3.create(0, 0, -4),
    range: 1,
    shadowed: false,
  };
  const directional = {
    kind: 'directional' as const,
    position: vec3.create(0, 0, 0),
    range: Number.POSITIVE_INFINITY,
    shadowed: false,
  };
  const clusterCount = DEFAULT_CLUSTER_GRID.x * DEFAULT_CLUSTER_GRID.y * DEFAULT_CLUSTER_GRID.z;

  it('keeps the directional slot after the local lights and out of every cluster', () => {
    const prepared = prepareStandardLighting(makeFrame([point, directional, directional])).unwrap();
    expect(prepared.local).toHaveLength(3);
    expect(prepared.membershipLightCount).toBe(1);
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const offset = prepared.clusterGrid[cluster * 2] ?? 0;
      const count = prepared.clusterGrid[cluster * 2 + 1] ?? 0;
      for (const index of prepared.lightIndexList.subarray(offset, offset + count))
        expect(index).toBe(0);
    }
  });

  it('bins the same grid with or without the directional tail', () => {
    const withTail = prepareStandardLighting(makeFrame([point, directional])).unwrap();
    const without = prepareStandardLighting(makeFrame([point])).unwrap();
    expect(withTail.clusterGrid).toEqual(without.clusterGrid);
    expect(withTail.lightIndexList.subarray(0, withTail.membershipEntryCount)).toEqual(
      without.lightIndexList.subarray(0, without.membershipEntryCount),
    );
    expect(withTail.lightBounds).toEqual(without.lightBounds);
  });

  it('leaves the grid empty for a directional-only frame', () => {
    const prepared = prepareStandardLighting(makeFrame([directional])).unwrap();
    expect(prepared.membershipLightCount).toBe(0);
    expect(prepared.membershipEntryCount).toBe(0);
  });
});
