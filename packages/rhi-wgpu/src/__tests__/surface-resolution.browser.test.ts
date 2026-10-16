import { expect, it } from 'vitest';
import { ensureReady, requestAdapter, rhi } from '../index';

it('uses adapter resolution for a DPR3 surface and rejects extents above the actual limit', async () => {
  const canvas = document.createElement('canvas');
  // Official WeChat simulator regression: landscape 844×390 CSS pixels, DPR 3.
  canvas.width = 2532;
  canvas.height = 1170;
  document.body.append(canvas);
  await ensureReady();
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const gl = canvas.getContext('webgl2');
  expect(gl).not.toBeNull();
  if (gl === null) throw new Error('real WebGL2 context required');
  expect(device.limits.maxTextureDimension2D).toBeGreaterThanOrEqual(2532);
  expect(device.limits.maxTextureDimension2D).toBeLessThanOrEqual(
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
  );
  const context = rhi.acquireCanvasContext(canvas).unwrap();
  const configure = () =>
    context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' });
  try {
    expect(configure().ok).toBe(true);
    expect(context.getCurrentTexture().ok).toBe(true);
    await Promise.resolve();
    canvas.width = device.limits.maxTextureDimension2D + 1;
    canvas.height = 1;
    const oversized = configure();
    expect(oversized.ok).toBe(false);
    if (oversized.ok) throw new Error('extent beyond device limit was accepted');
    expect(oversized.error.hint).toContain('TooLarge');
    canvas.width = 2532;
    canvas.height = 1170;
    expect(configure().ok).toBe(true);
  } finally {
    context.unconfigure();
    canvas.remove();
  }
});

it('presents the complete surface after canvas-only portrait and landscape changes', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 2532;
  canvas.height = 1170;
  document.body.append(canvas);
  await ensureReady();
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const context = rhi.acquireCanvasContext(canvas).unwrap();
  context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();
  const gl = canvas.getContext('webgl2');
  if (gl === null) throw new Error('real WebGL2 context required');
  try {
    for (const [width, height] of [
      [1170, 2532],
      [2532, 1170],
    ] as const) {
      // The Host only changes canvas dimensions. GPUCanvasContext follows that
      // drawing buffer without requiring a second public configure call.
      canvas.width = width;
      canvas.height = height;
      const color = context.getCurrentTexture().unwrap();
      expect(context.getCurrentTexture().unwrap()).toBe(color);
      expect(context.presentationProof?.validated).toMatchObject({ width, height });
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(color, {}).unwrap(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 1, b: 0, a: 1 },
          },
        ],
      });
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const completed = device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      for (const [x, y] of [
        [0, 0],
        [width - 1, height - 1],
      ] as const) {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        expect(gl.getError()).toBe(gl.NO_ERROR);
        expect(Array.from(pixel)).toEqual([0, 255, 0, 255]);
      }
      await completed;
    }
  } finally {
    context.unconfigure();
    canvas.remove();
  }
});
