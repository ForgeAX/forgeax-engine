import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter, rhi } from '../index';

it('admits floating depth/stencil and renders greater-depth occlusion on WebGL2', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await ensureReady();
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  expect(adapter.features.has('depth32float-stencil8')).toBe(true);
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const context = rhi.acquireCanvasContext(canvas).unwrap();
  context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();
  expect(context.getConfiguration()?.device).toBe(device);
  context.unconfigure();
  expect(context.getConfiguration()).toBeUndefined();
  context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();
  expect(context.getConfiguration()?.device).toBe(device);
  const depth = device
    .createTexture({ size: [4, 4], format: 'depth32float-stencil8', usage: 0x10 })
    .unwrap();
  try {
    const pipeline = async (z: number, rgb: string) => {
      const module = (
        await createShaderModule(device, {
          code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  let p=array<vec2<f32>,3>(vec2<f32>(-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  return vec4<f32>(p[i],${z},1.0);
}
@fragment fn fs()->@location(0) vec4<f32>{return vec4<f32>(${rgb},1.0);}
`,
        })
      ).unwrap();
      return device
        .createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
          primitive: { topology: 'triangle-list' },
          vertex: { module, entryPoint: 'vs', buffers: [] },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          depthStencil: {
            format: 'depth32float-stencil8',
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        })
        .unwrap();
    };
    const near = await pipeline(0.75, '1.0,0.0,0.0');
    const far = await pipeline(0.25, '0.0,1.0,0.0');
    const color = context.getCurrentTexture().unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(color, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: device.createTextureView(depth, {}).unwrap(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });
    pass.setPipeline(near);
    pass.draw(3);
    pass.setPipeline(far);
    pass.draw(3);
    pass.end();
    // Screen UI acquires again after scene recording, before their shared submit.
    // Both passes must retain the same live surface image.
    const overlayColor = context.getCurrentTexture().unwrap();
    expect(overlayColor).toBe(color);
    const overlay = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(overlayColor, {}).unwrap(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    overlay.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = device.queue.onSubmittedWorkDone();
    // Let the owned surface presentation microtask blit to the WebGL2 backbuffer.
    await Promise.resolve();
    const gl = canvas.getContext('webgl2');
    if (gl === null) throw new Error('WebGL2 surface unavailable');
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const pixels = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    expect(gl.getError()).toBe(gl.NO_ERROR);
    expect(Array.from(pixels.slice(0, 4))).toEqual([255, 0, 0, 255]);
    await completed;
    // Replay admission consumes the enabled device features, after the same
    // requested feature has already backed a real floating depth/stencil draw.
    expect(device.features.has('depth32float-stencil8')).toBe(true);
  } finally {
    context.unconfigure();
    device.destroyTexture(depth).unwrap();
    canvas.remove();
  }
});
