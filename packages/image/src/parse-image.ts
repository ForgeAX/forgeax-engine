import type { DecodedImage, ImageColorSpace, ImageError } from '@forgeax/engine-types';
import * as jpeg from 'jpeg-js';
// Static imports of upng-js + jpeg-js. tsup external keeps both as runtime
// require() calls so the browser bundle still tree-shakes them out when
// only image-decoder-browser.ts (createImageBitmap) is reached at runtime.
// Synchronous decode is required by the parseImage signature contract (see
// plan-strategy section 3.3).
import * as UPNG from 'upng-js';
import { imageError } from './errors.js';
import { downscaleRgba } from './resize-image.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

export interface ParseImageOptions {
  /**
   * Maximum allowed dimension (width or height). Defaults to 16384 -- the
   * conservative WebGPU `maxTextureDimension2D` floor across desktop +
   * high-end mobile (research F-3 / spec). Test fixtures pass smaller
   * values to exercise the bounds-check code path with tiny fixtures.
   */
  readonly maxDimension?: number;

  /** Optional asset-owned cooked-payload target; source bytes remain unchanged. */
  readonly downscaleMaxDimension?: number;

  /**
   * Sidecar `colorSpace` carried over to the DecodedImage POD. Defaults to
   * 'srgb' (typical baseColor / albedo path; plan-strategy section 2.5).
   */
  readonly colorSpace?: ImageColorSpace;

  /**
   * Sidecar `mipmap` flag carried over to DecodedImage. Defaults to true
   * (auto-generate via runtime mipmap-generator; plan-strategy section 2.6).
   */
  readonly mipmap?: boolean;

  /**
   * Optional source path to embed in error.detail.path (decode-failed /
   * format-unsupported variants). decodeImageFromFile fills this in;
   * in-memory parseImage callers leave it empty.
   */
  readonly path?: string;
}

const DEFAULT_MAX_DIMENSION = 16384;

const SUPPORTED_MIMES: readonly string[] = ['image/png', 'image/jpeg'];

interface UpngDecoded {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

interface JpegDecoded {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Pure synchronous image decoder. Translates raw byte stream + mime hint
 * into a tight-packed RGBA `DecodedImage` POD. Surfaces all four
 * ImageErrorCode members through the structured `Result<DecodedImage,
 * ImageError>` return (charter P3 explicit failure; AGENTS.md "Return
 * Result, never throw").
 *
 * Decoder selection follows the mime hint:
 * - `image/png` -> upng-js `UPNG.decode` + `UPNG.toRGBA8`
 * - `image/jpeg` -> jpeg-js `decode` with `formatAsRGBA: true`
 * - other -> `image-format-unsupported`
 *
 * Decoded bytes are always tight-packed RGBA (`bytes.length === width *
 * height * 4`). `colorSpace` and `mipmap` are carried from the supplied
 * `ParseImageOptions` (decodeImageFromFile passes the sidecar settings).
 */
export function parseImage(
  bytes: Uint8Array,
  mime: string,
  opts: ParseImageOptions = {},
): Result<DecodedImage, ImageError> {
  if (!SUPPORTED_MIMES.includes(mime)) {
    return err(
      imageError({
        code: 'image-format-unsupported',
        actualMime: mime,
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      }),
    );
  }

  let width = 0;
  let height = 0;
  let rgba: Uint8Array;

  try {
    if (mime === 'image/png') {
      const upngMod: {
        decode: (b: Uint8Array | ArrayBuffer) => UpngDecoded;
        toRGBA8: (i: UpngDecoded) => ArrayBuffer[];
      } = ((UPNG as unknown as { default?: typeof UPNG }).default ?? UPNG) as unknown as {
        decode: (b: Uint8Array | ArrayBuffer) => UpngDecoded;
        toRGBA8: (i: UpngDecoded) => ArrayBuffer[];
      };
      const decoded = upngMod.decode(bytes);
      width = decoded.width;
      height = decoded.height;
      const frames = upngMod.toRGBA8(decoded);
      const first = frames[0];
      if (first === undefined) {
        return err(
          imageError({
            code: 'image-decode-failed',
            reason: 'UPNG.toRGBA8 returned no frames',
            ...(opts.path !== undefined ? { path: opts.path } : {}),
          }),
        );
      }
      rgba = new Uint8Array(first);
    } else {
      // image/jpeg
      const jpegMod: {
        decode: (
          b: Uint8Array | ArrayBuffer,
          o?: { useTArray?: boolean; formatAsRGBA?: boolean },
        ) => JpegDecoded;
      } = ((jpeg as unknown as { default?: typeof jpeg }).default ?? jpeg) as unknown as {
        decode: (
          b: Uint8Array | ArrayBuffer,
          o?: { useTArray?: boolean; formatAsRGBA?: boolean },
        ) => JpegDecoded;
      };
      const decoded = jpegMod.decode(bytes, { useTArray: true, formatAsRGBA: true });
      width = decoded.width;
      height = decoded.height;
      rgba = decoded.data;
    }
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: e instanceof Error ? e.message : String(e),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      }),
    );
  }

  const downscaleLimit = opts.downscaleMaxDimension;
  if (downscaleLimit !== undefined && Number.isInteger(downscaleLimit) && downscaleLimit > 0) {
    const downscaled = downscaleRgba(rgba, width, height, downscaleLimit);
    rgba = downscaled.bytes;
    width = downscaled.width;
    height = downscaled.height;
  }

  const limit = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;
  if (width > limit || height > limit) {
    return err(
      imageError({
        code: 'image-dimension-out-of-bounds',
        requested: { width, height },
        limit,
      }),
    );
  }

  return ok({
    bytes: rgba,
    width,
    height,
    mime: mime as 'image/png' | 'image/jpeg',
    colorSpace: opts.colorSpace ?? 'srgb',
    mipmap: opts.mipmap ?? true,
  });
}
