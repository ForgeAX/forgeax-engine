import type { FrameReceipt } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';
import {
  completeFixturePicture,
  requireValidReflectionSignal,
} from './renderer-ready-draw.fixture';

const ok = { ok: true as const };
function frame(presentation: 'pending' | 'ready', preparationCompleted?: Promise<typeof ok>) {
  return {
    presentation,
    frameId: 1,
    presentationPendingReason: { code: 'material-pipeline-preparation' },
    completed: Promise.resolve(ok),
    ...(preparationCompleted === undefined ? {} : { preparationCompleted }),
  } as unknown as FrameReceipt;
}

it('awaits pending preparation and completion before obtaining a new ready receipt without another World update', async () => {
  let prepared!: (value: typeof ok) => void;
  const preparation = new Promise<typeof ok>((resolve) => {
    prepared = resolve;
  });
  let completed!: (value: typeof ok) => void;
  const completion = new Promise<typeof ok>((resolve) => {
    completed = resolve;
  });
  const pending = Object.freeze({ ...frame('pending', preparation), completed: completion });
  const ready = Object.freeze({ ...frame('ready', Promise.resolve(ok)), frameId: 2 });
  const draw = vi.fn().mockReturnValue({ ok: true, value: pending });
  const submitPrepared = vi.fn().mockReturnValue(ready);
  const advance = vi.fn();
  let consumed = false;
  const picture = completeFixturePicture(() => {
    advance();
    return draw().value;
  }, submitPrepared).then(
    (receipt) => {
      consumed = true;
      return receipt;
    },
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(consumed).toBe(false);
  expect(submitPrepared).not.toHaveBeenCalled();
  prepared(ok);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(consumed).toBe(false);
  expect(submitPrepared).not.toHaveBeenCalled();
  completed(ok);
  expect(await picture).toBe(ready);
  expect(pending.presentation).toBe('pending');
  expect(draw).toHaveBeenCalledTimes(1);
  expect(submitPrepared).toHaveBeenCalledTimes(1);
  expect(advance).toHaveBeenCalledTimes(1);
});

it('rejects original preparation failure instead of consuming an empty completed frame', async () => {
  const error = new Error('native pipeline preparation refused');
  const receipt = frame(
    'pending',
    Promise.resolve({ ok: false, error }) as unknown as Promise<typeof ok>,
  );
  const draw = vi.fn().mockReturnValue({ ok: true, value: receipt });
  const submitPrepared = vi.fn();
  await expect(completeFixturePicture(() => draw().value, submitPrepared)).rejects.toBe(error);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(submitPrepared).not.toHaveBeenCalled();
  const missingSignal = frame('pending');
  await expect(completeFixturePicture(() => missingSignal, submitPrepared)).rejects.toThrow(
    'Renderer omitted its compilation completion signal',
  );
  expect(submitPrepared).not.toHaveBeenCalled();
});

it('consumes a ready original picture only after its real GPU completion', async () => {
  let complete!: (value: typeof ok) => void;
  const completion = new Promise<typeof ok>((resolve) => {
    complete = resolve;
  });
  const receipt = { ...frame('ready', Promise.resolve(ok)), completed: completion };
  const draw = vi.fn().mockReturnValue({ ok: true, value: receipt });
  const submitPrepared = vi.fn();
  let consumed = false;
  const picture = completeFixturePicture(() => draw().value, submitPrepared).then((value) => {
    consumed = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(consumed).toBe(false);
  complete(ok);
  expect(await picture).toBe(receipt);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(submitPrepared).not.toHaveBeenCalled();
});

it('keeps the original GPU failure without submitting a replacement picture', async () => {
  const error = new Error('original GPU fence refused');
  const receipt = {
    ...frame('ready', Promise.resolve(ok)),
    completed: Promise.resolve({ ok: false, error }),
  };
  const draw = vi.fn().mockReturnValue({ ok: true, value: receipt });
  const submitPrepared = vi.fn();
  await expect(completeFixturePicture(() => draw().value, submitPrepared)).rejects.toBe(error);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(submitPrepared).not.toHaveBeenCalled();
});

it('rejects invalid or nonfinite signal records instead of masking or filling pixels', () => {
  const invalid = new Float32Array([1, 2, 3, 1, 4, 5, 6, 0]);
  const before = invalid.slice();
  expect(() => requireValidReflectionSignal(invalid, 2, 'raw')).toThrow();
  expect(invalid).toEqual(before);
  expect(() =>
    requireValidReflectionSignal(new Float32Array([Number.NaN, 2, 3, 1]), 1, 'raw'),
  ).toThrow();
  expect(() => requireValidReflectionSignal(new Float32Array([1, 2, 3, 1]), 2, 'raw')).toThrow();
  expect(() =>
    requireValidReflectionSignal(new Float32Array([1, 2, 3, 1]), 1, 'raw'),
  ).not.toThrow();
});
