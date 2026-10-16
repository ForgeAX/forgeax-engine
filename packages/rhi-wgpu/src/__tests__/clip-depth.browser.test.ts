import type { MappedBuffer } from '@forgeax/engine-rhi';
import { createShaderModule, ensureReady, requestAdapter } from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';

interface ClipControl {
  LOWER_LEFT_EXT: number;
  UPPER_LEFT_EXT: number;
  NEGATIVE_ONE_TO_ONE_EXT: number;
  ZERO_TO_ONE_EXT: number;
  CLIP_DEPTH_MODE_EXT: number;
  CLIP_ORIGIN_EXT: number;
  clipControlEXT(origin: number, depth: number): void;
}

it.each([
  false,
  true,
])('preserves near-coplanar ordering and Y orientation with EXT_clip_control hidden=%s', async (hideExtension) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 unavailable');
  const extension = gl.getExtension('EXT_clip_control') as ClipControl | null;
  if (!extension) throw new Error('This regression requires a real EXT_clip_control context');
  const getExtension = gl.getExtension.bind(gl);
  let extensionQueries = 0;
  Object.defineProperty(gl, 'getExtension', {
    configurable: true,
    value: (name: string) => {
      if (name === 'EXT_clip_control') {
        extensionQueries++;
        if (hideExtension) return null;
      }
      return getExtension(name);
    },
  });
  await ensureReady();
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const color = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x11 }).unwrap();
  const depth = device
    .createTexture({ size: [4, 4], format: 'depth32float', usage: 0x10 })
    .unwrap();
  const staging = device.createBuffer({ size: 1024, usage: 0x09 }).unwrap();
  let mapped: MappedBuffer | undefined;
  try {
    const pipeline = async (depthBits: number, rgb: string) => {
      const module = (
        await createShaderModule(device, {
          code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
  let p=array<vec2<f32>,6>(vec2<f32>(-1.0,1.0),vec2<f32>(1.0,1.0),
    vec2<f32>(-1.0,0.0),vec2<f32>(-1.0,0.0),vec2<f32>(1.0,1.0),vec2<f32>(1.0,0.0));
  return vec4<f32>(p[i],bitcast<f32>(${depthBits}u),1.0);
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
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'greater',
          },
        })
        .unwrap();
    };
    // Adjacent f32 depths collapse to one value in the legacy z*2-w conversion.
    const first = await pipeline(0x3c23d70a, '1.0,0.0,0.0');
    const next = await pipeline(0x3c23d70b, '0.0,1.0,0.0');
    for (let submission = 0; submission < 2; submission++) {
      if (!hideExtension && submission > 0) {
        // Exercise the external-context reset, including Y orientation.
        extension.clipControlEXT(extension.UPPER_LEFT_EXT, extension.NEGATIVE_ONE_TO_ONE_EXT);
      }
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
        depthStencilAttachment: {
          view: device.createTextureView(depth, {}).unwrap(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(first);
      pass.draw(6);
      pass.setPipeline(next);
      pass.draw(6);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: color },
        { buffer: staging, bytesPerRow: 256 },
        [4, 4, 1],
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      mapped = (await staging.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
      expect([...bytes.slice(4, 8)]).toEqual(hideExtension ? [255, 0, 0, 255] : [0, 255, 0, 255]);
      expect([...bytes.slice(772, 776)]).toEqual([0, 0, 255, 255]);
      expect(gl.getParameter(extension.CLIP_DEPTH_MODE_EXT)).toBe(
        hideExtension ? extension.NEGATIVE_ONE_TO_ONE_EXT : extension.ZERO_TO_ONE_EXT,
      );
      expect(gl.getParameter(extension.CLIP_ORIGIN_EXT)).toBe(extension.LOWER_LEFT_EXT);
      expect(gl.getError()).toBe(gl.NO_ERROR);
      mapped.unmap();
      mapped = undefined;
    }
    expect(extensionQueries).toBeGreaterThan(0);
  } finally {
    mapped?.unmap();
    device.destroyBuffer(staging).unwrap();
    device.destroyTexture(color).unwrap();
    device.destroyTexture(depth).unwrap();
    Reflect.deleteProperty(gl, 'getExtension');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
});
