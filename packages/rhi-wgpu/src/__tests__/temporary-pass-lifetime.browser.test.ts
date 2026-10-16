import type { CommandBuffer } from '@forgeax/engine-rhi';
import { ensureReady } from '@forgeax/engine-wgpu-wasm';
import { expect, it } from 'vitest';
import { makeRhiQueue } from '../queue';

async function fixture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const wasm = await ensureReady();
  const memory = (await wasm.default()).memory;
  const instance = await wasm.RhiWgpuInstance.create();
  const adapter = await instance.requestAdapterWithCanvas(canvas);
  if (!(adapter instanceof wasm.RhiWgpuAdapter)) throw new Error(String(adapter));
  const device = await adapter.requestDevice({});
  const rawQueue = device.queue;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Actual WebGL2 required');
  const queue = makeRhiQueue(rawQueue as unknown as Parameters<typeof makeRhiQueue>[0]);
  const texture = (format: string, sampleCount = 1) =>
    device.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format,
      sampleCount,
      usage: sampleCount === 1 ? 0x10 | 0x01 : 0x10,
    });
  return {
    device,
    queue,
    memory,
    gl,
    texture,
    dispose() {
      rawQueue.free();
      device.free();
      adapter.free();
      instance.free();
      canvas.remove();
    },
  };
}

it('reclaims temporary pass descriptors and submission wrappers after real completed work', async () => {
  const f = await fixture();
  const color = f.texture('rgba8unorm');
  const depth = f.texture('depth24plus-stencil8');
  const view = f.device.createTextureView(color, {});
  const depthView = f.device.createTextureView(depth, {});
  const readback = f.device.createBuffer({ size: 1024, usage: 0x01 | 0x08 });
  // Amplify leaked descriptor labels within a bounded real 60-frame window.
  // This is an allocator regression, not a representative scene/FPS benchmark.
  const label = `temporary-pass-${'x'.repeat(16 * 1024)}`;
  const pages: number[] = [];
  let submitted = 0;
  let completed = 0;
  try {
    for (let batch = 0; batch < 3; batch += 1) {
      for (let frame = 0; frame < 60; frame += 1) {
        const encoder = f.device.createCommandEncoder({ label });
        try {
          for (let passIndex = 0; passIndex < 8; passIndex += 1) {
            const pass = encoder.beginRenderPass({
              label,
              colorAttachments: [
                {
                  view,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 1, b: 1, a: 1 },
                },
              ],
              depthStencilAttachment: {
                view: depthView,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0.25,
                stencilLoadOp: 'clear',
                stencilStoreOp: 'store',
                stencilClearValue: 7,
              },
            });
            // beginRenderPass has returned: all borrowed descriptor storage
            // may now disappear, while the native pass still owns its work.
            pass.end();
            pass.free();
          }
          encoder.copyTextureToBuffer(color, 0, 0, 0, 0, 0, readback, 0n, 256, 4, 4, 4, 1);
          const command = encoder.finish();
          f.queue.submit([command as unknown as CommandBuffer]).unwrap();
          submitted += 1;
          await f.queue.onSubmittedWorkDone();
          completed += 1;
          await readback.mapAsync(1);
          try {
            const pixels = new Uint8Array(readback.getMappedRange());
            for (const offset of [0, 12, 768, 780]) {
              expect([...pixels.slice(offset, offset + 4)]).toEqual([0, 255, 255, 255]);
            }
          } finally {
            readback.unmap();
          }
        } finally {
          encoder.free();
        }
      }
      pages.push(f.memory.buffer.byteLength);
    }
    expect(submitted).toBe(180);
    expect(completed).toBe(submitted);
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
    // biome-ignore lint/suspicious/noConsole: retain measured allocator evidence in the browser log.
    console.info(
      JSON.stringify({ kind: 'wasm-pass-temporaries', submitted, completed, heapBytes: pages }),
    );
    // Memory is the WASM linear arena high-water mark, not JS or driver memory.
    // After one identical warmup batch, allow at most four 64 KiB arena pages.
    const warmupBytes = pages[0];
    const finalBytes = pages[2];
    if (warmupBytes === undefined || finalBytes === undefined) {
      throw new Error('Missing completed-batch memory measurement');
    }
    expect(finalBytes - warmupBytes).toBeLessThanOrEqual(4 * 65536);
  } finally {
    readback.destroy();
    readback.free();
    view.free();
    depthView.free();
    color.destroy();
    color.free();
    depth.destroy();
    depth.free();
    f.dispose();
  }
});

it('retains multisample resolve and read-only depth/stencil resources after descriptor release', async () => {
  const f = await fixture();
  const color = f.texture('rgba8unorm', 4);
  const resolved = f.texture('rgba8unorm');
  const depth = f.texture('depth24plus-stencil8', 4);
  const view = f.device.createTextureView(color, {});
  const resolveView = f.device.createTextureView(resolved, {});
  const depthView = f.device.createTextureView(depth, {});
  const readback = f.device.createBuffer({ size: 1024, usage: 0x01 | 0x08 });
  const encoder = f.device.createCommandEncoder({});
  try {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          resolveTarget: resolveView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 1, b: 1, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.25,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store',
        stencilClearValue: 7,
      },
    });
    pass.end();
    pass.free();
    const readOnly = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthReadOnly: true,
        stencilReadOnly: true,
      },
    });
    readOnly.end();
    readOnly.free();
    encoder.copyTextureToBuffer(resolved, 0, 0, 0, 0, 0, readback, 0n, 256, 4, 4, 4, 1);
    f.queue.submit([encoder.finish() as unknown as CommandBuffer]).unwrap();
    await f.queue.onSubmittedWorkDone();
    await readback.mapAsync(1);
    try {
      expect([...new Uint8Array(readback.getMappedRange()).slice(0, 4)]).toEqual([
        0, 255, 255, 255,
      ]);
    } finally {
      readback.unmap();
    }
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
  } finally {
    encoder.free();
    readback.destroy();
    readback.free();
    for (const handle of [view, resolveView, depthView]) handle.free();
    for (const handle of [color, resolved, depth]) {
      handle.destroy();
      handle.free();
    }
    f.dispose();
  }
});

it('rejects repeated or duplicate submitted command buffers and accepts subsequent fresh work', async () => {
  const f = await fixture();
  const finish = () => {
    const encoder = f.device.createCommandEncoder({});
    try {
      return encoder.finish() as unknown as CommandBuffer;
    } finally {
      encoder.free();
    }
  };
  try {
    const first = finish();
    f.queue.submit([first]).unwrap();
    await f.queue.onSubmittedWorkDone();
    const repeated = f.queue.submit([first]);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe('queue-submit-failed');
    const duplicate = finish();
    const twice = f.queue.submit([duplicate, duplicate]);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.code).toBe('queue-submit-failed');
    f.queue.submit([finish()]).unwrap();
    await f.queue.onSubmittedWorkDone();
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
  } finally {
    f.dispose();
  }
});
