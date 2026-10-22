import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

function batch(binding: object): GpuDrivenBatch {
  return { batchId: 1, visibleCapacity: 1, binding } as unknown as GpuDrivenBatch;
}

it('does not keep an earlier selection reachable through its change diff', async () => {
  const binding = { material: {}, worldId: 0, assetHandle: 1, drawItemIndex: 0 };
  let previous: GpuDrawSelection | undefined = new GpuDrawSelection([batch(binding)]);
  const released = new WeakRef(previous);
  const current = new GpuDrawSelection([batch(binding)]);
  expect(current.changedBindingsSince(previous).size).toBe(1);
  previous = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(released.deref()).toBeUndefined();
  expect(current).toBeDefined();
});
