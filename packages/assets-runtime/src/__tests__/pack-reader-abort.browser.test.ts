import { expect, it } from 'vitest';
import { readPackWithoutNativeAny } from './support/pack-reader-abort.js';

const expected = { cancelled: 'asset-load-cancelled', loaded: true, calls: 1 };

it('loads a Pack and preserves shared reads in a Window without AbortSignal.any', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  try {
    expect(await readPackWithoutNativeAny()).toEqual(expected);
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    else Reflect.deleteProperty(AbortSignal, 'any');
  }
});

it('loads a Pack and preserves shared reads in a Worker without AbortSignal.any', async () => {
  const worker = new Worker(new URL('./support/pack-reader-abort.worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const reply = await new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage('read');
    });
    expect(reply).toEqual({ result: expected });
  } finally {
    worker.terminate();
  }
});
