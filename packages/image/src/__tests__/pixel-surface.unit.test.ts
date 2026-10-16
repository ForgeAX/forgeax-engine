import { describe, expect, it } from 'vitest';
import { createPixelSurface, toAssetPack } from '../index.js';

const META = {
  guid: '01928000-7c00-7000-8000-000000000099',
  colorSpace: 'srgb' as const,
  mipmap: 'none' as const,
  addressMode: 'repeat' as const,
  filterMode: 'nearest' as const,
};

function surface(width = 4, height = 3) {
  const result = createPixelSurface({ width, height, colorSpace: 'srgb', mipmap: false });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('PixelSurface', () => {
  it('rejects malformed dimensions and channel/seed values through ImageError', () => {
    const badDimension = createPixelSurface({ width: 0, height: 2 });
    expect(badDimension.ok).toBe(false);
    if (!badDimension.ok) {
      expect(badDimension.error.code).toBe('image-surface-invalid');
      if (badDimension.error.code === 'image-surface-invalid') {
        expect(badDimension.error.detail.expected).toContain('positive integer');
        expect(badDimension.error.detail.code).toBe('image-surface-invalid');
      }
    }

    const candidate = surface();
    const badColor = candidate.setPixel(0, 0, [0, 0, 256, 255]);
    expect(badColor.ok).toBe(false);
    if (!badColor.ok && badColor.error.code === 'image-surface-invalid') {
      expect(badColor.error.detail.operation).toBe('set-pixel');
    }

    const badSeed = candidate.fillNoise(Number.NaN);
    expect(badSeed.ok).toBe(false);
    if (!badSeed.ok && badSeed.error.code === 'image-surface-invalid') {
      expect(badSeed.error.detail.operation).toBe('noise');
    }
  });

  it('rounds coordinates, clips writes, and keeps exact RGBA8 channel order', () => {
    const candidate = surface();
    expect(candidate.setPixel(1.4, 1.6, [10, 20, 30, 40]).ok).toBe(true);
    expect(candidate.data.slice((2 * 4 + 1) * 4, (2 * 4 + 2) * 4)).toEqual(
      Uint8Array.of(10, 20, 30, 40),
    );
    expect(candidate.fillRect(-1.2, -1.2, 3.1, 3.1, [1, 2, 3, 4]).ok).toBe(true);
    expect(candidate.data.slice(0, 4)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(candidate.fillCircle(3, 2, 1, { r: 9, g: 8, b: 7, a: 6 }).ok).toBe(true);
    expect(candidate.data.slice((2 * 4 + 3) * 4, (2 * 4 + 4) * 4)).toEqual(
      Uint8Array.of(9, 8, 7, 6),
    );
  });

  it('snapshots overlapping blits before writing', () => {
    const candidate = surface(4, 1);
    for (let x = 0; x < 4; x += 1) {
      expect(candidate.setPixel(x, 0, [x + 1, 0, 0, 255]).ok).toBe(true);
    }
    expect(candidate.blit(candidate, 1, 0, { x: 0, y: 0, width: 3, height: 1 }).ok).toBe(true);
    expect(Array.from(candidate.data.filter((_value, index) => index % 4 === 0))).toEqual([
      1, 1, 2, 3,
    ]);
  });

  it('produces byte-identical seeded noise and a regular TextureAsset/Pack carrier', () => {
    const first = surface();
    const second = surface();
    expect(first.fillNoise(42, { min: 10, max: 200, alpha: 123 }).ok).toBe(true);
    expect(second.noise(42, { min: 10, max: 200, alpha: 123 }).ok).toBe(true);
    expect(first.data).toEqual(second.data);
    expect(first.toTextureAsset()).toMatchObject({
      kind: 'texture',
      shape: {
        viewDimension: '2d',
        extent: { width: 4, height: 3 },
      },
      format: 'rgba8unorm-srgb',
      colorSpace: 'srgb',
      mips: { kind: 'none' },
    });
    const decoded = first.toDecodedImage();
    const pack = toAssetPack(META);
    expect(pack.subAssets).toEqual([{ guid: META.guid, sourceIndex: 0, kind: 'texture' }]);
    expect(pack.importSettings.mipmap).toBe('none');
    const changed = decoded.bytes.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(changed).not.toEqual(decoded.bytes);
  });
});
