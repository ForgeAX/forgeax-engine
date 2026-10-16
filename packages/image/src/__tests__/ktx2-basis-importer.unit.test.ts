import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { ImportError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';
import { imageImporter } from '../image-importer.js';

const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(TRANSCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_GLUE));

const GUID = '019f0000-0000-7000-8000-000000000301';

async function makeKtx2(): Promise<Uint8Array> {
  const result = await basisEncode(new Uint8Array(4 * 4 * 4).fill(127), {
    mode: 'uastc-ldr',
    width: 4,
    height: 4,
    srgb: false,
    perceptual: false,
    uastcSupercompression: true,
    mipGen: false,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function loadEncoder(): Promise<BasisEncoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../../codec/pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  return mod;
}

async function makeBasis(): Promise<Uint8Array> {
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

function context(source: string, bytes: Uint8Array) {
  return {
    source,
    readSource: async () => ({ ok: true as const, value: bytes }),
    readSibling: async () => ({
      ok: false as const,
      error: new ImportError({
        code: 'source-read-failed',
        expected: 'no sibling source',
        hint: 'test source has no sibling',
        detail: { source, reason: 'no sibling' },
      }),
    }),
    decodeImage: async () => {
      throw new Error('precompressed source must not call decodeImage');
    },
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'main', kind: 'texture' as const }],
    importSettings: { colorSpace: 'linear' as const },
    sourceOverrides: { main: { colorSpace: 'linear' as const } },
  };
}

describe.skipIf(!pkgBuilt)('KTX2/Basis source importer', () => {
  it('rejects an unsupported precompressed extension before image decoding', async () => {
    await expect(imageImporter.import(context('fixture.dds', new Uint8Array()))).rejects.toThrow(
      'unsupported source extension',
    );
  });

  it('imports a KTX2 source without decoding it as PNG/JPEG and preserves codec facts', async () => {
    const bytes = await makeKtx2();
    const result = await imageImporter.import(context('fixture.ktx2', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets[0]?.payload).toMatchObject({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
    });
    expect(result.value.assets[0]?.artifacts.body?.assetCodec).toMatchObject({
      name: 'basis',
      container: 'ktx2',
      profile: 'uastc-ldr',
    });
    expect(result.value.assets[0]?.artifacts.body?.bytes).toEqual(bytes);
  });

  it('imports raw Basis with authored Meta color-space provenance', async () => {
    const bytes = await makeBasis();
    const result = await imageImporter.import(context('fixture.basis', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets[0]?.payload.colorSpace).toBe('linear');
    expect(result.value.assets[0]?.artifacts.body?.assetCodec).toMatchObject({
      name: 'basis',
      container: 'basis',
      profile: 'uastc-ldr',
    });
  });
});
