import type { Texture } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { RhiCallEvent } from '../protocol/types';
import { projectTextureExtent, type TextureLayout } from '../texel-layout';
import { eventFailure, type ReplayExecutionContext } from './execute';

// Depth formats cannot be queue.writeTexture destinations. Restore their exact
// float values through an unfiltered color upload and a depth-only raster pass.
const SEED_DEPTH = `
@group(0) @binding(0) var savedDepth: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1,-1), vec2<f32>(3,-1), vec2<f32>(-1,3));
  return vec4<f32>(p[index],0,1);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  return textureLoad(savedDepth, vec2<i32>(p.xy), 0).r;
}`;

export async function seedDepthInitialData(
  context: ReplayExecutionContext,
  texture: Texture,
  event: Extract<RhiCallEvent, { kind: 'createTexture' }>,
  bytes: Uint8Array,
  layout: TextureLayout,
  bootstrapIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const { device } = context;
  let upload: Texture | undefined;
  try {
    const extent = projectTextureExtent(event.desc.size);
    upload = device
      .createTexture({
        size: { width: extent.width, height: extent.height, depthOrArrayLayers: extent.layerCount },
        format: 'r32float',
        mipLevelCount: event.desc.mipLevelCount ?? 1,
        usage: 0x06,
      })
      .unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 2,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
          },
        ],
      })
      .unwrap();
    const pipelineLayout = device
      .createPipelineLayout({ bindGroupLayouts: [groupLayout] })
      .unwrap();
    const shader = (
      await context.createShaderModule(device, { code: SEED_DEPTH, label: 'rhi-debug-seed-depth' })
    ).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vs', buffers: [] },
        fragment: { module: shader, entryPoint: 'fs', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();
    const encoder = device.createCommandEncoder({ label: 'rhi-debug-seed-depth' }).unwrap();
    for (const slice of layout.slices) {
      device.queue
        .writeTexture(
          { texture: upload, mipLevel: slice.mip, origin: { x: 0, y: 0, z: slice.layer } },
          bytes.subarray(slice.byteOffset, slice.byteOffset + slice.byteLength),
          { bytesPerRow: slice.width * 4, rowsPerImage: slice.height },
          { width: slice.width, height: slice.height, depthOrArrayLayers: 1 },
        )
        .unwrap();
      const view = {
        dimension: '2d' as const,
        baseMipLevel: slice.mip,
        mipLevelCount: 1,
        baseArrayLayer: slice.layer,
        arrayLayerCount: 1,
      };
      const source = device.createTextureView(upload, view).unwrap();
      const destination = device
        .createTextureView(texture, { ...view, aspect: 'depth-only' })
        .unwrap();
      const group = device
        .createBindGroup({
          layout: groupLayout,
          entries: [{ binding: 0, resource: { kind: 'textureView', value: source } }],
        })
        .unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: destination,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    return ok(undefined);
  } catch (cause) {
    return eventFailure(-bootstrapIndex - 1, event, 'write', cause);
  } finally {
    if (upload !== undefined) device.destroyTexture(upload);
  }
}
