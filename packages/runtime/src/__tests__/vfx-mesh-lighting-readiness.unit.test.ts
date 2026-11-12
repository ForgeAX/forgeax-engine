import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { VfxMeshLightingRig } from './vfx-mesh-lighting.fixture';

it('exposes preparation before waiting for GPU completion and recycles only settled packets', async () => {
  vi.useFakeTimers();
  const recycled: number[] = [];
  let revision = 0;
  const preparationCompleted = new Promise((resolve) =>
    setTimeout(() => resolve(ok(undefined)), 10_000),
  );
  const completed = new Promise((resolve) => setTimeout(() => resolve(ok(undefined)), 20_000));
  const draw = vi.fn(() =>
    ok(
      revision === 1
        ? {
            frameId: revision,
            presentation: 'pending',
            presentationPendingReason: { code: 'scene-pipeline-preparation' },
            preparationCompleted,
            completed,
          }
        : { frameId: revision, presentation: 'ready', completed: Promise.resolve(ok(undefined)) },
    ),
  );
  // Only the frame driver runs here; renderer construction and GPU acceptance
  // remain in the complete publication Browser fixture.
  const rig = Object.assign(Object.create(VfxMeshLightingRig.prototype), {
    options: { signal: new AbortController().signal },
    renderer: { draw },
    publisher: {
      prepare: () => {
        revision++;
        expect(recycled).toHaveLength(revision - 1);
        return ok({ message: { revision, record: new ArrayBuffer(8) }, accept() {} });
      },
      recycle: (value: number) => {
        recycled.push(value);
        return ok(undefined);
      },
    },
  }) as VfxMeshLightingRig;
  try {
    const result = rig.drawFrame();
    const settled = expect(result).resolves.toMatchObject({
      ok: true,
      value: { frameId: 2, presentation: 'ready' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(recycled).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(recycled).toEqual([1, 2]);
    expect(draw).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
