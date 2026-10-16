import { describe, expect, it } from 'vitest';
import { type CameraTargetCandidate, selectCameraTargetViews } from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import { createRenderTargetOwner } from '../targets/owner';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 16,
  height: 16,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

function targets() {
  const owner = createRenderTargetOwner({ rendererId: Symbol('renderer'), getGeneration: () => 1 });
  const first = owner.create(descriptor);
  const second = owner.create(descriptor);
  if (!first.ok) throw first.error;
  if (!second.ok) throw second.error;
  return [first.value, second.value] as const;
}

describe('Camera target consumption', () => {
  it('keeps display authority separate and applies stable auxiliary ordering and budget', () => {
    const [first, second] = targets();
    const cameras: CameraTargetCandidate[] = [
      { worldId: 2, entityKey: 20, target: first, requestVersion: 1, update: 'once' },
      { worldId: 1, entityKey: 30, target: second, requestVersion: 1, update: 'continuous' },
      { worldId: 1, entityKey: 10, requestVersion: 0, update: 'continuous' },
    ];
    const selected = selectCameraTargetViews(cameras, { displayEntityKey: 10, budget: 1 });
    expect(selected.display?.entityKey).toBe(10);
    expect(selected.auxiliary.map((camera) => camera.entityKey)).toEqual([30]);
    expect(selected.rejected).toHaveLength(1);
    expect(selected.rejected[0]?.reason).toBe('budget');
  });

  it('rejects a target camera selected as display and duplicate target producers', () => {
    const [first] = targets();
    const cameras: CameraTargetCandidate[] = [
      { worldId: 1, entityKey: 3, target: first, requestVersion: 1, update: 'once' },
      { worldId: 1, entityKey: 4, target: first, requestVersion: 2, update: 'once' },
    ];
    const selected = selectCameraTargetViews(cameras, { displayEntityKey: 3, budget: 2 });
    expect(selected.display).toBeUndefined();
    expect(selected.rejected.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(['display-target', 'duplicate-target']),
    );
  });

  it('records every distinct layer writer of a selected target under a per-target budget', () => {
    const [first, second] = targets();
    const cameras: CameraTargetCandidate[] = [
      {
        worldId: 1,
        entityKey: 1,
        target: first,
        targetLayer: 0,
        requestVersion: 1,
        update: 'continuous',
      },
      {
        worldId: 1,
        entityKey: 2,
        target: first,
        targetLayer: 2,
        requestVersion: 1,
        update: 'continuous',
      },
      {
        worldId: 1,
        entityKey: 3,
        target: first,
        targetLayer: 2,
        requestVersion: 1,
        update: 'continuous',
      },
      {
        worldId: 1,
        entityKey: 4,
        target: second,
        targetLayer: 1,
        requestVersion: 1,
        update: 'continuous',
      },
    ];
    const selected = selectCameraTargetViews(cameras, { budget: 1 });
    expect(selected.auxiliary.map((camera) => camera.entityKey)).toEqual([1, 2]);
    expect(selected.rejected).toEqual([
      { entityKey: 3, reason: 'duplicate-target' },
      { entityKey: 4, reason: 'budget' },
    ]);
  });
});
