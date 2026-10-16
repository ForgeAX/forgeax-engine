import { describe, expect, it } from 'vitest';
import {
  advanceProbeFilter,
  boxProjectReflectionDirection,
  createProbeFilterState,
} from '../reflection/filter';
import { buildReflectionProbeTable } from '../reflection/gpu-table';

describe('ReflectionProbe bounded filtering and table projection', () => {
  it('does at most one face and one mip filter step per frame', () => {
    const state = createProbeFilterState({ probeIndex: 2, faceCount: 6, mipCount: 5 });
    expect(advanceProbeFilter(state)).toEqual({ probeIndex: 2, faceIndex: 0, mipLevel: 0 });
    expect(advanceProbeFilter({ ...state, cursor: 1 })).toEqual({
      probeIndex: 2,
      faceIndex: 1,
      mipLevel: 0,
    });
  });

  it('keeps active LKG while a candidate is incomplete', () => {
    const state = createProbeFilterState({ probeIndex: 0, faceCount: 6, mipCount: 3 });
    expect(state.activeGeneration).toBe(0);
    const next = advanceProbeFilter({ ...state, cursor: 17 });
    expect(next).toEqual({ probeIndex: 0, faceIndex: 5, mipLevel: 2 });
    expect(state.activeGeneration).toBe(0);
  });

  it('publishes only filtered probe rows and joins CPU/GPU by one index', () => {
    const table = buildReflectionProbeTable([
      {
        primitiveKey: '0:9',
        index: 1,
        worldId: 0,
        entityKey: 8,
        center: [0, 0, 0],
        halfExtents: [2, 2, 2],
        intensity: 1,
        generation: 4,
      },
    ]);
    expect(table.rows[0]?.index).toBe(1);
    expect(table.rows[0]?.generation).toBe(4);
    expect(table.cpuIndexByPrimitive('0:9')).toBe(1);
  });

  it('does not turn an outside ray into a direction from the box center', () => {
    expect(boxProjectReflectionDirection([0, 1, 0], [0, 0, 0], [1, 1, 1], [4, -1, 3])).toEqual([
      0, 1, 0,
    ]);
    expect(boxProjectReflectionDirection([0, -1, 0], [0, 0, 0], [1, 1, 1], [4, -1, 3])).toEqual([
      0, -1, 0,
    ]);
  });

  it('projects a reflection direction from inside and outside the box', () => {
    expect(boxProjectReflectionDirection([1, 0, 0], [0, 0, 0], [2, 2, 2], [0, 0, 0])).toEqual([
      1, 0, 0,
    ]);
    expect(boxProjectReflectionDirection([1, 0, 0], [0, 0, 0], [2, 2, 2], [3, 0, 0])).toEqual([
      1, 0, 0,
    ]);
  });
});
