import { describe, expect, it } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { skinDemandLayout } from '../gpu-driven/skin-demand';
import {
  deriveGpuDrivenViewBufferCapacities,
  growGpuDrivenVisibleCapacity,
} from '../gpu-driven/view-gpu';
import { growGpuSceneTableCapacity } from '../gpu-scene';

const DEFAULT_BINDING = 134_217_728;
const DEFAULT_BUFFER = 268_435_456;

/** Synthetic membership: one dominant rigid window plus small residual windows. */
function plan(members: readonly number[]): Pick<SubmissionPlan, 'candidateCount' | 'batches'> {
  let base = 0;
  const batches = members.map((count, index) => {
    const allocation = Math.max(1, Math.ceil(count / 64)) * 64;
    const batch = {
      batchId: index,
      visibleBase: base,
      visibleCapacity: count,
      visibleAllocationCapacity: allocation,
      indirectOffset: index * 20,
      candidates: { length: count },
    } as unknown as GpuDrivenBatch;
    base += allocation;
    return batch;
  });
  return {
    candidateCount: members.reduce((total, count) => total + count, 0),
    batches: batches as unknown as SubmissionPlan['batches'],
  };
}

describe('GPU-driven buffers at 1M objects', () => {
  const membership = [999_740, ...Array.from({ length: 128 }, () => 5)];
  const capacities = deriveGpuDrivenViewBufferCapacities(plan(membership));

  it('derives the visible stream from actual membership, not a power of two', () => {
    expect(capacities.visible).toBe(Math.ceil(999_740 / 64) * 64 + 128 * 64);
    expect(capacities.visible).toBeLessThan(1_010_000);
  });

  it('fits the main view (union + late mirror + Skin tail) in the default binding', () => {
    const visible = growGpuDrivenVisibleCapacity(0, capacities.visible, Number.MAX_SAFE_INTEGER);
    expect(visible).toBe(Math.ceil((capacities.visible * 1.25) / 64) * 64);
    const skin = skinDemandLayout(1_000_380, 128, visible * 16 * 2);
    expect(skin.outputBytes).toBeLessThan(DEFAULT_BINDING / 2);
  });

  it('keeps shadow views without a late mirror at one copy', () => {
    expect(capacities.visible * 16).toBeLessThan(DEFAULT_BINDING / 8);
  });
});

describe('visible capacity growth', () => {
  it('keeps a stable capacity and grows geometrically', () => {
    expect(growGpuDrivenVisibleCapacity(0, 100, 1e9)).toBe(192);
    expect(growGpuDrivenVisibleCapacity(128, 100, 1e9)).toBe(128);
    expect(growGpuDrivenVisibleCapacity(1024, 1025, 1e9)).toBe(1536);
    expect(growGpuDrivenVisibleCapacity(1024, 4000, 1e9)).toBe(4032);
  });

  it('clamps growth slack to the device ceiling without clamping the requirement', () => {
    const ceiling = DEFAULT_BINDING / 32;
    expect(growGpuDrivenVisibleCapacity(3_000_000, 3_100_000, ceiling)).toBe(ceiling);
    expect(growGpuDrivenVisibleCapacity(3_000_000, ceiling + 1, ceiling)).toBe(ceiling + 64);
    expect(growGpuDrivenVisibleCapacity(0, ceiling - 64, ceiling)).toBe(ceiling);
  });
});

describe('GPU Scene table growth', () => {
  it('doubles below the binding limit and clamps slack at it', () => {
    expect(growGpuSceneTableCapacity(1024, 1024, 128, DEFAULT_BINDING)).toEqual({
      ok: true,
      value: 1024,
    });
    expect(growGpuSceneTableCapacity(1024, 1025, 128, DEFAULT_BINDING)).toEqual({
      ok: true,
      value: 2048,
    });
    // 1M transforms (128 B) fit exactly in 128 MiB; slack never exceeds it.
    expect(growGpuSceneTableCapacity(524_288, 1_000_600, 128, DEFAULT_BINDING)).toEqual({
      ok: true,
      value: 1_048_576,
    });
    expect(growGpuSceneTableCapacity(900_000, 1_000_600, 128, 200_000_000)).toEqual({
      ok: true,
      value: Math.floor(200_000_000 / 128),
    });
  });

  it('fails with a structured limit error only beyond the device ceiling', () => {
    const result = growGpuSceneTableCapacity(1_048_576, 1_048_577, 128, DEFAULT_BINDING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
    expect(result.error.detail).toEqual({
      maxStorageBufferBindingSize: DEFAULT_BINDING,
      requestedBytes: 1_048_577 * 128,
    });
    expect(growGpuSceneTableCapacity(1_048_576, 1_048_577, 128, DEFAULT_BUFFER).ok).toBe(true);
  });
});
