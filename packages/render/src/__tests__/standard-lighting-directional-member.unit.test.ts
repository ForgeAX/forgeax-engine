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

describe('additional DirectionalLight as a Cluster member', () => {
  it('admits an infinite-range directional slot to every cluster after local lights', () => {
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
    const prepared = prepareStandardLighting(makeFrame([point, directional])).unwrap();
    const clusterCount = DEFAULT_CLUSTER_GRID.x * DEFAULT_CLUSTER_GRID.y * DEFAULT_CLUSTER_GRID.z;
    let withDirectional = 0;
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const offset = prepared.clusterGrid[cluster * 2] ?? 0;
      const count = prepared.clusterGrid[cluster * 2 + 1] ?? 0;
      const members = [...prepared.lightIndexList.slice(offset, offset + count)];
      if (members.includes(1)) withDirectional++;
    }
    expect(withDirectional).toBe(clusterCount);
    expect(prepared.membershipLightCount).toBe(2);
  });

  it('counts additional directional lights against the light budget', () => {
    const directional = {
      kind: 'directional' as const,
      position: vec3.create(0, 0, 0),
      range: Number.POSITIVE_INFINITY,
      shadowed: false,
    };
    const result = prepareStandardLighting({
      ...makeFrame([directional, directional]),
      lightCount: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('standard-light-budget-exceeded');
  });
});
