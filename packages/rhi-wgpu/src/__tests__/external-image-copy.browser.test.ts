import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter, rhi } from '../index';

const TOP = [220, 30, 60] as const;
const BOTTOM = [20, 200, 90] as const;

// WebGL2 has no texture_external, so video and canvas sources reach sampled
// textures only through copyExternalImageToTexture. The wasm queue used to
// lack it, which left every video quad on the default white texture.
it.each([
  { flipY: false, top: TOP, bottom: BOTTOM },
  { flipY: true, top: BOTTOM, bottom: TOP },
])('copies a canvas source into a sampled texture on WebGL2 (flipY $flipY)', async ({
  flipY,
  top,
  bottom,
}) => {
  const source = document.createElement('canvas');
  source.width = source.height = 4;
  const source2d = source.getContext('2d');
  if (source2d === null) throw new Error('2D canvas unavailable');
  source2d.fillStyle = `rgb(${TOP.join(',')})`;
  source2d.fillRect(0, 0, 4, 2);
  source2d.fillStyle = `rgb(${BOTTOM.join(',')})`;
  source2d.fillRect(0, 2, 4, 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await ensureReady();
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const context = rhi.acquireCanvasContext(canvas).unwrap();
  context.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();
  const texture = device
    .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x02 | 0x04 | 0x10 })
    .unwrap();
  try {
    device.queue
      .copyExternalImageToTexture(
        { source, origin: [0, 0], flipY },
        { texture, origin: [0, 0, 0] },
        { width: 4, height: 4, depthOrArrayLayers: 1 },
      )
      .unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(texture, {}).unwrap(),
            },
          },
        ],
      })
      .unwrap();
    const module = (
      await createShaderModule(device, {
        code: `
@group(0) @binding(0) var copied: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  let p=array<vec2<f32>,3>(vec2<f32>(-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  return vec4<f32>(p[i],0.0,1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>)->@location(0) vec4<f32> {
  return textureLoad(copied, vec2<i32>(pos.xy), 0);
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
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
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
    // readPixels rows run bottom-up: y=3 is the top source row, y=0 the bottom.
    const read = (y: number) => {
      const pixels = new Uint8Array(4);
      gl.readPixels(1, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return [...pixels.slice(0, 3)];
    };
    expect(read(3)).toEqual([...top]);
    expect(read(0)).toEqual([...bottom]);
    expect(gl.getError()).toBe(gl.NO_ERROR);
  } finally {
    context.unconfigure();
    device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
});
