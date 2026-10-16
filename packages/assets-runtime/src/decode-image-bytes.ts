// @forgeax/engine-assets-runtime -- runtime image byte decoder
// (tweak-20260714-runtime-image-bytes-decoder-add-decodeimagebytes M2 / m2-1).
//
// M1 established the signature + TSDoc contract + red test skeleton. M2
// fills the body:
//   1. mime whitelist pre-check (PNG / JPEG); non-match -> structured
//      `image-format-unsupported` err (charter P3 explicit failure).
//   2. Delegate to `@forgeax/engine-image::decodeImageInBrowser` (SSOT
//      browser-safe decoder; charter architecture principle 1 SSOT).
//   3. Map `DecodedImage` -> `TextureAsset` POD; `format` derives from
//      `opts.colorSpace` (srgb -> 'rgba8unorm-srgb' / linear ->
//      'rgba8unorm', mirrors `image-importer.ts` colorSpaceToFormat); when
//      `opts.mipmap !== false`, the mip policy derives from the decoded shape
//      (charter Derive-Don't-Duplicate).
//
// decode-image-bytes.ts is the SINGLE assets-runtime file allowed to
// statically import @forgeax/engine-image (charter D-2; the
// scripts/check-image-pipeline-isolation.mjs Path (a.2-anti) whitelist
// row anchors this exact path). The gate's (a.1) forbidden-symbol regex
// `\basync\s+function\s+decodeImage\b` does NOT match `decodeImageBytes`
// because `\b` between `e` and `B` fails (both are word chars) --
// verified at M2 by running the gate locally.
import { decodeImageInBrowser } from '@forgeax/engine-image';
import type { ImageError, Result, TextureAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { makeImageError } from './image-error';

/** v1 mime whitelist -- PNG / JPEG only (charter P1 progressive disclosure). */
const SUPPORTED_MIMES = ['image/png', 'image/jpeg'] as const;
type SupportedMime = (typeof SUPPORTED_MIMES)[number];

function isSupportedMime(mime: string): mime is SupportedMime {
  return SUPPORTED_MIMES.some((supportedMime) => supportedMime === mime);
}

/**
 * Decode a PNG / JPEG byte stream into a `TextureAsset` POD.
 *
 * Runtime SDK entry for AI users who hold image bytes (fetched over the
 * network, embedded as base64, produced by an out-of-tree decoder, etc.) and
 * want to feed them into `world.allocSharedRef('TextureAsset', pod)` +
 * `GpuResourceStore.ensureResident` without the disk-side importer / build
 * pipeline in the loop (charter P1 progressive disclosure: one-step "bytes
 * in, POD out").
 *
 * v1 supports the two universally-decodable mime types: `image/png` and
 * `image/jpeg`. Failure surfaces are all structured via the closed
 * `ImageError` union (`.code` / `.expected` / `.hint` / `.detail`); the
 * function never throws for expected failures (AGENTS.md Error model +
 * charter P3 explicit failure).
 *
 * Error codes possible (subset of the closed `ImageErrorCode` union):
 * - `image-format-unsupported` -- mime not in the v1 whitelist (`detail.actualMime`)
 * - `image-decode-failed` -- decoder rejected the bytes, or the environment
 *   lacks `createImageBitmap` (`detail.reason`)
 *
 * @param bytes - Encoded image byte stream (`Uint8Array` or `ArrayBuffer`).
 * @param mime - Byte-stream mime type. v1 whitelist: `'image/png' | 'image/jpeg'`.
 * @param opts - Optional decode overrides:
 *   - `colorSpace`: `'srgb'` (default) or `'linear'`. Derives POD `format`:
 *     `srgb -> 'rgba8unorm-srgb'`, `linear -> 'rgba8unorm'`.
 *   - `mipmap`: `true` (default) or `false`. When true, the producer requests
 *     generated mips; when false, it keeps one authored level.
 * @returns `ok(TextureAsset)` on success; `err(ImageError)` on failure.
 *
 * @example
 * ```ts
 * import { decodeImageBytes } from '@forgeax/engine-assets-runtime';
 *
 * const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
 * const result = await decodeImageBytes(bytes, 'image/png');
 * if (!result.ok) {
 *   // The ImageError code and detail are one correlated discriminated union.
 *   switch (result.error.code) {
 *     case 'image-format-unsupported':
 *       console.error('bad mime:', result.error.detail.actualMime);
 *       break;
 *     case 'image-decode-failed':
 *       console.error('decode reason:', result.error.detail.reason);
 *       break;
 *   }
 *   return;
 * }
 * const handle = world.allocSharedRef('TextureAsset', result.value);
 * ```
 */
export async function decodeImageBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,
  opts: { colorSpace?: 'srgb' | 'linear'; mipmap?: boolean } = {},
): Promise<Result<TextureAsset, ImageError>> {
  if (!isSupportedMime(mime)) {
    return err(
      makeImageError({
        code: 'image-format-unsupported',
        actualMime: mime,
      }),
    );
  }

  const colorSpace = opts.colorSpace ?? 'srgb';
  const mipmap = opts.mipmap ?? true;

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const decoded = await decodeImageInBrowser(u8, mime, { colorSpace, mipmap });
  if (!decoded.ok) {
    return err(decoded.error);
  }

  const dec = decoded.value;
  const format: GPUTextureFormat = colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
  const pod: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: dec.width, height: dec.height } },
    format,
    data: dec.bytes,
    colorSpace,
    mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
  };
  return ok(pod);
}
