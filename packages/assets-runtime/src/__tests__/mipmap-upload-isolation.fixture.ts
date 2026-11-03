import { readbackTexturePixels } from '@forgeax/engine/rhi-debug';
import * as backend from '@forgeax/engine/rhi-wgpu';
import type { Texture } from '@forgeax/engine-rhi';
import { blitMipmapsSync, getOrCreateMipmapPipeline } from '../mipmap-generator';

const colors = [
  [40, 80, 160, 255],
  [220, 160, 80, 255],
] as const;
const shader = `
struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1,-1), vec2<f32>(3,-1), vec2<f32>(-1,3));
  return V(vec4<f32>(p[i],0,1),p[i]*vec2<f32>(.5,-.5)+vec2<f32>(.5));
}
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  return textureSampleLevel(t,s,vec2<f32>(.5),floor(v.uv.x*6.0));
}`;

/** No readback, queue drain or frame boundary separates these two uploads. */
export async function sampleSequentialMips(format: 'rgba8unorm' | 'rgba8unorm-srgb') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  await backend.ensureReady();
  const adapter = (await backend.requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const textures: Texture[] = [];
  try {
    (await getOrCreateMipmapPipeline(device, format, backend.createShaderModule)).unwrap();
    for (const color of colors) {
      const texture = device
        .createTexture({
          size: [60, 4],
          mipLevelCount: 6,
          format,
          // Ordinary mip inputs need neither COPY_SRC nor RENDER_ATTACHMENT.
          usage: 2 | 4,
        })
        .unwrap();
      textures.push(texture);
      const bytes = new Uint8Array(60 * 4 * 4);
      for (let at = 0; at < bytes.length; at += 4) bytes.set(color, at);
      device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 240 }, [60, 4]).unwrap();
      blitMipmapsSync(device, texture, { width: 60, height: 4, format }).unwrap();
    }
    const module = (await backend.createShaderModule(device, { code: shader })).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, sampler: { type: 'filtering' } },
          { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const sampler = device
      .createSampler({ minFilter: 'nearest', magFilter: 'nearest', mipmapFilter: 'nearest' })
      .unwrap();
    const samples: {
      texture: number;
      mip: number;
      actual: number[];
      expected: readonly number[];
    }[] = [];
    for (const [index, texture] of textures.entries()) {
      const expected = colors[index];
      if (expected === undefined) throw new Error('Unexpected probe texture');
      // A 64-pixel row is naturally copy-aligned on the WebGL2 readback path.
      const output = device.createTexture({ size: [64, 4], format, usage: 1 | 16 }).unwrap();
      try {
        const group = device
          .createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { kind: 'sampler', value: sampler } },
              {
                binding: 1,
                resource: {
                  kind: 'textureView',
                  value: device.createTextureView(texture, { dimension: '2d' }).unwrap(),
                },
              },
            ],
          })
          .unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: device.createTextureView(output).unwrap(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const pixels = await readbackTexturePixels(device, output, 64, 4);
        for (let mip = 0; mip < 6; mip++) {
          const x = Math.floor(((mip + 0.5) * 64) / 6);
          samples.push({
            texture: index,
            mip,
            actual: Array.from(pixels.subarray(x * 4, x * 4 + 4)),
            expected,
          });
        }
      } finally {
        device.destroyTexture(output).unwrap();
      }
    }
    return { backend: device.caps.backendKind, samples };
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
}
