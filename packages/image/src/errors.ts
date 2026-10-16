import type { ImageErrorCode, ImageErrorDetailFor, ImageErrorFor } from '@forgeax/engine-types';
import { IMAGE_ERROR_HINTS } from '@forgeax/engine-types';

// Per-code .expected string literals SSOT.
// Mirrors ASSET_ERROR_HINTS / IMAGE_ERROR_HINTS shape (charter P5 consistent
// abstraction). AI users surface .expected when a structured error needs to
// describe the precondition that was violated.
const IMAGE_ERROR_EXPECTED: Readonly<Record<ImageErrorCode, string>> = {
  'image-decode-failed': 'PNG / JPG byte stream decodes successfully',
  'image-format-unsupported':
    "mime is one of ['image/png', 'image/jpeg']; uploadTexture format <-> colorSpace family agrees",
  'image-dimension-out-of-bounds':
    'width and height fall under device caps maxTextureDimension2D (or 16384 hard cap)',
  'image-meta-missing':
    "<source>.meta.json sidecar (importer: 'image') exists in the same directory",
  'image-hdr-decode-failed': 'Radiance RGBE header is valid and pixel data decodes successfully',
  // feat-20260521-sprite-atlas-animation M1 T-03 — vite-plugin-image atlas
  // hook .expected literals (plan-strategy section 2 D-2 + AC-10 a/b/c).
  // ImageErrorImpl construction path is unchanged: the new atlas-* errors
  // flow through `new ImageErrorImpl({ code: 'atlas-...', ...detail })` and
  // pick the .expected string up from this Record at construction time
  // (charter P3 explicit failure SSOT — AI users surface .expected next to
  // .hint after switch (err.code) without parsing the message).
  'atlas-empty-input': 'images.length >= 1',
  'atlas-size-exceeded':
    'image width x height <= maxAtlasSize^2 and each image fits in the atlas footprint',
  'atlas-region-mismatch': 'sum(regions[i].w x regions[i].h) <= atlasWidth x atlasHeight',
  'image-surface-invalid':
    'PixelSurface dimensions and authoring inputs satisfy the RGBA8 contract',
};

/** Runtime implementation of the correlated `ImageErrorFor<C>` envelope. */
export class ImageErrorImpl<C extends ImageErrorCode = ImageErrorCode>
  extends Error
  implements ImageErrorFor<C>
{
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetailFor<C>;

  constructor(detail: ImageErrorDetailFor<C>) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED[code];
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

/** Construct a structured image error while preserving its code/detail pair. */
export function imageError<C extends ImageErrorCode>(
  detail: ImageErrorDetailFor<C>,
): ImageErrorFor<C> {
  return new ImageErrorImpl<C>(detail);
}

export { IMAGE_ERROR_EXPECTED };

export type CubeParserErrorCode =
  | 'cube-header-invalid'
  | 'cube-size-invalid'
  | 'cube-domain-invalid'
  | 'cube-row-invalid'
  | 'cube-data-count-invalid';

export interface CubeParserError {
  readonly code: CubeParserErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sourceKey: string;
    readonly line?: number;
    readonly field: string;
    readonly actual: unknown;
  };
}

export function cubeParserError(
  code: CubeParserErrorCode,
  sourceKey: string,
  field: string,
  actual: unknown,
  line?: number,
): CubeParserError {
  const lineDetail = line === undefined ? '' : ` at line ${line}`;
  return {
    code,
    expected: `valid .cube source with LUT_3D_SIZE, DOMAIN_MIN/MAX, and exactly N^3 RGB rows${lineDetail}`,
    hint: `repair field ${field} in sourceKey ${sourceKey} and re-run the Node image producer`,
    detail: { sourceKey, field, actual, ...(line === undefined ? {} : { line }) },
  };
}
