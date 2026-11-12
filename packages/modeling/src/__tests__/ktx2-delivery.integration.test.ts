import { parseKtx2, transcodeKtx2 } from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { mipChain, normalFromHeight, textureFrom } from '../index';
import { toksvigRoughness } from '../texture';
import { decodeBcLevel } from '../tools/block-decode';
import { encodeKtx2 } from '../tools/ktx2';

/**
 * U35 / U41 delivery gates (R7 BK4, BK10, BK-E1, BK-E2): baked and procedural textures
 * encoded to KTX2 with their offline mip chain, transcoded the way the Renderer does
 * (normals to BC5), decoded and compared with the rgba8 source.
 */

const SIZE = 128;
const deg = (rad: number) => (rad * 180) / Math.PI;

/** A baked-panel normal map: bolt domes, a groove and a raised plate on a flat field. */
function bumps(): TextureAsset {
  const height = (x: number, y: number) => {
    let h = 0;
    for (const [cx, cy] of [
      [20, 20],
      [100, 24],
      [64, 64],
      [30, 100],
      [96, 96],
    ] as const) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < 7) h += 3 * Math.sqrt(1 - (d / 7) * (d / 7));
    }
    const g = Math.abs(y - 48);
    if (g < 2) h -= 1.5 * (1 - g / 2);
    if (x > 70 && x < 120 && y > 60 && y < 90) h += 1;
    return h;
  };
  const t = normalFromHeight(SIZE, SIZE, height, 1, { mips: false });
  if (!t.ok) throw t.error;
  return t.value;
}

const unit = (bytes: Uint8Array, i: number, stride = 4): [number, number, number] => {
  const x = ((bytes[i * stride] as number) / 255) * 2 - 1;
  const y = ((bytes[i * stride + 1] as number) / 255) * 2 - 1;
  const z = ((bytes[i * stride + 2] as number) / 255) * 2 - 1;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/** XY (rg8 or BC5) to a unit normal with the shader's reconstructed Z. */
const fromXy = (xy: Uint8Array, i: number): [number, number, number] => {
  const x = ((xy[i * 2] as number) / 255) * 2 - 1;
  const y = ((xy[i * 2 + 1] as number) / 255) * 2 - 1;
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

const dot3 = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number);

const angle = (a: readonly number[], b: readonly number[]) =>
  deg(Math.acos(Math.min(1, Math.max(-1, dot3(a, b)))));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

async function bc5Levels(ktx2: Uint8Array) {
  const parsed = parseKtx2(ktx2);
  if (!parsed.ok) throw new Error(parsed.error.code);
  const bc5 = await transcodeKtx2(parsed.value, 'bc5-rg-unorm');
  if (!bc5.ok) throw new Error(bc5.error.code);
  return bc5.value.mips.map((m) => ({ ...m, xy: decodeBcLevel(m.data, m.width, m.height, 2) }));
}

describe('KTX2 delivery of normal maps (U35, BK-E1, BK-E2)', () => {
  it('BC5 from the RRRG KTX2 stays within p95 1.5 and p99 6 degrees of the rgba8 chain on every level', async () => {
    const source = bumps();
    const chain = mipChain(source, { layout: 'normal' });
    if (!chain.ok) throw chain.error;
    const encoded = await encodeKtx2(source, { layout: 'normal' });
    if (!encoded.ok) throw encoded.error;
    expect(encoded.value.texture).toMatchObject({
      encoding: 'ktx2',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'packed', levelCount: 8 },
    });
    const levels = await bc5Levels(encoded.value.texture.data);
    expect(levels).toHaveLength(8);
    const errors: number[] = [];
    for (const [k, level] of levels.entries()) {
      const ref = chain.value.levels[k] as Uint8Array;
      for (let i = 0; i < level.width * level.height; i++)
        errors.push(angle(fromXy(level.xy, i), unit(ref, i)));
    }
    const p95 = percentile(errors, 0.95);
    const p99 = percentile(errors, 0.99);
    expect(p95).toBeLessThan(1.5);
    expect(p99).toBeLessThan(6);
    // Every level carries unit normals: renormalized offline, not box-shortened.
    for (const level of levels.slice(1)) {
      let sum = 0;
      for (let i = 0; i < level.width * level.height; i++) {
        const x = ((level.xy[i * 2] as number) / 255) * 2 - 1;
        const y = ((level.xy[i * 2 + 1] as number) / 255) * 2 - 1;
        sum += x * x + y * y;
      }
      expect(sum / (level.width * level.height)).toBeLessThanOrEqual(1);
    }
  });

  it('sharp feature rims: BC5 adds nothing to the UASTC tail, which is measured', async () => {
    // Stepped plates, a disc, a diagonal ridge, a knurl and a serrated rim: 56-63 deg
    // one-texel rims inside 4x4 blocks, the case the gentle bumps() panel does not exercise.
    const height = (x: number, y: number) => {
      let h = 0;
      if (x > 9 && x < 54 && y > 13 && y < 46) h += 3;
      if (x > 73 && x < 118 && y > 69 && y < 114) h -= 3;
      if (Math.hypot(x - 94, y - 34) < 17.5) h += 3;
      if (Math.abs(x - y + 50) < 3.5 && x < 60) h += 3;
      if (x > 12 && x < 60 && y > 64 && y < 116)
        h += 2 * (((x + y) % 3 === 0 ? 1 : 0) + ((x - y + 300) % 3 === 0 ? 1 : 0));
      if ((Math.floor(x / 2) % 2) * 3 + Math.hypot(x - 96, y - 96) < 12) h += 4;
      return h;
    };
    const source = normalFromHeight(SIZE, SIZE, height, 1, { mips: false });
    if (!source.ok) throw source.error;
    const chain = mipChain(source.value, { layout: 'normal' });
    const encoded = await encodeKtx2(source.value, { layout: 'normal' });
    if (!chain.ok || !encoded.ok) throw new Error('encode failed');
    const levels = await bc5Levels(encoded.value.texture.data);
    const p95 = (k: number, xyOf: (i: number) => [number, number, number]) => {
      const ref = chain.value.levels[k] as Uint8Array;
      const n = (ref.length / 4) | 0;
      return percentile(
        Array.from({ length: n }, (_, i) => angle(xyOf(i), unit(ref, i))),
        0.95,
      );
    };
    const bc5 = (k: number) => {
      const level = levels[k];
      if (level === undefined) throw new Error(`no level ${k}`);
      return (i: number) => fromXy(level.xy, i);
    };
    // The UASTC block itself, decoded losslessly (luminance in R, Y in A).
    const parsed = parseKtx2(encoded.value.texture.data);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const rgba = await transcodeKtx2(parsed.value, 'rgba8unorm');
    if (!rgba.ok) throw new Error(rgba.error.code);
    const la = rgba.value.mips[0]?.data as Uint8Array;
    const uastc = (i: number) =>
      fromXy(new Uint8Array([la[i * 4] as number, la[i * 4 + 3] as number]), 0);
    // Measured: level 0 p95 21.3 deg (UASTC alone 23.6), mips 2-5 p95 3.7, 2.9, 2.6, 1.0.
    // UASTC's endpoint model, not BC5, sets this tail: one-texel knurls and serrations need
    // texel-sized relief or an uncompressed delivery.
    expect(p95(0, bc5(0))).toBeLessThan(24);
    expect(p95(0, bc5(0))).toBeLessThanOrEqual(p95(0, uastc) + 0.5);
    for (const k of [2, 3, 4, 5]) expect(p95(k, bc5(k))).toBeLessThan(4.5);
  });

  it('falsifier: the same chain as three-channel UASTC (BC7) misses the BC5 p95', async () => {
    const chain = mipChain(bumps(), { layout: 'normal' });
    if (!chain.ok) throw chain.error;
    const p95 = async (channels: 'rg' | 'rgba') => {
      const levels = chain.value.levels;
      const encoded = await basisEncode(levels[0] as Uint8Array, {
        mode: 'uastc-ldr',
        width: SIZE,
        height: SIZE,
        srgb: false,
        perceptual: false,
        uastcSupercompression: true,
        mipGen: false,
        levels: levels.slice(1),
        channels,
        uastcLevel: 2,
      });
      if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
      const parsed = parseKtx2(encoded.value);
      if (!parsed.ok) throw new Error(parsed.error.code);
      const target = channels === 'rg' ? 'bc5-rg-unorm' : 'rgba8unorm';
      const decoded = await transcodeKtx2(parsed.value, target);
      if (!decoded.ok) throw new Error(decoded.error.code);
      const errors: number[] = [];
      for (const [k, m] of decoded.value.mips.entries()) {
        const xy =
          channels === 'rg'
            ? decodeBcLevel(m.data, m.width, m.height, 2)
            : Uint8Array.from(
                { length: m.width * m.height * 2 },
                (_, j) => m.data[(j >> 1) * 4 + (j & 1)] as number,
              );
        for (let i = 0; i < m.width * m.height; i++)
          errors.push(angle(fromXy(xy, i), unit(levels[k] as Uint8Array, i)));
      }
      return percentile(errors, 0.95);
    };
    expect(await p95('rg')).toBeLessThan(await p95('rgba'));
  });

  it('falsifier: the same normals delivered as sRGB color exceed the angular gate', async () => {
    const source = bumps();
    const asColor: TextureAsset = { ...source, format: 'rgba8unorm-srgb', colorSpace: 'srgb' };
    const encoded = await encodeKtx2(asColor, { layout: 'color' });
    if (!encoded.ok) throw encoded.error;
    const parsed = parseKtx2(encoded.value.texture.data);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const rgba = await transcodeKtx2(parsed.value, 'rgba8unorm');
    if (!rgba.ok) throw new Error(rgba.error.code);
    const level = rgba.value.mips[0];
    if (level === undefined) throw new Error('no level 0');
    // An -srgb view decodes the stored values before the shader reads XY.
    const linear = (b: number) => {
      const c = b / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const errors: number[] = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      const xy = new Uint8Array([
        Math.round(linear(level.data[i * 4] as number) * 255),
        Math.round(linear(level.data[i * 4 + 1] as number) * 255),
      ]);
      errors.push(angle(fromXy(xy, 0), unit(source.data, i)));
    }
    expect(percentile(errors, 0.95)).toBeGreaterThan(3);
  });

  it('is byte-deterministic and splits the source key from the encode key', async () => {
    const source = bumps();
    const a = await encodeKtx2(source, { layout: 'normal', rdo: 0.5 });
    const b = await encodeKtx2(source, { layout: 'normal', rdo: 0.5 });
    const c = await encodeKtx2(source, { layout: 'normal', rdo: 1 });
    if (!a.ok || !b.ok || !c.ok) throw new Error('encode failed');
    expect(a.value.texture.data).toEqual(b.value.texture.data);
    expect(a.value.keys).toEqual(b.value.keys);
    // Changing only the RDO lambda keeps the bake (source) key and misses the encode key.
    expect(c.value.keys.source).toBe(a.value.keys.source);
    expect(c.value.keys.encode).not.toBe(a.value.keys.encode);
    const keyed = await encodeKtx2(source, { layout: 'normal', sourceKey: 'bake-key' });
    if (!keyed.ok) throw keyed.error;
    expect(keyed.value.keys.source).toBe('bake-key');
    const moved = await encodeKtx2(
      { ...source, data: source.data.map((v, i) => (i === 0 ? v ^ 1 : v)) },
      { layout: 'normal' },
    );
    if (!moved.ok) throw moved.error;
    expect(moved.value.keys.source).not.toBe(a.value.keys.source);
    expect(a.value.report.bytes).toBeLessThan(a.value.report.rgba8Bytes);
  });

  it('rejects inputs the block formats cannot carry', async () => {
    const odd = textureFrom(6, 6, () => [0.5, 0.5, 1, 1], { mips: false });
    if (!odd.ok) throw odd.error;
    const results = await Promise.all([
      encodeKtx2(odd.value, { layout: 'normal' }),
      encodeKtx2(bumps(), { layout: 'normal', rdo: 0 }),
      encodeKtx2(bumps(), { layout: 'color', roughnessFromNormal: bumps() }),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'model-invalid-argument',
      'model-invalid-argument',
      'model-invalid-argument',
    ]);
  });
});

describe('coverage-preserving mask mips (R6: the mask layout of mipChain)', () => {
  /** A wire mesh: 1-texel wires every 4 texels, alpha 1 on wires, 0 between. */
  function wires(): TextureAsset {
    const t = textureFrom(
      SIZE,
      SIZE,
      (x, y) => [0.5, 0.5, 0.5, x % 7 < 2 || (x + y) % 9 === 0 ? 1 : 0],
      {
        mips: false,
      },
    );
    if (!t.ok) throw t.error;
    return t.value;
  }
  const coverage = (level: Uint8Array, cutoff: number) => {
    let n = 0;
    for (let i = 3; i < level.length; i += 4) if ((level[i] as number) / 255 >= cutoff) n++;
    return n / (level.length / 4);
  };

  it('keeps the alpha-test coverage of mip 4 within 5% of mip 0 (falsifier: the box chain loses it)', () => {
    const mask = mipChain(wires(), { layout: 'mask', alphaCutoff: 0.5 });
    const box = mipChain(wires(), { layout: 'color' });
    if (!mask.ok || !box.ok) throw new Error('chain failed');
    expect(mask.value.policy).toBe('mask-coverage/1');
    const c0 = coverage(mask.value.levels[0] as Uint8Array, 0.5);
    expect(c0).toBeGreaterThan(0.3);
    // Level 1 holds only 0.25 alpha steps, so its alpha test cannot hit c0 exactly;
    // R7b BK18 gates mip 4.
    for (const k of [3, 4])
      expect(Math.abs(coverage(mask.value.levels[k] as Uint8Array, 0.5) - c0)).toBeLessThan(0.05);
    expect(Math.abs(coverage(box.value.levels[4] as Uint8Array, 0.5) - c0)).toBeGreaterThan(0.05);
  });

  it('rejects a cutoff outside (0, 1) or on another layout', () => {
    const results = [
      mipChain(wires(), { layout: 'mask', alphaCutoff: 1 }),
      mipChain(wires(), { layout: 'color', alphaCutoff: 0.5 }),
    ];
    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'model-invalid-argument',
      'model-invalid-argument',
    ]);
  });
});

/** Alternating +-theta tilt about Y per texel: every mip >= 1 averages to length cos(theta). */
function stripes(theta: number): TextureAsset {
  const t = textureFrom(
    SIZE,
    SIZE,
    (x) => {
      const s = x % 2 === 0 ? 1 : -1;
      return [s * Math.sin(theta) * 0.5 + 0.5, 0.5, Math.cos(theta) * 0.5 + 0.5, 1];
    },
    { mips: false },
  );
  if (!t.ok) throw t.error;
  return t.value;
}

function ormh(roughness: number): TextureAsset {
  const t = textureFrom(SIZE, SIZE, () => [1, roughness, 0, 0.5], { mips: false });
  if (!t.ok) throw t.error;
  return t.value;
}

/** GGX normal distribution for a unit normal n, half vector h and alpha. */
function ggx(n: readonly number[], h: readonly number[], alpha: number): number {
  const c = Math.max(0, dot3(n, h));
  const a2 = alpha * alpha;
  const d = c * c * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

describe('Toksvig roughness mips', () => {
  it('leaves unit-length normals unchanged and widens shortened ones monotonically', () => {
    expect(toksvigRoughness(0.3, 1)).toBeCloseTo(0.3, 12);
    let previous = 0.3;
    for (const len of [0.99, 0.95, 0.9, 0.8, 0.6]) {
      const r = toksvigRoughness(0.3, len);
      expect(r).toBeGreaterThan(previous);
      previous = r;
    }
    expect(toksvigRoughness(1, 0.5)).toBe(1);
  });

  it('raises the mip 4 roughness of a bump stripe to the Toksvig value within 0.05 after encoding', async () => {
    const theta = (25 * Math.PI) / 180;
    const encoded = await encodeKtx2(ormh(0.25), {
      layout: 'ormh',
      roughnessFromNormal: stripes(theta),
      rdo: 0.5,
    });
    if (!encoded.ok) throw encoded.error;
    expect(encoded.value.report.policy).toBe('ormh-box-toksvig/2');
    const parsed = parseKtx2(encoded.value.texture.data);
    if (!parsed.ok) throw new Error(parsed.error.code);
    // UASTC to BC7 is lossless, so the RGBA decode is what a BC7 sampler reads.
    const rgba = await transcodeKtx2(parsed.value, 'rgba8unorm');
    if (!rgba.ok) throw new Error(rgba.error.code);
    const mean = (k: number, c: number) => {
      const m = rgba.value.mips[k];
      if (m === undefined) throw new Error(`no mip ${k}`);
      let sum = 0;
      for (let i = 0; i < m.width * m.height; i++) sum += m.data[i * 4 + c] as number;
      return sum / (m.width * m.height) / 255;
    };
    const expected = toksvigRoughness(0.25, Math.cos(theta));
    expect(mean(0, 1)).toBeCloseTo(0.25, 1);
    expect(Math.abs(mean(4, 1) - expected)).toBeLessThan(0.05);
    expect(mean(4, 1)).toBeGreaterThan(0.25 + 0.05);
    // Occlusion and height stay box-filtered constants.
    expect(Math.abs(mean(4, 0) - 1)).toBeLessThan(2 / 255);
    expect(Math.abs(mean(4, 3) - 0.5)).toBeLessThan(2 / 255);
  });

  it('cuts the prefiltered specular error of a minified bump field (falsifier: without Toksvig it is larger)', () => {
    const theta = (20 * Math.PI) / 180;
    const normal = stripes(theta);
    const rough = 0.2;
    const withT = mipChain(ormh(rough), { layout: 'ormh', roughnessFromNormal: normal });
    const without = mipChain(ormh(rough), { layout: 'ormh' });
    const normals = mipChain(normal, { layout: 'normal' });
    if (!withT.ok || !without.ok || !normals.ok) throw new Error('chain failed');
    const k = 4;
    const footprint = 1 << k;
    const alpha0 = rough * rough;
    const errors = { toksvig: 0, box: 0 };
    let count = 0;
    for (const hz of [1, 0.98, 0.94, 0.9]) {
      const hx = Math.sqrt(1 - hz * hz);
      const h = [hx, 0, hz];
      // Reference: shade every level-0 normal under the footprint, then average.
      let ref = 0;
      for (let x = 0; x < footprint; x++) ref += ggx(unit(normal.data, x), h, alpha0);
      ref /= footprint;
      const n = unit(normals.value.levels[k] as Uint8Array, 0);
      const r = (levels: readonly Uint8Array[]) => ((levels[k] as Uint8Array)[1] as number) / 255;
      const rt = r(withT.value.levels);
      const rb = r(without.value.levels);
      errors.toksvig += Math.abs(ggx(n, h, rt * rt) - ref) / ref;
      errors.box += Math.abs(ggx(n, h, rb * rb) - ref) / ref;
      count++;
    }
    errors.toksvig /= count;
    errors.box /= count;
    expect(errors.toksvig).toBeLessThan(errors.box * 0.5);
  });
});

describe('KTX2 encode keys and options', () => {
  const gradient = (colorSpace: 'srgb' | 'linear') => {
    const t = textureFrom(64, 64, (x, y) => [x / 64, y / 64, 0.5, 1], { mips: false, colorSpace });
    if (!t.ok) throw t.error;
    return t.value;
  };

  it('keys the output color space and extent (falsifier: same source bytes, other KTX2)', async () => {
    const srgb = gradient('srgb');
    const linear: TextureAsset = { ...srgb, format: 'rgba8unorm', colorSpace: 'linear' };
    const wide: TextureAsset = {
      ...linear,
      shape: { viewDimension: '2d', extent: { width: 128, height: 32 } },
    };
    const [a, b, c] = await Promise.all(
      [srgb, linear, wide].map((t) => encodeKtx2(t, { layout: 'color' })),
    );
    if (!a?.ok || !b?.ok || !c?.ok) throw new Error('encode failed');
    // The bytes alone cannot tell these apart, while the KTX2 output differs.
    expect(a.value.keys.source).toBe(b.value.keys.source);
    expect(b.value.keys.source).toBe(c.value.keys.source);
    expect(a.value.texture.data).not.toEqual(b.value.texture.data);
    expect(new Set([a, b, c].map((r) => r.value.keys.encode)).size).toBe(3);
  });

  it('carries a mask alphaCutoff into the chain and the key', async () => {
    const t = textureFrom(64, 64, (x, y) => [1, 1, 1, ((x * 7 + y * 3) % 10) / 10], {
      mips: false,
      colorSpace: 'srgb',
    });
    if (!t.ok) throw t.error;
    const alpha = async (alphaCutoff: number | undefined) => {
      const encoded = await encodeKtx2(t.value, {
        layout: 'mask',
        ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
      });
      if (!encoded.ok) throw encoded.error;
      const parsed = parseKtx2(encoded.value.texture.data);
      if (!parsed.ok) throw new Error(parsed.error.code);
      const rgba = await transcodeKtx2(parsed.value, 'rgba8unorm');
      if (!rgba.ok) throw new Error(rgba.error.code);
      const m = rgba.value.mips[3];
      if (m === undefined) throw new Error('no mip 3');
      let sum = 0;
      for (let i = 0; i < m.width * m.height; i++) sum += m.data[i * 4 + 3] as number;
      return { key: encoded.value.keys.encode, mean: sum / (m.width * m.height) };
    };
    const chainMean = (alphaCutoff: number) => {
      const chain = mipChain(t.value, { layout: 'mask', alphaCutoff });
      if (!chain.ok) throw chain.error;
      const level = chain.value.levels[3] as Uint8Array;
      let sum = 0;
      for (let i = 3; i < level.length; i += 4) sum += level[i] as number;
      return sum / (level.length / 4);
    };
    const [low, fallback, half] = await Promise.all([alpha(0.3), alpha(undefined), alpha(0.5)]);
    // Measured: the 0.3 chain holds mean mip-3 alpha 77, the 0.5 chain 127.
    expect(Math.abs((low?.mean ?? 0) - chainMean(0.3))).toBeLessThan(4);
    expect(Math.abs((half?.mean ?? 0) - chainMean(0.5))).toBeLessThan(4);
    expect(low?.key).not.toBe(half?.key);
    expect(fallback?.key).toBe(half?.key);
    const wrong = await encodeKtx2(t.value, { layout: 'color', alphaCutoff: 0.3 });
    expect(wrong.ok ? 'ok' : wrong.error.code).toBe('model-invalid-argument');
  });

  it('Toksvig leaves level 0 roughness unchanged for every byte (falsifier: bytes 0-2 lifted to 3)', () => {
    const normal = bumps();
    let changed = 0;
    for (let b = 0; b < 256; b++) {
      const t = textureFrom(SIZE, SIZE, () => [1, b / 255, 0, 0], { mips: false });
      if (!t.ok) throw t.error;
      const withT = mipChain(t.value, { layout: 'ormh', roughnessFromNormal: normal });
      const plain = mipChain(t.value, { layout: 'ormh' });
      if (!withT.ok || !plain.ok) throw new Error('chain failed');
      const a = withT.value.levels[0] as Uint8Array;
      const c = plain.value.levels[0] as Uint8Array;
      for (let i = 1; i < a.length; i += 4) if (a[i] !== c[i]) changed++;
    }
    expect(changed).toBe(0);
  });
});
