import { describe, expect, it } from 'vitest';
import { boundedReflectionProbeFilterWork } from '../record/typed-frame-graph';
import {
  advanceProbeFilter,
  createProbeFilterState,
  probeFilterIsSteady,
} from '../reflection/filter';
import { ReflectionProbeProjection } from '../reflection/projection';

describe('ReflectionProbe steady-state performance contract', () => {
  it('keeps off and steady filter work exactly zero', () => {
    const off = boundedReflectionProbeFilterWork({ work: [], maxStepsPerFrame: 1 });
    const steady = createProbeFilterState({ probeIndex: 0, faceCount: 6, mipCount: 5 });
    const complete = { ...steady, cursor: steady.faceCount * steady.mipCount };

    expect(off).toHaveLength(0);
    expect(probeFilterIsSteady(complete)).toBe(true);
    expect(advanceProbeFilter(complete)).toBeUndefined();
  });

  it('keeps one candidate bounded to active output and one table row', () => {
    const state = createProbeFilterState({ probeIndex: 3, faceCount: 6, mipCount: 5 });
    const step = advanceProbeFilter(state);
    expect(step).toBeDefined();
    if (!step) throw new Error('expected an initial reflection probe filter step');
    expect(step).toEqual({ probeIndex: 3, faceIndex: 0, mipLevel: 0 });
    expect(
      boundedReflectionProbeFilterWork({
        work: [step],
        maxStepsPerFrame: 1,
      }),
    ).toHaveLength(1);
  });

  it('does not advance the projection revision on a stable frame', () => {
    const projection = new ReflectionProbeProjection();
    const facts = [
      {
        worldId: 0,
        entityKey: 3,
        center: [0, 0, 0] as const,
        halfExtents: [2, 2, 2] as const,
        priority: 1,
        intensity: 1,
        resolution: 64,
        revision: 1,
      },
    ];
    const primitives = [
      { worldId: 0, entityKey: 8, center: [0, 0, 0] as const },
      { worldId: 0, entityKey: 9, center: [3, 0, 0] as const },
    ];
    const first = projection.update(facts, primitives);
    const second = projection.update(facts, primitives);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(1);
    expect(second.scannedPrimitives).toBe(first.scannedPrimitives);
  });
});
