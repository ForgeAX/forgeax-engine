import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBGPU_STUB_PROFILE, installWebGpuStub, requestAdapter } from '../index';

class TestCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(_type: string): unknown {
    return null;
  }
}
Object.assign(globalThis, { OffscreenCanvas: TestCanvas });
installWebGpuStub(DEFAULT_WEBGPU_STUB_PROFILE);

const settledWithin = async (promise: Promise<unknown>, turns = 8): Promise<boolean> => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let turn = 0; turn < turns && !settled; turn++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
};

describe('queue completion hold', () => {
  it('delays held completions in FIFO order while unheld credit completions settle', async () => {
    const device = (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
    const queue = device.queue;
    expect(queue.holdCompletions).toBeTypeOf('function');
    expect(queue.onSubmittedWorkDoneUnheld).toBeTypeOf('function');

    expect(await settledWithin(queue.onSubmittedWorkDone())).toBe(true);

    const release = queue.holdCompletions?.() ?? (() => {});
    const order: string[] = [];
    const first = queue.onSubmittedWorkDone().then(() => order.push('first'));
    const second = queue.onSubmittedWorkDone().then(() => order.push('second'));
    const credit = queue.onSubmittedWorkDoneUnheld?.() ?? Promise.resolve();
    expect(await settledWithin(credit)).toBe(true);
    expect(await settledWithin(first)).toBe(false);
    expect(order).toEqual([]);

    // Nested holds keep delivery closed until the last one is released.
    const nested = queue.holdCompletions?.() ?? (() => {});
    release();
    release();
    expect(await settledWithin(second)).toBe(false);
    nested();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);

    // After release, completions are delivered without delay again.
    expect(await settledWithin(queue.onSubmittedWorkDone())).toBe(true);
  });
});
