import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { makeRhiDevice } from '../device';

/** A strict old-signature receiver forwards all admitted work to the actual GPU. */
export async function verifyBufferCompatibility() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('Buffer compatibility requires a native WebGPU adapter');
  const raw = await adapter.requestDevice();
  let copies = 0;
  const proxy = new Proxy(raw, {
    get(target, key) {
      if (key === 'createCommandEncoder') {
        return (desc?: GPUCommandEncoderDescriptor) => {
          const encoder = target.createCommandEncoder(desc);
          return new Proxy(encoder, {
            get(target, key) {
              if (key === 'copyBufferToBuffer') {
                return (...args: unknown[]) => {
                  if (args.length !== 5) throw new TypeError('Expected five native copy arguments');
                  copies++;
                  return target.copyBufferToBuffer(
                    args[0] as GPUBuffer,
                    args[1] as number,
                    args[2] as GPUBuffer,
                    args[3] as number,
                    args[4] as number,
                  );
                };
              }
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { device } = makeRhiDevice(proxy);
  const source = device.createBuffer({ size: 16, usage: 4 | 8 }).unwrap();
  const target = device.createBuffer({ size: 16, usage: 1 | 8 }).unwrap();
  const data = new Float32Array([11, 22, 33, 44]);
  const read = async () => {
    const mapped = (await target.mapAsync(1)).unwrap();
    try {
      return Array.from(new Float32Array(mapped.getMappedRange().unwrap()).slice());
    } finally {
      mapped.unmap();
    }
  };
  const submit = (encode: (encoder: RhiCommandEncoder) => void) => {
    const encoder = device.createCommandEncoder().unwrap();
    encode(encoder);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  try {
    raw.pushErrorScope('validation');
    device.queue.writeBuffer(source, 0, data).unwrap();
    submit((encoder) => encoder.copyBufferToBuffer(source, target));
    expect(await read()).toEqual([11, 22, 33, 44]);

    device.queue.writeBuffer(target, 0, new Float32Array([99, 99, 99, 99])).unwrap();
    submit((encoder) => encoder.copyBufferToBuffer(source, target, 0));
    expect(await read()).toEqual([99, 99, 99, 99]);

    submit((encoder) => encoder.copyBufferToBuffer(source, 4, target, 8, 8));
    expect(await read()).toEqual([99, 99, 22, 33]);

    device.queue.writeBuffer(target, 4, data, 1).unwrap();
    expect(await read()).toEqual([99, 22, 33, 44]);
    device.queue.writeBuffer(target, 0, data, 2, 2).unwrap();
    expect(await read()).toEqual([33, 44, 33, 44]);
    device.queue.writeBuffer(target, 0, data, 0, 0).unwrap();
    expect(await read()).toEqual([33, 44, 33, 44]);
    expect(await raw.popErrorScope()).toBeNull();
    expect(copies).toBe(3);

    raw.pushErrorScope('validation');
    const invalid = device.createCommandEncoder().unwrap();
    invalid.copyBufferToBuffer(source, target, 20);
    invalid.finish().unwrap();
    expect(await raw.popErrorScope()).not.toBeNull();
  } finally {
    device.destroyBuffer(source).unwrap();
    device.destroyBuffer(target).unwrap();
    raw.destroy();
  }
}
