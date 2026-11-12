import { expect, it } from 'vitest';
import { makeRhiQueue } from '../queue';

it('refuses to report GPU completion when the backend supplies no completion primitive', async () => {
  await expect(makeRhiQueue({}).onSubmittedWorkDone()).rejects.toMatchObject({
    code: 'webgpu-runtime-error',
  });
});

it('delivers the native completion and preserves its unheld promise and queue receiver', async () => {
  const completion = Promise.resolve(undefined);
  const raw = {
    onSubmittedWorkDone() {
      expect(this).toBe(raw);
      return completion;
    },
  };
  const queue = makeRhiQueue(raw);
  const delivered = queue.onSubmittedWorkDone();
  expect(queue.onSubmittedWorkDoneUnheld?.()).toBe(completion);
  await delivered;
});

it('converts synchronous native binding failures to a rejected completion promise', async () => {
  const failure = new WebAssembly.RuntimeError('native registration trapped');
  const queue = makeRhiQueue({
    onSubmittedWorkDone() {
      throw failure;
    },
  });
  await expect(queue.onSubmittedWorkDone()).rejects.toBe(failure);
});

it('keeps prior completion cleanup pending across nested recording holds while credit completes', async () => {
  const pending: (() => void)[] = [];
  const raw = {
    onSubmittedWorkDone() {
      return new Promise<undefined>((resolve) => pending.push(() => resolve(undefined)));
    },
  };
  const queue = makeRhiQueue(raw),
    order: string[] = [];
  // The earlier submission is already pending when the next frame starts recording.
  const first = queue.onSubmittedWorkDone().then(() => order.push('first'));
  const release = queue.holdCompletions?.() ?? (() => {});
  const nested = queue.holdCompletions?.() ?? (() => {});
  const second = queue.onSubmittedWorkDone().then(() => order.push('second'));
  const credit = queue.onSubmittedWorkDoneUnheld?.() ?? queue.onSubmittedWorkDone();
  expect(pending).toHaveLength(3);
  for (const complete of pending) complete();
  await credit;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);
  release();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);
  nested();
  await Promise.all([first, second]);
  expect(order).toEqual(['first', 'second']);
});
