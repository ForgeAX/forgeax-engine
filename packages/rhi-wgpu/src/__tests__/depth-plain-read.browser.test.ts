import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter, rhi } from '../index';

// naga's GLSL backend used to declare every depth texture as `sampler2DShadow`,
// so non-comparison depth reads (CSM overlays, DOF, soft particles) failed to
// compile on WebGL2.
it('reads a depth texture without comparison through textureSample and textureLoad on WebGL2', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await ensureReady();
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const context = rhi.acquireCanvasContext(canvas).unwrap();
  context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();
  const depth = device
    .createTexture({ size: [4, 4], format: 'depth32float', usage: 0x10 | 0x04 })
    .unwrap();
  try {
    const depthView = device.createTextureView(depth, {}).unwrap();
    const clear = device.createCommandEncoder().unwrap();
    clear
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0.25,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    device.queue.submit([clear.finish().unwrap()]).unwrap();

    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
          { binding: 1, visibility: 2, sampler: { type: 'non-filtering' } },
        ],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: depthView } },
          {
            binding: 1,
            resource: {
              kind: 'sampler',
              value: device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' }).unwrap(),
            },
          },
        ],
      })
      .unwrap();
    const module = (
      await createShaderModule(device, {
        code: `
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  let p=array<vec2<f32>,3>(vec2<f32>(-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  return vec4<f32>(p[i],0.0,1.0);
}
@fragment fn fs()->@location(0) vec4<f32> {
  let sampled = textureSample(sceneDepth, depthSampler, vec2<f32>(0.5));
  let loaded = textureLoad(sceneDepth, vec2<i32>(1, 2), 0);
  return vec4<f32>(sampled, loaded * 2.0, 0.0, 1.0);
}
`,
      })
    ).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        primitive: { topology: 'triangle-list' },
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      })
      .unwrap();
    const color = context.getCurrentTexture().unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(color, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 1, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    // Let the owned surface presentation microtask blit to the WebGL2 backbuffer.
    await Promise.resolve();
    const gl = canvas.getContext('webgl2');
    if (gl === null) throw new Error('WebGL2 surface unavailable');
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const pixels = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    expect(gl.getError()).toBe(gl.NO_ERROR);
    const [red = 0, green = 0, blue = 0] = pixels;
    expect(Math.abs(red - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(green - 128)).toBeLessThanOrEqual(1);
    expect(blue).toBe(0);
  } finally {
    context.unconfigure();
    device.destroyTexture(depth).unwrap();
    canvas.remove();
  }
});
