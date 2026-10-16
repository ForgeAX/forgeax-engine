import { describe, expect, it } from 'vitest';
import type { ReflectionProbeSelectionInspection } from '../inspection-types';
import { ReflectionProbeProjection } from '../reflection/projection';
import { createRenderTargetOwner } from '../targets/owner';

describe('bounded render-target inspection', () => {
  it('retains only POD owner facts and no GPU handles or unbounded history', () => {
    const owner = createRenderTargetOwner({
      rendererId: Symbol('renderer'),
      getGeneration: () => 4,
    });
    const target = owner.create({
      shape: '2d',
      width: 8,
      height: 8,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const inspection = owner.inspect(target.value);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(Object.keys(inspection.value).sort()).toEqual([
      'descriptor',
      'generation',
      'state',
      'token',
    ]);
    expect(inspection.value).not.toHaveProperty('history');
    expect(inspection.value).not.toHaveProperty('device');
  });

  it('keeps selection inspection bounded to current primitives', () => {
    const projection = new ReflectionProbeProjection();
    const snapshot = projection.update([], []);
    expect(snapshot.scannedPrimitives).toBe(0);
    expect(snapshot.selected.size).toBe(0);
    expect(projection.selection(1, 2)).toEqual({ kind: 'skylight' });
  });

  it('uses a closed identity for selected probes and Skylight fallback', () => {
    const selected: ReflectionProbeSelectionInspection = {
      kind: 'probe',
      worldId: 2,
      entityKey: 7,
    };
    const fallback: ReflectionProbeSelectionInspection = { kind: 'skylight' };
    expect(selected).toEqual({ kind: 'probe', worldId: 2, entityKey: 7 });
    expect(fallback).toEqual({ kind: 'skylight' });
  });
});
