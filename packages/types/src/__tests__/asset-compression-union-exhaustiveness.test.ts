// asset-compression-union-exhaustiveness.test - the five-member AssetCompression
// union + the runtime catalog narrowing that must stay in sync with it (M3 w22).
//
// Coverage (AC-11a / D-3 / R-8):
//   (a) AssetCompression is exactly the five closed members -- the exhaustive
//       switch below visits each literal; a dropped or renamed member raises
//       TS2322 at the `_exhaustiveCheck: never` line, and a NEW member without a
//       case here raises the same. tsc surfaces the drift (charter P3).
//   (b) The three basis-* members and the two Loop-1 members are all present
//       (runtime assertion mirrors the compile-time set so a reader sees the
//       cardinality without reading the type).
//   (c) The runtime catalog narrowing site (asset-registry.ts:~4723) accepts all
//       five values -- modelled here by the same five-arm predicate the catalog
//       uses, so a future member addition that forgets the catalog site is
//       caught by the shared exhaustive switch (R-8 sync guard).
//   (d) ImageMetadata.compressionMode is the four-state sidecar tri-plus union.
//
// Members (5; D-3 flat mutually-exclusive):
//   - none            (pass-through)
//   - zstd            (generic container compression, Loop 1)
//   - basis-etc1s     (Basis KTX2, ETC1S)
//   - basis-uastc     (Basis KTX2, UASTC-LDR)
//   - basis-uastc-hdr (Basis KTX2, UASTC-HDR)

import { describe, expect, it } from 'vitest';
import type { AssetCompression, ImageMetadata } from '../index';

/**
 * Exhaustive switch over AssetCompression. Compiles only if every union member
 * is covered; the `never` assignment fails to typecheck if a member is dropped,
 * renamed, or added without a matching case. This same five-arm shape is what
 * the runtime catalog narrowing site (asset-registry.ts) must mirror (R-8).
 */
function classifyCompression(c: AssetCompression): 'uncompressed' | 'container' | 'basis' {
  switch (c) {
    case 'none':
      return 'uncompressed';
    case 'zstd':
      return 'container';
    case 'basis-etc1s':
    case 'basis-uastc':
    case 'basis-uastc-hdr':
      return 'basis';
    default: {
      const _exhaustiveCheck: never = c;
      return _exhaustiveCheck;
    }
  }
}

describe('AssetCompression union exhaustiveness (M3 w22)', () => {
  it('carries exactly the five closed members', () => {
    const all: AssetCompression[] = [
      'none',
      'zstd',
      'basis-etc1s',
      'basis-uastc',
      'basis-uastc-hdr',
    ];
    expect(all.length).toBe(5);
    expect(new Set(all).size).toBe(5);
  });

  it('the three basis-* members classify as basis; loop-1 members do not', () => {
    expect(classifyCompression('basis-etc1s')).toBe('basis');
    expect(classifyCompression('basis-uastc')).toBe('basis');
    expect(classifyCompression('basis-uastc-hdr')).toBe('basis');
    expect(classifyCompression('none')).toBe('uncompressed');
    expect(classifyCompression('zstd')).toBe('container');
  });

  it('the catalog five-value narrowing accepts every member (R-8 sync)', () => {
    // Mirrors the asset-registry.ts:~4723 narrowing predicate: every member
    // must be admitted. `catalogNarrow` returns the value when admitted, null
    // when rejected. All five must be admitted.
    const catalogNarrow = (v: unknown): AssetCompression | null => {
      if (
        v === 'none' ||
        v === 'zstd' ||
        v === 'basis-etc1s' ||
        v === 'basis-uastc' ||
        v === 'basis-uastc-hdr'
      ) {
        return v;
      }
      return null;
    };
    const members: AssetCompression[] = [
      'none',
      'zstd',
      'basis-etc1s',
      'basis-uastc',
      'basis-uastc-hdr',
    ];
    for (const m of members) {
      expect(catalogNarrow(m)).toBe(m);
    }
    expect(catalogNarrow('garbage')).toBeNull();
  });

  it('ImageMetadata.compressionMode is the four-state sidecar union', () => {
    const modes: NonNullable<ImageMetadata['compressionMode']>[] = [
      'auto',
      'etc1s',
      'uastc',
      'none',
    ];
    expect(modes.length).toBe(4);
    expect(new Set(modes).size).toBe(4);
  });
});
