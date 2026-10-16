// feat-20260521-sprite-atlas-animation / M1 / T-01.
//
// TDD red phase: ImageErrorCode +3 atlas-* members + ImageErrorDetail +3
// discriminated variants are not yet in @forgeax/engine-types — these
// type-level assertions stay red until T-02 lands the union extension
// (plan-strategy section 2 D-2 / requirements section AC-10).
//
// The atlas-* family is the build-time fail-fast SSOT for the
// vite-plugin-image atlas hook (M5 T-32 producer); add-only minor
// evolution per AGENTS.md section Error model evolution contract
// (research F-7 candidate B). Reused ImageErrorImpl class + IMAGE_ERROR_*
// SSOT tables stay the SSOT for the 4-field surface (.code / .expected /
// .hint / .detail) AI users consume.
//
// Per-code detail shape (1:1 with requirements section AC-10 a / b / c):
//   - 'atlas-empty-input'   -> { receivedCount: number }
//   - 'atlas-size-exceeded' -> { name, width, height, maxAtlasSize }
//   - 'atlas-region-mismatch' -> { name, regionsTotalPixels, atlasPixels }
//
// Anchors: plan-strategy section 2 D-2 + section 3.1 PT block
//          (ImageErrorCode +3 / ImageErrorDetail +3) + section 4 risk
//          R-ERR-2 reaction; requirements section AC-10 (a/b/c) four-field
//          structured fail-fast surface; research F-7 candidate B (add-only
//          minor, reuse ImageErrorImpl + IMAGE_ERROR_HINTS SSOT); charter
//          P3 explicit failure (.code switch + property access on .detail).

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ImageErrorCode, ImageErrorDetail } from '../index';

describe('ImageErrorCode +3 atlas-* union members [feat-20260521 / M1 T-01]', () => {
  it("'atlas-empty-input' is assignable to ImageErrorCode", () => {
    const code: ImageErrorCode = 'atlas-empty-input';
    expect(code).toBe('atlas-empty-input');
    expectTypeOf<'atlas-empty-input'>().toMatchTypeOf<ImageErrorCode>();
  });

  it("'atlas-size-exceeded' is assignable to ImageErrorCode", () => {
    const code: ImageErrorCode = 'atlas-size-exceeded';
    expect(code).toBe('atlas-size-exceeded');
    expectTypeOf<'atlas-size-exceeded'>().toMatchTypeOf<ImageErrorCode>();
  });

  it("'atlas-region-mismatch' is assignable to ImageErrorCode", () => {
    const code: ImageErrorCode = 'atlas-region-mismatch';
    expect(code).toBe('atlas-region-mismatch');
    expectTypeOf<'atlas-region-mismatch'>().toMatchTypeOf<ImageErrorCode>();
  });
});

describe('ImageErrorDetail +3 discriminated variants [AC-10 a/b/c]', () => {
  it("'atlas-empty-input' detail carries receivedCount: number", () => {
    const detail: ImageErrorDetail = {
      code: 'atlas-empty-input',
      receivedCount: 0,
    };
    if (detail.code === 'atlas-empty-input') {
      expectTypeOf(detail.receivedCount).toEqualTypeOf<number>();
    }
    expect(detail.code).toBe('atlas-empty-input');
  });

  it("'atlas-size-exceeded' detail carries name / width / height / maxAtlasSize", () => {
    const detail: ImageErrorDetail = {
      code: 'atlas-size-exceeded',
      name: 'walk',
      width: 5000,
      height: 5000,
      maxAtlasSize: 4096,
    };
    if (detail.code === 'atlas-size-exceeded') {
      expectTypeOf(detail.name).toEqualTypeOf<string>();
      expectTypeOf(detail.width).toEqualTypeOf<number>();
      expectTypeOf(detail.height).toEqualTypeOf<number>();
      expectTypeOf(detail.maxAtlasSize).toEqualTypeOf<number>();
    }
    expect(detail.code).toBe('atlas-size-exceeded');
  });

  it("'atlas-region-mismatch' detail carries name / regionsTotalPixels / atlasPixels", () => {
    const detail: ImageErrorDetail = {
      code: 'atlas-region-mismatch',
      name: 'walk',
      regionsTotalPixels: 1048577,
      atlasPixels: 1048576,
    };
    if (detail.code === 'atlas-region-mismatch') {
      expectTypeOf(detail.name).toEqualTypeOf<string>();
      expectTypeOf(detail.regionsTotalPixels).toEqualTypeOf<number>();
      expectTypeOf(detail.atlasPixels).toEqualTypeOf<number>();
    }
    expect(detail.code).toBe('atlas-region-mismatch');
  });
});

describe('ImageErrorDetail exhaustive switch narrows the new atlas-* variants', () => {
  it('switch (detail.code) reaches each atlas-* branch with the right field shape', () => {
    function describeAtlasDetail(detail: ImageErrorDetail): string {
      switch (detail.code) {
        case 'image-decode-failed':
          return `decode:${detail.reason}`;
        case 'image-format-unsupported':
          return `mime:${detail.actualMime}`;
        case 'image-dimension-out-of-bounds':
          return `dim:${detail.requested.width}x${detail.requested.height}`;
        case 'image-meta-missing':
          return `meta:${detail.sourcePath}`;
        case 'image-hdr-decode-failed':
          return `hdr:${detail.reason}`;
        case 'atlas-empty-input':
          // AI users branch on .detail.receivedCount to surface the glob.
          expectTypeOf(detail.receivedCount).toEqualTypeOf<number>();
          return `atlas-empty:${detail.receivedCount}`;
        case 'atlas-size-exceeded':
          // AI users branch on .detail.maxAtlasSize to decide partitioning.
          expectTypeOf(detail.name).toEqualTypeOf<string>();
          expectTypeOf(detail.maxAtlasSize).toEqualTypeOf<number>();
          return `atlas-size:${detail.name}:${detail.width}x${detail.height}>${detail.maxAtlasSize}`;
        case 'atlas-region-mismatch':
          expectTypeOf(detail.regionsTotalPixels).toEqualTypeOf<number>();
          expectTypeOf(detail.atlasPixels).toEqualTypeOf<number>();
          return `atlas-region:${detail.name}:${detail.regionsTotalPixels}>${detail.atlasPixels}`;
        case 'image-surface-invalid':
          expectTypeOf(detail.operation).toEqualTypeOf<
            'create' | 'set-pixel' | 'fill-rect' | 'fill-circle' | 'blit' | 'noise' | 'to-asset'
          >();
          return `surface:${detail.operation}:${detail.field}`;
        default: {
          const _exhaustive: never = detail;
          throw new Error(`unreachable: ${String(_exhaustive)}`);
        }
      }
    }

    expect(describeAtlasDetail({ code: 'atlas-empty-input', receivedCount: 0 })).toBe(
      'atlas-empty:0',
    );
    expect(
      describeAtlasDetail({
        code: 'atlas-size-exceeded',
        name: 'walk',
        width: 5000,
        height: 5000,
        maxAtlasSize: 4096,
      }),
    ).toBe('atlas-size:walk:5000x5000>4096');
    expect(
      describeAtlasDetail({
        code: 'atlas-region-mismatch',
        name: 'walk',
        regionsTotalPixels: 1048577,
        atlasPixels: 1048576,
      }),
    ).toBe('atlas-region:walk:1048577>1048576');
  });
});
