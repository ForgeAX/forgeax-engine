// Logical asset extent to physical GPU storage extent. Per-mip upload layout
// is owned by the types texture contract (`deriveTextureLayout`).

import { describe, expect, it } from 'vitest';
import { deriveTextureExtent } from '../../../render/src/render-data';

describe('deriveTextureExtent -- logical asset extent to physical storage extent (w35)', () => {
  it('derives BC7 physical storage and a logical UV scale without changing logical metadata', () => {
    expect(deriveTextureExtent('bc7-rgba-unorm', 2085, 1573)).toEqual({
      logicalExtent: { width: 2085, height: 1573 },
      physicalExtent: { width: 2088, height: 1576 },
      uvScale: [2085 / 2088, 1573 / 1576],
    });
  });

  it('derives each 4x4 tail mip independently', () => {
    expect(deriveTextureExtent('bc7-rgba-unorm', 2, 1)).toEqual({
      logicalExtent: { width: 2, height: 1 },
      physicalExtent: { width: 4, height: 4 },
      uvScale: [0.5, 0.25],
    });
  });

  it('uses the texture format block for a non-4x4 format', () => {
    expect(deriveTextureExtent('astc-6x6-unorm', 7, 8)).toEqual({
      logicalExtent: { width: 7, height: 8 },
      physicalExtent: { width: 12, height: 12 },
      uvScale: [7 / 12, 8 / 12],
    });
  });

  it('keeps uncompressed textures at identity extent and scale', () => {
    expect(deriveTextureExtent('rgba8unorm', 17, 9)).toEqual({
      logicalExtent: { width: 17, height: 9 },
      physicalExtent: { width: 17, height: 9 },
      uvScale: [1, 1],
    });
  });
});
