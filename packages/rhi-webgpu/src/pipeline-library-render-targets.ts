import type { PipelineLibraryRender } from '@forgeax/engine-rhi';
import { textureFormatBlock } from '@forgeax/engine-types';

// These color-renderable formats have an eight-byte render-target cost even
// though their copy footprint is four bytes. Keep all other footprint facts
// with textureFormatBlock rather than a second complete format registry.
const EXPANDED_TARGET_FORMATS = new Set<GPUTextureFormat>([
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgba8snorm',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'rgb10a2uint',
  'rgb10a2unorm',
  'rg11b10ufloat',
]);

/** Portable archives contain alternative output shapes, not simultaneous draws.
 * Select once per preparation against the receiving native device. */
export function compatiblePipelineRenderTargets(
  recipe: PipelineLibraryRender,
  limits: Pick<GPUSupportedLimits, 'maxColorAttachments' | 'maxColorAttachmentBytesPerSample'>,
): boolean {
  const targets = recipe.fragment?.targets ?? [];
  if (targets.length > (limits.maxColorAttachments ?? 8)) return false;
  let bytes = 0;
  for (const target of targets) {
    if (target === null) continue;
    const block = textureFormatBlock(target.format);
    const componentBits = /^(?:r|rg|rgba)(8|16|32)/.exec(target.format)?.[1];
    const alignment = target.format.startsWith('bgra8')
      ? 1
      : target.format.startsWith('rgb10a2') || target.format === 'rg11b10ufloat'
        ? 4
        : Number(componentBits ?? 0) / 8;
    // Native validation still owns non-color/compressed attachment errors.
    if (block.blockWidth !== 1 || block.blockHeight !== 1 || alignment === 0) return true;
    // WebGPU's attachment budget uses ordered component alignment and render
    // cost, not the copy footprint, and is independent of MSAA sample count.
    // https://gpuweb.github.io/gpuweb/#abstract-opdef-calculating-color-attachment-bytes-per-sample
    const cost = EXPANDED_TARGET_FORMATS.has(target.format) ? 8 : block.bytesPerBlock;
    bytes = Math.ceil(bytes / alignment) * alignment + cost;
  }
  return bytes <= (limits.maxColorAttachmentBytesPerSample ?? 32);
}
