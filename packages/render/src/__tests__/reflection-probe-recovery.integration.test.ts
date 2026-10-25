import { describe, expect, it } from 'vitest';
import {
  admitReflectionProbe,
  estimateReflectionProbeBytes,
  ReflectionProbeProjection,
} from '../reflection/projection';
import { primitiveRows } from './helpers/reflection-rows';

describe('ReflectionProbe recovery integration', () => {
  it('selects by world identity and falls back to Skylight outside all boxes', () => {
    const projection = new ReflectionProbeProjection();
    const scene = primitiveRows([
      { worldId: 9, entityKey: 100, center: [0, 0, 0] },
      { worldId: 3, entityKey: 200, center: [4, 0, 0] },
    ]);
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
      scene.rows(),
      scene.centerOf,
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

  it('re-selects only the D changed rows of a steady scene and recovers cold', () => {
    const N = 20_000;
    const facts = [
      {
        worldId: 0,
        entityKey: 1_000_000,
        center: [0, 0, 0] as const,
        halfExtents: [10, 10, 10] as const,
        priority: 1,
        intensity: 1,
        resolution: 64,
        revision: 1,
      },
    ];
    const scene = primitiveRows(
      Array.from({ length: N }, (_, entityKey) => ({
        worldId: 0,
        entityKey,
        center: [entityKey % 40, 0, 0] as const,
      })),
    );
    const projection = new ReflectionProbeProjection();
    expect(projection.update(facts, scene.rows(), scene.centerOf).scannedPrimitives).toBe(N);
    const D = 8;
    for (let index = 0; index < D; index++) scene.move(index * 101, [50, 0, 0]);
    const steady = projection.update(facts, scene.rows(), scene.centerOf);
    expect(steady.scannedPrimitives).toBe(D);
    expect(projection.selection(0, 101)).toEqual({ kind: 'skylight' });
    expect(projection.selection(0, 1)).toMatchObject({ kind: 'probe' });
    const selected = new Map(steady.selected);

    const recovered = new ReflectionProbeProjection();
    const cold = recovered.update(facts, scene.rows(), scene.centerOf);
    expect(cold.scannedPrimitives).toBe(N);
    expect(new Map(cold.selected)).toEqual(selected);
  });
});
