import type {
  DecodedImage,
  ImageColorSpace,
  ImageError,
  ImageErrorDetailFor,
  ImageMeta,
  TextureAsset,
} from '@forgeax/engine-types';
import { imageError } from './errors.js';
import { err, ok, type Result } from './result.js';
import { type ExternalAssetPackage, toAssetPack } from './to-asset-pack.js';

/** Four finite RGBA8 channels in source order. */
export type PixelColor =
  | readonly [number, number, number, number]
  | Readonly<{ r: number; g: number; b: number; a: number }>;

/** Optional source rectangle for a blit; coordinates are rounded and clipped. */
export interface PixelSurfaceRect {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface PixelSurfaceNoiseOptions {
  /** Inclusive lower channel bound, default 0. */
  readonly min?: number;
  /** Inclusive upper channel bound, default 255. */
  readonly max?: number;
  /** Alpha written for every generated pixel, default 255. */
  readonly alpha?: number;
}

export interface PixelSurfaceOptions {
  readonly width: number;
  readonly height: number;
  readonly colorSpace?: ImageColorSpace;
  readonly mipmap?: boolean;
}

export interface PixelSurface {
  readonly width: number;
  readonly height: number;
  readonly colorSpace: ImageColorSpace;
  readonly mipmap: boolean;
  /** Tight RGBA8 level-zero bytes in row-major order. */
  readonly data: Uint8Array;

  setPixel(x: number, y: number, color: PixelColor): Result<void, ImageError>;
  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: PixelColor,
  ): Result<void, ImageError>;
  fillCircle(cx: number, cy: number, radius: number, color: PixelColor): Result<void, ImageError>;
  blit(
    source: PixelSurface,
    destinationX: number,
    destinationY: number,
    sourceRect?: PixelSurfaceRect,
  ): Result<void, ImageError>;
  /** Fill RGB channels with deterministic seeded noise and set alpha uniformly. */
  fillNoise(seed: number, options?: PixelSurfaceNoiseOptions): Result<void, ImageError>;
  /** Alias kept on the same value for the concise authoring spelling. */
  noise(seed: number, options?: PixelSurfaceNoiseOptions): Result<void, ImageError>;

  toDecodedImage(): DecodedImage;
  toTextureAsset(): TextureAsset;
  toAssetPack(meta: ImageMeta): ExternalAssetPackage;
}

type SurfaceOperation = ImageErrorDetailFor<'image-surface-invalid'>['operation'];

function invalid(
  operation: SurfaceOperation,
  field: string,
  value: string | number,
  expected: string,
): Result<never, ImageError> {
  return err(
    imageError({
      code: 'image-surface-invalid',
      operation,
      field,
      value,
      expected,
    }),
  );
}

function finiteNumber(
  operation: SurfaceOperation,
  field: string,
  value: number,
): Result<number, ImageError> {
  if (!Number.isFinite(value)) {
    return invalid(operation, field, String(value), 'a finite number');
  }
  return ok(value);
}

function positiveDimension(
  operation: SurfaceOperation,
  field: string,
  value: number,
): Result<number, ImageError> {
  if (!Number.isInteger(value) || value <= 0) {
    return invalid(operation, field, value, 'a positive integer');
  }
  return ok(value);
}

function colorChannels(
  operation: SurfaceOperation,
  color: PixelColor,
): Result<readonly [number, number, number, number], ImageError> {
  const channels = Array.isArray(color)
    ? color
    : color !== null && typeof color === 'object'
      ? [
          (color as Readonly<{ r: number; g: number; b: number; a: number }>).r,
          (color as Readonly<{ r: number; g: number; b: number; a: number }>).g,
          (color as Readonly<{ r: number; g: number; b: number; a: number }>).b,
          (color as Readonly<{ r: number; g: number; b: number; a: number }>).a,
        ]
      : undefined;
  if (channels === undefined || channels.length !== 4) {
    return invalid(operation, 'color', 'malformed', 'four finite RGBA8 channels');
  }
  const normalized: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    if (channel === undefined || !Number.isFinite(channel) || channel < 0 || channel > 255) {
      return invalid(
        operation,
        `color[${index}]`,
        channel ?? 'missing',
        'a finite number in [0, 255]',
      );
    }
    normalized[index] = Math.round(channel);
  }
  return ok(normalized);
}

function rounded(
  operation: SurfaceOperation,
  field: string,
  value: number,
): Result<number, ImageError> {
  const result = finiteNumber(operation, field, value);
  return result.ok ? ok(Math.round(result.value)) : result;
}

function rectangle(
  operation: 'fill-rect' | 'blit',
  x: number,
  y: number,
  width: number,
  height: number,
): Result<readonly [number, number, number, number], ImageError> {
  const values: [number, number, number, number] = [x, y, width, height];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      return invalid(
        operation,
        ['x', 'y', 'width', 'height'][index] ?? 'rectangle',
        String(value),
        'a finite number',
      );
    }
  }
  if (width <= 0 || height <= 0) {
    return invalid(
      operation,
      width <= 0 ? 'width' : 'height',
      width <= 0 ? width : height,
      'a positive number',
    );
  }
  return ok([Math.round(x), Math.round(y), Math.round(width), Math.round(height)]);
}

function writePixel(
  data: Uint8Array,
  width: number,
  x: number,
  y: number,
  color: ArrayLike<number>,
): void {
  if (x < 0 || y < 0 || x >= width) return;
  const offset = (y * width + x) * 4;
  data[offset] = color[0] ?? 0;
  data[offset + 1] = color[1] ?? 0;
  data[offset + 2] = color[2] ?? 0;
  data[offset + 3] = color[3] ?? 0;
}

function fillClippedRect(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: readonly number[],
): void {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(width, x + rectWidth);
  const bottom = Math.min(height, y + rectHeight);
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      writePixel(data, width, column, row, color);
    }
  }
}

function nextRandom(state: number): number {
  // xorshift32 is small, deterministic across runtimes, and has no ambient
  // state. The seed is normalized once by fillNoise, so zero remains valid.
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function makeSurface(options: PixelSurfaceOptions): Result<PixelSurface, ImageError> {
  const width = positiveDimension('create', 'width', options.width);
  if (!width.ok) return width;
  const height = positiveDimension('create', 'height', options.height);
  if (!height.ok) return height;
  if (
    options.colorSpace !== undefined &&
    options.colorSpace !== 'srgb' &&
    options.colorSpace !== 'linear'
  ) {
    return invalid('create', 'colorSpace', String(options.colorSpace), "'srgb' or 'linear'");
  }
  if (options.mipmap !== undefined && typeof options.mipmap !== 'boolean') {
    return invalid('create', 'mipmap', String(options.mipmap), 'a boolean');
  }
  const data = new Uint8Array(width.value * height.value * 4);
  const colorSpace = options.colorSpace ?? 'srgb';
  const mipmap = options.mipmap ?? false;

  const surface: PixelSurface = {
    width: width.value,
    height: height.value,
    colorSpace,
    mipmap,
    data,
    setPixel(x, y, color) {
      const px = rounded('set-pixel', 'x', x);
      if (!px.ok) return px;
      const py = rounded('set-pixel', 'y', y);
      if (!py.ok) return py;
      const normalized = colorChannels('set-pixel', color);
      if (!normalized.ok) return normalized;
      writePixel(data, width.value, px.value, py.value, normalized.value);
      return ok(undefined);
    },
    fillRect(x, y, rectWidth, rectHeight, color) {
      const rect = rectangle('fill-rect', x, y, rectWidth, rectHeight);
      if (!rect.ok) return rect;
      const normalized = colorChannels('fill-rect', color);
      if (!normalized.ok) return normalized;
      fillClippedRect(
        data,
        width.value,
        height.value,
        rect.value[0] ?? 0,
        rect.value[1] ?? 0,
        rect.value[2] ?? 0,
        rect.value[3] ?? 0,
        normalized.value,
      );
      return ok(undefined);
    },
    fillCircle(cx, cy, radius, color) {
      const centerX = rounded('fill-circle', 'cx', cx);
      if (!centerX.ok) return centerX;
      const centerY = rounded('fill-circle', 'cy', cy);
      if (!centerY.ok) return centerY;
      const circleRadius = rounded('fill-circle', 'radius', radius);
      if (!circleRadius.ok) return circleRadius;
      if (circleRadius.value <= 0) {
        return invalid('fill-circle', 'radius', circleRadius.value, 'a positive number');
      }
      const normalized = colorChannels('fill-circle', color);
      if (!normalized.ok) return normalized;
      const radiusSquared = circleRadius.value * circleRadius.value;
      const left = Math.max(0, centerX.value - circleRadius.value);
      const right = Math.min(width.value - 1, centerX.value + circleRadius.value);
      const top = Math.max(0, centerY.value - circleRadius.value);
      const bottom = Math.min(height.value - 1, centerY.value + circleRadius.value);
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const dx = column - centerX.value;
          const dy = row - centerY.value;
          if (dx * dx + dy * dy <= radiusSquared)
            writePixel(data, width.value, column, row, normalized.value);
        }
      }
      return ok(undefined);
    },
    blit(source, destinationX, destinationY, sourceRect) {
      const destination = rounded('blit', 'destinationX', destinationX);
      if (!destination.ok) return destination;
      const destinationYResult = rounded('blit', 'destinationY', destinationY);
      if (!destinationYResult.ok) return destinationYResult;
      if (
        source === null ||
        typeof source !== 'object' ||
        !Number.isInteger(source.width) ||
        !Number.isInteger(source.height) ||
        !(source.data instanceof Uint8Array) ||
        source.data.length !== source.width * source.height * 4
      ) {
        return invalid('blit', 'source', 'malformed', 'a valid PixelSurface');
      }
      const rect = rectangle(
        'blit',
        sourceRect?.x ?? 0,
        sourceRect?.y ?? 0,
        sourceRect?.width ?? source.width,
        sourceRect?.height ?? source.height,
      );
      if (!rect.ok) return rect;
      const sourceX = rect.value[0] ?? 0;
      const sourceY = rect.value[1] ?? 0;
      const sourceWidth = rect.value[2] ?? 0;
      const sourceHeight = rect.value[3] ?? 0;
      const left = Math.max(0, sourceX);
      const top = Math.max(0, sourceY);
      const right = Math.min(source.width, sourceX + sourceWidth);
      const bottom = Math.min(source.height, sourceY + sourceHeight);
      if (right <= left || bottom <= top) return ok(undefined);
      const snapshot = source.data.slice();
      for (let row = top; row < bottom; row += 1) {
        for (let column = left; column < right; column += 1) {
          const targetX = destination.value + column - sourceX;
          const targetY = destinationYResult.value + row - sourceY;
          if (targetX < 0 || targetY < 0 || targetX >= width.value || targetY >= height.value)
            continue;
          const sourceOffset = (row * source.width + column) * 4;
          writePixel(
            data,
            width.value,
            targetX,
            targetY,
            snapshot.subarray(sourceOffset, sourceOffset + 4),
          );
        }
      }
      return ok(undefined);
    },
    fillNoise(seed, noiseOptions) {
      if (!Number.isFinite(seed)) return invalid('noise', 'seed', String(seed), 'a finite number');
      const min = noiseOptions?.min ?? 0;
      const max = noiseOptions?.max ?? 255;
      const alpha = noiseOptions?.alpha ?? 255;
      for (const [field, value] of [
        ['min', min],
        ['max', max],
        ['alpha', alpha],
      ] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 255) {
          return invalid('noise', field, value, 'a finite number in [0, 255]');
        }
      }
      if (min > max) return invalid('noise', 'min', min, 'a value no greater than max');
      let state = Math.trunc(seed) >>> 0 || 0x6d2b79f5;
      const span = max - min;
      for (let index = 0; index < data.length; index += 4) {
        state = nextRandom(state);
        const value = min + (state / 0x100000000) * span;
        const channel = Math.round(value);
        data[index] = channel;
        data[index + 1] = channel;
        data[index + 2] = channel;
        data[index + 3] = Math.round(alpha);
      }
      return ok(undefined);
    },
    noise(seed, noiseOptions) {
      return surface.fillNoise(seed, noiseOptions);
    },
    toDecodedImage() {
      return {
        bytes: data.slice(),
        width: width.value,
        height: height.value,
        mime: 'image/png',
        colorSpace,
        mipmap,
      };
    },
    toTextureAsset() {
      return {
        kind: 'texture',
        shape: {
          viewDimension: '2d',
          extent: { width: width.value, height: height.value },
        },
        format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        data: data.slice(),
        colorSpace,
        mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
      };
    },
    toAssetPack(meta) {
      return toAssetPack(meta);
    },
  };
  return ok(surface);
}

/** Create a deterministic, image-owned RGBA8 authoring surface. */
export function createPixelSurface(options: PixelSurfaceOptions): Result<PixelSurface, ImageError> {
  return makeSurface(options);
}
