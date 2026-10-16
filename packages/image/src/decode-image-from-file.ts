import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { DecodedImage, ImageError, ImageMeta } from '@forgeax/engine-types';
import { imageError } from './errors.js';
import { decodeHdr, type HdrDecoded } from './hdr-decoder.js';
import { parseImage } from './parse-image.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/**
 * Sidecar JSON shape consumed by decodeImageFromFile. The schema is the
 * external-asset-package $defs from `packages/pack/schema/meta.schema.json`
 * (research F-9). Only the fields required by the Node-side decoder are
 * enumerated here; importSettings remains free-form per plan-strategy R5.
 */
interface SidecarMeta {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'image';
  readonly source: string;
  readonly importSettings: Partial<{
    colorSpace: ImageMeta['colorSpace'];
    mipmap: ImageMeta['mipmap'];
    addressMode: ImageMeta['addressMode'];
    filterMode: ImageMeta['filterMode'];
  }>;
  readonly subAssets: ReadonlyArray<{
    readonly guid: string;
    readonly sourceIndex: number;
    readonly kind: string;
  }>;
}

/**
 * Result envelope returned by decodeImageFromFile for PNG/JPG sources.
 * Carries both the raw DecodedImage POD (for direct uploadTexture consumption)
 * and the parsed ImageMeta POD.
 */
export interface DecodedImageWithMeta {
  readonly decoded: DecodedImage;
  readonly meta: ImageMeta;
}

/**
 * Result envelope returned by decodeImageFromFile for .hdr sources.
 * Carries the HDR-decoded float data ready for cubemap upload.
 */
export interface DecodedHdrWithMeta {
  readonly hdr: HdrDecoded;
  readonly meta: ImageMeta;
}

const EXT_TO_MIME: Readonly<Record<string, 'image/png' | 'image/jpeg' | 'image/vnd.radiance'>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.hdr': 'image/vnd.radiance',
};

function deriveSidecarPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  // sidecar lives next to source as <source-with-ext>.meta.json
  // (feat-20260521 unify-sidecar-meta-dispatch-by-content; the importer field
  //  in the JSON drives importer dispatch instead of filename suffix).
  const base = sourcePath.slice(dir.length + 1);
  return join(dir, `${base}.meta.json`);
}

/**
 * Async file-system entry to the image importer (plan-strategy section 3.2
 * sequence A; AC-17 path (a) sidecar three-way fallback).
 *
 * Behaviour (left-to-right, fail-fast on first surfaced ImageError):
 *  1. Sniff extension -- not in `.png / .jpg / .jpeg` -> image-format-unsupported
 *  2. Stat source -- absent -> image-decode-failed with the source path
 *  3. Stat sibling `<source>.meta.json` (importer: 'image') -- absent -> image-meta-missing
 *  4. Read source bytes + parse sidecar JSON
 *  5. Hand off to `parseImage(bytes, mime, opts)` -- surfaces image-decode-failed
 *     / image-format-unsupported / image-dimension-out-of-bounds
 *  6. Compose DecodedImage POD + ImageMeta POD return envelope.
 *
 * AC-17 path (a) lock: when the sidecar is absent, the returned error
 * carries `detail.sourcePath` + `detail.expectedSidecarPath` so AI users
 * read .hint and run `forgeax asset import <path> --root <project>` to
 * self-recover (charter P3 explicit failure + IDE jump-to-source).
 */
export async function decodeImageFromFile(
  sourcePath: string,
): Promise<Result<DecodedImageWithMeta, ImageError>> {
  const ext = extname(sourcePath).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (mime === undefined) {
    return err(
      imageError({
        code: 'image-format-unsupported',
        actualMime: `extension '${ext || '<none>'}'`,
        path: sourcePath,
      }),
    );
  }

  const sidecarPath = deriveSidecarPath(sourcePath);

  try {
    await stat(sourcePath);
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: `failed to read source: ${e instanceof Error ? e.message : String(e)}`,
        path: sourcePath,
      }),
    );
  }

  try {
    await stat(sidecarPath);
  } catch {
    return err(
      imageError({
        code: 'image-meta-missing',
        sourcePath,
        expectedSidecarPath: sidecarPath,
      }),
    );
  }

  let sidecarText: string;
  try {
    sidecarText = (await readFile(sidecarPath)).toString('utf8');
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: `failed to read sidecar: ${e instanceof Error ? e.message : String(e)}`,
        path: sidecarPath,
      }),
    );
  }

  let sidecar: SidecarMeta;
  try {
    sidecar = JSON.parse(sidecarText) as SidecarMeta;
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: `sidecar JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        path: sidecarPath,
      }),
    );
  }

  const settings = sidecar.importSettings ?? {};
  const colorSpace: ImageMeta['colorSpace'] = settings.colorSpace ?? 'srgb';
  const mipmap: ImageMeta['mipmap'] = settings.mipmap ?? 'auto';
  const addressMode: ImageMeta['addressMode'] = settings.addressMode ?? 'repeat';
  const filterMode: ImageMeta['filterMode'] = settings.filterMode ?? 'linear';
  const guid = sidecar.subAssets[0]?.guid ?? '';

  const meta: ImageMeta = {
    guid,
    colorSpace,
    mipmap,
    addressMode,
    filterMode,
  };

  let bytes: Uint8Array;
  try {
    const buf = await readFile(sourcePath);
    bytes = new Uint8Array(buf);
  } catch (e) {
    return err(
      imageError({
        code: 'image-decode-failed',
        reason: `failed to read source: ${e instanceof Error ? e.message : String(e)}`,
        path: sourcePath,
      }),
    );
  }

  // .hdr path: delegate to HDR decoder, enforce linear color space
  if (mime === 'image/vnd.radiance') {
    if (colorSpace !== 'linear') {
      return err(
        imageError({
          code: 'image-format-unsupported',
          actualMime: `colorSpace conflict: HDR requires linear, got ${colorSpace}`,
          path: sourcePath,
        }),
      );
    }
    const hdrRes = decodeHdr(bytes);
    if (!hdrRes.ok) return err(hdrRes.error);
    // DecodedImageWithMeta expects DecodedImage; for HDR we return the HDR
    // variant through a separate export path. Downstream consumers
    // distinguish by file extension.
    // For the DecodedImageWithMeta return type compatibility, we synthesise
    // a minimal DecodedImage POD carrying the byte representation.
    // This keeps the return type stable for existing PNG/JPG callers.
    // The HDR data is available through the separate decodeHdr export.
    const rgba8 = new Uint8Array(hdrRes.value.width * hdrRes.value.height * 4);
    // convert float to quantised 8-bit for the POD shape (lossy; consumers
    // should use decodeHdr directly for float precision)
    for (let i = 0; i < hdrRes.value.data.length; i++) {
      const v = hdrRes.value.data[i];
      const clamped = v !== undefined ? Math.max(0, Math.min(1, v as number)) : 0;
      rgba8[i] = Math.round(clamped * 255);
    }
    const decoded: DecodedImage = {
      bytes: rgba8,
      width: hdrRes.value.width,
      height: hdrRes.value.height,
      mime: 'image/jpeg',
      colorSpace: 'linear',
      mipmap: false,
    };
    return ok({ decoded, meta });
  }

  const r = parseImage(bytes, mime, {
    colorSpace,
    mipmap: mipmap === 'auto',
    path: sourcePath,
  });
  if (!r.ok) {
    return err(r.error);
  }

  return ok({ decoded: r.value, meta });
}
