import type { FrameReceipt } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererContractFailureError } from '../../../../render/src/errors/render';
import { completedReadyFrame } from './completed-ready-frame';

afterEach(() => vi.useRealTimers());

function receipt(
  frameId: number,
  presentation: 'pending' | 'ready',
  preparationCompleted?: FrameReceipt['preparationCompleted'],
): FrameReceipt {
  return {
    frameId,
    deviceGeneration: 0,
    backendId: 'webgpu',
    presentation,
    completed: Promise.resolve(ok(undefined)),
    ...(preparationCompleted === undefined ? {} : { preparationCompleted }),
  };
}

it('waits for actual preparation and a new completed ready receipt without advancing the source', async () => {
  let settle!: (value: ReturnType<typeof ok<void>>) => void;
  const pending = receipt(
    1,
    'pending',
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  const ready = receipt(2, 'ready');
  const draw = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(ready);
  const waiting = completedReadyFrame(draw, Date.now() + 1000);
  await pending.completed;
  expect(draw).toHaveBeenCalledTimes(1);
  settle(ok(undefined));
  expect(await waiting).toBe(ready);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(pending.presentation).toBe('pending');
});

it('preserves a failed preparation and refuses pending work without a completion signal', async () => {
  const error = new RendererContractFailureError('draw', 'native preparation rejected');
  const draw = vi.fn(() => receipt(1, 'pending', Promise.resolve(err(error))));
  await expect(completedReadyFrame(draw, Date.now() + 1000)).rejects.toBe(error);
  expect(draw).toHaveBeenCalledTimes(1);
  await expect(completedReadyFrame(() => receipt(2, 'pending'), Date.now() + 1000)).rejects.toThrow(
    'omitted',
  );
});

it('retains the original deadline and refuses reuse of the pending receipt', async () => {
  vi.useFakeTimers();
  const waiting = completedReadyFrame(
    () => receipt(1, 'pending', new Promise(() => {})),
    Date.now() + 1000,
  );
  const rejected = expect(waiting).rejects.toThrow('deadline expired');
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  const pending = receipt(2, 'pending', Promise.resolve(ok(undefined)));
  await expect(completedReadyFrame(() => pending, Date.now() + 1000)).rejects.toThrow(
    'new frame receipt',
  );
});
