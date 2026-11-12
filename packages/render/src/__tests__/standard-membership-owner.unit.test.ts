import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { createClusterBinScratch } from '../cluster-binner';
import { StandardClusterMembershipOwner } from '../pipeline/standard-lighting/membership-owner';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';

function frame(): StandardLightFrame {
  return {
    directional: undefined,
    local: [{ kind: 'point', position: vec3.create(0, 0, -4), range: 1000, shadowed: false }],
    view: mat4.identity(mat4.create()),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 4, z: 4 },
    lightCount: 32,
    renderPath: 'forward',
  };
}

describe('stock view Cluster membership owner', () => {
  it('keeps only numerical membership while current light and path payloads change', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    const firstFrame = frame();
    const first = prepareStandardLighting(firstFrame, undefined, scratch, owner).unwrap();
    const nextFrame = {
      ...firstFrame,
      local: firstFrame.local.map((light) => ({ ...light, kind: 'spot' as const, shadowed: true })),
      renderPath: 'deferred' as const,
    };
    for (let index = 0; index < 20; index++) {
      const next = prepareStandardLighting(nextFrame, undefined, scratch, owner).unwrap();
      expect(next.clusterGrid).toBe(first.clusterGrid);
      expect(next.lightIndexList).toBe(first.lightIndexList);
      expect(next.lightBounds).toBe(first.lightBounds);
      expect(next.local).toBe(nextFrame.local);
      expect(next.renderPath).toBe('deferred');
      expect(next).not.toBe(first);
    }
    expect(first.local).toBe(firstFrame.local);
    expect(first.renderPath).toBe('forward');
  });

  it('captures every camera matrix lane and leaves held old memberships independent', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    const input = frame();
    let previous = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    for (const matrix of [input.view, input.projection]) {
      for (let index = 0; index < 16; index++) {
        const oldGrid = previous.clusterGrid.slice();
        matrix[index] = (matrix[index] ?? 0) + 0.001;
        const next = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
        const fresh = prepareStandardLighting(input).unwrap();
        expect(next.clusterGrid).not.toBe(previous.clusterGrid);
        expect(next.clusterGrid).toEqual(fresh.clusterGrid);
        expect(next.lightIndexList).toEqual(fresh.lightIndexList);
        expect(next.lightBounds).toEqual(fresh.lightBounds);
        expect(previous.clusterGrid).toEqual(oldGrid);
        previous = next;
      }
    }
  });

  it('invalidates near, far, all grid dimensions, ordered light values, count and scratch', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    let input = frame();
    let previous = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    const changes: ((input: StandardLightFrame) => StandardLightFrame)[] = [
      (value) => ({ ...value, near: 0.2 }),
      (value) => ({ ...value, far: 80 }),
      ...(['x', 'y', 'z'] as const).map((axis) => (value: StandardLightFrame) => ({
        ...value,
        grid: { ...value.grid, [axis]: 5 },
      })),
      ...([0, 1, 2] as const).map((axis) => (value: StandardLightFrame) => ({
        ...value,
        local: value.local.map((light) => {
          const position = vec3.clone(light.position);
          position[axis] = (position[axis] ?? 0) + 1;
          return { ...light, position };
        }),
      })),
      (value) => ({ ...value, local: value.local.map((light) => ({ ...light, range: 2 })) }),
      (value) => ({
        ...value,
        local: [
          ...value.local,
          { kind: 'point', position: vec3.create(8, 0, -4), range: 4, shadowed: false },
        ],
      }),
      (value) => ({ ...value, local: [...value.local].reverse() }),
      (value) => ({ ...value, local: [] }),
    ];
    for (const change of changes) {
      input = change(input);
      const next = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
      const fresh = prepareStandardLighting(input).unwrap();
      expect(next.clusterGrid).not.toBe(previous.clusterGrid);
      expect(next.clusterGrid).toEqual(fresh.clusterGrid);
      expect(next.lightIndexList).toEqual(fresh.lightIndexList);
      expect(next.lightBounds).toEqual(fresh.lightBounds);
      previous = next;
    }
    const independent = prepareStandardLighting(
      input,
      undefined,
      createClusterBinScratch(),
      owner,
    ).unwrap();
    expect(independent.clusterGrid).not.toBe(previous.clusterGrid);
    expect(independent.clusterGrid).toEqual(previous.clusterGrid);
  });

  it('validates budget before a hit and preserves its last successful fact through overflow', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    const input = frame();
    const first = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    expect(prepareStandardLighting(input, 0, scratch, owner).ok).toBe(false);
    const tooMany = {
      ...input,
      local: Array.from({ length: 33 }, () => input.local[0]).filter(
        (value) => value !== undefined,
      ),
    };
    expect(prepareStandardLighting(tooMany, undefined, scratch, owner).ok).toBe(false);
    const overflowing = {
      ...input,
      grid: { x: 32, y: 32, z: 33 },
      local: Array.from({ length: 32 }, () => ({
        kind: 'point' as const,
        position: vec3.create(0, 0, -4),
        range: 1000,
        shadowed: false,
      })),
    };
    const rejected = prepareStandardLighting(overflowing, undefined, scratch, owner);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('standard-cluster-index-overflow');
    const recovered = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    expect(recovered.clusterGrid).toBe(first.clusterGrid);
    expect(recovered.lightBounds).toEqual(first.lightBounds);
    owner.clear();
    const restarted = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    expect(restarted.clusterGrid).not.toBe(first.clusterGrid);
    expect(restarted.clusterGrid).toEqual(first.clusterGrid);
  });

  it('keeps separate views and ordinary borrowed preparation independent', () => {
    const input = frame();
    const firstOwner = new StandardClusterMembershipOwner();
    const secondOwner = new StandardClusterMembershipOwner();
    const first = prepareStandardLighting(input, undefined, undefined, firstOwner).unwrap();
    expect(
      prepareStandardLighting(input, undefined, undefined, firstOwner).unwrap().clusterGrid,
    ).toBe(first.clusterGrid);
    expect(
      prepareStandardLighting(input, undefined, undefined, secondOwner).unwrap().clusterGrid,
    ).not.toBe(first.clusterGrid);
    expect(prepareStandardLighting(input).unwrap().clusterGrid).not.toBe(first.clusterGrid);
    expect(prepareStandardLighting(input).unwrap().clusterGrid).not.toBe(
      prepareStandardLighting(input).unwrap().clusterGrid,
    );
  });
});
