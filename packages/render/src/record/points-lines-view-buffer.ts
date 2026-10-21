import { type Buffer, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../lifecycle';
import { POINTS_LINES_VIEW_SLOT_COUNT, POINTS_LINES_VIEW_SLOT_STRIDE } from './view-ubo';

/** A view's draw parameters grow before recording; replaced buffers retire after submitted work. */
export function createPointsLinesViewBuffer(device: RhiDevice, scope?: DeviceScope) {
  let buffer: Buffer | undefined;
  let capacity = 0;
  let disposed = false;
  const release = (value: Buffer) => {
    const destroy = () => {
      device.destroyBuffer(value);
    };
    void device.queue.onSubmittedWorkDone().then(destroy, destroy);
  };
  const owner = {
    get buffer(): Buffer {
      if (buffer === undefined) throw new Error('Points/Lines view buffer is not allocated');
      return buffer;
    },
    ensureCapacity(slots: number): void {
      if (disposed) throw new Error('Points/Lines view buffer is disposed');
      if (slots <= capacity) return;
      const next = Math.max(POINTS_LINES_VIEW_SLOT_COUNT, 2 ** Math.ceil(Math.log2(slots)));
      const size = next * POINTS_LINES_VIEW_SLOT_STRIDE;
      if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'capacity for all submitted Points/Lines parameters',
          hint: 'reduce visible point/line work or use a device with a larger buffer limit',
        });
      const result = device.createBuffer({
        label: 'points-lines-view-ubo',
        size,
        usage: 0x40 | 0x08,
      });
      if (!result.ok) throw result.error;
      const previous = buffer;
      buffer = result.value;
      capacity = next;
      if (previous !== undefined) release(previous);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (buffer !== undefined) release(buffer);
      buffer = undefined;
    },
  };
  owner.ensureCapacity(1);
  scope?._adopt('buffer', owner, (value) => value.dispose());
  return owner;
}
