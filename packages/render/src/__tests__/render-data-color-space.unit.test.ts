import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { deriveRenderDataTexture } from '../render-data';

const texture = (format: TextureAsset['format'], colorSpace: 'srgb' | 'linear'): TextureAsset => ({
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
  format,
  data: new Uint8Array(64),
  colorSpace,
  mips: { kind: 'none' },
});

describe('TextureAsset format / colorSpace pairing', () => {
  it('names both sides of a mismatch in the recovery hint', () => {
    for (const [format, colorSpace] of [
      ['rgba8unorm', 'srgb'],
      ['rgba8unorm-srgb', 'linear'],
    ] as const) {
      const result = deriveRenderDataTexture(texture(format, colorSpace));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('invalid-source-format');
      expect(result.error.hint).toContain(`'${format}'`);
      expect(result.error.hint).toContain(`'${colorSpace}'`);
      expect(result.error.hint).not.toContain('.hdr');
    }
  });

  it('admits matching pairs', () => {
    expect(deriveRenderDataTexture(texture('rgba8unorm-srgb', 'srgb')).ok).toBe(true);
    expect(deriveRenderDataTexture(texture('rgba8unorm', 'linear')).ok).toBe(true);
  });
});
