import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';

/** Actual bytes distinguish fresh allocation, a completed writer and retained history. */
export async function conditionalStorageEvidence(): Promise<number[]> {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = device.createBuffer({ size: 4, usage: 0x04 | 0x08 }).unwrap();
  const readback = device.createBuffer({ size: 4, usage: 0x01 | 0x08 }).unwrap();
  device.queue.writeBuffer(source, 0, Uint32Array.of(42)).unwrap();
  const build = () => {
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder; write: boolean }>();
    const data = builder.createBuffer('persistent', { size: 4 }).unwrap();
    const input = builder.importBuffer('input', { size: 4, usage: 0x04 }, () => source).unwrap();
    const output = builder
      .importBuffer('output', { size: 4, usage: 0x08 }, () => readback)
      .unwrap();
    builder
      .addCopyPass('conditional-write', {
        accesses: [
          { resource: input, usage: 'copy-src' },
          { resource: data, usage: 'copy-dst' },
        ],
        executeIf: (frame) => frame.write,
        encode: ({ encoder, resources }) =>
          encoder.copyBufferToBuffer(
            resources.buffer(input).unwrap(),
            0,
            resources.buffer(data).unwrap(),
            0,
            4,
          ),
      })
      .unwrap();
    builder
      .addCopyPass('read', {
        accesses: [
          { resource: data, usage: 'copy-src' },
          { resource: output, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyBufferToBuffer(
            resources.buffer(data).unwrap(),
            0,
            resources.buffer(output).unwrap(),
            0,
            4,
          ),
      })
      .unwrap();
    return builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  };
  const values: number[] = [];
  let compiled = build();
  try {
    for (const write of [false, true, false]) {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder, write }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(0x01)).unwrap();
      values.push(new Uint32Array(mapped.getMappedRange().unwrap())[0] ?? -1);
      mapped.unmap();
    }
    (await compiled.retire()).unwrap();
    compiled = build();
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder, write: false }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(0x01)).unwrap();
    values.push(new Uint32Array(mapped.getMappedRange().unwrap())[0] ?? -1);
    mapped.unmap();
  } finally {
    (await compiled.retire()).unwrap();
    device.destroyBuffer(source).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
  return values;
}
