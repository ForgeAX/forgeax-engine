import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';
import { imageImporter } from '../image-importer.js';
import { makeCorruptPng, makeJpg, makePng } from './make-fixture.js';

const GUID = '019f0000-0000-7000-8000-000000000301';
const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(TRANSCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_GLUE));

function registry(): ImporterRegistry {
  const result = new ImporterRegistry();
  result.register(imageImporter);
  return result;
}

function meta(
  source = 'retry.png',
  importSettings: Readonly<Record<string, unknown>> = {
    colorSpace: 'srgb',
    mipmap: 'none',
  },
  sourceOverrides: RunImportMeta['sourceOverrides'] = undefined,
  kind: 'texture' | 'equirect' = 'texture',
): RunImportMeta {
  return {
    importer: 'image',
    source,
    importSettings,
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'image:texture', kind }],
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
  };
}

function source(state: { bytes: Uint8Array; reads: number }): ImportContext['readSource'] {
  return vi.fn(async () => {
    state.reads += 1;
    return { ok: true as const, value: state.bytes };
  });
}

function expectConversionFailure(
  result: Awaited<ReturnType<typeof runImport>>,
  diagnosticCode: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('source-validation-failed');
  expect(result.error.detail).toMatchObject({
    diagnostics: [
      expect.objectContaining({
        code: diagnosticCode,
        rule: expect.stringMatching(/^image-conversion-/),
        severity: 'error',
        expected: expect.any(String),
        hint: expect.any(String),
      }),
    ],
  });
  expect(result).not.toHaveProperty('value');
}

async function loadEncoder(): Promise<BasisEncoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const module = await factory({
    locateFile: () => new URL('../../../codec/pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  module.initializeBasis();
  return module;
}

async function makeRawBasis(hdr = false): Promise<Uint8Array> {
  const module = await loadEncoder();
  const encoder = new module.BasisEncoder();
  try {
    const width = 4;
    const height = 4;
    if (hdr) {
      encoder.setSliceSourceImageHDR(
        0,
        new Uint8Array(width * height * 8),
        width,
        height,
        0,
        false,
        1,
      );
      encoder.setFormatMode(module.basis_tex_format.cUASTC_HDR_4x4.value);
    } else {
      encoder.setSliceSourceImage(
        0,
        new Uint8Array(width * height * 4).fill(127),
        width,
        height,
        0,
      );
      encoder.setFormatMode(module.basis_tex_format.cUASTC_LDR_4x4.value);
    }
    encoder.setCreateKTX2File(false);
    encoder.setMipGen(false);
    const output = new Uint8Array(1 << 20);
    const length = encoder.encode(output);
    if (length <= 0) throw new Error('raw Basis encode failed');
    return output.slice(0, length);
  } finally {
    encoder.delete();
  }
}

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

describe('image importer conversion failure through the public runner', () => {
  it.each([
    { source: 'corrupt.png', bytes: makeCorruptPng(), code: 'image-conversion-decode-ldr' },
    {
      source: 'corrupt.jpeg',
      bytes: makeJpg(2, 2, [10, 20, 30, 255]).slice(0, 8),
      code: 'image-conversion-decode-ldr',
    },
    {
      source: 'corrupt.hdr',
      bytes: new Uint8Array([0, 0, 0, 0]),
      code: 'image-conversion-decode-hdr',
    },
    {
      source: 'corrupt.ktx2',
      bytes: new Uint8Array([0, 0, 0, 0]),
      code: 'image-conversion-inspect-ktx2-parse',
    },
  ])('returns stable source-validation-failed diagnostics for corrupt $source', async (input) => {
    const state = { bytes: input.bytes, reads: 0 };
    const result = await runImport(
      meta(
        input.source,
        input.source.endsWith('.hdr') ? { colorSpace: 'linear' } : undefined,
        undefined,
        input.source.endsWith('.hdr') ? 'equirect' : 'texture',
      ),
      registry(),
      {
        readSource: source(state),
      },
    );

    expectConversionFailure(result, input.code);
    expect(state.reads).toBe(2);
  });

  it.skipIf(!pkgBuilt)('returns a stable diagnostic for corrupt raw Basis bytes', async () => {
    const state = { bytes: new Uint8Array([0, 0, 0, 0]), reads: 0 };
    const result = await runImport(meta('corrupt.basis', { colorSpace: 'linear' }), registry(), {
      readSource: source(state),
    });

    expectConversionFailure(result, 'image-conversion-inspect-basis-inspection-failed');
    expect(state.reads).toBe(2);
  });

  it('retries corrected bytes through the same registry and preserves the GUID artifact', async () => {
    const state = { bytes: makeCorruptPng(), reads: 0 };
    const importerRegistry = registry();
    const input = meta();

    const readSource = source(state);
    const rejected = await runImport(input, importerRegistry, { readSource });
    expectConversionFailure(rejected, 'image-conversion-decode-ldr');

    state.bytes = makePng(1, 1, [1, 2, 3, 255]);
    const repaired = await runImport(input, importerRegistry, { readSource });

    expect(repaired.ok).toBe(true);
    if (!repaired.ok || 'skipped' in repaired.value) return;
    expect(repaired.value.pack.assets).toHaveLength(1);
    expect(repaired.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      artifacts: { body: { mediaType: 'application/x-forgeax-rgba8' } },
    });
    expect(repaired.value.pack).not.toHaveProperty('diagnostics');
    expect(state.reads).toBe(4);

    const repeated = await runImport(input, importerRegistry, { readSource });
    expect(repeated).toEqual(repaired);
    expect(state.reads).toBe(6);
  });

  it.each([
    { colorSpace: 'srgb' as const, format: 'rgba8unorm-srgb' },
    { colorSpace: 'linear' as const, format: 'rgba8unorm' },
  ])('publishes a format matching the authored $colorSpace color space', async (input) => {
    const result = await runImport(
      meta('valid.png', { colorSpace: input.colorSpace, mipmap: 'none' }),
      registry(),
      { readSource: source({ bytes: makePng(1, 1, [1, 2, 3, 255]), reads: 0 }) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack.assets[0]?.payload).toMatchObject({
      colorSpace: input.colorSpace,
      format: input.format,
      mips: { kind: 'none' },
    });
  });

  it.skipIf(!pkgBuilt)('repairs raw Basis color-space settings in the same registry', async () => {
    const state = { bytes: await makeRawBasis(), reads: 0 };
    const importerRegistry = registry();
    let settings: Readonly<Record<string, unknown>> = {};
    const readSource = source(state);

    const rejected = await runImport(meta('texture.basis', settings), importerRegistry, {
      readSource,
    });
    expectConversionFailure(rejected, 'image-conversion-inspect-basis-color-space-invalid');

    settings = { colorSpace: 'linear' };
    const repaired = await runImport(meta('texture.basis', settings), importerRegistry, {
      readSource,
    });

    expect(repaired.ok).toBe(true);
    if (!repaired.ok || 'skipped' in repaired.value) return;
    expect(repaired.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      payload: {
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        mips: { kind: 'none' },
      },
      artifacts: {
        body: {
          mediaType: 'application/x-forgeax-basis',
          assetCodec: { name: 'basis', container: 'basis', profile: 'uastc-ldr' },
        },
      },
    });
  });

  it.skipIf(!pkgBuilt)('rejects an unsupported raw Basis profile before publication', async () => {
    const state = { bytes: await makeRawBasis(true), reads: 0 };
    const result = await runImport(
      meta('hdr-profile.basis', { colorSpace: 'linear' }),
      registry(),
      {
        readSource: source(state),
      },
    );

    expectConversionFailure(result, 'image-conversion-inspect-basis-profile-unsupported');
  });

  it.skipIf(!pkgBuilt)('repairs KTX2 color-space provenance in the same registry', async () => {
    const state = { bytes: await makeKtx2(), reads: 0 };
    const importerRegistry = registry();
    const readSource = source(state);
    const rejected = await runImport(
      meta('texture.ktx2', { colorSpace: 'srgb' }, { 'image:texture': { colorSpace: 'srgb' } }),
      importerRegistry,
      { readSource },
    );

    expectConversionFailure(rejected, 'image-conversion-inspect-ktx2-color-space-conflict');

    const repaired = await runImport(
      meta('texture.ktx2', { colorSpace: 'linear' }, { 'image:texture': { colorSpace: 'linear' } }),
      importerRegistry,
      { readSource },
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok || 'skipped' in repaired.value) return;
    expect(repaired.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      payload: {
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        mips: { kind: 'none' },
      },
      artifacts: {
        body: {
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', container: 'ktx2', profile: 'uastc-ldr' },
        },
      },
    });
  });

  it.skipIf(!pkgBuilt)(
    'returns a structured encode refusal before Pack publication',
    async () => {
      const oversized = makePng(4097, 4096, [1, 2, 3, 255]);
      const result = await runImport(
        meta('oversized.png', { colorSpace: 'linear', compressionMode: 'uastc' }),
        registry(),
        { readSource: source({ bytes: oversized, reads: 0 }) },
      );

      expectConversionFailure(result, 'image-conversion-encode-ktx2-source-too-large');
    },
    15_000,
  );
});
