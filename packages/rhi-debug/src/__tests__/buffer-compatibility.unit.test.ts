import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { wrap } from '../recorder';

async function fixture() {
  const debug = wrap(rhi, createShaderModule);
  const adapter = (await debug.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  debug.arm(1).unwrap();
  return { debug, device };
}

describe('buffer command recording semantics', () => {
  it.each([
    undefined,
    0,
    12,
  ])('records shorthand copy size %s without changing its meaning', async (size) => {
    const { debug, device } = await fixture();
    const source = device.createBuffer({ size: 16, usage: 4 }).unwrap();
    const destination = device.createBuffer({ size: 32, usage: 8 }).unwrap();
    device.createCommandEncoder().unwrap().copyBufferToBuffer(source, destination, size);
    const event = debug.getEvents().find((event) => event.kind === 'copyBufferToBuffer');
    expect(event).toMatchObject({ sourceOffset: 0, destinationOffset: 0, size: size ?? 16 });
  });

  it('records the actual source bytes of a typed-element upload', async () => {
    const { debug, device } = await fixture();
    const data = new Float32Array(new ArrayBuffer(32), 8, 4);
    data.set([11, 22, 33, 44]);
    const buffer = device.createBuffer({ size: 16, usage: 8 }).unwrap();
    device.queue.writeBuffer(buffer, 0, data, 1, 2).unwrap();
    const event = debug.getEvents().find((event) => event.kind === 'writeBuffer');
    if (event?.kind !== 'writeBuffer') throw new Error('Missing upload event');
    expect(event.size).toBe(8);
    expect(new Uint8Array(debug.getBlobPool().get(event.dataHash) ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(data.buffer, data.byteOffset + 4, 8),
    );
  });
});
