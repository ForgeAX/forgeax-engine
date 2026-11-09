import { describe, expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createMockGpu } from './__mocks__/gpu-device';

async function fixture() {
  const adapter = await createMockGpu().requestAdapter();
  if (adapter === null) throw new Error('Missing fixture adapter');
  const raw = await adapter.requestDevice();
  const original = raw.createCommandEncoder.bind(raw);
  const copy = vi.fn((...args: unknown[]) => {
    if (args.length !== 5) throw new TypeError('copyBufferToBuffer requires 5 arguments');
  });
  raw.createCommandEncoder = (desc) => ({ ...original(desc), copyBufferToBuffer: copy });
  const write = vi.spyOn(raw.queue, 'writeBuffer');
  const { device } = makeRhiDevice(raw as unknown as GPUDevice);
  const source = device.createBuffer({ size: 16, usage: 4 }).unwrap();
  const destination = device.createBuffer({ size: 32, usage: 8 }).unwrap();
  return { device, source, destination, copy, write };
}

describe('WebGPU native buffer compatibility', () => {
  it.each([
    undefined,
    0,
    12,
  ])('expands shorthand size %s to the legacy native form', async (size) => {
    const { device, source, destination, copy } = await fixture();
    device.createCommandEncoder().unwrap().copyBufferToBuffer(source, destination, size);
    expect(copy.mock.calls[0]).toEqual([expect.anything(), 0, expect.anything(), 0, size ?? 16]);
  });

  it('preserves full-form offsets and an invalid oversized request', async () => {
    const { device, source, destination, copy } = await fixture();
    device.createCommandEncoder().unwrap().copyBufferToBuffer(source, 4, destination, 8, 64);
    expect(copy.mock.calls[0]?.slice(1)).toEqual([4, expect.anything(), 8, 64]);
  });

  it('checks the remaining TypedArray elements in bytes', async () => {
    const { device, write } = await fixture();
    const buffer = device.createBuffer({ size: 16, usage: 8 }).unwrap();
    const data = new Float32Array([11, 22, 33, 44]);
    expect(device.queue.writeBuffer(buffer, 4, data, 1).ok).toBe(true);
    expect(write.mock.calls[0]?.slice(1)).toEqual([4, data, 1]);
  });

  it('rejects a typed-element range that exceeds destination bytes', async () => {
    const { device, write } = await fixture();
    const buffer = device.createBuffer({ size: 4, usage: 8 }).unwrap();
    expect(device.queue.writeBuffer(buffer, 0, new Float32Array(4), 1, 2).ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps DataView ranges in bytes and preserves explicit zero', async () => {
    const { device, destination, write } = await fixture();
    const data = new DataView(new ArrayBuffer(24), 4, 16);
    expect(device.queue.writeBuffer(destination, 0, data, 4, 8).ok).toBe(true);
    expect(device.queue.writeBuffer(destination, 0, data, 0, 0).ok).toBe(true);
    expect(write.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, data, 4, 8],
      [0, data, 0, 0],
    ]);
  });
});
