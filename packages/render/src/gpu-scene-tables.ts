import type {
  Buffer,
  Result,
  RhiDevice,
  RhiError,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from './gpu-usage';

/**
 * Where GPU Scene table rows live: storage buffers, or `rgba32uint` textures
 * read by `textureLoad` on devices without vertex-visible storage buffers.
 */
export type GpuSceneTableBackend = 'buffer' | 'texture';

/** One table texture; row bytes run linearly through texels, `width` texels per line. */
export interface GpuSceneTableTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly width: number;
}

export type GpuSceneTableResource =
  | { readonly kind: 'buffer'; readonly buffer: Buffer }
  | ({ readonly kind: 'texture' } & GpuSceneTableTexture);

const TEXEL_BYTES = 16;
const TEXTURE_WIDTH = 1024;
const TEXTURE_USAGE_COPY_DST = 0x02;
const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;

function positiveLimit(value: unknown): number {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
}

function textureWidth(device: RhiDevice): number {
  return Math.min(TEXTURE_WIDTH, positiveLimit(device.limits.maxTextureDimension2D));
}

/** Every table is bound whole: one storage binding, or one 2D texture. */
export function gpuSceneTableByteLimit(device: RhiDevice, backend: GpuSceneTableBackend): number {
  if (backend === 'texture') {
    const dimension = positiveLimit(device.limits.maxTextureDimension2D);
    return Math.min(Number.MAX_SAFE_INTEGER, textureWidth(device) * dimension * TEXEL_BYTES);
  }
  return Math.min(
    positiveLimit(device.limits.maxStorageBufferBindingSize),
    positiveLimit(device.limits.maxBufferSize),
  );
}

export function createGpuSceneTable(
  device: RhiDevice,
  backend: GpuSceneTableBackend,
  label: string,
  size: number,
): Result<GpuSceneTableResource, RhiError> {
  if (backend === 'buffer') {
    const buffer = device.createBuffer({
      label,
      size,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
      mappedAtCreation: false,
    });
    return buffer.ok ? ok({ kind: 'buffer', buffer: buffer.value }) : buffer;
  }
  const width = textureWidth(device);
  const height = Math.max(1, Math.ceil(size / (width * TEXEL_BYTES)));
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba32uint',
    textureBindingViewDimension: '2d',
    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!texture.ok) return texture;
  const view = device.createTextureView(texture.value, { dimension: '2d' });
  if (!view.ok) {
    device.destroyTexture(texture.value);
    return view;
  }
  return ok({ kind: 'texture', texture: texture.value, view: view.value, width });
}

export function destroyGpuSceneTable(device: RhiDevice, table: GpuSceneTableResource): void {
  if (table.kind === 'buffer') device.destroyBuffer(table.buffer);
  else device.destroyTexture(table.texture);
}

/**
 * Upload `size` bytes at `offset` of the CPU table image. Texture tables
 * widen the range to whole texels and write at most a partial first line,
 * the full lines, and a partial last line.
 */
export function writeGpuSceneTable(
  device: RhiDevice,
  table: GpuSceneTableResource,
  source: ArrayBuffer,
  offset: number,
  size: number,
): Result<number, RhiError> {
  if (table.kind === 'buffer') {
    const written = device.queue.writeBuffer(table.buffer, offset, source, offset, size);
    return written.ok ? ok(size) : written;
  }
  const first = Math.floor(offset / TEXEL_BYTES);
  const end = Math.ceil((offset + size) / TEXEL_BYTES);
  let texel = first;
  while (texel < end) {
    const x = texel % table.width;
    const y = Math.floor(texel / table.width);
    const lineEnd = (y + 1) * table.width;
    const rows = x === 0 && end >= lineEnd ? Math.floor((end - texel) / table.width) : 1;
    const width = Math.min(end, lineEnd) - texel;
    const written = device.queue.writeTexture(
      { texture: table.texture, origin: { x, y, z: 0 } },
      source,
      { offset: texel * TEXEL_BYTES, bytesPerRow: table.width * TEXEL_BYTES, rowsPerImage: rows },
      { width, height: rows, depthOrArrayLayers: 1 },
    );
    if (!written.ok) return written;
    texel += rows > 1 ? rows * table.width : width;
  }
  return ok((end - first) * TEXEL_BYTES);
}
