import { describe, expect, it } from 'vitest';
import {
  admitReflectionProbe,
  estimateReflectionProbeBytes,
  ReflectionProbeProjection,
} from '../reflection/projection';

describe('ReflectionProbe recovery integration', () => {
  it('selects by world identity and falls back to Skylight outside all boxes', () => {
    const projection = new ReflectionProbeProjection();
    const snapshot = projection.update(
      [
        {
          worldId: 9,
          entityKey: 4,
          center: [0, 0, 0],
          halfExtents: [2, 2, 2],
          priority: 1,
          intensity: 1,
          resolution: 64,
          revision: 1,
        },
        {
          worldId: 3,
          entityKey: 8,
          center: [0, 0, 0],
          halfExtents: [2, 2, 2],
          priority: 1,
          intensity: 1,
          resolution: 64,
          revision: 1,
        },
      ],
      [
        { worldId: 9, entityKey: 100, center: [0, 0, 0] },
        { worldId: 3, entityKey: 200, center: [4, 0, 0] },
      ],
    );
    expect(snapshot.scannedPrimitives).toBe(2);
    expect(projection.selection(9, 100)).toMatchObject({ kind: 'probe', worldId: 3, entityKey: 8 });
    expect(projection.selection(3, 200)).toEqual({ kind: 'skylight' });
    expect([...snapshot.facts].map((fact) => `${fact.worldId}:${fact.entityKey}`)).toEqual([
      '3:8',
      '9:4',
    ]);
  });

  it('rejects the next allocation before GPU work exceeds the admission budget', () => {
    const probe = { halfExtents: [1, 1, 1] as const, priority: 0, intensity: 1, resolution: 64 };
    const bytes = estimateReflectionProbeBytes(probe.resolution);
    const result = admitReflectionProbe(probe, { acceptedCount: 16, acceptedBytes: bytes * 16 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('reflection-probe-budget-exceeded');
  });
});
