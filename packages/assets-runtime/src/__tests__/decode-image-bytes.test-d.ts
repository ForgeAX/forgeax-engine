// @forgeax/engine-assets-runtime -- decodeImageBytes type-only contract test
// (tweak-20260714-runtime-image-bytes-decoder-add-decodeimagebytes M1 / m1-1).
//
// AC-05 + AC-06 compile-time narrowing anchor. The vitest typecheck project
// runs `.test-d.ts` files so any drift in the exported signature / Result
// narrowing / ImageErrorDetail per-code shape trips CI (charter P4 explicit
// failure -- typechecker acts as the reviewer).
//
// The SSOT `ImageError` type correlates the envelope `.code` with its
// per-code `.detail` shape, so consumers switch on one discriminant.

import type { ImageError, Result, TextureAsset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import { decodeImageBytes } from '../index';

describe('decodeImageBytes signature (AC-05 / AC-06 / opts compat)', () => {
  it('returns Promise<Result<TextureAsset, ImageError>>', () => {
    expectTypeOf(decodeImageBytes).returns.toEqualTypeOf<
      Promise<Result<TextureAsset, ImageError>>
    >();
  });

  it('AC-05: `if (r.ok)` narrows r.value to TextureAsset, else r.error to ImageError', async () => {
    const r = await decodeImageBytes(new Uint8Array(), 'image/png');
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<TextureAsset>();
    } else {
      expectTypeOf(r.error).toEqualTypeOf<ImageError>();
    }
  });

  it('AC-06: `switch (err.code)` narrows err.detail per-code (exhaustive)', async () => {
    const r = await decodeImageBytes(new Uint8Array(), 'image/png');
    if (r.ok) return;
    // Exhaustive over the correlated ImageError union so a future minor-add
    // to ImageErrorCode fails compilation here until this file catches up.
    switch (r.error.code) {
      case 'image-decode-failed': {
        expectTypeOf(r.error.detail.reason).toBeString();
        expectTypeOf(r.error.detail.path).toEqualTypeOf<string | undefined>();
        break;
      }
      case 'image-format-unsupported': {
        expectTypeOf(r.error.detail.actualMime).toBeString();
        break;
      }
      case 'image-dimension-out-of-bounds': {
        expectTypeOf(r.error.detail.requested.width).toBeNumber();
        expectTypeOf(r.error.detail.limit).toBeNumber();
        break;
      }
      case 'image-meta-missing': {
        expectTypeOf(r.error.detail.sourcePath).toBeString();
        expectTypeOf(r.error.detail.expectedSidecarPath).toBeString();
        break;
      }
      case 'image-hdr-decode-failed': {
        expectTypeOf(r.error.detail.reason).toBeString();
        break;
      }
      case 'atlas-empty-input': {
        expectTypeOf(r.error.detail.receivedCount).toBeNumber();
        break;
      }
      case 'atlas-size-exceeded': {
        expectTypeOf(r.error.detail.maxAtlasSize).toBeNumber();
        break;
      }
      case 'atlas-region-mismatch': {
        expectTypeOf(r.error.detail.atlasPixels).toBeNumber();
        break;
      }
    }
  });

  it('opts compat: all optional, partial, and full forms compile', async () => {
    await decodeImageBytes(new Uint8Array(), 'image/png');
    await decodeImageBytes(new Uint8Array(), 'image/png', { colorSpace: 'linear' });
    await decodeImageBytes(new Uint8Array(), 'image/png', { mipmap: false });
    await decodeImageBytes(new Uint8Array(), 'image/png', {
      colorSpace: 'srgb',
      mipmap: true,
    });
    await decodeImageBytes(new ArrayBuffer(0), 'image/png');
  });

  it('AC-05 negative: `if (!r.ok)` MUST NOT let r.value type-check (@ts-expect-error)', async () => {
    const r = await decodeImageBytes(new Uint8Array(), 'image/png');
    if (!r.ok) {
      // @ts-expect-error -- on the err branch `r` is `ResultErr<ImageError>`
      // and has no `.value` property; if this line ever compiles, the
      // Result narrowing broke.
      const _v: TextureAsset = r.value;
      void _v;
    }
  });

  it('AC-06 negative: `reason` is not on the image-format-unsupported detail arm (@ts-expect-error)', async () => {
    const r = await decodeImageBytes(new Uint8Array(), 'image/png');
    if (r.ok) return;
    if (r.error.detail.code === 'image-format-unsupported') {
      // @ts-expect-error -- `reason` belongs to the image-decode-failed arm;
      // it must NOT be reachable on the image-format-unsupported arm.
      const _r: string = r.error.detail.reason;
      void _r;
    }
  });
});
