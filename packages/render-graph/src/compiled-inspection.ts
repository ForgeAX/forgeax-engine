import { textureFormatBlock } from '@forgeax/engine-types';
import {
  accessResourceId,
  type CompiledPass,
  type CompiledResource,
  handleData,
  type PhysicalGraphSlots,
  physicalAllocationKey,
} from './kernel-internal.js';
import { accessModeForPass, rangesOverlap } from './pass-access.js';
import type { RasterBatch } from './raster-batching.js';
import type {
  CompiledRenderGraphInfo,
  GraphBufferDescriptor,
  GraphTextureContentRange,
  GraphTextureDescriptor,
  RenderGraphFrame,
} from './types.js';

function inspectResourceDescriptor<FrameCtx>(
  resource: CompiledResource<FrameCtx>,
): CompiledRenderGraphInfo['resources'][number]['descriptor'] {
  const texture =
    resource.record.kind === 'texture'
      ? (resource.record.descriptor as GraphTextureDescriptor)
      : undefined;
  const buffer =
    resource.record.kind === 'buffer'
      ? (resource.record.descriptor as GraphBufferDescriptor)
      : undefined;
  const accelerationStructure =
    resource.record.kind === 'acceleration-structure' ? resource.record.descriptor : undefined;
  const extent = (resource.resolvedDescriptor ?? resource.textureDescriptor)?.size;
  return Object.freeze(
    accelerationStructure !== undefined
      ? {
          kind: 'acceleration-structure' as const,
          maxInstances: accelerationStructure.maxInstances,
        }
      : texture === undefined
        ? {
            kind: 'buffer' as const,
            size: buffer?.size ?? 0,
          }
        : {
            kind: 'texture' as const,
            format: texture.format,
            ...(texture.domain === undefined ? {} : { domain: texture.domain }),
            size:
              resource.resolvedDescriptor?.size ??
              (typeof texture.size === 'string'
                ? texture.size
                : Object.freeze({ ...texture.size })),
            width: extent?.width ?? 1,
            height: extent?.height ?? 1,
            depthOrArrayLayers: extent?.depthOrArrayLayers ?? 1,
            mipLevelCount: texture.mipLevelCount ?? 1,
            sampleCount: texture.sampleCount ?? 1,
          },
  );
}

const KNOWN_TEXTURE_BYTE_FORMATS = new Set<GPUTextureFormat>([
  'r8unorm',
  'r8snorm',
  'r8uint',
  'r8sint',
  'rg8unorm',
  'rg8snorm',
  'rg8uint',
  'rg8sint',
  'r16unorm',
  'r16snorm',
  'r16uint',
  'r16sint',
  'r16float',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgba8snorm',
  'rgba8uint',
  'rgba8sint',
  'r32float',
  'r32uint',
  'r32sint',
  'depth32float',
  'rg16float',
  'rg16uint',
  'rg16sint',
  'rg16snorm',
  'rg16unorm',
  'rgba16float',
  'rgba16uint',
  'rgba16sint',
  'rgba16snorm',
  'rgba16unorm',
  'rg32float',
  'rg32uint',
  'rg32sint',
  'rgba32float',
  'rgba32uint',
  'rgba32sint',
]);

function textureByteSize(
  format: GPUTextureFormat,
  dimension: GPUTextureDimension,
  extent: { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number },
  mipLevelCount: number,
  sampleCount: number,
): number | undefined {
  if (!KNOWN_TEXTURE_BYTE_FORMATS.has(format)) return undefined;
  const bytesPerTexel = textureFormatBlock(format).bytesPerBlock;
  let bytes = 0;
  let width = extent.width;
  let height = extent.height;
  let depth = extent.depthOrArrayLayers;
  for (let level = 0; level < mipLevelCount; level += 1) {
    bytes += width * height * depth * bytesPerTexel * sampleCount;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    // Array layers are independent images and retain their layer count at
    // every mip. Only a true 3D allocation reduces its depth axis.
    if (dimension === '3d') depth = Math.max(1, Math.floor(depth / 2));
  }
  return bytes;
}

export function allocationBytes<FrameCtx>(
  resource: CompiledResource<FrameCtx>,
): number | undefined {
  if (resource.record.origin === 'imported' || resource.usage === 0) return undefined;
  if (resource.record.kind === 'buffer') return resource.record.descriptor.size;
  const texture = resource.record.descriptor;
  const extent = (resource.resolvedDescriptor ?? resource.textureDescriptor)?.size;
  return extent === undefined
    ? undefined
    : textureByteSize(
        texture.format,
        texture.dimension ?? '2d',
        extent,
        texture.mipLevelCount ?? 1,
        texture.sampleCount ?? 1,
      );
}

function nativePassProfiles(
  passes: NonNullable<CompiledRenderGraphInfo['passes'][number]['nativeProfilePasses']>,
) {
  return Object.freeze(
    passes.map(({ name, kind, profileName }) =>
      Object.freeze({ name, kind, ...(profileName === undefined ? {} : { profileName }) }),
    ),
  );
}

export function inspectPasses<FrameCtx extends RenderGraphFrame>(
  passes: readonly CompiledPass<FrameCtx>[],
  physical: PhysicalGraphSlots<FrameCtx>,
  rasterBatches: readonly (RasterBatch<FrameCtx> | undefined)[],
): CompiledRenderGraphInfo['passes'] {
  // Dependencies explain the declared execution order. Recording needs only validated
  // access and attachment state, so reconstruct these diagnostic edges on inspection.
  type Touch = {
    index: number;
    write: boolean;
    read: boolean;
    range: GraphTextureContentRange | undefined;
  };
  const history = new Map<number, Touch[]>();
  const dependenciesOf = (pass: CompiledPass<FrameCtx>, index: number): readonly string[] => {
    const dependencies = new Set<number>();
    for (const access of pass.pass.descriptor.accesses) {
      const id = accessResourceId(access);
      if (id === undefined) continue;
      const data = handleData(access.resource);
      const range =
        data?.kind === 'texture-view' ? physical.view(data.id)?.record.range : undefined;
      const mode = accessModeForPass(pass, access);
      let touches = history.get(id);
      if (touches === undefined) {
        touches = [];
        history.set(id, touches);
      }
      for (let prior = touches.length - 1; prior >= 0; prior--) {
        const touch = touches[prior] as Touch;
        if (touch.index === index || !rangesOverlap(touch.range, range)) continue;
        if (touch.write || (mode.write && touch.read)) dependencies.add(touch.index);
        if (touch.write) break;
      }
      touches.push({ index, range, ...mode });
    }
    return Object.freeze(
      [...dependencies]
        .sort((a, b) => a - b)
        .map((i) => (passes[i] as CompiledPass<FrameCtx>).name),
    );
  };
  return Object.freeze(
    passes.map((pass, executionIndex) =>
      Object.freeze({
        name: pass.name,
        kind: pass.pass.kind,
        executionIndex,
        ...(rasterBatches[executionIndex] !== undefined
          ? { rasterBatch: rasterBatches[executionIndex]?.names }
          : {}),
        ...(pass.pass.kind === 'subgraph' && pass.pass.descriptor.profilePasses !== undefined
          ? { nativeProfilePasses: nativePassProfiles(pass.pass.descriptor.profilePasses()) }
          : {}),
        accesses: Object.freeze(
          pass.pass.descriptor.accesses.map((access) => {
            const id = accessResourceId(access);
            return Object.freeze({
              resource: physical.resource(id ?? -1)?.record.label ?? 'foreign',
              usage: access.usage,
            });
          }),
        ),
        dependencies: dependenciesOf(pass, executionIndex),
      }),
    ),
  );
}

export function inspectResource<FrameCtx>(
  resource: CompiledResource<FrameCtx>,
): CompiledRenderGraphInfo['resources'][number] {
  const texture =
    resource.record.kind === 'texture'
      ? (resource.record.descriptor as GraphTextureDescriptor)
      : undefined;
  const handle = resource.texture ?? resource.buffer;
  const allocationKey = handle === undefined ? undefined : physicalAllocationKey(handle);
  const extent = (resource.resolvedDescriptor ?? resource.textureDescriptor)?.size;
  const knownByteSize = allocationBytes(resource);
  const byteSizeUnknownReason =
    resource.record.origin === 'imported'
      ? ('imported-owner' as const)
      : resource.usage === 0
        ? ('not-allocated' as const)
        : knownByteSize === undefined
          ? ('format-or-layout-unknown' as const)
          : undefined;
  return Object.freeze({
    label: resource.record.label,
    kind: resource.record.kind,
    origin: resource.record.origin,
    descriptor: inspectResourceDescriptor(resource),
    firstUse: resource.firstUse,
    lastUse: resource.lastUse,
    derivedUsage: resource.usage,
    ...(allocationKey === undefined ? {} : { physicalAllocationKey: allocationKey }),
    ...(texture === undefined ? {} : { format: texture.format }),
    ...(knownByteSize === undefined ? {} : { byteSize: knownByteSize }),
    ...(byteSizeUnknownReason === undefined ? {} : { byteSizeUnknownReason }),
    ...(texture === undefined
      ? {}
      : {
          dimension: texture.dimension ?? '2d',
          extent,
        }),
  });
}
