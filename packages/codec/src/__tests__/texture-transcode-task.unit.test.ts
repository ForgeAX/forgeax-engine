import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type CodecResult,
  ktx2IsNative,
  ktx2NativeTexture,
  type PackedTranscodedTexture,
  parseKtx2,
  type TextureTranscodeRequest,
  type TranscodedTexture,
  textureTranscodeTask,
  transcodeBasis,
  transcodeKtx2,
  transcodeKtx2Packed,
  transcodeTexturePacked,
} from '@forgeax/engine-codec';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BasisEncoderModule, BasisModuleFactory } from '../wasm/basis-types.js';

/**
 * The packed task path must reproduce the per-level transcode byte for byte:
 * every level of every target, sliced out of the single packed buffer, equals
 * what the per-level API returns for the same source.
 */

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

const LDR_TARGETS: readonly GPUTextureFormat[] = [
  'bc7-rgba-unorm',
  'bc7-rgba-unorm-srgb',
  'bc5-rg-unorm',
  'bc4-r-unorm',
  'etc2-rgba8unorm',
  'etc2-rgba8unorm-srgb',
  'eac-r11unorm',
  'eac-rg11unorm',
  'astc-4x4-unorm',
  'astc-4x4-unorm-srgb',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rg8unorm',
  'r8unorm',
];
const HDR_TARGETS: readonly GPUTextureFormat[] = ['bc6h-rgb-ufloat', 'rgba16float'];

type Mode = 'etc1s' | 'uastc-ldr' | 'uastc-hdr';

async function loadEncoder(): Promise<BasisEncoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  return mod;
}

function rgba(w: number, h: number, alpha: boolean): Uint8Array {
  const img = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img[i] = (x * 9 + y * 3) & 255;
      img[i + 1] = (y * 11) & 255;
      img[i + 2] = ((x ^ y) * 17) & 255;
      img[i + 3] = alpha ? (x * 5 + y * 7) & 255 : 255;
    }
  return img;
}

function f16(value: number): number {
  const f32 = new Float32Array([value]);
  const x = new Uint32Array(f32.buffer)[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  if (((x >>> 23) & 0xff) === 0 || e <= 0) return sign;
  if (e >= 0x1f) return sign | 0x7c00;
  return sign | (e << 10) | ((x & 0x7fffff) >> 13);
}

function rgbaHalf(w: number, h: number): Uint8Array {
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = f16((x % 16) / 4);
      out[i + 1] = f16((y % 8) / 8);
      out[i + 2] = f16(0.25 + ((x + y) % 4) / 2);
      out[i + 3] = f16(1);
    }
  return new Uint8Array(out.buffer);
}

function encode(
  mod: BasisEncoderModule,
  mode: Mode,
  w: number,
  h: number,
  ktx2: boolean,
  alpha = true,
): Uint8Array {
  const e = new mod.BasisEncoder();
  if (mode === 'uastc-hdr') e.setSliceSourceImageHDR(0, rgbaHalf(w, h), w, h, 0, false, 1.0);
  else e.setSliceSourceImage(0, rgba(w, h, alpha), w, h, 0);
  e.setCreateKTX2File(ktx2);
  if (mode === 'etc1s') {
    e.setFormatMode(mod.basis_tex_format.cETC1S.value);
    e.setQualityLevel(128);
  } else if (mode === 'uastc-ldr') {
    if (ktx2) e.setKTX2UASTCSupercompression(true);
    e.setFormatMode(mod.basis_tex_format.cUASTC_LDR_4x4.value);
  } else {
    e.setFormatMode(mod.basis_tex_format.cUASTC_HDR_4x4.value);
  }
  if (mode !== 'uastc-hdr') e.setPerceptual(true);
  e.setMipGen(true);
  const out = new Uint8Array(1 << 22);
  const n = e.encode(out);
  e.delete();
  if (n <= 0) throw new Error(`${mode} encode failed`);
  return out.slice(0, n);
}

/** The derivation path before the task pool: one array per level. */
async function perLevel(request: TextureTranscodeRequest): Promise<CodecResult<TranscodedTexture>> {
  if (request.encoding === 'basis') return transcodeBasis(request.data, request.target);
  const parsed = parseKtx2(request.data);
  if (!parsed.ok) return parsed;
  return ktx2IsNative(parsed.value)
    ? ktx2NativeTexture(parsed.value, request.target)
    : transcodeKtx2(parsed.value, request.target);
}

function expectSameLevels(
  reference: TranscodedTexture,
  packed: PackedTranscodedTexture,
  label: string,
): void {
  expect(packed.format, label).toBe(reference.format);
  expect([packed.width, packed.height], label).toEqual([reference.width, reference.height]);
  expect(packed.levels.length, label).toBe(reference.mips.length);
  let offset = 0;
  reference.mips.forEach((mip, level) => {
    const slot = packed.levels[level];
    expect(slot, `${label} L${level}`).toEqual({
      width: mip.width,
      height: mip.height,
      byteLength: mip.data.byteLength,
    });
    const slice = packed.data.subarray(offset, offset + mip.data.byteLength);
    // toEqual on typed arrays compares every byte; report the first mismatch compactly.
    const first = slice.findIndex((value, i) => value !== mip.data[i]);
    expect(first, `${label} L${level} first differing byte`).toBe(-1);
    offset += mip.data.byteLength;
  });
  expect(offset, `${label} packed length`).toBe(packed.data.byteLength);
}

const context = { aborted: false, yield: () => Promise.resolve() };

describe.skipIf(!pkgBuilt)('packed texture transcode matches per-level transcode', () => {
  const fixtures: {
    label: string;
    request: Omit<TextureTranscodeRequest, 'target'>;
    hdr: boolean;
  }[] = [];

  beforeAll(async () => {
    const mod = await loadEncoder();
    for (const [w, h] of [
      [64, 64],
      [36, 20],
    ] as const) {
      for (const mode of ['etc1s', 'uastc-ldr', 'uastc-hdr'] as const) {
        fixtures.push({
          label: `ktx2 ${mode} ${w}x${h}`,
          request: { encoding: 'ktx2', data: encode(mod, mode, w, h, true) },
          hdr: mode === 'uastc-hdr',
        });
      }
    }
    fixtures.push({
      label: 'ktx2 etc1s opaque 32x32',
      request: { encoding: 'ktx2', data: encode(mod, 'etc1s', 32, 32, true, false) },
      hdr: false,
    });
    fixtures.push({
      label: 'basis uastc-ldr 48x32',
      request: { encoding: 'basis', data: encode(mod, 'uastc-ldr', 48, 32, false) },
      hdr: false,
    });
  });

  it('agrees level by level for every supported target', async () => {
    await textureTranscodeTask.init?.({ shared: await textureTranscodeTask.shared?.() });
    let compared = 0;
    let rejected = 0;
    for (const fixture of fixtures) {
      for (const target of fixture.hdr ? HDR_TARGETS : LDR_TARGETS) {
        const label = `${fixture.label} -> ${target}`;
        const request = { ...fixture.request, target };
        const reference = await perLevel(request);
        const direct = await transcodeTexturePacked(request);
        // The task receives its own copy, as the submitter transfers it.
        const task = await textureTranscodeTask.run(
          { ...request, data: request.data.slice() },
          context,
        );
        if (!reference.ok) {
          // A pairing the source cannot produce fails identically on every path.
          expect(direct, label).toEqual(reference);
          expect(task.value, label).toEqual(reference);
          rejected++;
          continue;
        }
        expect(reference.value.mips.length, `${label} has mips`).toBeGreaterThan(1);
        expect(direct.ok, label).toBe(true);
        if (direct.ok) expectSameLevels(reference.value, direct.value, `${label} (direct)`);
        expect(task.value.ok, label).toBe(true);
        if (task.value.ok) {
          expectSameLevels(reference.value, task.value.value, `${label} (task)`);
          expect(task.transfer).toEqual([task.value.value.data.buffer]);
        }
        compared++;
      }
    }
    expect(compared + rejected).toBe(6 * LDR_TARGETS.length + 2 * HDR_TARGETS.length);
    // ETC1S sources have no single-channel EAC projection; every other pairing transcodes.
    expect([compared, rejected]).toEqual([82, 6]);
  });

  it('stops between levels once cancelled', async () => {
    const fixture = fixtures[0];
    if (fixture === undefined) throw new Error('missing fixture');
    const parsed = parseKtx2(fixture.request.data);
    if (!parsed.ok) throw new Error('parse failed');
    const checkpoint = {
      aborted: false,
      yields: 0,
      async yield() {
        this.yields++;
        this.aborted = true;
      },
    };
    await expect(transcodeKtx2Packed(parsed.value, 'rgba8unorm', checkpoint)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    expect(checkpoint.yields).toBe(1);
  });
});
