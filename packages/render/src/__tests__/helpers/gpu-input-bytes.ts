import { type Buffer, err, type RhiDevice, type RhiError } from '@forgeax/engine-rhi';
import { vi } from 'vitest';
import { GPU_DRIVEN_BATCH_STRIDE } from '../../gpu-driven/view-gpu';

/** Observe actual Null queue bytes and actual selector bindings; never synthesize a plan. */
export function observeGpuInputBytes(device: RhiDevice) {
  const bytes = new Map<Buffer, Uint8Array>();
  const original = device.queue.writeBuffer.bind(device.queue);
  let fault: { at: number; thrown: boolean; error: RhiError } | undefined;
  let attempt = 0;
  const writes = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, begin, length) => {
      if (fault !== undefined && ++attempt === fault.at) {
        if (fault.thrown) throw fault.error;
        return err(fault.error);
      }
      const result = original(buffer, offset, data, begin, length);
      if (!result.ok) return result;
      const source =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const patch = source.subarray(begin ?? 0, (begin ?? 0) + (length ?? source.byteLength));
      const previous = bytes.get(buffer);
      const next = new Uint8Array(Math.max(previous?.byteLength ?? 0, offset + patch.length));
      if (previous !== undefined) next.set(previous);
      next.set(patch, offset);
      bytes.set(buffer, next);
      return result;
    });
  const bindings = vi.spyOn(device, 'createBindGroup');
  const buffers = () => {
    for (let index = bindings.mock.calls.length - 1; index >= 0; index--) {
      const entries = [...(bindings.mock.calls[index]?.[0].entries ?? [])];
      if (entries.length !== 9) continue;
      const arena = entries.find((entry) => entry.binding === 3)?.resource;
      const tasks = entries.find((entry) => entry.binding === 4)?.resource;
      if (arena?.kind === 'buffer' && tasks?.kind === 'buffer')
        return { arena: arena.value.buffer, tasks: tasks.value.buffer };
    }
    throw new Error('Missing actual selector input bindings');
  };
  const header = (batch = 0) => {
    const value = bytes.get(buffers().tasks);
    if (value === undefined) throw new Error('Missing uploaded task bytes');
    return new DataView(
      value.buffer,
      value.byteOffset + batch * GPU_DRIVEN_BATCH_STRIDE,
      GPU_DRIVEN_BATCH_STRIDE,
    );
  };
  const readMembers = (root: number, buffer: Buffer, count: number) => {
    const value = bytes.get(buffer);
    if (value === undefined) throw new Error('Missing uploaded arena bytes');
    const words = new Uint32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    const values: {
      primitiveIndex: number;
      generation: number;
      instanceOrdinal: number;
      sourceSlot: number;
    }[] = [];
    let visited = 0;
    const walk = (address: number) => {
      if (address === 0) return;
      if (++visited > count * 2 + 1 || address + 8 > words.length)
        throw new Error('Malformed member encoding extent or cycle');
      walk(words[address] as number);
      const own = words[address + 3] as number;
      if (values.length + own > count) throw new Error('Member weight exceeds task extent');
      for (let ordinal = 0; ordinal < own; ordinal++)
        values.push({
          primitiveIndex: words[address + 4] as number,
          generation: words[address + 5] as number,
          instanceOrdinal: (words[address + 7] as number) + ordinal,
          sourceSlot: words[address + 6] as number,
        });
      walk(words[address + 1] as number);
    };
    walk(root);
    if (values.length !== count) throw new Error('Member encoding is shorter than task extent');
    return values;
  };
  return {
    writes,
    bindings,
    bytes,
    buffers,
    header,
    readMembers,
    injectFailure(at: number, thrown: boolean, error: RhiError) {
      attempt = 0;
      fault = { at, thrown, error };
    },
    clearFailure() {
      fault = undefined;
    },
    members(batch = 0) {
      const table = header(batch);
      return readMembers(table.getUint32(48, true), buffers().arena, table.getUint32(4, true));
    },
    close() {
      writes.mockRestore();
      bindings.mockRestore();
    },
  };
}
