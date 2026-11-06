import type { TextureAsset } from '@forgeax/engine/types';
import { describe, expect, it } from 'vitest';
import { CONVOY_SURFACE_IDS } from '../convoy-surfaces.ts';
import { convoyHardwareTextures, finishConvoyTextures } from '../convoy-finish.ts';

const texture = (values: readonly number[]): TextureAsset => ({
  kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear',
  shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
  data: new Uint8Array([...values, ...values]), mips: { kind: 'none' },
});
const id = (family: keyof typeof CONVOY_SURFACE_IDS) => [...CONVOY_SURFACE_IDS[family].map(value => value * 255), 255];
const flat = (pixel: readonly number[]) => texture(Array.from({ length: 8 }, () => pixel).flat());

describe('Convoy surface finish', () => {
  it('keeps enamel and glass coated, with dry metal, rubber and emissive lamps', () => {
    const maps = Object.fromEntries(['normal', 'ao', 'ormh', 'baseColor', 'emissive', 'height', 'curvature', 'edgeWear', 'position', 'cavity', 'materialId'].map(name => [name, flat([0, 0, 0, 255])]));
    maps.baseColor = texture([
      204, 14, 11, 255, 14, 61, 160, 255, 204, 217, 230, 255, 7, 8, 10, 255,
      14, 69, 97, 255, 20, 140, 204, 255, 255, 102, 10, 255, 209, 125, 41, 255,
    ]);
    maps.ormh = texture([0.22, 0.24, 0.18, 0.86, 0.06, 0.2, 0.3, 0.35].flatMap((rough, i) => [255, Math.round(rough * 255), i === 2 || i === 7 ? 255 : 0, 128]));
    maps.emissive = texture(Array.from({ length: 8 }, (_, i) => i === 5 ? [20, 166, 255, 255] : i === 6 ? [255, 71, 4, 255] : [0, 0, 0, 255]).flat());
    maps.normal = flat([128, 128, 255, 255]);
    maps.materialId = texture((['painted', 'painted', 'metal', 'rubber', 'glass', 'other', 'other', 'metal'] as const).flatMap(id));
    const result = finishConvoyTextures(maps);
    expect(Object.keys(result).sort()).toEqual(['baseColor', 'coat', 'emissive', 'normal', 'ormh']);
    const coat = result.coat!.data as Uint8Array;
    expect([0, 1].map(i => coat[i * 4])).toEqual([255, 255]);
    expect(coat[4 * 4]).toBe(191);
    for (const i of [2, 3, 5, 6, 7]) expect(coat[i * 4]).toBe(0);
    expect(result.coat!.mips).toEqual({ kind: 'packed', levelCount: 3 });
    const recolored = finishConvoyTextures({ ...maps, baseColor: flat([128, 128, 128, 255]) });
    expect(recolored.coat!.data).toEqual(result.coat!.data);
  });

  it('keeps an antiparallel baked normal normalized when adding microfinish', () => {
    const maps = Object.fromEntries(['normal', 'ao', 'ormh', 'baseColor', 'emissive', 'height', 'curvature', 'edgeWear', 'position', 'cavity', 'materialId'].map(name => [name, flat([0, 0, 0, 255])]));
    maps.baseColor = flat([204, 14, 11, 255]);
    maps.ormh = flat([255, 64, 0, 128]);
    maps.normal = flat([128, 128, 0, 255]);
    maps.materialId = flat(id('painted'));
    const bytes = finishConvoyTextures(maps).normal!.data as Uint8Array;
    for (let i = 0; i < 32; i += 4) {
      expect(Math.abs(Math.hypot(bytes[i]! / 127.5 - 1, bytes[i + 1]! / 127.5 - 1, bytes[i + 2]! / 127.5 - 1) - 1)).toBeLessThan(0.012);
      expect(bytes[i + 2]).toBeLessThan(5);
    }
  });

  it('ships different brushed and rubber normals with complete normalized mip chains', () => {
    const maps = convoyHardwareTextures();
    const brushed = maps['texture/convoy-brushed-normal']!, rubber = maps['texture/convoy-rubber-normal']!;
    expect(brushed.data).not.toEqual(rubber.data);
    for (const map of [brushed, rubber]) {
      expect(map.mips).toEqual({ kind: 'packed', levelCount: 9 });
      expect(map.data.length).toBe(349524);
      const bytes = map.data as Uint8Array;
      for (let i = 0; i < bytes.length; i += 4) {
        const length = Math.hypot(bytes[i]! / 127.5 - 1, bytes[i + 1]! / 127.5 - 1, bytes[i + 2]! / 127.5 - 1);
        expect(Math.abs(length - 1)).toBeLessThan(0.012);
      }
    }
  });
});
