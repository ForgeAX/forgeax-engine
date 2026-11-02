import { Materials } from '@forgeax/engine-render';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { proceduralMaterials, type TextureSink } from '../materials';
import { region2d } from '../region2d';
import { TEXT_CHARACTERS, textRegion, textStrokes } from '../text';
import { coverage, decalTexture, hash2, textureFrom, valueNoise } from '../texture';

function sink(): { textures: Map<string, TextureAsset>; texture: TextureSink } {
  const textures = new Map<string, TextureAsset>();
  return {
    textures,
    texture: (key, asset) => {
      textures.set(key, asset);
      return `texture:${key}`;
    },
  };
}

describe('procedural textures', () => {
  it('encodes sRGB within one level and declares mips', () => {
    const ramp = textureFrom(256, 1, (x) => [x / 255, x / 255, x / 255, 1], { colorSpace: 'srgb' });
    if (!ramp.ok) throw ramp.error;
    expect(ramp.value.format).toBe('rgba8unorm-srgb');
    expect(ramp.value.mips).toEqual({ kind: 'packed', levelCount: 9 });
    expect(ramp.value.data.length).toBe(4 * (256 + 128 + 64 + 32 + 16 + 8 + 4 + 2 + 1));
    for (let x = 0; x < 256; x++) {
      const v = x / 255;
      const exact = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      expect(Math.abs((ramp.value.data[x * 4] as number) - exact * 255)).toBeLessThanOrEqual(0.51);
    }
    expect(textureFrom(0, 4, () => [0, 0, 0, 1]).ok).toBe(false);
  });

  it('hashes deterministically and tiles noise seamlessly', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    expect(hash2(3, 4, 5)).not.toBe(hash2(4, 3, 5));
    for (const v of [0, 0.3, 0.71]) {
      expect(valueNoise(0, v, 8, 1)).toBeCloseTo(valueNoise(1, v, 8, 1), 12);
      expect(valueNoise(v, 0, 8, 1)).toBeCloseTo(valueNoise(v, 1, 8, 1), 12);
    }
  });

  it('rasterizes region coverage with anti-aliased edges and composites decal layers', () => {
    const square = [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
    ] as const;
    const cover = coverage([...square], 16, 16, [0, 0, 1, 1]);
    expect(cover.reduce((a, b) => a + b, 0)).toBeCloseTo(64, 6);
    const half = coverage(
      [
        [0.3, 0.3],
        [0.7, 0.3],
        [0.7, 0.7],
        [0.3, 0.7],
      ],
      10,
      10,
      [0, 0, 1, 1],
    );
    expect(half[3 * 10 + 3]).toBeCloseTo(1, 6);
    expect(half[2 * 10 + 2]).toBe(0);
    const sheet = decalTexture({
      width: 16,
      height: 16,
      background: [1, 0, 0, 1],
      layers: [{ region: [...square], color: [1, 1, 1, 1] }],
      colorSpace: 'linear',
    });
    if (!sheet.ok) throw sheet.error;
    const px = (x: number, y: number) => [
      ...sheet.value.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4),
    ];
    expect(px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(8, 8)).toEqual([255, 255, 255, 255]);
  });
});

describe('stroke text', () => {
  it('lays out every supported character and rejects others', () => {
    const all = textStrokes(TEXT_CHARACTERS, { height: 6 });
    if (!all.ok) throw all.error;
    expect(all.value.length).toBeGreaterThan(TEXT_CHARACTERS.length);
    const bad = textStrokes('a~');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('model-invalid-argument');
      expect(bad.error.detail?.character).toBe('~');
    }
  });

  it('builds filled outlines with holes for closed letters, centered on request', () => {
    const o = textRegion('O8', { height: 1, weight: 0.15, align: 'center' });
    if (!o.ok) throw o.error;
    const holes = o.value.region.reduce((n, s) => n + (s.holes?.length ?? 0), 0);
    expect(holes).toBe(3);
    const b = region2d.bounds(o.value.region);
    expect(b?.[0]).toBeCloseTo(-(1 + 4 / 6) / 2 - 0.075, 2);
    expect(b?.[3]).toBeCloseTo(1.075, 2);
    expect(region2d.area(o.value.region)).toBeGreaterThan(0.2);
    const moved = region2d.transform(o.value.region, { scale: [-1, 1], translate: [2, 0] });
    expect(region2d.area(moved)).toBeCloseTo(region2d.area(o.value.region), 9);
  });
});

describe('procedural materials', () => {
  it('produce Standard options that Materials.standard accepts, with generated textures', () => {
    const s = sink();
    const recipes = [
      proceduralMaterials.carPaint({ color: '#9c1418', texture: s.texture }),
      proceduralMaterials.carbonFiber({ texture: s.texture }),
      proceduralMaterials.metal({ finish: 'chrome' }),
      proceduralMaterials.metal({ finish: 'brushed', texture: s.texture, direction: 90 }),
      proceduralMaterials.tire({ texture: s.texture, pattern: 'chevron' }),
      proceduralMaterials.emissive({
        color: [1, 0.2, 0.05],
        segments: { count: 12, gap: 0.3, texture: s.texture },
      }),
    ];
    for (const r of recipes) {
      if (!r.ok) throw r.error;
      const material = Materials.standard(r.value);
      expect(material.kind).toBe('material');
    }
    expect(Materials.standard(proceduralMaterials.glass()).kind).toBe('material');
    expect([...s.textures.keys()].sort()).toEqual([
      'car-paint-flakes',
      'carbon-fiber-albedo',
      'carbon-fiber-anisotropy',
      'carbon-fiber-normal',
      'emissive-segments',
      'metal-brushed-normal',
      'tire-chevron-normal',
      'tire-chevron-roughness',
    ]);
    const paint = recipes[0];
    if (paint?.ok) {
      expect(paint.value.staticSwitches).toEqual({ clearcoat: true });
      expect(paint.value.normalTexture).toMatchObject({
        coordinates: { set: 0, transform: { scale: [20, 20] } },
      });
    }
  });

  it('places a decal sheet on uv1 over the base material', () => {
    const s = sink();
    const paint = proceduralMaterials.carPaint({
      color: [0.5, 0.02, 0.02],
      texture: s.texture,
      flake: 0,
    });
    if (!paint.ok) throw paint.error;
    const number = textRegion('7', { height: 0.4 });
    if (!number.ok) throw number.error;
    const decal = proceduralMaterials.decal(paint.value, {
      texture: s.texture,
      key: 'hood-decal',
      width: 64,
      height: 64,
      background: [0.5, 0.02, 0.02, 1],
      layers: [
        {
          region: region2d.transform(number.value.region, { translate: [0.4, 0.3] }),
          color: [1, 1, 1, 1],
        },
      ],
    });
    if (!decal.ok) throw decal.error;
    expect(decal.value.baseColorTexture).toMatchObject({
      texture: 'texture:hood-decal',
      coordinates: { set: 1 },
    });
    expect(Materials.standard(decal.value).kind).toBe('material');
  });
});
