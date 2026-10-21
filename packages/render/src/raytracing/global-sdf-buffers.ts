import type { Buffer, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';

/** Global-SDF kernels own only the buffers allocated for their input/output tuple. */
export function createGlobalSdfBuffers<Key extends string>(
  device: RhiDevice,
  label: string,
  data: Record<Key, Uint8Array>,
): Result<
  {
    readonly buffers: Record<Key, Buffer>;
    readonly disposed: boolean;
    dispose(): void;
  },
  RhiError
> {
  const buffers = {} as Record<Key, Buffer>;
  const owned: Buffer[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const buffer of owned) device.destroyBuffer(buffer);
    owned.length = 0;
  };
  for (const key of Object.keys(data) as Key[]) {
    const bytes = data[key];
    const made = device.createBuffer({
      label: `${label}.${key}`,
      size: bytes.byteLength,
      usage: (key === 'settings' ? 64 : 128) | 12,
    });
    if (!made.ok) {
      dispose();
      return made;
    }
    buffers[key] = made.value;
    owned.push(made.value);
    const wrote = device.queue.writeBuffer(made.value, 0, bytes);
    if (!wrote.ok) {
      dispose();
      return wrote;
    }
  }
  return ok({
    buffers,
    get disposed() {
      return disposed;
    },
    dispose,
  });
}
