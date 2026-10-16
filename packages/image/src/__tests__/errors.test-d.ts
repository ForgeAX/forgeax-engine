import type {
  DecodedImage,
  ImageError,
  ImageErrorCode,
  ImageErrorDetail,
  ImageErrorDetailFor,
  ImageErrorFor,
  ImageMeta,
} from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

// Type-only tests. Verify the 9-member ImageErrorCode closed union compiles
// an exhaustive switch without a default arm (charter P4 explicit failure).
// Verifies the discriminated ImageErrorDetail narrowing per .code (charter
// P3 machine-readable union > prose; AGENTS.md Error model row pattern).
//
// feat-20260521-sprite-atlas-animation M1 T-03 update: union grew from 5 to
// 8 with the atlas-* triplet (atlas-empty-input / atlas-size-exceeded /
// atlas-region-mismatch); the 9th arm is the image-owned PixelSurface
// authoring error. The exact-member assertion + exhaustive switch
// arms below mirror the SSOT in @forgeax/engine-types ImageErrorCode +
// ImageErrorDetail so a future minor add still fails this file at compile
// time until the new arm + .expected + .hint rows are supplied.

describe('ImageErrorCode + ImageErrorDetail closed union compile contract', () => {
  it('ImageErrorCode is the exact 9-member union literal set', () => {
    expectTypeOf<ImageErrorCode>().toEqualTypeOf<
      | 'image-decode-failed'
      | 'image-format-unsupported'
      | 'image-dimension-out-of-bounds'
      | 'image-meta-missing'
      | 'image-hdr-decode-failed'
      | 'atlas-empty-input'
      | 'atlas-size-exceeded'
      | 'atlas-region-mismatch'
      | 'image-surface-invalid'
    >();
  });

  it('exhaustive switch on err.code compiles with no default arm (charter P4)', () => {
    function recover(code: ImageErrorCode): string {
      switch (code) {
        case 'image-decode-failed':
          return 'check file integrity / re-export from DCC tool';
        case 'image-format-unsupported':
          return 'convert to PNG or JPG';
        case 'image-dimension-out-of-bounds':
          return 'downscale source under device caps maxDimension';
        case 'image-meta-missing':
          return 'run forgeax asset import <path> --root <project>';
        case 'image-hdr-decode-failed':
          return 'verify Radiance RGBE header and FORMAT=32-bit_rle_rgbe field';
        case 'atlas-empty-input':
          return 'verify forgeax asset atlas --input glob matches at least 1 PNG';
        case 'atlas-size-exceeded':
          return 'downscale source or split atlas under maxAtlasSize cap';
        case 'atlas-region-mismatch':
          return 'shelfPack regions exceed atlas footprint -- packer safety net';
        case 'image-surface-invalid':
          return 'repair PixelSurface authoring input';
      }
    }
    expectTypeOf(recover).toBeFunction();
  });

  it('ImageErrorDetail narrows per .code via discriminated union pattern', () => {
    function describe_(detail: ImageErrorDetail): string {
      switch (detail.code) {
        case 'image-decode-failed':
          return detail.reason;
        case 'image-format-unsupported':
          return detail.actualMime;
        case 'image-dimension-out-of-bounds':
          return `${detail.requested.width}x${detail.requested.height} > ${detail.limit}`;
        case 'image-meta-missing':
          return `${detail.sourcePath} -> ${detail.expectedSidecarPath}`;
        case 'image-hdr-decode-failed':
          return detail.reason;
        case 'atlas-empty-input':
          return `atlas-empty:${detail.receivedCount}`;
        case 'atlas-size-exceeded':
          return `atlas-size:${detail.name}:${detail.width}x${detail.height}>${detail.maxAtlasSize}`;
        case 'atlas-region-mismatch':
          return `atlas-region:${detail.name}:${detail.regionsTotalPixels}>${detail.atlasPixels}`;
        case 'image-surface-invalid':
          return `surface:${detail.operation}:${detail.field}`;
      }
    }
    expectTypeOf(describe_).toBeFunction();
  });

  it('ImageError correlates envelope code and detail shape', () => {
    function describeError(error: ImageError): string {
      switch (error.code) {
        case 'image-decode-failed':
          return error.detail.reason;
        case 'image-format-unsupported':
          return error.detail.actualMime;
        case 'image-dimension-out-of-bounds':
          return `${error.detail.requested.width} > ${error.detail.limit}`;
        case 'image-meta-missing':
          return error.detail.expectedSidecarPath;
        case 'image-hdr-decode-failed':
          return error.detail.reason;
        case 'atlas-empty-input':
          return `${error.detail.receivedCount}`;
        case 'atlas-size-exceeded':
          return `${error.detail.name}:${error.detail.maxAtlasSize}`;
        case 'atlas-region-mismatch':
          return `${error.detail.name}:${error.detail.atlasPixels}`;
        case 'image-surface-invalid':
          return `${error.detail.operation}:${error.detail.field}`;
      }
    }

    expectTypeOf(describeError).toBeFunction();
    expectTypeOf<ImageErrorDetailFor<'image-decode-failed'>>().toMatchTypeOf<{
      code: 'image-decode-failed';
      reason: string;
    }>();
    expectTypeOf<ImageErrorFor<'image-format-unsupported'>>().toMatchTypeOf<{
      code: 'image-format-unsupported';
      detail: { actualMime: string };
    }>();
  });

  it('ImageMeta POD has the 5 free-form fields (guid + 4 importer settings)', () => {
    expectTypeOf<ImageMeta>().toMatchTypeOf<{
      guid: string;
      colorSpace: 'srgb' | 'linear';
      mipmap: 'auto' | 'none';
      addressMode: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
      filterMode: 'nearest' | 'linear';
    }>();
  });

  it('DecodedImage POD has the 6 fields (bytes + dims + mime + colorSpace + mipmap)', () => {
    expectTypeOf<DecodedImage>().toMatchTypeOf<{
      bytes: Uint8Array;
      width: number;
      height: number;
      mime: 'image/jpeg' | 'image/png' | 'image/x-tga';
      colorSpace: 'srgb' | 'linear';
      mipmap: boolean;
    }>();
  });

  it('ImageError 4-field surface (.code / .expected / .hint / .detail) parallels RhiError shape', () => {
    expectTypeOf<ImageError>().toMatchTypeOf<{
      code: ImageErrorCode;
      expected: string;
      hint: string;
      detail: ImageErrorDetail;
    }>();
  });
});
