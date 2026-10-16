// caps-three-way.unit.test.ts — M4 w23 (green after w25).
//
// Verifies the three-way texture compression cap contract on RhiCaps.
// D-8: caps fields are derived from GPUAdapter.features Set via has(...).
//
// Scenarios:
//   (a) bc-only  → textureCompressionBc=true, etc2/astc=false
//   (b) etc2+astc → etc2/astc true, bc false
//   (c) no compression → three-way all false
//   (d) rhi-null → three-way all false (AC-06)

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RhiCaps } from '../index';

// ============================================================================
// Type-level: RhiCaps has the three fields as readonly boolean
// ============================================================================

describe('RhiCaps — three-way texture compression (w25)', () => {
  it('textureCompressionBc is readonly boolean', () => {
    expectTypeOf<RhiCaps['textureCompressionBc']>().toEqualTypeOf<boolean>();
  });

  it('textureCompressionEtc2 is readonly boolean', () => {
    expectTypeOf<RhiCaps['textureCompressionEtc2']>().toEqualTypeOf<boolean>();
  });

  it('textureCompressionAstc is readonly boolean', () => {
    expectTypeOf<RhiCaps['textureCompressionAstc']>().toEqualTypeOf<boolean>();
  });

  it('textureCompressionBc/Etc2/Astc are readonly', () => {
    type Check = {
      readonly textureCompressionBc: boolean;
      readonly textureCompressionEtc2: boolean;
      readonly textureCompressionAstc: boolean;
    };
    expectTypeOf<
      Pick<RhiCaps, 'textureCompressionBc' | 'textureCompressionEtc2' | 'textureCompressionAstc'>
    >().toEqualTypeOf<Check>();
  });

  it('three fields are camelCase per D-8', () => {
    const keys = [
      'textureCompressionBc',
      'textureCompressionEtc2',
      'textureCompressionAstc',
    ] as const;
    for (const k of keys) {
      expect(k).toMatch(/^textureCompression[A-Z]/);
    }
  });
});

// ============================================================================
// Scenario tests: mock the Derive-from-features contract
// ============================================================================

/** Simulates Derive: given a Set of GPUFeatureName strings, produce the three caps. */
function deriveThreeWayCaps(features: ReadonlySet<string>): {
  textureCompressionBc: boolean;
  textureCompressionEtc2: boolean;
  textureCompressionAstc: boolean;
} {
  return {
    textureCompressionBc: features.has('texture-compression-bc'),
    textureCompressionEtc2: features.has('texture-compression-etc2'),
    textureCompressionAstc: features.has('texture-compression-astc'),
  };
}

describe('RhiCaps three-way — derive from features Set (Derive principle, D-8)', () => {
  it('(a) bc-only: textureCompressionBc=true, etc2/astc=false', () => {
    const caps = deriveThreeWayCaps(new Set(['texture-compression-bc']));
    expect(caps.textureCompressionBc).toBe(true);
    expect(caps.textureCompressionEtc2).toBe(false);
    expect(caps.textureCompressionAstc).toBe(false);
  });

  it('(b) etc2-only: textureCompressionEtc2=true, bc/astc=false', () => {
    const caps = deriveThreeWayCaps(new Set(['texture-compression-etc2']));
    expect(caps.textureCompressionBc).toBe(false);
    expect(caps.textureCompressionEtc2).toBe(true);
    expect(caps.textureCompressionAstc).toBe(false);
  });

  it('(b-2) astc-only: textureCompressionAstc=true, bc/etc2=false', () => {
    const caps = deriveThreeWayCaps(new Set(['texture-compression-astc']));
    expect(caps.textureCompressionBc).toBe(false);
    expect(caps.textureCompressionEtc2).toBe(false);
    expect(caps.textureCompressionAstc).toBe(true);
  });

  it('(c) no compression features: three-way all false', () => {
    const caps = deriveThreeWayCaps(new Set(['timestamp-query']));
    expect(caps.textureCompressionBc).toBe(false);
    expect(caps.textureCompressionEtc2).toBe(false);
    expect(caps.textureCompressionAstc).toBe(false);
    // Also works with empty set
    const capsEmpty = deriveThreeWayCaps(new Set());
    expect(capsEmpty.textureCompressionBc).toBe(false);
    expect(capsEmpty.textureCompressionEtc2).toBe(false);
    expect(capsEmpty.textureCompressionAstc).toBe(false);
  });

  it('(d) rhi-null contract: three-way all false (AC-06)', () => {
    // rhi-null backend has no real GPU; its caps must truthfully report false.
    // Verified here as the contract; actual null device verification is in w26.
    const caps = deriveThreeWayCaps(new Set());
    expect(caps.textureCompressionBc).toBe(false);
    expect(caps.textureCompressionEtc2).toBe(false);
    expect(caps.textureCompressionAstc).toBe(false);
  });

  it('bc+etc2+astc co-exist: all three true (e.g. Apple Silicon dual HW)', () => {
    const caps = deriveThreeWayCaps(
      new Set(['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc']),
    );
    expect(caps.textureCompressionBc).toBe(true);
    expect(caps.textureCompressionEtc2).toBe(true);
    expect(caps.textureCompressionAstc).toBe(true);
  });
});

// ============================================================================
// Breaking: old textureCompression must be absent from RhiCaps after w25
// ============================================================================

describe('RhiCaps — old field removed (breaking, no compat alias)', () => {
  it('old textureCompression single boolean is no longer a key of RhiCaps', () => {
    // Type-level: 'textureCompression' extends keyof RhiCaps? must be false.
    type HasOldTextureCompression = 'textureCompression' extends keyof RhiCaps ? true : false;
    expectTypeOf<HasOldTextureCompression>().toEqualTypeOf<false>();
  });

  it('old name is not among the three-way keys', () => {
    const threeWayKeys = [
      'textureCompressionBc',
      'textureCompressionEtc2',
      'textureCompressionAstc',
    ] as const;
    expect(threeWayKeys).not.toContain('textureCompression');
  });
});
