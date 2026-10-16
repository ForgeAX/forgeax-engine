import { expect, it } from 'vitest';
import { makeRhiQueue } from '../queue';

it('refuses to report GPU completion when the backend supplies no completion primitive', async () => {
  await expect(makeRhiQueue({}).onSubmittedWorkDone()).rejects.toMatchObject({
    code: 'webgpu-runtime-error',
  });
});

it('returns the actual native completion promise with its queue receiver', async () => {
  const completion = Promise.resolve(undefined);
  const raw = {
    onSubmittedWorkDone() {
      expect(this).toBe(raw);
      return completion;
    },
  };
  expect(makeRhiQueue(raw).onSubmittedWorkDone()).toBe(completion);
  await completion;
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
