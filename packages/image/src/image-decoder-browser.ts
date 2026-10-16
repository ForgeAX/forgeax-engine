import type { DecodedImage, ImageColorSpace, ImageError } from '@forgeax/engine-types';
import { imageError } from './errors.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/**
 * Browser image decoder (plan-strategy section 3.3 + section 2.4 D Open Q-3).
 *
 * Uses `createImageBitmap(blob, { colorSpaceConversion: 'none' })` to keep
 * the bytes in their authored color space (sRGB / linear); the runtime
 * uploadTexture entry asserts `format <-> colorSpace` consistency at GPU
 * upload time (plan-strategy section 2.5 D Open Q-4 (c)).
 *
 * Pixel readback uses an offscreen 2D canvas + `getImageData`; AI users
 * never call this directly -- it is the browser-mode counterpart of
 * `parseImage` (Node-mode upng / jpeg-js path) consumed by future M2b
 * vite-plugin overlay paths and direct browser-mode loaders. The Node
 * decoder remains the SSOT for parseImage; this file is the browser
 * fallback when running inside vitest browser mode or the Vite dev server.
 */
export async function decodeImageInBrowser(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  opts: { colorSpace?: ImageColorSpace; mipmap?: boolean } = {},
): Promise<Result<DecodedImage, ImageError>> {
  if (typeof createImageBitmap !== 'function') {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: 'createImageBitmap is not available in this environment',
      }),
    );
  }

  let bitmap: ImageBitmap;
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  // Read pixels back via OffscreenCanvas (browser context) -- 2D context is
  // ubiquitous and avoids the WebGPU readback round-trip during disk-side
  // decode (charter P5 producer / consumer split: GPU upload happens inside
  // @forgeax/engine-runtime AssetRegistry.uploadTexture, not here).
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : (() => {
          const c = document.createElement('canvas');
          c.width = bitmap.width;
          c.height = bitmap.height;
          return c;
        })();
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (ctx === null) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: 'failed to acquire 2d canvas context for pixel readback',
      }),
    );
  }
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();

  return ok({
    bytes: new Uint8Array(data.data.buffer.slice(0)),
    width: data.width,
    height: data.height,
    mime,
    colorSpace: opts.colorSpace ?? 'srgb',
    mipmap: opts.mipmap ?? true,
  });
}
