import { handleData, type PassRecord } from './kernel-internal.js';
import type {
  GraphAccess,
  GraphAccessUsage,
  GraphTextureContentRange,
  GraphTextureDescriptor,
  GraphTextureViewDescriptor,
  RenderGraphFrame,
} from './types.js';

const DEPTH_ONLY_FORMATS = new Set<GPUTextureFormat>([
  'depth16unorm',
  'depth24plus',
  'depth32float',
]);
export function canonicalTextureAspect(
  format: GPUTextureFormat,
  aspect: GPUTextureAspect,
): GPUTextureAspect {
  return aspect === 'all' && DEPTH_ONLY_FORMATS.has(format) ? 'depth-only' : aspect;
}

const READ_ACCESS_MODE = Object.freeze({ read: true, write: false });
const WRITE_ACCESS_MODE = Object.freeze({ read: false, write: true });
const READ_WRITE_ACCESS_MODE = Object.freeze({ read: true, write: true });

export function accessMode(access: GraphAccessUsage): {
  readonly read: boolean;
  readonly write: boolean;
} {
  switch (access) {
    case 'storage-read-write':
    case 'sampled-storage-read-write':
      return READ_WRITE_ACCESS_MODE;
    case 'storage-write':
    case 'sampled-storage-write':
    case 'color-attachment':
    case 'depth-stencil-write':
    case 'copy-dst':
    case 'acceleration-structure-build':
      return WRITE_ACCESS_MODE;
    default:
      return READ_ACCESS_MODE;
  }
}

export function rangesOverlap(
  left: GraphTextureContentRange | undefined,
  right: GraphTextureContentRange | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  const aspectOverlap =
    left.aspect === 'all' || right.aspect === 'all' || left.aspect === right.aspect;
  return (
    aspectOverlap &&
    left.mipStart < right.mipEnd &&
    right.mipStart < left.mipEnd &&
    left.layerStart < right.layerEnd &&
    right.layerStart < left.layerEnd
  );
}

/** A dynamic attachment can load its prior contents on any execution. */
export function mayLoadAttachment<Frame>(
  op: GPULoadOp | ((frame: Frame) => GPULoadOp) | undefined,
): boolean {
  return op === 'load' || typeof op === 'function';
}

export function accessModeForPass<FrameCtx extends RenderGraphFrame>(
  pass: PassRecord<FrameCtx>,
  access: GraphAccess,
): { readonly read: boolean; readonly write: boolean } {
  const base = accessMode(access.usage);
  if (
    pass.pass.kind === 'subgraph' &&
    (access.usage === 'color-attachment' || access.usage === 'depth-stencil-write')
  )
    return READ_WRITE_ACCESS_MODE;
  if (pass.pass.kind !== 'raster' || handleData(access.resource)?.kind !== 'texture-view') {
    return base;
  }
  if (access.usage === 'color-attachment') {
    const attachment = pass.pass.descriptor.colorAttachments.find(
      (candidate) => candidate.view === access.resource,
    );
    return mayLoadAttachment(attachment?.loadOp) ? READ_WRITE_ACCESS_MODE : base;
  }
  if (access.usage === 'depth-stencil-write') {
    const attachment = pass.pass.descriptor.depthStencilAttachment;
    if (
      attachment?.view === access.resource &&
      (mayLoadAttachment(attachment.depthLoadOp) || mayLoadAttachment(attachment.stencilLoadOp))
    ) {
      return READ_WRITE_ACCESS_MODE;
    }
  }
  return base;
}

export function viewAccessRange(
  texture: Pick<GraphTextureDescriptor, 'format' | 'size' | 'mipLevelCount'>,
  view: GraphTextureViewDescriptor,
): GraphTextureContentRange {
  const mipLevels = texture.mipLevelCount ?? 1;
  const layers = typeof texture.size === 'object' ? (texture.size.depthOrArrayLayers ?? 1) : 1;
  const mipStart = view.baseMipLevel ?? 0;
  const layerStart = view.baseArrayLayer ?? 0;
  return {
    mipStart,
    mipEnd: mipStart + (view.mipLevelCount ?? mipLevels - mipStart),
    layerStart,
    layerEnd: layerStart + (view.arrayLayerCount ?? layers - layerStart),
    aspect: canonicalTextureAspect(texture.format, view.aspect ?? 'all'),
  };
}
