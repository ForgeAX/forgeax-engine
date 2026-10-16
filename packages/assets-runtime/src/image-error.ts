// @forgeax/engine-assets-runtime -- runtime-local ImageError constructor
// (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1 straight-cut).
// Pure move from asset-registry.ts; zero identifier changes.

import type { ImageErrorDetailFor, ImageErrorFor } from '@forgeax/engine-types';
import { IMAGE_ERROR_HINTS } from '@forgeax/engine-types';

// Local minimal `ImageError` constructor (charter P5 producer / consumer
// split: the runtime AssetRegistry should not import @forgeax/engine-image
// errors module because the image package is the disk-side decoder; the
// runtime is the GPU consumer. Both packages share the `ImageError`
// interface SSOT in @forgeax/engine-types so runtime constructs the
// 4-field surface (.code / .expected / .hint / .detail) directly without
// duplicating the @forgeax/engine-image errors.ts class).
type UnsupportedMimeImageError = ImageErrorFor<'image-format-unsupported'>;
type UnsupportedMimeImageErrorDetail = ImageErrorDetailFor<'image-format-unsupported'>;

const IMAGE_ERROR_EXPECTED_LOCAL: Readonly<
  Record<UnsupportedMimeImageErrorDetail['code'], string>
> = {
  'image-format-unsupported':
    "mime is one of ['image/png', 'image/jpeg', 'image/x-tga']; texture format <-> colorSpace family agrees",
};

class RuntimeImageError extends Error implements UnsupportedMimeImageError {
  readonly code: UnsupportedMimeImageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: UnsupportedMimeImageErrorDetail;
  constructor(detail: UnsupportedMimeImageErrorDetail) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED_LOCAL[code];
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export function makeImageError(detail: UnsupportedMimeImageErrorDetail): UnsupportedMimeImageError {
  return new RuntimeImageError(detail);
}
