import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { VfxMeshLightingRig } from './vfx-mesh-lighting.fixture';

it.each([
  false,
  true,
])('exposes preparation before waiting for GPU completion and recycles only settled packets (diagnostics=%s)', async (diagnostics) => {
  vi.useFakeTimers();
  const recycled: number[] = [];
  const captureReceipt = vi.fn();
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
    options: {
      signal: new AbortController().signal,
      ...(diagnostics ? { onIblFailure: vi.fn() } : {}),
    },
    renderer: { draw },
    ...(diagnostics ? { phases: { captureReceipt } } : {}),
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
    expect(captureReceipt).toHaveBeenCalledTimes(diagnostics ? 1 : 0);
    if (diagnostics)
      expect(captureReceipt.mock.calls[0]?.[0]).toMatchObject({
        frameId: 1,
        presentation: 'pending',
      });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(recycled).toEqual([1, 2]);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(captureReceipt).toHaveBeenCalledTimes(diagnostics ? 2 : 0);
    if (diagnostics)
      expect(captureReceipt.mock.calls[1]?.[0]).toMatchObject({
        frameId: 2,
        presentation: 'ready',
      });
  } finally {
    vi.useRealTimers();
  }
});
