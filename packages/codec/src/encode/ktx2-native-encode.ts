import { compressZstd } from '../encode-impl.js';
import { type CodecResult, codecError } from '../errors.js';
import { KTX2_IDENTIFIER, type Ktx2NativeFormat } from '../ktx2.js';

export interface Ktx2NativeEncodeOptions {
  readonly format: Ktx2NativeFormat;
  readonly width: number;
  readonly height: number;
  /** Tight RG8 texels or BC5 blocks per level, base level first. */
  readonly levels: readonly Uint8Array[];
  readonly supercompression?: 'none' | 'zstd';
}

const LAYOUT = {
  rg8unorm: { vkFormat: 16, model: 1, block: [0, 0], bytes: 2, bits: 8, upper: 255 },
  'bc5-rg-unorm': { vkFormat: 141, model: 132, block: [3, 3], bytes: 16, bits: 64, upper: -1 },
} as const;

function levelBytes(format: Ktx2NativeFormat, width: number, height: number): number {
  return format === 'rg8unorm'
    ? width * height * 2
    : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/**
 * Write a linear 2D RG8 / BC5 KTX2 (no Basis) that `inspectKtx2Native`
 * admits: base-first level index, smallest-first payloads, one RGBSDA / BC5
 * DFD with the linear transfer function, optional per-level Zstandard.
 */
export async function encodeKtx2Native(
  options: Ktx2NativeEncodeOptions,
): Promise<CodecResult<Uint8Array>> {
  const { format, width, height, levels } = options;
  const fail = (reason: string) => codecError('ktx2-encode-failed', { mode: format, reason });
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return fail('invalid size');
  if (levels.length < 1 || levels.length > Math.floor(Math.log2(Math.max(width, height))) + 1)
    return fail('too many levels');
  for (const [level, data] of levels.entries())
    if (
      data.byteLength !==
      levelBytes(format, Math.max(1, width >> level), Math.max(1, height >> level))
    )
      return fail('level size mismatch');
  const zstd = options.supercompression === 'zstd';
  const payloads: Uint8Array[] = [];
  for (const data of levels) {
    if (!zstd) payloads.push(data);
    else {
      const packed = await compressZstd(data);
      if (!packed.ok) return packed;
      payloads.push(packed.value);
    }
  }
  const layout = LAYOUT[format];
  const dfdOffset = 80 + levels.length * 24;
  const descriptorSize = 24 + 2 * 16;
  const dfdLength = 4 + descriptorSize;
  const alignment = zstd ? 1 : layout.bytes === 2 ? 4 : 16;
  const offsets: number[] = new Array(levels.length);
  let cursor = dfdOffset + dfdLength;
  for (let level = levels.length - 1; level >= 0; level--) {
    cursor = Math.ceil(cursor / alignment) * alignment;
    offsets[level] = cursor;
    cursor += payloads[level]?.byteLength ?? 0;
  }
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);
  const u64 = (offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true);
  out.set(KTX2_IDENTIFIER, 0);
  [layout.vkFormat, 1, width, height, 0, 0, 1, levels.length, zstd ? 2 : 0].forEach((v, i) => {
    u32(12 + i * 4, v);
  });
  u32(48, dfdOffset);
  u32(52, dfdLength);
  for (const [level, payload] of payloads.entries()) {
    const entry = 80 + level * 24;
    u64(entry, offsets[level] ?? 0);
    u64(entry + 8, payload.byteLength);
    u64(entry + 16, levels[level]?.byteLength ?? 0);
    out.set(payload, offsets[level] ?? 0);
  }
  u32(dfdOffset, dfdLength);
  u32(dfdOffset + 8, 2 | (descriptorSize << 16));
  u32(dfdOffset + 12, layout.model | (1 << 8) | (1 << 16));
  u32(dfdOffset + 16, layout.block[0] | (layout.block[1] << 8));
  u32(dfdOffset + 20, layout.bytes);
  for (let channel = 0; channel < 2; channel++) {
    const sample = dfdOffset + 28 + channel * 16;
    u32(sample, channel * layout.bits + ((layout.bits - 1) << 16) + channel * 2 ** 24);
    u32(sample + 12, layout.upper);
  }
  return { ok: true, value: out };
}
