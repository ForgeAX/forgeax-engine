import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';
import { mipDimension, ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from './render-pipeline';
import type { TransmissionBackdropMipEncoder } from './transmission/backdrop';

/**
 * Fill a color target's mip chain from level 0, then return the full-chain
 * view its receivers sample. WebGPU samples only the preceding mip and writes
 * the disjoint next mip directly. WebGL2 retains a separate scratch texture:
 * disjoint mip views still alias one physical texture on that backend.
 */
export function addGraphColorMipPasses(
  builder: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  texture: GraphTexture,
  descriptor: { readonly width: number; readonly height: number; readonly format: TextureFormat },
  levels: number,
  encodeMip: TransmissionBackdropMipEncoder | undefined,
  direct: GraphTextureView | undefined,
  backendKind: RhiCaps['backendKind'],
): Result<GraphTextureView | undefined, RenderGraphError> {
  if (levels <= 1 || encodeMip === undefined) return ok(direct);
  const levelSize = (level: number) => ({
    width: mipDimension(descriptor.width, level),
    height: mipDimension(descriptor.height, level),
  });
  const mipView = (level: number) =>
    builder.view(texture, {
      label: `${label}.mip-${level}`,
      dimension: '2d',
      baseMipLevel: level,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
  const scratch =
    backendKind === 'wgpu-webgl2'
      ? builder.createTexture(`${label}.mip-scratch`, {
          format: descriptor.format,
          size: levelSize(1),
          sampleCount: 1,
          mipLevelCount: levels - 1,
        })
      : undefined;
  if (scratch !== undefined && !scratch.ok) return scratch;
  const scratchTexture = scratch?.value;
  let source = mipView(0);
  if (!source.ok) return source;
  for (let level = 1; level < levels; level += 1) {
    const destination = mipView(level);
    if (!destination.ok) return destination;
    const output =
      scratchTexture === undefined
        ? destination
        : builder.view(scratchTexture, {
            label: `${label}.mip-scratch.${level - 1}`,
            baseMipLevel: level - 1,
            mipLevelCount: 1,
          });
    if (!output.ok) return output;
    const from = source.value;
    const mip = builder.addRasterPass(`${label}-mip-${level}`, {
      accesses: [
        { resource: from, usage: 'sampled-read' },
        { resource: output.value, usage: 'color-attachment' },
      ],
      colorAttachments: [
        {
          view: output.value,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      encodeDirect: (pass, frame, resources) =>
        encodeMip({
          pass,
          frame,
          resources,
          source: from,
          destination: output.value,
          format: descriptor.format,
          level,
        }),
    });
    if (!mip.ok) return mip;
    if (scratchTexture !== undefined) {
      const copied = builder.addCopyPass(`${label}-mip-copy-${level}`, {
        accesses: [
          { resource: output.value, usage: 'copy-src' },
          { resource: destination.value, usage: 'copy-dst' },
        ],
        encodeDirect: (encoder, _frame, resources) => {
          const scratchPhysical = resources.texture(scratchTexture);
          const target = resources.texture(texture);
          if (!scratchPhysical.ok) throw scratchPhysical.error;
          if (!target.ok) throw target.error;
          encoder.copyTextureToTexture(
            { texture: scratchPhysical.value, mipLevel: level - 1, origin: { x: 0, y: 0, z: 0 } },
            { texture: target.value, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
            { ...levelSize(level), depthOrArrayLayers: 1 },
          );
        },
      });
      if (!copied.ok) return copied;
    }
    source = destination;
  }
  return builder.view(texture, {
    label: `${label}.mips`,
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: levels,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
}
