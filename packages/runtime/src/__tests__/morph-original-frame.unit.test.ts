import type { FrameReceipt } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { MorphOriginalFrame, preserveMorphFailure } from './helpers/morph-original-frame';

it('closes the original submission without waiting for its pending preparation or GPU fence', async () => {
  const boundary = vi.fn(async () => ok(undefined));
  const recorder = {
    captureFrame: vi.fn(() => new Promise<never>(() => {})),
    frameBoundary: boundary,
  } satisfies Pick<RecorderAttachment, 'captureFrame' | 'frameBoundary'>;
  const owner = new MorphOriginalFrame(recorder, () => ({ pending: true }));
  await owner.begin();
  const receipt = {
    frameId: 76,
    presentation: 'pending',
    presentationPendingReason: { code: 'scene-pipeline-preparation' },
    completed: new Promise<never>(() => {}),
    preparationCompleted: new Promise<never>(() => {}),
  } satisfies Pick<
    FrameReceipt,
    'frameId' | 'presentation' | 'presentationPendingReason' | 'completed' | 'preparationCompleted'
  >;
  owner.submitted(receipt);
  owner.submitted({ ...receipt, frameId: 77 });
  expect(boundary).toHaveBeenCalledTimes(2);
  expect(owner.evidence().receipt).toMatchObject({
    frameId: 76,
    preparation: { status: 'pending' },
    completed: { status: 'pending' },
  });
  expect(owner.evidence().tape).toBeUndefined();
  owner.dispose();
  expect(boundary).toHaveBeenCalledTimes(2);
});

it('retains the original completion timestamps without awaiting either signal', async () => {
  const owner = new MorphOriginalFrame(
    {
      captureFrame: () => new Promise<never>(() => {}),
      frameBoundary: async () => ok(undefined),
    },
    () => ({}),
  );
  await owner.begin();
  owner.submitted({
    frameId: 1,
    presentation: 'pending',
    completed: Promise.resolve(ok(undefined)),
    preparationCompleted: Promise.resolve(ok(undefined)),
  });
  await Promise.resolve();
  expect(owner.evidence().receipt).toMatchObject({
    preparation: { status: 'fulfilled', atUnixMs: expect.any(Number) },
    completed: { status: 'fulfilled', atUnixMs: expect.any(Number) },
  });
  owner.dispose();
});

it('preserves the original rendering error when diagnostic transport rejects', async () => {
  const original = new Error('original pending preparation');
  const report = vi.fn(async () => {
    throw new Error('transport');
  });
  const draw = vi.fn();
  await expect(preserveMorphFailure(report, draw, original)).rejects.toBe(original);
  expect(report).toHaveBeenCalledWith(draw, original);
  expect(draw).not.toHaveBeenCalled();
});
