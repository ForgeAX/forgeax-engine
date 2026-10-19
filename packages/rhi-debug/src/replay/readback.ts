import type {
  Buffer,
  MappedBuffer,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
} from '@forgeax/engine-rhi';
import { textureReadbackLayout } from '@forgeax/engine-rhi';
import { err, mipDimension, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { readbackDepthTexture } from '../readback-depth';
import type { CreateShaderModuleFn } from '../recorder';
import { projectTextureExtent } from '../texel-layout';
import type { ResourceTable, ResourceTableEntry } from './resources';
import {
  getTextureReadbackPlan,
  isDepthStencilTextureFormat,
  isDepthTextureFormat,
  textureBytesPerTexel,
} from './texture-format';

const COPY_DST_MAP_READ = 0x9;
const GPU_MAP_MODE_READ = 0x1;

export interface BufferReadbackRange {
  readonly offset: number;
  readonly size?: number;
}

export interface TextureReadbackSubresource {
  readonly mipLevel?: number;
  /** Array layer, or the depth slice of a `3d` texture (the copy origin z). */
  readonly arrayLayer?: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export type ReplayReadbackRequest = BufferReadbackRange | TextureReadbackSubresource;

/** Public readback selector: a buffer byte range or one texture subresource. */
export interface TextureSubresource {
  readonly mipLevel: number;
  readonly arrayLayer: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export type ReadbackSubresource = TextureSubresource | BufferReadbackRange;

export interface ReplayReadbackProvenance {
  readonly generation: number;
  readonly resourceId: string;
  readonly subresource: ReplayReadbackRequest | null;
  readonly selectedWorkIndex?: number;
}

export interface ReplayReadbackResult {
  readonly resourceId: string;
  readonly kind: 'buffer' | 'texture';
  readonly format?: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: Uint8Array;
  readonly provenance: ReplayReadbackProvenance;
}

type ReplayReadbackPayload = Omit<ReplayReadbackResult, 'provenance'>;

export async function readReplayResource(
  device: RhiDevice,
  table: ResourceTable,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
  createShaderModule: CreateShaderModuleFn,
): Promise<Result<ReplayReadbackResult, RhiDebugError>> {
  const entry = table.get(resourceId);
  if (entry === undefined)
    return readbackFailure(`resource ${resourceId} is not present in the current generation`);
  let result: Result<ReplayReadbackPayload, RhiDebugError>;
  if (entry.resource.kind === 'texture-view') {
    const sourceId = stringField(entry.descriptor, 'sourceHandleId');
    const source = sourceId === undefined ? undefined : table.get(sourceId);
    if (source === undefined || source.resource.kind !== 'texture') {
      return readbackFailure(`texture view ${resourceId} has no readable source texture`);
    }
    const sourceSubresource = resolveTextureViewSubresource(entry, source, subresource);
    if (!sourceSubresource.ok) return sourceSubresource;
    result = await readTexture(
      device,
      source,
      resourceId,
      sourceSubresource.value,
      createShaderModule,
    );
  } else if (entry.resource.kind === 'texture') {
    result = await readTexture(device, entry, resourceId, subresource, createShaderModule);
  } else if (entry.resource.kind === 'buffer') {
    result = await readBuffer(device, entry, resourceId, subresource);
  } else {
    return readbackFailure(`resource ${resourceId} is not readable by the v7 core matrix`);
  }
  if (!result.ok) return result;
  return ok({
    ...result.value,
    provenance: {
      generation: table.generation,
      resourceId,
      subresource: subresource ?? null,
    },
  });
}

/** Copyable z extent: array layers, or the mip's depth slices for a `3d` texture. */
function textureLayerExtent(depthOrArrayLayers: number, dimension: string, mip: number): number {
  return dimension === '3d' ? mipDimension(depthOrArrayLayers, mip) : depthOrArrayLayers;
}

function resolveTextureViewSubresource(
  view: ResourceTableEntry,
  source: ResourceTableEntry,
  requested: ReplayReadbackRequest | undefined,
): Result<ReplayReadbackRequest | undefined, RhiDebugError> {
  if (isBufferRange(requested)) return ok(requested);
  const sourceDescriptor = recordField(source.descriptor, 'desc');
  const sourceSize = projectTextureExtent(sourceDescriptor?.size);
  if (sourceSize === undefined)
    return readbackFailure('the source texture descriptor has invalid dimensions');
  const sourceMipCount = numberField(sourceDescriptor, 'mipLevelCount') ?? 1;
  const viewDescriptor = recordField(view.descriptor, 'desc');
  const baseMipLevel = numberField(viewDescriptor, 'baseMipLevel') ?? 0;
  const baseArrayLayer = numberField(viewDescriptor, 'baseArrayLayer') ?? 0;
  const mipLevelCount =
    numberField(viewDescriptor, 'mipLevelCount') ?? sourceMipCount - baseMipLevel;
  const arrayLayerCount =
    numberField(viewDescriptor, 'arrayLayerCount') ?? sourceSize.layerCount - baseArrayLayer;
  const localMipLevel = requested?.mipLevel ?? 0;
  const localArrayLayer = requested?.arrayLayer ?? 0;
  if ((stringField(sourceDescriptor, 'dimension') ?? '2d') === '3d') {
    // A 3d view spans every depth slice; the request names the slice directly.
    const mipLevel = baseMipLevel + localMipLevel;
    if (
      !validIndex(localMipLevel, mipLevelCount) ||
      baseMipLevel + mipLevelCount > sourceMipCount ||
      !validIndex(localArrayLayer, textureLayerExtent(sourceSize.layerCount, '3d', mipLevel))
    ) {
      return readbackFailure('texture view subresource is outside the recorded view extent');
    }
    return ok({
      ...requested,
      mipLevel,
      arrayLayer: localArrayLayer,
      aspect: requested?.aspect ?? 'all',
    });
  }
  if (
    !validIndex(baseMipLevel, sourceMipCount + 1) ||
    !validIndex(baseArrayLayer, sourceSize.layerCount + 1) ||
    !validIndex(localMipLevel, mipLevelCount) ||
    !validIndex(localArrayLayer, arrayLayerCount) ||
    baseMipLevel + mipLevelCount > sourceMipCount ||
    baseArrayLayer + arrayLayerCount > sourceSize.layerCount
  ) {
    return readbackFailure('texture view subresource is outside the recorded view extent');
  }
  return ok({
    ...requested,
    mipLevel: baseMipLevel + localMipLevel,
    arrayLayer: baseArrayLayer + localArrayLayer,
    aspect:
      requested?.aspect ??
      (viewDescriptor?.aspect === 'depth-only' || viewDescriptor?.aspect === 'stencil-only'
        ? viewDescriptor.aspect
        : 'all'),
  });
}

async function readBuffer(
  device: RhiDevice,
  entry: ResourceTableEntry,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
): Promise<Result<ReplayReadbackPayload, RhiDebugError>> {
  const size = numberField(recordField(entry.descriptor, 'desc'), 'size');
  if (size === undefined || !Number.isSafeInteger(size) || size < 0)
    return readbackFailure(`buffer ${resourceId} has no valid recorded size`);
  // The recorder never promotes a mappable buffer, so one recorded without
  // COPY_SRC (MAP_READ staging) cannot be a copy source; MAP_WRITE | COPY_SRC can.
  const usage = numberField(recordField(entry.descriptor, 'desc'), 'usage') ?? 0;
  if ((usage & 0x3) !== 0 && (usage & 0x4) === 0)
    return readbackUnsupported(
      resourceId,
      'buffer',
      'a mappable staging buffer cannot be a copy source; read the buffer it was copied from',
    );
  const request = isBufferRange(subresource) ? subresource : undefined;
  const offset = request?.offset ?? 0;
  const requestedSize = request?.size ?? size - offset;
  if (!validRange(offset, requestedSize, size))
    return readbackFailure(
      `buffer range ${offset}:${requestedSize} escapes ${resourceId} (${size} bytes)`,
    );
  const bytes = await copyBufferBytes(
    device,
    entry.resource.value as Buffer,
    offset,
    requestedSize,
  );
  if (!bytes.ok) return bytes;
  return ok({ resourceId, kind: 'buffer', bytes: bytes.value });
}

async function readTexture(
  device: RhiDevice,
  entry: ResourceTableEntry,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
  createShaderModule: CreateShaderModuleFn,
): Promise<Result<ReplayReadbackPayload, RhiDebugError>> {
  const descriptor = recordField(entry.descriptor, 'desc');
  const format = stringField(descriptor, 'format');
  const dimension = stringField(descriptor, 'dimension') ?? '2d';
  if (format === undefined) return readbackFailure(`texture ${resourceId} has no recorded format`);
  if ((numberField(descriptor, 'sampleCount') ?? 1) > 1) {
    return readbackUnsupported(
      resourceId,
      format,
      'multisampled textures require a single-sample resolve target before readback',
    );
  }
  const plan = getTextureReadbackPlan({ format, dimension });
  if (!plan.supported) {
    return err(
      createRhiDebugError('readback-unsupported', {
        stage: 'readback',
        resourceId,
        format,
        reason: plan.reason,
      }),
    );
  }
  const size = projectTextureExtent(recordField(descriptor, 'size'));
  if (size === undefined) return readbackFailure('the texture descriptor has invalid dimensions');
  const mipLevel = textureSubresourceField(subresource, 'mipLevel') ?? 0;
  const arrayLayer = textureSubresourceField(subresource, 'arrayLayer') ?? 0;
  const mipCount = numberField(descriptor, 'mipLevelCount') ?? 1;
  if (
    !validIndex(mipLevel, mipCount) ||
    !Number.isInteger(arrayLayer) ||
    arrayLayer < 0 ||
    arrayLayer >= textureLayerExtent(size.layerCount, dimension, mipLevel)
  ) {
    return readbackFailure(`texture subresource for ${resourceId} is outside the recorded extent`);
  }
  const width = mipDimension(size.width, mipLevel);
  const height = mipDimension(size.height, mipLevel);
  const requestedAspect = textureAspect(subresource);
  if (isDepthStencilTextureFormat(format)) {
    if (requestedAspect === 'all') {
      return readbackUnsupported(
        resourceId,
        format,
        `${format} requires an explicit depth-only or stencil-only aspect`,
      );
    }
    if (requestedAspect === 'stencil-only') {
      const layout = textureReadbackLayout(width, height, {
        blockWidth: 1,
        blockHeight: 1,
        bytesPerBlock: 1,
      });
      const bytes = await copyTextureBytes(
        device,
        entry.resource.value as Texture,
        layout.byteLength,
        {
          mipLevel,
          arrayLayer,
          aspect: 'stencil-only',
          width,
          height,
          bytesPerRow: layout.bytesPerRow,
          rowBytes: width,
        },
      );
      if (!bytes.ok) return bytes;
      return ok({ resourceId, kind: 'texture', format, width, height, bytes: bytes.value });
    }
  }
  if (isDepthTextureFormat(format)) {
    if (requestedAspect === 'stencil-only') {
      return readbackUnsupported(resourceId, format, `${format} has no stencil aspect`);
    }
    const bytes = await readbackDepthTexture(
      device,
      entry.resource.value as Texture,
      width,
      height,
      mipLevel,
      arrayLayer,
      createShaderModule,
      size.layerCount > 1 || stringField(descriptor, 'textureBindingViewDimension') === '2d-array',
    );
    if (!bytes.ok) return bytes;
    return ok({ resourceId, kind: 'texture', format, width, height, bytes: bytes.value });
  }
  const texelBytes = textureBytesPerTexel(format);
  if (texelBytes === undefined)
    return readbackFailure(`texture format ${format} has no byte layout`);
  const { rowBytes, bytesPerRow, byteLength } = textureReadbackLayout(width, height, {
    blockWidth: 1,
    blockHeight: 1,
    bytesPerBlock: texelBytes,
  });
  const bytes = await copyTextureBytes(device, entry.resource.value as Texture, byteLength, {
    mipLevel,
    arrayLayer,
    aspect: requestedAspect,
    width,
    height,
    bytesPerRow,
    rowBytes,
  });
  if (!bytes.ok) return bytes;
  return ok({ resourceId, kind: 'texture', format, width, height, bytes: bytes.value });
}

function readbackUnsupported(
  resourceId: string,
  format: string,
  reason: string,
): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('readback-unsupported', {
      stage: 'readback',
      resourceId,
      format,
      reason,
    }),
  );
}

/** Own the staging lifetime through encoding, submission, mapping and detached output. */
async function copyReadbackBytes(
  device: RhiDevice,
  bufferSize: number,
  mappedSize: number,
  kind: 'buffer' | 'texture',
  encode: (encoder: RhiCommandEncoder, staging: Buffer) => void,
  read: (mapped: Uint8Array) => Uint8Array,
): Promise<Result<Uint8Array, RhiDebugError>> {
  let staging: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  try {
    const created = device.createBuffer({ size: bufferSize, usage: COPY_DST_MAP_READ });
    if (!created.ok)
      return readbackFailure(`staging buffer creation failed: ${created.error.code}`);
    staging = created.value;
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return readbackFailure(`readback encoder creation failed: ${encoderResult.error.code}`);
    const encoder = encoderResult.value;
    encode(encoder, staging);
    const finished = encoder.finish();
    if (!finished.ok)
      return readbackFailure(`readback encoder finish failed: ${finished.error.code}`);
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) return readbackFailure(`readback submit failed: ${submitted.error.code}`);
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await staging.mapAsync(GPU_MAP_MODE_READ);
    if (!mappedResult.ok) return readbackFailure(`readback map failed: ${mappedResult.error.code}`);
    mapped = mappedResult.value;
    const range = mapped.getMappedRange(0, mappedSize);
    if (!range.ok) return readbackFailure(`readback mapped range failed: ${range.error.code}`);
    return ok(read(new Uint8Array(range.value)));
  } catch (cause) {
    return readbackFailure(`${kind} readback failed: ${messageOf(cause)}`);
  } finally {
    if (mapped !== undefined) mapped.unmap();
    if (staging !== undefined) device.destroyBuffer(staging);
  }
}

function copyBufferBytes(
  device: RhiDevice,
  source: Buffer,
  sourceOffset: number,
  size: number,
): Promise<Result<Uint8Array, RhiDebugError>> {
  const alignedSourceOffset = sourceOffset - (sourceOffset % 4);
  const leadingBytes = sourceOffset - alignedSourceOffset;
  const copySize = align4(leadingBytes + size);
  return copyReadbackBytes(
    device,
    Math.max(4, copySize),
    copySize,
    'buffer',
    (encoder, staging) =>
      encoder.copyBufferToBuffer(source, alignedSourceOffset, staging, 0, copySize),
    (bytes) => bytes.slice(leadingBytes, leadingBytes + size),
  );
}

function copyTextureBytes(
  device: RhiDevice,
  source: Texture,
  bufferSize: number,
  copy: {
    readonly mipLevel: number;
    readonly arrayLayer: number;
    readonly aspect: 'all' | 'depth-only' | 'stencil-only';
    readonly width: number;
    readonly height: number;
    readonly bytesPerRow: number;
    readonly rowBytes: number;
  },
): Promise<Result<Uint8Array, RhiDebugError>> {
  return copyReadbackBytes(
    device,
    bufferSize,
    bufferSize,
    'texture',
    (encoder, staging) =>
      encoder.copyTextureToBuffer(
        {
          texture: source,
          mipLevel: copy.mipLevel,
          origin: { x: 0, y: 0, z: copy.arrayLayer },
          aspect: copy.aspect,
        },
        {
          buffer: staging,
          offset: 0,
          bytesPerRow: copy.bytesPerRow,
          rowsPerImage: copy.height,
        },
        { width: copy.width, height: copy.height, depthOrArrayLayers: 1 },
      ),
    (padded) => {
      const bytes = new Uint8Array(copy.rowBytes * copy.height);
      for (let row = 0; row < copy.height; row++) {
        bytes.set(
          padded.subarray(row * copy.bytesPerRow, row * copy.bytesPerRow + copy.rowBytes),
          row * copy.rowBytes,
        );
      }
      return bytes;
    },
  );
}

function readbackFailure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field !== null && typeof field === 'object'
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' ? field : undefined;
}

function textureSubresourceField(
  value: ReplayReadbackRequest | undefined,
  key: 'mipLevel' | 'arrayLayer',
): number | undefined {
  if (value === undefined || isBufferRange(value)) return undefined;
  return value[key];
}

function textureAspect(
  value: ReplayReadbackRequest | undefined,
): 'all' | 'depth-only' | 'stencil-only' {
  if (value === undefined || isBufferRange(value)) return 'all';
  return value.aspect ?? 'all';
}

function isBufferRange(value: ReplayReadbackRequest | undefined): value is BufferReadbackRange {
  return value !== undefined && 'offset' in value;
}

function validRange(offset: number, size: number, total: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(size) &&
    offset >= 0 &&
    size >= 0 &&
    offset + size <= total
  );
}

function validIndex(value: number, count: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < count;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
