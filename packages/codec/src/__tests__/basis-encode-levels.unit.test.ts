import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ktx2ChannelLanes,
  parseKtx2,
  selectTranscodeTarget,
  transcodeKtx2,
} from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

/**
 * BK-E1 / BK-E2: pre-generated mip levels and two-channel sources.
 *
 * - Levels: a normal map whose mips are renormalized offline keeps unit normals in
 *   every transcoded level; the encoder's own box mips (`mipGen`) shorten them.
 * - Channels: an `rg` source becomes UASTC luminance-alpha (`RRRG` in the DFD),
 *   selects BC5 and transcodes X and Y; Basis reads BC5 from R and A, so the same
 *   pixels encoded as RGBA lose Y.
 */

const pkgBuilt = existsSync(
  fileURLToPath(new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url)),
);

const SIZE = 32;

/** A checker of normals tilted +-45 degrees about Y: box averaging halves their length. */
function tiltedChecker(size: number, cell: number): Float64Array {
  const out = new Float64Array(size * size * 3);
  const s = Math.SQRT1_2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sign = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 1 : -1;
      out.set([sign * s, 0, s], (y * size + x) * 3);
    }
  }
  return out;
}

function downsampleRenormalized(src: Float64Array, size: number): Float64Array {
  const half = Math.max(1, size >> 1);
  const out = new Float64Array(half * half * 3);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const acc = [0, 0, 0];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const o = (Math.min(size - 1, y * 2 + dy) * size + Math.min(size - 1, x * 2 + dx)) * 3;
        for (let c = 0; c < 3; c++) acc[c] = (acc[c] as number) + (src[o + c] as number);
      }
      const len = Math.hypot(acc[0] as number, acc[1] as number, acc[2] as number) || 1;
      out.set(
        [(acc[0] as number) / len, (acc[1] as number) / len, (acc[2] as number) / len],
        (y * half + x) * 3,
      );
    }
  }
  return out;
}

const toBytes = (normals: Float64Array): Uint8Array => {
  const out = new Uint8Array((normals.length / 3) * 4);
  for (let i = 0; i < normals.length / 3; i++) {
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round(((normals[i * 3 + c] as number) * 0.5 + 0.5) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
};

function renormalizedChain(): Uint8Array[] {
  let level = tiltedChecker(SIZE, 1);
  const chain = [toBytes(level)];
  for (let size = SIZE; size > 1; size >>= 1) {
    level = downsampleRenormalized(level, size);
    chain.push(toBytes(level));
  }
  return chain;
}

const options = {
  mode: 'uastc-ldr',
  width: SIZE,
  height: SIZE,
  srgb: false,
  perceptual: false,
  uastcSupercompression: true,
  mipGen: false,
} as const;

/** Mean decoded normal length of every level (RGB of an rgba8 transcode). */
async function levelLengths(ktx2: Uint8Array): Promise<number[]> {
  const parsed = parseKtx2(ktx2);
  if (!parsed.ok) throw new Error(parsed.error.code);
  const decoded = await transcodeKtx2(parsed.value, 'rgba8unorm');
  if (!decoded.ok) throw new Error(decoded.error.code);
  return decoded.value.mips.map((mip) => {
    let sum = 0;
    for (let i = 0; i < mip.data.length; i += 4) {
      const n = [0, 1, 2].map((c) => ((mip.data[i + c] as number) / 255) * 2 - 1);
      sum += Math.hypot(n[0] as number, n[1] as number, n[2] as number);
    }
    return sum / (mip.data.length / 4);
  });
}

/** Decode one BC4 block (8 bytes) into 16 bytes, texel-major within the block. */
function decodeBc4(block: Uint8Array): Uint8Array {
  const r0 = block[0] as number;
  const r1 = block[1] as number;
  const palette = [r0, r1];
  if (r0 > r1)
    for (let k = 1; k < 7; k++) palette.push(Math.floor(((7 - k) * r0 + k * r1 + 3) / 7));
  else {
    for (let k = 1; k < 5; k++) palette.push(Math.floor(((5 - k) * r0 + k * r1 + 2) / 5));
    palette.push(0, 255);
  }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(block[2 + i] as number) << BigInt(8 * i);
  const out = new Uint8Array(16);
  for (let t = 0; t < 16; t++) out[t] = palette[Number((bits >> BigInt(3 * t)) & 7n)] as number;
  return out;
}

/** BC5 level bytes to per-texel [R, G]. */
function decodeBc5(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  const bw = Math.ceil(width / 4);
  for (let by = 0; by < Math.ceil(height / 4); by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * 16;
      const r = decodeBc4(data.subarray(o, o + 8));
      const g = decodeBc4(data.subarray(o + 8, o + 16));
      for (let t = 0; t < 16; t++) {
        const x = bx * 4 + (t % 4);
        const y = by * 4 + Math.floor(t / 4);
        if (x >= width || y >= height) continue;
        out[(y * width + x) * 2] = r[t] as number;
        out[(y * width + x) * 2 + 1] = g[t] as number;
      }
    }
  }
  return out;
}

describe.skipIf(!pkgBuilt)('basisEncode pre-generated levels (BK-E2)', () => {
  it('assembles one KTX2 chain whose transcoded levels keep unit normals', async () => {
    const chain = renormalizedChain();
    const encoded = await basisEncode(chain[0] as Uint8Array, {
      ...options,
      levels: chain.slice(1),
    });
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
    const parsed = parseKtx2(encoded.value);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.value.header.levelCount).toBe(chain.length);
    const lengths = await levelLengths(encoded.value);
    expect(lengths).toHaveLength(6);
    for (const length of lengths) expect(Math.abs(length - 1)).toBeLessThan(4 / 255);
  });

  it('falsifier: the encoder box mips shorten the same normals far below unit length', async () => {
    const chain = renormalizedChain();
    const encoded = await basisEncode(chain[0] as Uint8Array, { ...options, mipGen: true });
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
    const lengths = await levelLengths(encoded.value);
    expect(lengths.length).toBeGreaterThan(4);
    expect(Math.abs((lengths[0] as number) - 1)).toBeLessThan(4 / 255);
    expect(lengths[1] as number).toBeLessThan(0.8);
  });

  it('is byte-identical across encodes and rejects inconsistent level sets', async () => {
    const chain = renormalizedChain();
    const run = () => basisEncode(chain[0] as Uint8Array, { ...options, levels: chain.slice(1) });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value).toEqual(b.value);
    const reasons = await Promise.all(
      [
        basisEncode(chain[0] as Uint8Array, { ...options, levels: [chain[2] as Uint8Array] }),
        basisEncode(chain[0] as Uint8Array, { ...options, mipGen: true, levels: chain.slice(1) }),
        basisEncode(chain[0] as Uint8Array, { ...options, mode: 'etc1s', levels: chain.slice(1) }),
        basisEncode(chain[0] as Uint8Array, {
          ...options,
          levels: [...chain.slice(1), new Uint8Array(4)],
        }),
      ].map(async (p) => {
        const r = await p;
        return r.ok
          ? 'ok'
          : `${r.error.code}: ${'reason' in r.error.detail ? r.error.detail.reason : ''}`;
      }),
    );
    expect(reasons).toEqual([
      expect.stringMatching(/^ktx2-encode-failed: level 1 holds 16x16/),
      'ktx2-encode-failed: levels and mipGen are exclusive',
      'ktx2-encode-failed: pre-generated levels need a UASTC mode',
      expect.stringMatching(/^ktx2-encode-failed: at most 5 levels follow 32x32/),
    ]);
  });
});

describe.skipIf(!pkgBuilt)('two-channel UASTC sources (BK-E1)', () => {
  /** Smooth X in R and Y in G; B and the opaque A must never reach the result. */
  function rgPixels(): Uint8Array {
    const px = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) px.set([64 + 4 * x, 32 + 5 * y, 0, 255], (y * SIZE + x) * 4);
    }
    return px;
  }

  it('marks the DFD RRRG, selects BC5 and transcodes X and Y', async () => {
    const pixels = rgPixels();
    const encoded = await basisEncode(pixels, {
      ...options,
      uastcSupercompression: false,
      channels: 'rg',
    });
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
    const parsed = parseKtx2(encoded.value);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(parsed.value.dfd?.samples[0]?.channelType).toBe(5);
    expect(ktx2ChannelLanes(parsed.value)).toEqual({ channels: 'rg', lanes: [0, 3] });
    const target = selectTranscodeTarget(
      { model: 'uastc-ldr', srgb: false, channels: ktx2ChannelLanes(parsed.value).channels },
      { bc: true, astc: true, etc2: true },
    );
    expect(target).toBe('bc5-rg-unorm');
    const bc5 = await transcodeKtx2(parsed.value, target);
    if (!bc5.ok) throw new Error(bc5.error.code);
    const xy = decodeBc5(bc5.value.mips[0]?.data as Uint8Array, SIZE, SIZE);
    let worst = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      worst = Math.max(
        worst,
        Math.abs((xy[i * 2] as number) - (pixels[i * 4] as number)),
        Math.abs((xy[i * 2 + 1] as number) - (pixels[i * 4 + 1] as number)),
      );
    }
    expect(worst).toBeLessThanOrEqual(4);
    const rg8 = await transcodeKtx2(parsed.value, 'rg8unorm');
    if (!rg8.ok) throw new Error(rg8.error.code);
    expect(Math.abs((rg8.value.mips[0]?.data[1] as number) - (pixels[1] as number))).toBeLessThan(
      16,
    );
  });

  it('falsifier: the same pixels marked RGBA read BC5 Y from alpha (all 255)', async () => {
    const pixels = rgPixels();
    const encoded = await basisEncode(pixels, { ...options, uastcSupercompression: false });
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
    const parsed = parseKtx2(encoded.value);
    if (!parsed.ok) throw new Error(parsed.error.code);
    expect(ktx2ChannelLanes(parsed.value).channels).toBe('rgba');
    const bc5 = await transcodeKtx2(parsed.value, 'bc5-rg-unorm');
    if (!bc5.ok) throw new Error(bc5.error.code);
    const xy = decodeBc5(bc5.value.mips[0]?.data as Uint8Array, SIZE, SIZE);
    expect(xy.filter((_, i) => i % 2 === 1).every((g) => g === 255)).toBe(true);
  });

  it('uastcLevel trades encode time for a closer UASTC decode of curved normals', async () => {
    const px = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const nx = Math.sin((x / SIZE) * 6 * Math.PI) * 0.6;
        const ny = Math.cos((y / SIZE) * 5 * Math.PI + x / 7) * 0.6;
        px.set(
          [Math.round((nx * 0.5 + 0.5) * 255), Math.round((ny * 0.5 + 0.5) * 255), 0, 255],
          (y * SIZE + x) * 4,
        );
      }
    }
    const error = async (uastcLevel: 0 | 2) => {
      const encoded = await basisEncode(px, { ...options, channels: 'rg', uastcLevel });
      if (!encoded.ok) throw new Error(JSON.stringify(encoded.error));
      const parsed = parseKtx2(encoded.value);
      if (!parsed.ok) throw new Error(parsed.error.code);
      const rg = await transcodeKtx2(parsed.value, 'rg8unorm');
      if (!rg.ok) throw new Error(rg.error.code);
      const data = rg.value.mips[0]?.data as Uint8Array;
      let sum = 0;
      for (let i = 0; i < SIZE * SIZE; i++)
        for (let c = 0; c < 2; c++)
          sum += ((data[i * 2 + c] as number) - (px[i * 4 + c] as number)) ** 2;
      return Math.sqrt(sum / (SIZE * SIZE * 2));
    };
    const fast = await error(0);
    const careful = await error(2);
    expect(careful).toBeLessThan(fast);
  });

  it('rejects channel marks outside UASTC-LDR', async () => {
    const r = await basisEncode(rgPixels(), { ...options, mode: 'etc1s', channels: 'rg' });
    expect(r.ok ? 'ok' : r.error.detail).toEqual({
      mode: 'etc1s',
      reason: "channels 'rg' needs uastc-ldr",
    });
  });
});
