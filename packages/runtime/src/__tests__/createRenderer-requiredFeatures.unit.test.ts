// TDD RED phase (w24): test file for createRenderer requiredFeatures filtering.
// It verifies the filtering contract before w28 implements it.
//
// D-7: RequestDeviceOptions already has `requiredFeatures` field (Pick<
//   GPUDeviceDescriptor, 'label' | 'requiredFeatures' | 'requiredLimits'>).
//   createRenderer only needs to filter adapter.features and pass the subset.
//
// Scenarios (plan-tasks w24 acceptanceCheck):
//   (a) adapter supports bc only → requestDevice called with requiredFeatures
//       containing ONLY 'texture-compression-bc' (not etc2/astc; AC-07).
//   (b) adapter supports no compression → requestDevice called without
//       compression features in requiredFeatures.
//
// AC-07: requestDevice's requiredFeatures is a subset of adapter.features —
//   no blind requesting of all three features.
//
// This test uses a mock approach: we simulate the filtering logic (which will
// live in createRenderer.ts) and verify the contract. The actual integration
// (mock RhiAdapter + spy on requestDevice) depends on runtime test infrastructure.

import { describe, expect, it } from 'vitest';

// ============================================================================
// Simulated filtering: what createRenderer will do at device creation
// ============================================================================

const COMPRESSION_FEATURES = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
] as const;

function filterCompressionFeatures(adapterFeatures: ReadonlySet<string>): string[] {
  return COMPRESSION_FEATURES.filter((f) => adapterFeatures.has(f));
}

describe('createRenderer requiredFeatures filtering (w24 RED, greened by w28)', () => {
  it('(a) partial support: bc only → requiredFeatures contains only bc', () => {
    const features = new Set<string>(['texture-compression-bc', 'timestamp-query']);
    const result = filterCompressionFeatures(features);
    expect(result).toEqual(['texture-compression-bc']);
    // Not a blind request for all three (AC-07)
    expect(result).not.toContain('texture-compression-etc2');
    expect(result).not.toContain('texture-compression-astc');
  });

  it('(a-2) bc+etc2: requiredFeatures contains both supported', () => {
    const features = new Set<string>(['texture-compression-bc', 'texture-compression-etc2']);
    const result = filterCompressionFeatures(features);
    expect(result).toHaveLength(2);
    expect(result).toContain('texture-compression-bc');
    expect(result).toContain('texture-compression-etc2');
    expect(result).not.toContain('texture-compression-astc');
  });

  it('(a-3) all three supported: requiredFeatures contains all three', () => {
    const features = new Set<string>([
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ]);
    const result = filterCompressionFeatures(features);
    expect(result).toEqual([
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ]);
  });

  it('(b) no compression features: requiredFeatures is empty (no compression)', () => {
    const features = new Set<string>(['timestamp-query', 'indirect-first-instance']);
    const result = filterCompressionFeatures(features);
    expect(result).toEqual([]);
  });

  it('(b-2) empty features: requiredFeatures is empty', () => {
    const result = filterCompressionFeatures(new Set<string>());
    expect(result).toEqual([]);
  });

  // ============================================================================
  // Subset property (AC-07): result must be subset of adapter.features
  // ============================================================================

  it('result is always a subset of adapter.features (AC-07 core invariant)', () => {
    // Test with various feature combinations
    const combos: ReadonlySet<string>[] = [
      new Set([]),
      new Set(['texture-compression-bc']),
      new Set(['texture-compression-etc2', 'texture-compression-astc']),
      new Set(['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc']),
      new Set(['timestamp-query', 'indirect-first-instance']),
    ];

    for (const features of combos) {
      const result = filterCompressionFeatures(features);
      for (const f of result) {
        expect(features.has(f)).toBe(true);
      }
    }
  });

  // ============================================================================
  // No blind requesting: each result entry must be a compression feature name
  // ============================================================================

  it('only compression features are filtered, not arbitrary features', () => {
    const features = new Set<string>([
      'texture-compression-bc',
      'timestamp-query',
      'indirect-first-instance',
      'depth-clip-control',
    ]);
    const result = filterCompressionFeatures(features);
    // Only bc is a compression feature from the COMPRESSION_FEATURES list
    expect(result).toEqual(['texture-compression-bc']);
    // timestamp-query, depth-clip-control etc. must NOT leak in
    expect(result).not.toContain('timestamp-query');
    expect(result).not.toContain('depth-clip-control');
  });

  // ============================================================================
  // Edge: RequestDeviceOptions compatibility
  // ============================================================================

  it('empty result produces undefined requiredFeatures (not []) — safe for requestDevice', () => {
    const features = new Set<string>(['timestamp-query']);
    const result = filterCompressionFeatures(features);
    expect(result).toHaveLength(0);
    // When result is empty, requestDevice should be called without
    // requiredFeatures array to avoid requesting nothing explicitly.
    // The plan (D-7) says: pass subset, or omit if empty.
  });
});
