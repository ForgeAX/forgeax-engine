import type { Buffer, MappedBuffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter } from '../index';

async function withDevice(run: (device: RhiDevice) => Promise<void>): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await ensureReady();
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  try {
    await run(device);
  } finally {
    canvas.remove();
  }
}

async function copiedBytes(device: RhiDevice, source: Buffer, size: number): Promise<Uint8Array> {
  const staging = device.createBuffer({ size, usage: 0x01 | 0x08 }).unwrap();
  let mapped: MappedBuffer | undefined;
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, 0, staging, 0, size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    mapped = (await staging.mapAsync(1)).unwrap();
    return new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
  } finally {
    mapped?.unmap();
    device.destroyBuffer(staging).unwrap();
  }
}

it('commits disjoint creation mappings to a static vertex buffer and draws its vertices', async () => {
  await withDevice(async (device) => {
    const vertices = device
      .createBuffer({ size: 24, usage: 0x20 | 0x04, mappedAtCreation: true })
      .unwrap() as MappedBuffer;
    const target = device
      .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 | 0x01 })
      .unwrap();
    const staging = device.createBuffer({ size: 1024, usage: 0x01 | 0x08 }).unwrap();
    let read: MappedBuffer | undefined;
    try {
      const first = vertices.getMappedRange(0, 16).unwrap();
      const last = vertices.getMappedRange(16, 8).unwrap();
      new Float32Array(first).set([-1, -1, 3, -1]);
      new Float32Array(last).set([-1, 3]);
      vertices.unmap();
      const copied = await copiedBytes(device, vertices, 24);
      expect([...new Float32Array(copied.buffer)]).toEqual([-1, -1, 3, -1, -1, 3]);
      expect(first.byteLength).toBe(0);
      expect(last.byteLength).toBe(0);
      expect(vertices.mapState).toBe('unmapped');
      vertices.unmap();
      const shader = (
        await createShaderModule(device, {
          code: `
@vertex fn vs(@location(0) p: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(p, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 1.0, 1.0, 1.0); }
`,
        })
      ).unwrap();
      const pipeline = device
        .createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
          vertex: {
            module: shader,
            entryPoint: 'vs',
            buffers: [
              {
                arrayStride: 8,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
              },
            ],
          },
          fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        })
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(target, {}).unwrap(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, vertices);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: staging, bytesPerRow: 256 },
        [4, 4, 1],
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      read = (await staging.mapAsync(1)).unwrap();
      expect([...new Uint8Array(read.getMappedRange().unwrap()).slice(260, 264)]).toEqual([
        0, 255, 255, 255,
      ]);
    } finally {
      read?.unmap();
      vertices.unmap();
      device.destroyBuffer(vertices).unwrap();
      device.destroyBuffer(staging).unwrap();
      device.destroyTexture(target).unwrap();
    }
  });
});

it('commits WRITE mapping subranges, rejects overlapping ranges and permits a fresh mapping', async () => {
  await withDevice(async (device) => {
    const buffer = device.createBuffer({ size: 32, usage: 0x02 | 0x04 }).unwrap();
    try {
      let mapped = (await buffer.mapAsync(2, 8, 16)).unwrap();
      const first = mapped.getMappedRange(8, 8).unwrap();
      const second = mapped.getMappedRange(16, 8).unwrap();
      new Uint32Array(first).set([11, 22]);
      new Uint32Array(second).set([33, 44]);
      mapped.unmap();
      expect([...new Uint32Array((await copiedBytes(device, buffer, 32)).buffer)]).toEqual([
        0, 0, 11, 22, 33, 44, 0, 0,
      ]);
      expect(first.byteLength).toBe(0);
      expect(second.byteLength).toBe(0);
      mapped = (await buffer.mapAsync(2, 8, 16)).unwrap();
      expect(mapped.getMappedRange(0, 8).ok).toBe(false);
      expect(mapped.getMappedRange(12, 4).ok).toBe(false);
      const range = mapped.getMappedRange(8, 8).unwrap();
      expect(mapped.getMappedRange(8, 4).ok).toBe(false);
      new Uint32Array(range).set([55, 66]);
      mapped.unmap();
      expect([...new Uint32Array((await copiedBytes(device, buffer, 32)).buffer)]).toEqual([
        0, 0, 55, 66, 33, 44, 0, 0,
      ]);
    } finally {
      (buffer as MappedBuffer).unmap();
      device.destroyBuffer(buffer).unwrap();
    }
  });
});

it('discards edits to READ mappings and detaches ranges on unmap and destruction', async () => {
  await withDevice(async (device) => {
    const buffer = device.createBuffer({ size: 16, usage: 0x01 | 0x08 }).unwrap();
    let destroyed = false;
    try {
      device.queue.writeBuffer(buffer, 0, new Uint32Array([10, 20, 30, 40])).unwrap();
      device.queue.submit([]).unwrap();
      await device.queue.onSubmittedWorkDone();
      let mapped = (await buffer.mapAsync(1)).unwrap();
      const first = mapped.getMappedRange().unwrap();
      new Uint32Array(first).fill(99);
      mapped.unmap();
      mapped.unmap();
      mapped = (await buffer.mapAsync(1)).unwrap();
      const second = mapped.getMappedRange().unwrap();
      expect([...new Uint32Array(second)]).toEqual([10, 20, 30, 40]);
      expect(first.byteLength).toBe(0);
      device.destroyBuffer(buffer).unwrap();
      destroyed = true;
      expect(second.byteLength).toBe(0);
      expect(buffer.mapState).toBe('unmapped');
      expect(mapped.getMappedRange().ok).toBe(false);
    } finally {
      if (!destroyed) {
        (buffer as MappedBuffer).unmap();
        device.destroyBuffer(buffer).unwrap();
      }
    }
  });
});

it('retires a cancelled pending mapping without taking over a later mapping', async () => {
  await withDevice(async (device) => {
    const buffer = device.createBuffer({ size: 16, usage: 0x02 | 0x04 }).unwrap();
    try {
      const pending = buffer.mapAsync(2);
      (buffer as MappedBuffer).unmap();
      expect((await pending).ok).toBe(false);
      expect(buffer.mapState).toBe('unmapped');
      expect((await buffer.mapAsync(2, 4, 8)).ok).toBe(false);
      expect(buffer.mapState).toBe('unmapped');
      const mapped = (await buffer.mapAsync(2)).unwrap();
      expect(buffer.mapState).toBe('mapped');
      new Uint32Array(mapped.getMappedRange().unwrap()).set([1, 2, 3, 4]);
      mapped.unmap();
      expect([...new Uint32Array((await copiedBytes(device, buffer, 16)).buffer)]).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      (buffer as MappedBuffer).unmap();
      device.destroyBuffer(buffer).unwrap();
    }
  });
});

it('commits mappings and retires inert copies when transfer APIs are unavailable', async () => {
  await withDevice(async (device) => {
    const writable = device
      .createBuffer({ size: 16, usage: 0x02 | 0x04, mappedAtCreation: true })
      .unwrap() as MappedBuffer;
    const readable = device.createBuffer({ size: 16, usage: 0x01 | 0x08 }).unwrap();
    const transfer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer');
    const clone = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    let readableDestroyed = false;
    try {
      Object.defineProperty(ArrayBuffer.prototype, 'transfer', {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: undefined,
      });
      expect(Reflect.get(ArrayBuffer.prototype, 'transfer')).toBeUndefined();
      expect(globalThis.structuredClone).toBeUndefined();

      const created = writable.getMappedRange().unwrap();
      new Uint32Array(created).set([10, 20, 30, 40]);
      writable.unmap();
      expect(writable.mapState).toBe('unmapped');
      expect(created.byteLength).toBe(16);
      new Uint32Array(created).fill(99);
      expect([...new Uint32Array((await copiedBytes(device, writable, 16)).buffer)]).toEqual([
        10, 20, 30, 40,
      ]);

      const mappedWrite = (await writable.mapAsync(2, 8, 8)).unwrap();
      const written = mappedWrite.getMappedRange(8, 8).unwrap();
      new Uint32Array(written).set([55, 66]);
      new Uint32Array(created).fill(77);
      mappedWrite.unmap();
      expect(written.byteLength).toBe(8);
      new Uint32Array(written).fill(88);
      expect([...new Uint32Array((await copiedBytes(device, writable, 16)).buffer)]).toEqual([
        10, 20, 55, 66,
      ]);

      const encoder = device.createCommandEncoder().unwrap();
      encoder.copyBufferToBuffer(writable, 0, readable, 0, 16);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      let mappedRead = (await readable.mapAsync(1)).unwrap();
      const read = mappedRead.getMappedRange().unwrap();
      expect([...new Uint32Array(read)]).toEqual([10, 20, 55, 66]);
      new Uint32Array(read).fill(111);
      mappedRead.unmap();
      mappedRead.unmap();
      expect(read.byteLength).toBe(16);
      new Uint32Array(read).fill(222);
      mappedRead = (await readable.mapAsync(1)).unwrap();
      const retired = mappedRead.getMappedRange().unwrap();
      expect([...new Uint32Array(retired)]).toEqual([10, 20, 55, 66]);
      device.destroyBuffer(readable).unwrap();
      readableDestroyed = true;
      expect(retired.byteLength).toBe(16);
      new Uint32Array(retired).fill(333);
      expect(readable.mapState).toBe('unmapped');
      expect(mappedRead.getMappedRange().ok).toBe(false);
      device.queue.submit([]).unwrap();
      await device.queue.onSubmittedWorkDone();
    } finally {
      try {
        writable.unmap();
        device.destroyBuffer(writable).unwrap();
        if (!readableDestroyed) {
          (readable as MappedBuffer).unmap();
          device.destroyBuffer(readable).unwrap();
        }
      } finally {
        if (transfer) Object.defineProperty(ArrayBuffer.prototype, 'transfer', transfer);
        else Reflect.deleteProperty(ArrayBuffer.prototype, 'transfer');
        if (clone) Object.defineProperty(globalThis, 'structuredClone', clone);
        else Reflect.deleteProperty(globalThis, 'structuredClone');
      }
    }
    expect(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer')).toEqual(transfer);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')).toEqual(clone);
  });
});
