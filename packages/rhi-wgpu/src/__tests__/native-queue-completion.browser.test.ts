import { ensureReady } from '@forgeax/engine-wgpu-wasm';
import { expect, it } from 'vitest';
import { makeRhiQueue, type RawQueueLike } from '../queue';

async function fixture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const wasm = await ensureReady();
  const instance = await wasm.RhiWgpuInstance.create();
  const adapter = await instance.requestAdapterWithCanvas(canvas);
  if (!(adapter instanceof wasm.RhiWgpuAdapter)) throw new Error(String(adapter));
  const device = await adapter.requestDevice({});
  const queue = device.queue;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Actual WebGL2 is required');
  const complete = (value = queue) =>
    makeRhiQueue(value as unknown as RawQueueLike).onSubmittedWorkDone();
  return {
    canvas,
    device,
    queue,
    gl,
    complete,
    dispose() {
      queue.free();
      device.free();
      adapter.free();
      instance.free();
      canvas.remove();
    },
  };
}

it('completes final native submissions and shared queue wrappers in FIFO with readable pixels', async () => {
  const f = await fixture();
  const color = f.device.createTexture({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x10 | 0x01,
  });
  const view = f.device.createTextureView(color, {});
  const readback = f.device.createBuffer({ size: 1024, usage: 0x01 | 0x08 });
  const secondQueue = f.device.queue;
  try {
    await f.complete();
    for (let frame = 0; frame < 60; frame += 1) {
      const encoder = f.device.createCommandEncoder({});
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: frame % 2, g: 1, b: 0, a: 1 },
          },
        ],
      });
      pass.end();
      pass.free();
      encoder.copyTextureToBuffer(color, 0, 0, 0, 0, 0, readback, 0n, 256, 4, 4, 4, 1);
      f.queue.submit([encoder.finish()]);
      encoder.free();
      const order: number[] = [];
      const first = f.complete().then(() => order.push(1));
      const second = f.complete(secondQueue).then(() => order.push(2));
      await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
      await readback.mapAsync(1);
      try {
        const bytes = new Uint8Array(readback.getMappedRange());
        expect([...bytes.slice(0, 4)]).toEqual([255 * (frame % 2), 255, 0, 255]);
      } finally {
        readback.unmap();
      }
    }
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
  } finally {
    secondQueue.free();
    readback.destroy();
    readback.free();
    view.free();
    color.destroy();
    color.free();
    f.dispose();
  }
});

it('rejects pending native completion after actual WebGL context loss', async () => {
  const f = await fixture();
  try {
    const extension = f.gl.getExtension('WEBGL_lose_context');
    expect(extension).not.toBeNull();
    if (!extension) throw new Error('Context loss extension is required');
    const completion = f.complete();
    extension.loseContext();
    await expect(completion).rejects.toMatch(/context lost before queue completion/);
  } finally {
    f.dispose();
  }
});

it('settles earlier buffer mapping before queue completion', async () => {
  const f = await fixture();
  const readback = f.device.createBuffer({ size: 4, usage: 0x01 | 0x08 });
  const source = f.device.createBuffer({ size: 4, usage: 0x04 | 0x08 });
  try {
    for (let frame = 0; frame < 60; frame += 1) {
      f.queue.writeBuffer(source, 0n, new Uint8Array([frame, 23, 42, 255]));
      const encoder = f.device.createCommandEncoder({});
      encoder.copyBufferToBuffer(source, 0n, readback, 0n, 4n);
      f.queue.submit([encoder.finish()]);
      encoder.free();
      const order: string[] = [];
      const mapped = readback.mapAsync(1).then(() => order.push('map'));
      const completed = f.complete().then(() => order.push('queue'));
      await Promise.all([mapped, completed]);
      expect(order).toEqual(['map', 'queue']);
      expect([...new Uint8Array(readback.getMappedRange())]).toEqual([frame, 23, 42, 255]);
      readback.unmap();
    }
  } finally {
    source.destroy();
    source.free();
    readback.destroy();
    readback.free();
    f.dispose();
  }
});
