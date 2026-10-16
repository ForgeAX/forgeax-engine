import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  inspectBasisSource,
  ktx2ColorSpace,
  parseKtx2,
  selectTranscodeTarget,
  type TranscodeCaps,
} from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';
import type { Ktx2Parsed } from '../ktx2.js';
import type { BasisEncoderModule, BasisFile, BasisModuleFactory } from '../wasm/basis-types.js';

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

function parsedWithTransfer(transferFunction: number): Ktx2Parsed {
  return {
    header: {
      vkFormat: 0,
      typeSize: 1,
      pixelWidth: 4,
      pixelHeight: 4,
      pixelDepth: 0,
      layerCount: 0,
      faceCount: 1,
      levelCount: 1,
      supercompressionScheme: 1,
    },
    index: {
      dfdByteOffset: 0,
      dfdByteLength: 0,
      kvdByteOffset: 0,
      kvdByteLength: 0,
      sgdByteOffset: 0,
      sgdByteLength: 0,
    },
    levelIndex: [{ byteOffset: 0, byteLength: 0, uncompressedByteLength: 0 }],
    dfd: {
      totalSize: 44,
      vendorId: 0,
      descriptorType: 0,
      versionNumber: 2,
      descriptorBlockSize: 40,
      colorModel: 166,
      colorPrimaries: 1,
      transferFunction,
      flags: 0,
      texelBlockDimension: [3, 3, 0, 0],
      bytesPlane: [16, 0, 0, 0, 0, 0, 0, 0],
      samples: [],
    },
    kvEntries: [],
    sgd: null,
    rawBytes: new Uint8Array(),
  };
}

function fakeBasisFile(): BasisFile {
  return {
    close: () => undefined,
    getNumImages: () => 1,
    getNumLevels: () => 2,
    getImageWidth: () => 8,
    getImageHeight: () => 4,
    getBasisTexFormat: () => 0,
    getHasAlpha: () => 1,
    startTranscoding: () => 1,
    getImageTranscodedSizeInBytes: () => 16,
    transcodeImage: () => 1,
  };
}

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

async function realKtx2(mode: 'etc1s' | 'uastc-ldr' | 'uastc-hdr'): Promise<Uint8Array> {
  const pixels =
    mode === 'uastc-hdr'
      ? new Uint8Array(4 * 4 * 8)
      : new Uint8Array(4 * 4 * 4).map((_, index) => (index * 17) & 0xff);
  const result = await basisEncode(pixels, {
    mode,
    width: 4,
    height: 4,
    srgb: mode !== 'uastc-hdr',
    perceptual: mode !== 'uastc-hdr',
    uastcSupercompression: mode === 'uastc-ldr',
    mipGen: false,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function realBasis(): Promise<Uint8Array> {
  const mod = await loadEncoder();
  const encoder = new mod.BasisEncoder();
  try {
    encoder.setSliceSourceImage(0, new Uint8Array(4 * 4 * 4).fill(127), 4, 4, 0);
    encoder.setCreateKTX2File(false);
    encoder.setFormatMode(mod.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(false);
    encoder.setMipGen(false);
    const bytes = new Uint8Array(1 << 20);
    const length = encoder.encode(bytes);
    if (length <= 0) throw new Error('raw Basis encode failed');
    return bytes.slice(0, length);
  } finally {
    encoder.delete();
  }
}

const capabilityCells = [
  [{ bc: false, etc2: false, astc: false }, 'rgba'],
  [{ bc: false, etc2: false, astc: true }, 'astc'],
  [{ bc: true, etc2: false, astc: false }, 'bc'],
  [{ bc: false, etc2: true, astc: false }, 'etc'],
  [{ bc: true, etc2: true, astc: true }, 'all'],
] as const;

function expectedLdrTarget(srgb: boolean, arm: string): string {
  const suffix = srgb ? '-srgb' : '';
  switch (arm) {
    case 'bc':
    case 'all':
      return `bc7-rgba-unorm${suffix}`;
    case 'astc':
      return `astc-4x4-unorm${suffix}`;
    case 'etc':
      return `etc2-rgba8unorm${suffix}`;
    default:
      return `rgba8unorm${suffix}`;
  }
}

function expectedHdrTarget(arm: string): string {
  return arm === 'bc' || arm === 'all' ? 'bc6h-rgb-ufloat' : 'rgba16float';
}

describe('KTX2/Basis capability matrix', () => {
  it('projects DFD transfer functions without a duplicate source color fact', async () => {
    expect(ktx2ColorSpace(parsedWithTransfer(1))).toBe('linear');
    expect(ktx2ColorSpace(parsedWithTransfer(2))).toBe('srgb');
    expect(ktx2ColorSpace(parsedWithTransfer(0))).toBeUndefined();
  });

  it('inspects raw Basis dimensions and keeps Meta color-space provenance', () => {
    const result = inspectBasisSource(fakeBasisFile(), { colorSpace: 'srgb' }, 'etc1s');
    expect(result).toEqual({
      ok: true,
      value: {
        colorSpace: 'srgb',
        profile: 'etc1s',
        width: 8,
        height: 4,
        levelCount: 2,
        imageCount: 1,
      },
    });
  });

  it('rejects raw Basis inspection without an authored color-space fact', () => {
    const result = inspectBasisSource(fakeBasisFile(), {}, 'uastc-ldr');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ktx2-parse-failed');
    expect('reason' in result.error.detail).toBe(true);
    if ('reason' in result.error.detail)
      expect(result.error.detail.reason).toContain('Meta.colorSpace');
  });

  it.each([
    [{ bc: true, etc2: true, astc: true }, 'bc7-rgba-unorm-srgb'],
    [{ bc: false, etc2: false, astc: true }, 'astc-4x4-unorm-srgb'],
    [{ bc: false, etc2: true, astc: false }, 'etc2-rgba8unorm-srgb'],
    [{ bc: false, etc2: false, astc: false }, 'rgba8unorm-srgb'],
  ] as const)('selects a deterministic LDR target or explicit RGBA fallback', (caps, target) => {
    expect(
      selectTranscodeTarget(
        { model: 'etc1s', srgb: true, channels: 'rgba' },
        caps as TranscodeCaps,
      ),
    ).toBe(target);
  });

  it.skipIf(!pkgBuilt)('covers every real input profile across every capability cell', async () => {
    const inputs = [
      { id: 'ktx2-etc1s', bytes: await realKtx2('etc1s'), model: 'etc1s', srgb: true },
      { id: 'ktx2-uastc-ldr', bytes: await realKtx2('uastc-ldr'), model: 'uastc-ldr', srgb: true },
      { id: 'ktx2-uastc-hdr', bytes: await realKtx2('uastc-hdr'), model: 'uastc-hdr', srgb: false },
    ] as const;

    for (const input of inputs) {
      const parsed = await parseKtx2(input.bytes);
      expect(parsed.ok, input.id).toBe(true);
      if (!parsed.ok) continue;
      expect(ktx2ColorSpace(parsed.value), input.id).toBe(input.srgb ? 'srgb' : 'linear');
      for (const [caps, arm] of capabilityCells) {
        const target = selectTranscodeTarget(
          { model: input.model, srgb: input.srgb, channels: 'rgba' },
          caps,
        );
        expect(target, `${input.id}:${arm}`).toBe(
          input.model === 'uastc-hdr' ? expectedHdrTarget(arm) : expectedLdrTarget(input.srgb, arm),
        );
      }
    }

    const raw = await realBasis();
    const transcoder = await (await import(/* @vite-ignore */ TRANSCODER_GLUE.href)).default({
      locateFile: () => new URL('../../pkg/basis_transcoder.wasm', import.meta.url).href,
    });
    transcoder.initializeBasis();
    const file = new transcoder.BasisFile(raw);
    try {
      const inspected = inspectBasisSource(file, { colorSpace: 'srgb' }, 'uastc-ldr');
      expect(inspected.ok, 'raw-basis').toBe(true);
      for (const [caps, arm] of capabilityCells) {
        expect(
          selectTranscodeTarget({ model: 'uastc-ldr', srgb: true, channels: 'rgba' }, caps),
          `raw-basis:${arm}`,
        ).toBe(expectedLdrTarget(true, arm));
      }
    } finally {
      file.close();
    }
  });
});
