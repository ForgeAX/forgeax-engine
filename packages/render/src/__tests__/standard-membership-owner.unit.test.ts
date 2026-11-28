import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { createClusterBinScratch } from '../cluster-binner';
import { DEFAULT_CLUSTER_GRID } from '../pipeline/standard-lighting/layout';
import { StandardClusterMembershipOwner } from '../pipeline/standard-lighting/membership-owner';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';
import {
  matchesStandardLightingDeclaration,
  standardLightingDeclaration,
} from '../pipeline/standard-lighting/topology';
import { selectTestStandardClusterTransport } from './cluster-test-abi';

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
  it('keeps the stock physical light table independent of moving lights and publishes new ABI sizes', () => {
    const owner = new StandardClusterMembershipOwner();
    const light = vec3.create(0, 0, -4);
    const source = {
      ...frame(),
      grid: DEFAULT_CLUSTER_GRID,
      local: [{ kind: 'point' as const, position: light, range: 4, shadowed: false }],
    };
    function declaration(
      slots: number,
      compute: boolean,
      grid: StandardLightFrame['grid'] = source.grid,
    ) {
      const prepared = prepareStandardLighting(
        { ...source, grid },
        slots,
        undefined,
        owner,
      ).unwrap();
      const transport = selectTestStandardClusterTransport(
        { compute, storageBuffer: true, membershipPipelineReady: compute },
        prepared,
      ).unwrap();
      const input = { kind: 'clustered' as const, prepared, transport };
      return input;
    }
    const first = declaration(32, true);
    const binding = standardLightingDeclaration(first);
    for (let frameIndex = 0; frameIndex < 60; frameIndex++) {
      light[0] = frameIndex / 8;
      const moved = declaration(32, true);
      expect(moved.prepared.layout).toBe(first.prepared.layout);
      expect(matchesStandardLightingDeclaration(binding, moved)).toBe(true);
    }
    expect(matchesStandardLightingDeclaration(binding, declaration(32, false))).toBe(false);
    expect(matchesStandardLightingDeclaration(binding, declaration(64, true))).toBe(false);
    const borrowed = { x: 2, y: 3, z: 4 };
    const borrowedBinding = standardLightingDeclaration(declaration(64, true, borrowed));
    borrowed.y++;
    expect(
      matchesStandardLightingDeclaration(borrowedBinding, declaration(64, true, borrowed)),
    ).toBe(false);
    owner.clear();
    expect(declaration(32, true).prepared.layout).not.toBe(first.prepared.layout);
  });

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

  it('publishes the rotating GPU spot cone independently of its occupied cells', () => {
    const owner = new StandardClusterMembershipOwner();
    const input = frame();
    const point = input.local[0];
    if (!point) throw new Error('Expected one light');
    const direction = vec3.create(0, 0, -1);
    const cone = { apex: point.position, direction, cosOuter: 0.75, range: 12 };
    const spot = { ...point, kind: 'spot' as const, cone };
    const moving = { ...input, local: [spot] };
    const first = prepareStandardLighting(moving, undefined, undefined, owner).unwrap();
    const firstBytes = first.lightBounds.slice();
    for (let i = 1; i <= 60; i++) {
      direction[0] = Math.sin(i * 0.1);
      direction[2] = -Math.cos(i * 0.1);
      const current = prepareStandardLighting(moving, undefined, undefined, owner).unwrap();
      const reference = prepareStandardLighting(moving).unwrap();
      expect(current.lightBounds).toEqual(reference.lightBounds);
      expect(current.clusterGrid).toBe(first.clusterGrid);
      expect(current.lightIndexList).toBe(first.lightIndexList);
      expect(first.lightBounds).toEqual(firstBytes);
    }
  });

  it('projects every camera matrix lane and keeps the previously published GPU bytes independent', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    const input = frame();
    let previous = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    for (const matrix of [input.view, input.projection]) {
      for (let index = 0; index < 16; index++) {
        const oldGrid = previous.clusterGrid.slice();
        const oldBounds = previous.lightBounds.slice();
        matrix[index] = (matrix[index] ?? 0) + 0.001;
        const next = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
        const fresh = prepareStandardLighting(input).unwrap();
        expect(next.clusterGrid).toEqual(fresh.clusterGrid);
        expect(next.lightIndexList).toEqual(fresh.lightIndexList);
        expect(next.lightBounds).toEqual(fresh.lightBounds);
        expect(previous.clusterGrid).toEqual(oldGrid);
        expect(previous.lightBounds).toEqual(oldBounds);
        previous = next;
      }
    }
  });

  it('resolves near, far, grid dimensions, reordered lights and independent scratch', () => {
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
      if (next.clusterGrid === previous.clusterGrid)
        expect(next.lightIndexList).toEqual(previous.lightIndexList);
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

  it('re-derives a capped overflow frame and recovers the uncapped fact', () => {
    const owner = new StandardClusterMembershipOwner();
    const scratch = createClusterBinScratch();
    const input = frame();
    const first = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
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
    const capped = prepareStandardLighting(overflowing, undefined, scratch, owner).unwrap();
    expect(capped.clusterEntryCapK).toBe(31);
    const recovered = prepareStandardLighting(input, undefined, scratch, owner).unwrap();
    expect(recovered.clusterEntryCapK).toBeUndefined();
    expect(recovered.clusterGrid).toEqual(first.clusterGrid);
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
