import { describe, expect, it } from 'vitest';
import { referencedReflectionProbeIndices } from '../record/reflection-probe-material';
import { buildReflectionProbeTable } from '../reflection/gpu-table';

describe('Standard scene reflection probe binding', () => {
  it('covers only selected sparse environment indices, deduplicates receivers, and updates after removal', () => {
    const table = buildReflectionProbeTable(
      [7, 19, 42].map((index) => ({
        index,
        entityKey: index,
        primitiveKey: `${index + 100}`,
        center: [0, 0, 0] as const,
        halfExtents: [1, 1, 1] as const,
        intensity: 1,
        generation: 1,
      })),
    );
    const selections = new Map([
      ['receiver-a', { kind: 'probe' as const, entityKey: 107, normalizedDistance: 0.2 }],
      ['receiver-b', { kind: 'probe' as const, entityKey: 107, normalizedDistance: 0.4 }],
      ['receiver-c', { kind: 'probe' as const, entityKey: 142, normalizedDistance: 0.1 }],
    ]);
    expect([...referencedReflectionProbeIndices({ table, selections })]).toEqual([7, 42]);
    selections.delete('receiver-c');
    expect([...referencedReflectionProbeIndices({ table, selections })]).toEqual([7]);
    selections.clear();
    expect([...referencedReflectionProbeIndices({ table, selections })]).toEqual([]);
  });
  it('uses the default environment when the selected capture has no published row', () => {
    const table = buildReflectionProbeTable([
      {
        index: 7,
        entityKey: 107,
        primitiveKey: '107',
        center: [0, 0, 0],
        halfExtents: [1, 1, 1],
        intensity: 1,
        generation: 1,
      },
    ]);
    const selections = new Map([
      ['receiver-a', { kind: 'probe' as const, entityKey: 7, normalizedDistance: 0 }],
      ['receiver-b', { kind: 'skylight' as const }],
    ]);
    expect([...referencedReflectionProbeIndices({ table, selections })]).toEqual([]);
  });
});
