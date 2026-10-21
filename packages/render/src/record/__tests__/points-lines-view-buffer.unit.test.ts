import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createPointsLinesViewBuffer } from '../points-lines-view-buffer';
import { POINTS_LINES_VIEW_SLOT_STRIDE } from '../view-ubo';

it('grows past 1024 submitted draw rows and fences the replaced buffer', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let complete!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    complete = () => resolve(undefined);
  });
  const done = vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  const created = vi.spyOn(device, 'createBuffer');
  const view = createPointsLinesViewBuffer(device);
  const first = view.buffer;
  view.ensureCapacity(1200);
  const second = view.buffer;
  expect(second).not.toBe(first);
  expect(created.mock.calls.at(-1)?.[0].size).toBe(2048 * POINTS_LINES_VIEW_SLOT_STRIDE);
  expect(destroyed).not.toHaveBeenCalled();
  device.queue
    .writeBuffer(second, 1199 * POINTS_LINES_VIEW_SLOT_STRIDE, new Uint8Array(176))
    .unwrap();
  view.ensureCapacity(1200);
  expect(created).toHaveBeenCalledTimes(2);
  complete();
  await fence;
  expect(destroyed).toHaveBeenCalledWith(first);
  view.dispose();
  await Promise.resolve();
  expect(destroyed).toHaveBeenCalledWith(second);
  expect(() => view.ensureCapacity(1)).toThrow('disposed');
  done.mockRestore();
  destroyed.mockRestore();
  created.mockRestore();
});
