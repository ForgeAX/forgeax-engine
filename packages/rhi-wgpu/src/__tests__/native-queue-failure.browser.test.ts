import { ensureReady } from '@forgeax/engine-wgpu-wasm';
import { expect, it } from 'vitest';
import { makeRhiQueue, type RawQueueLike } from '../queue';

it('rejects a native poll exception without leaving the completion FIFO pending', async () => {
  const canvas = document.createElement('canvas');
  const wasm = await ensureReady();
  const instance = await wasm.RhiWgpuInstance.create();
  const adapter = await instance.requestAdapterWithCanvas(canvas);
  if (!(adapter instanceof wasm.RhiWgpuAdapter)) throw new Error(String(adapter));
  const device = await adapter.requestDevice({});
  const raw = device.queue;
  const secondRaw = device.queue;
  const queue = makeRhiQueue(raw as unknown as RawQueueLike);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Actual WebGL2 is required');
  const getSyncParameter = gl.getSyncParameter;
  let polls = 0;
  try {
    const encoder = device.createCommandEncoder({});
    raw.submit([encoder.finish()]);
    encoder.free();
    const order: number[] = [];
    const first = queue.onSubmittedWorkDone().then(
      () => 'resolved',
      (error: unknown) => {
        order.push(1);
        return error;
      },
    );
    const second = makeRhiQueue(secondRaw as unknown as RawQueueLike)
      .onSubmittedWorkDone()
      .then(
        () => 'resolved',
        (error: unknown) => {
          order.push(2);
          return error;
        },
      );
    gl.getSyncParameter = () => {
      polls += 1;
      throw new Error('injected native poll failure');
    };
    const outcome = await Promise.race([
      Promise.all([first, second]),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 300)),
    ]);
    expect(polls).toBeGreaterThan(0);
    expect(outcome).toBeInstanceOf(Array);
    expect(order).toEqual([1, 2]);
    if (!Array.isArray(outcome)) throw new Error('Native completion remained pending');
    expect(outcome[0]).toMatchObject({ cause: { message: 'injected native poll failure' } });
  } finally {
    gl.getSyncParameter = getSyncParameter;
    secondRaw.free();
    raw.free();
    device.free();
    adapter.free();
    instance.free();
  }
});
