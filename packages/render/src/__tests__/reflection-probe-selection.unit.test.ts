import { describe, expect, it } from 'vitest';
import { type ReflectionProbeFact, selectReflectionProbe } from '../reflection/projection';

const fact = (overrides: Partial<ReflectionProbeFact> = {}): ReflectionProbeFact => ({
  worldId: 0,
  entityKey: 1,
  center: [0, 0, 0],
  halfExtents: [2, 2, 2],
  priority: 0,
  intensity: 1,
  resolution: 256,
  revision: 1,
  ...overrides,
});

describe('ReflectionProbe deterministic selection', () => {
  it('filters by box containment before priority and normalized distance', () => {
    const selected = selectReflectionProbe(
      [fact({ entityKey: 3, priority: 2 }), fact({ entityKey: 2 })],
      [0.5, 0, 0],
    );
    expect(selected.kind).toBe('probe');
    if (selected.kind === 'probe') expect(selected.entityKey).toBe(3);
    expect(selectReflectionProbe([fact({ entityKey: 3 })], [3, 0, 0]).kind).toBe('skylight');
  });

  it('uses normalized distance and stable identity as tie-breaks', () => {
    const selected = selectReflectionProbe(
      [
        fact({ entityKey: 9, center: [1, 0, 0], halfExtents: [2, 2, 2] }),
        fact({ entityKey: 4, center: [-1, 0, 0], halfExtents: [4, 4, 4] }),
      ],
      [0, 0, 0],
    );
    expect(selected.kind).toBe('probe');
    if (selected.kind === 'probe') expect(selected.entityKey).toBe(4);
  });

  it('does not depend on World reorder or mix World identities', () => {
    const probes = [fact({ worldId: 2, entityKey: 8 }), fact({ worldId: 1, entityKey: 3 })];
    const first = selectReflectionProbe(probes, [0, 0, 0]);
    const second = selectReflectionProbe([...probes].reverse(), [0, 0, 0]);
    expect(first).toEqual(second);
    expect(selectReflectionProbe(probes, [8, 0, 0]).kind).toBe('skylight');
  });
});
