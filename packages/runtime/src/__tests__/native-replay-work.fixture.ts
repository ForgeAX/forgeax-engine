import type { RhiDevice } from '@forgeax/engine-rhi';
import { expect } from 'vitest';

/** Observe one real replay queue without changing calls, arguments or results. */
export function observeReplaySubmissions(device: RhiDevice) {
  const queue = device.nativeDevice().unwrap().queue;
  const descriptor = Object.getOwnPropertyDescriptor(queue, 'submit');
  const original = queue.submit;
  let submissions = 0;
  const measured = function (this: GPUQueue, ...args: Parameters<GPUQueue['submit']>) {
    submissions++;
    return Reflect.apply(original, this, args);
  };
  queue.submit = measured;
  return {
    assertMaximum(maximum: number) {
      expect(submissions, 'real replay queue submissions').toBeGreaterThan(0);
      expect(submissions, 'real replay queue submissions').toBeLessThanOrEqual(maximum);
    },
    restore() {
      if (queue.submit !== measured) return;
      if (descriptor === undefined) Reflect.deleteProperty(queue, 'submit');
      else Object.defineProperty(queue, 'submit', descriptor);
    },
  };
}
