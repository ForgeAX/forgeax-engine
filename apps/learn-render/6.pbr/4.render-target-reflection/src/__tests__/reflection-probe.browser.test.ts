import { describe, expect, it } from 'vitest';
import {
  REFLECTION_PROBE_IBL_STAGES,
  ReflectionProbeProjection,
  selectReflectionProbe,
} from '@forgeax/engine-render';

describe('ReflectionProbe Browser paired evidence contract', () => {
  it('keeps PMREM stages ordered before local sampling publication', () => {
    expect(REFLECTION_PROBE_IBL_STAGES).toEqual(['raw', 'filtered', 'publish']);
  });

  it('selects a box candidate inside and Skylight outside', () => {
    const fact = {
      worldId: 0,
      entityKey: 4,
      center: [0, 0, 0] as const,
      halfExtents: [1, 1, 1] as const,
      priority: 1,
      intensity: 1,
      resolution: 64,
      revision: 1,
    };
    expect(selectReflectionProbe([fact], [0, 0, 0]).kind).toBe('probe');
    expect(selectReflectionProbe([fact], [2, 0, 0]).kind).toBe('skylight');

    const projection = new ReflectionProbeProjection();
    const snapshot = projection.update([fact], [{ worldId: 0, entityKey: 9, center: [0, 0, 0] }]);
    expect(snapshot.selected.get('0:9')?.kind).toBe('probe');
  });
});
