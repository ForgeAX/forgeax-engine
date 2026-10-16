// image-importer.ts - the build-time imageImporter (feat-20260603-asset-import-loader-injection M3 / w23).
//
// The `{ key: 'image', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'image'` to. It absorbs the
// decode logic that previously lived inline in
// `@forgeax/engine-vite-plugin-pack`'s generateBundle (research Finding 4,
// vite-plugin-pack/src/index.ts:354-447): read the source bytes -> parseImage
// -> tight-packed RGBA `DecodedImage` -> a `TextureAsset` POD whose `data`
// column carries the imported RGBA bytes under the meta-declared GUID.
//
// Why image-importer lives in @forgeax/engine-image (D-9): the image domain
// logic stays co-located with the package that already owns parseImage (a
// node-only decoder). Splitting the import into a third package would fracture
// the SSOT. This module is a NODE-ONLY sub-export
// (`@forgeax/engine-image/image-importer`, `default: null` under browser
// conditions) because it statically imports `./parse-image.js` (jpeg-js +
// upng-js). The browser runtime never reaches it: the texture is decoded at
// build time and the runtime loader reads the imported `.bin` (M3 strips the
// runtime decoder edge, AC-15).
//
// importSettings folding (colorSpace / mipmap -> TextureAsset.format) mirrors
// `build-catalog.ts` buildImageMetadata (D-5: `'auto'` -> true / `'none'` ->
// false, `'srgb'` -> 'rgba8unorm-srgb' / `'linear'` -> 'rgba8unorm') so the
// importer and the catalog builder derive the same texture metadata. The
// imported RGBA bytes ride in `TextureAsset.data`; the generateBundle integration (w28)
// extracts that buffer into a hashed `.bin` and folds width/height/format into
// the pack-index row.
//
// GUID import-stable iron law: every produced `ImportedAsset.guid` comes from
// `ctx.subAssets[]`, never minted here. A sub-asset of `kind: 'equirect'`
// (HDR lat-long env map) IS folded by the .hdr arm into an EquirectAsset POD
// (a single 2D rgba16float image); the cube-to-cube IBL projection is a runtime
// GPU pass, not a build-time fold (feat-20260630).

import {
  type BasisSourceInspection,
  initBasisTranscoder,
  inspectBasisSource,
  ktx2ColorSpace,
  parseKtx2,
} from '@forgeax/engine-codec';
import type {
  EquirectAsset,
  ImageColorSpace,
  ImportContext,
  ImportedAsset,
  Importer,
  ImportResult,
  TextureAsset,
  TextureMipPolicy,
} from '@forgeax/engine-types';
import { IMPORT_ERROR_HINTS, ImportError } from '@forgeax/engine-types';
import type { CompressionMode, EncodedTexture } from './ktx2-encode.js';
import { encodeTextureToKtx2, resolveEncodeMode } from './ktx2-encode.js';
import { importCubeSource } from './lut/cube-producer.js';
import { parseImage } from './parse-image.js';
import { importTextureSource } from './texture/importer.js';

/** Map a source path / mime hint to the parseImage mime literal. */
function mimeFromSource(source: string): 'image/png' | 'image/jpeg' | undefined {
  const lower = source.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return undefined;
}

type RequiredImageOutputKind = 'texture' | 'equirect';

function requiredImageOutputKind(source: string): RequiredImageOutputKind | undefined {
  const lower = source.toLowerCase();
  if (lower.endsWith('.hdr')) return 'equirect';
  if (
    mimeFromSource(source) !== undefined ||
    lower.endsWith('.basis') ||
    lower.endsWith('.ktx2') ||
    lower.endsWith('.cube')
  ) {
    return 'texture';
  }
  return undefined;
}

function imageOutputTopologyActual(ctx: ImportContext): string {
  if (ctx.subAssets.length === 0) return 'subAssets[] is empty';
  return ctx.subAssets
    .map(
      (sub, index) => `subAssets[${index}]=${sub.kind}:${sub.guid}:sourceIndex=${sub.sourceIndex}`,
    )
    .join(', ');
}

type ImageConversionStage = 'decode' | 'inspect' | 'encode';

function imageConversionFailure(
  ctx: ImportContext,
  stage: ImageConversionStage,
  ownerCode: string,
  sourcePath: string,
  expected: string,
  actual: string,
  hint: string,
): ImportError {
  const diagnosticSourcePath = sourcePath.length === 0 ? ctx.source : sourcePath;
  return new ImportError({
    code: 'source-validation-failed',
    expected,
    actual,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: `image-conversion-${stage}-${ownerCode}`,
          severity: 'error',
          sourcePath: diagnosticSourcePath,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: `image-conversion-${stage}`,
          expected,
          actual,
          hint,
        },
      ],
    },
  });
}

function validateImageOutputTopology(
  ctx: ImportContext,
  requiredKind: RequiredImageOutputKind,
): ImportError | undefined {
  if (
    ctx.subAssets.length === 1 &&
    ctx.subAssets[0]?.kind === requiredKind &&
    ctx.subAssets[0]?.sourceIndex === 0
  ) {
    return undefined;
  }

  const expected = `exactly one subAssets[] entry with kind "${requiredKind}" and sourceIndex 0`;
  const actual = imageOutputTopologyActual(ctx);
  return new ImportError({
    code: 'source-validation-failed',
    expected,
    actual,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: 'image-subasset-topology',
          severity: 'error',
          sourcePath: `${ctx.source}#subAssets`,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'image-required-single-output',
          expected,
          actual,
          hint: `declare exactly one ${requiredKind} sub-asset with sourceIndex 0 and remove foreign, duplicate, or misplaced entries`,
        },
      ],
    },
  });
}

/** D-5 mipmap token mapping (mirrors build-catalog mipmapTokenToBoolean). */
function mipmapTokenToBoolean(token: unknown): boolean {
  return token === 'auto' || token === true;
}

/** colorSpace -> GPU format literal (mirrors build-catalog colorSpaceToFormat). */
function colorSpaceToFormat(colorSpace: ImageColorSpace): GPUTextureFormat {
  return colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

type BasisProfile = 'etc1s' | 'uastc-ldr' | 'uastc-hdr';

async function inspectKtx2Source(
  ctx: ImportContext,
  bytes: Uint8Array,
  metaColorSpace: ImageColorSpace | undefined,
): Promise<
  | {
      readonly colorSpace: ImageColorSpace;
      readonly profile: BasisProfile;
      readonly width: number;
      readonly height: number;
      readonly levelCount: number;
    }
  | ImportError
> {
  const parsed = await parseKtx2(bytes);
  if (!parsed.ok) {
    return imageConversionFailure(
      ctx,
      'inspect',
      'ktx2-parse',
      ctx.source,
      'a valid KTX2 container with a supported Basis profile',
      `codec:${parsed.error.code}`,
      'repair the KTX2 container and retry the image import',
    );
  }
  const dfdColorSpace = ktx2ColorSpace(parsed.value);
  if (dfdColorSpace === undefined) {
    return imageConversionFailure(
      ctx,
      'inspect',
      'ktx2-color-space-missing',
      `${ctx.source}#DFD.transferFunction`,
      'DFD transfer function to identify sRGB or linear color space',
      'missing-or-unsupported-transfer-function',
      'repair the KTX2 DFD color-space declaration before importing',
    );
  }
  if (metaColorSpace !== undefined && metaColorSpace !== dfdColorSpace) {
    return imageConversionFailure(
      ctx,
      'inspect',
      'ktx2-color-space-conflict',
      `${ctx.source}#importSettings.colorSpace`,
      'Meta.colorSpace to match the KTX2 DFD transfer function',
      `meta=${metaColorSpace},dfd=${dfdColorSpace}`,
      'repair Meta.colorSpace or re-encode the KTX2 source with matching color provenance',
    );
  }
  const { pixelDepth, layerCount, faceCount } = parsed.value.header;
  if (pixelDepth !== 0 || layerCount > 1 || faceCount !== 1) {
    return imageConversionFailure(
      ctx,
      'inspect',
      'ktx2-shape-unsupported',
      `${ctx.source}#header`,
      'a 2D, single-layer, single-face KTX2 texture',
      `pixelDepth=${pixelDepth},layerCount=${layerCount},faceCount=${faceCount}`,
      're-encode the source as one 2D Basis texture',
    );
  }
  const module = await initBasisTranscoder();
  let file: InstanceType<typeof module.KTX2File>;
  try {
    file = new module.KTX2File(bytes);
  } catch {
    return imageConversionFailure(
      ctx,
      'inspect',
      'ktx2-invalid',
      ctx.source,
      'Basis KTX2File bytes to pass transcoder validation',
      'basis-file-constructor-failed',
      'repair or re-encode the KTX2 source before importing',
    );
  }
  try {
    try {
      if (!file.isValid()) {
        return imageConversionFailure(
          ctx,
          'inspect',
          'ktx2-invalid',
          ctx.source,
          'Basis KTX2File bytes to pass transcoder validation',
          'basis-file-invalid',
          'repair or re-encode the KTX2 source before importing',
        );
      }
      const profile: BasisProfile | undefined = file.isETC1S()
        ? 'etc1s'
        : file.isHDR() || file.isHDR4x4()
          ? 'uastc-hdr'
          : file.isUASTC_LDR_4x4()
            ? 'uastc-ldr'
            : undefined;
      if (profile === undefined) {
        return imageConversionFailure(
          ctx,
          'inspect',
          'ktx2-profile-unsupported',
          `${ctx.source}#Basis.profile`,
          'ETC1S, UASTC-LDR, or UASTC-HDR Basis profile',
          'unsupported-basis-profile',
          're-encode the source with ETC1S, UASTC-LDR, or UASTC-HDR',
        );
      }
      if (profile === 'uastc-hdr' && dfdColorSpace !== 'linear') {
        return imageConversionFailure(
          ctx,
          'inspect',
          'ktx2-hdr-color-space-invalid',
          `${ctx.source}#DFD.transferFunction`,
          'UASTC-HDR source to use linear color space',
          `profile=${profile},dfd=${dfdColorSpace}`,
          're-encode HDR data with a linear KTX2 DFD transfer function',
        );
      }
      return {
        colorSpace: dfdColorSpace,
        profile,
        width: file.getWidth(),
        height: file.getHeight(),
        levelCount: file.getLevels(),
      };
    } catch {
      return imageConversionFailure(
        ctx,
        'inspect',
        'ktx2-invalid',
        ctx.source,
        'Basis KTX2File bytes to pass transcoder inspection',
        'basis-inspection-threw',
        'repair or re-encode the KTX2 source before importing',
      );
    }
  } finally {
    file.close();
  }
}

async function importKtx2Source(ctx: ImportContext, bytes: Uint8Array): Promise<ImportResult> {
  const sourceKey = ctx.subAssets[0]?.sourceKey;
  const metaColorSpace =
    sourceKey === undefined
      ? ctx.importSettings.colorSpace
      : ctx.sourceOverrides?.[sourceKey]?.colorSpace;
  const inspection = await inspectKtx2Source(
    ctx,
    bytes,
    metaColorSpace === 'srgb' || metaColorSpace === 'linear' ? metaColorSpace : undefined,
  );
  if (inspection instanceof ImportError) return { ok: false, error: inspection };
  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    if (sub.kind !== 'texture' || sub.sourceIndex !== 0) continue;
    out.push({
      guid: sub.guid,
      kind: 'texture',
      payload: {
        kind: 'texture',
        shape: {
          viewDimension: '2d',
          extent: { width: inspection.width, height: inspection.height },
        },
        format: colorSpaceToFormat(inspection.colorSpace),
        data: bytes,
        colorSpace: inspection.colorSpace,
        mips:
          inspection.levelCount > 1
            ? { kind: 'packed', levelCount: inspection.levelCount }
            : { kind: 'none' },
      },
      refs: [],
      artifacts: {
        body: {
          mediaType: 'image/ktx2',
          assetCodec: {
            name: 'basis',
            container: 'ktx2',
            profile: inspection.profile,
            version: '1',
          },
          bytes,
        },
      },
    });
  }
  return { ok: true, value: { assets: out, sourceDependencies: [] } };
}

function basisMetaColorSpace(ctx: ImportContext): ImageColorSpace | ImportError {
  const sourceKey = ctx.subAssets[0]?.sourceKey;
  const override = sourceKey === undefined ? undefined : ctx.sourceOverrides?.[sourceKey];
  const value = override?.colorSpace ?? ctx.importSettings.colorSpace;
  if (value !== 'srgb' && value !== 'linear') {
    return imageConversionFailure(
      ctx,
      'inspect',
      'basis-color-space-invalid',
      `${ctx.source}#Meta.colorSpace`,
      'Meta.colorSpace to be srgb or linear for raw Basis',
      value === undefined ? 'missing' : `invalid:${String(value)}`,
      'set Meta.colorSpace to srgb or linear before importing raw Basis bytes',
    );
  }
  return value;
}

async function importBasisSource(ctx: ImportContext, bytes: Uint8Array): Promise<ImportResult> {
  const colorSpace = basisMetaColorSpace(ctx);
  if (colorSpace instanceof ImportError) return { ok: false, error: colorSpace };
  const module = await initBasisTranscoder();
  if (module.BasisFile === undefined) {
    throw new Error('basis-source-inspection-unavailable: transcoder lacks BasisFile');
  }
  let file: InstanceType<typeof module.BasisFile>;
  try {
    file = new module.BasisFile(bytes);
  } catch {
    return {
      ok: false,
      error: imageConversionFailure(
        ctx,
        'inspect',
        'basis-source-invalid',
        ctx.source,
        'raw Basis bytes to pass transcoder validation',
        'basis-file-invalid',
        'repair or re-encode the raw Basis source before importing',
      ),
    };
  }
  let inspection: BasisSourceInspection | undefined;
  try {
    try {
      const format = file.getBasisTexFormat();
      const profile =
        format === module.basis_tex_format.cETC1S.value
          ? 'etc1s'
          : format === module.basis_tex_format.cUASTC_LDR_4x4.value
            ? 'uastc-ldr'
            : undefined;
      if (profile === undefined) {
        return {
          ok: false,
          error: imageConversionFailure(
            ctx,
            'inspect',
            'basis-profile-unsupported',
            `${ctx.source}#Basis.profile`,
            'ETC1S or UASTC-LDR raw Basis profile',
            'unsupported-basis-profile',
            're-encode the source with ETC1S or UASTC-LDR',
          ),
        };
      }
      const result = inspectBasisSource(file, { colorSpace }, profile);
      if (!result.ok) {
        return {
          ok: false,
          error: imageConversionFailure(
            ctx,
            'inspect',
            'basis-inspection-failed',
            ctx.source,
            'raw Basis source metadata to pass codec inspection',
            `codec:${result.error.code}`,
            'repair the raw Basis source metadata and retry the import',
          ),
        };
      }
      inspection = result.value;
    } catch {
      return {
        ok: false,
        error: imageConversionFailure(
          ctx,
          'inspect',
          'basis-source-invalid',
          ctx.source,
          'raw Basis bytes to pass transcoder inspection',
          'basis-inspection-threw',
          'repair or re-encode the raw Basis source before importing',
        ),
      };
    }
  } finally {
    file.close();
  }
  if (inspection === undefined) {
    return {
      ok: false,
      error: imageConversionFailure(
        ctx,
        'inspect',
        'basis-inspection-failed',
        ctx.source,
        'raw Basis source metadata to be available after codec inspection',
        'missing-inspection-result',
        'repair the raw Basis source and retry the import',
      ),
    };
  }
  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    if (sub.kind !== 'texture') continue;
    if (sub.sourceIndex !== 0 || inspection.imageCount !== 1) {
      return {
        ok: false,
        error: imageConversionFailure(
          ctx,
          'inspect',
          'basis-image-shape-unsupported',
          `${ctx.source}#Basis.images`,
          'one raw Basis image at sourceIndex 0',
          `imageCount=${inspection.imageCount},sourceIndex=${sub.sourceIndex}`,
          're-encode the source as one raw Basis image',
        ),
      };
    }
    out.push({
      guid: sub.guid,
      kind: 'texture',
      payload: {
        kind: 'texture',
        shape: {
          viewDimension: '2d',
          extent: { width: inspection.width, height: inspection.height },
        },
        format: colorSpaceToFormat(colorSpace),
        data: bytes,
        colorSpace,
        mips:
          inspection.levelCount > 1
            ? { kind: 'packed', levelCount: inspection.levelCount }
            : { kind: 'none' },
      },
      refs: [],
      artifacts: {
        body: {
          mediaType: 'application/x-forgeax-basis',
          assetCodec: {
            name: 'basis',
            container: 'basis',
            profile: inspection.profile,
            version: '1',
          },
          bytes,
        },
      },
    });
  }
  return { ok: true, value: { assets: out, sourceDependencies: [] } };
}

/**
 * Read the sidecar compressionMode token (D-12 / M3 w18).
 *
 * M3 SEQUENCING CONSTRAINT (plan R-9): the default is hard-wired to `'none'`.
 * An absent / unrecognised token stays `'none'` so existing textures keep the
 * uncompressed `.bin` path -- flipping the default to `'auto'` is M5 (w38).
 */
function compressionModeToken(token: unknown): CompressionMode {
  if (token === 'auto' || token === 'etc1s' || token === 'uastc' || token === 'none') {
    return token;
  }
  return 'none';
}

/** Decode, resize and cook an LDR image once for source and embedded imports. */
async function cookLdrImage(
  bytes: Uint8Array,
  mimeType: Parameters<ImportContext['decodeImage']>[1],
  settings: Readonly<Record<string, unknown>>,
  mipmap: boolean,
) {
  const colorSpace: ImageColorSpace = settings.colorSpace === 'srgb' ? 'srgb' : 'linear';
  const downscaleMaxDimension =
    typeof settings.downscaleMaxDimension === 'number' &&
    Number.isInteger(settings.downscaleMaxDimension) &&
    settings.downscaleMaxDimension > 0
      ? settings.downscaleMaxDimension
      : undefined;
  const decoded = parseImage(bytes, mimeType, {
    colorSpace,
    mipmap,
    ...(downscaleMaxDimension === undefined ? {} : { downscaleMaxDimension }),
  });
  if (!decoded.ok) return decoded;
  const image = decoded.value;
  const compressionMode = compressionModeToken(settings.compressionMode);
  let encoded: EncodedTexture | null = null;
  if (resolveEncodeMode(compressionMode, { colorSpace, isHdr: false }) !== 'none') {
    const result = await encodeTextureToKtx2(
      image.bytes,
      image.width,
      image.height,
      compressionMode,
      { colorSpace, isHdr: false, mipmap },
    );
    if (!result.ok) return result;
    encoded = result.value;
  }
  return {
    ok: true as const,
    value: {
      texture: {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: image.width, height: image.height } },
        format: colorSpaceToFormat(colorSpace),
        data: encoded?.ktx2 ?? image.bytes,
        colorSpace,
        mips: cookedMipPolicy(encoded, mipmap),
      } satisfies TextureAsset,
      encoded,
    },
  };
}

/**
 * A KTX2 body carries its own chain (block-compressed formats cannot be
 * mip-generated on the GPU); only uncompressed pixels defer to runtime generation.
 */
function cookedMipPolicy(ktx2: EncodedTexture | null, mipmap: boolean): TextureMipPolicy {
  if (ktx2 !== null) return { kind: 'packed', levelCount: ktx2.levelCount };
  return mipmap ? { kind: 'generate' } : { kind: 'none' };
}

async function importImage(ctx: ImportContext): Promise<ImportResult> {
  if (ctx.source.toLowerCase().endsWith('.texture.json')) {
    return importTextureSource(ctx);
  }
  if (ctx.source.toLowerCase().endsWith('.cube')) {
    return importCubeSource(ctx);
  }
  const requiredKind = requiredImageOutputKind(ctx.source);
  if (requiredKind !== undefined) {
    const topologyError = validateImageOutputTopology(ctx, requiredKind);
    if (topologyError !== undefined) return { ok: false, error: topologyError };
  }

  const read = await ctx.readSource();
  if (!read.ok) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: `readable source file at "${ctx.source}"`,
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: {
          source: ctx.source,
          reason: read.error instanceof Error ? read.error.message : String(read.error),
        },
      }),
    };
  }
  const mime = mimeFromSource(ctx.source);

  if (ctx.source.toLowerCase().endsWith('.basis')) {
    return importBasisSource(ctx, read.value);
  }
  if (ctx.source.toLowerCase().endsWith('.ktx2')) {
    return importKtx2Source(ctx, read.value);
  }

  // --- HDR arm (D-6): .hdr equirect source is decoded via decodeHdr -> f16 ---
  if (mime === undefined && ctx.source.toLowerCase().endsWith('.hdr')) {
    const { decodeHdr } = await import('./hdr-decoder.js');
    const decoded = decodeHdr(read.value);
    if (!decoded.ok) {
      return {
        ok: false,
        error: imageConversionFailure(
          ctx,
          'decode',
          'hdr',
          ctx.source,
          'valid Radiance RGBE bytes to decode into an equirect asset',
          `image:${decoded.error.code}`,
          'repair the HDR header or pixel payload and retry the import',
        ),
      };
    }
    const dec = decoded.value;
    const { halfFloat } = await import('@forgeax/engine-math');
    const f16Bytes = halfFloat.f32ToF16Bytes(
      new Uint8Array(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength),
    );

    // NO block-compression for equirect (feat-20260707 M5 fix). The .hdr arm
    // folds only `kind:'equirect'` sub-assets, and an equirect is ALWAYS an IBL /
    // skybox source: the runtime drives it through equirect-to-cube / irradiance /
    // prefilter / brdf-lut RENDER passes (Skylight.equirect / SkyboxBackground.
    // equirect). A BC6H (block-compressed) texture is sample-only, never a color-
    // renderable render target, so a BC6H equirect breaks cube projection with a
    // "BC6HRGBUfloat is not color renderable" WebGPU error. The equirect must stay
    // uncompressed rgba16float; the catalog `compression` discriminant is forced to
    // 'none' in import-texture.ts (compressionFor), so the two agree. A purely-
    // sampled HDR 2D texture (never folded by this arm) may still take the
    // UASTC-HDR path via the standard image arm below.
    const out: ImportedAsset[] = [];
    for (const sub of ctx.subAssets) {
      // The .hdr arm folds equirect sub-assets only: a single 2D rgba16float
      // image (the lat-long env map) with a disk identity. The cube-to-cube IBL
      // projection is a GPU-side pass driven by the runtime record arm, not a
      // build-time fold (feat-20260630 w5; orchestrator adjudication: equirect
      // produces a build .bin, unlike the retired cube-texture).
      if (sub.kind !== 'equirect') continue;
      const payload: EquirectAsset = {
        kind: 'equirect',
        width: dec.width,
        height: dec.height,
        format: 'rgba16float',
        data: f16Bytes,
        colorSpace: 'linear',
      };
      out.push({
        guid: sub.guid,
        kind: 'equirect',
        payload,
        refs: [],
        artifacts: {
          body: {
            mediaType: 'application/x-forgeax-rgba16f',
            assetCodec: { name: 'rgba16float' },
            bytes: f16Bytes,
          },
        },
      });
    }
    return { ok: true, value: { assets: out, sourceDependencies: [] } };
  }

  // --- Standard PNG/JPEG path ---
  if (mime === undefined) {
    throw new Error(
      `imageImporter: unsupported source extension for "${ctx.source}" (expected .png / .jpg / .jpeg / .hdr / .ktx2 / .basis)`,
    );
  }

  const cooked = await cookLdrImage(
    read.value,
    mime,
    ctx.importSettings,
    mipmapTokenToBoolean(ctx.importSettings.mipmap),
  );
  if (!cooked.ok) {
    const error = cooked.error;
    const encodeFailed = 'mode' in error;
    return {
      ok: false,
      error: imageConversionFailure(
        ctx,
        encodeFailed ? 'encode' : 'decode',
        encodeFailed
          ? error.code === 'ktx2-encode-source-too-large'
            ? 'ktx2-source-too-large'
            : 'ktx2-encode-refused'
          : 'ldr',
        encodeFailed ? `${ctx.source}#compressionMode` : ctx.source,
        encodeFailed
          ? 'the requested compression mode to accept the decoded image'
          : 'valid PNG or JPEG bytes to decode into RGBA pixels',
        encodeFailed ? `codec:${error.code},mode:${error.mode}` : `image:${error.code}`,
        encodeFailed
          ? error.code === 'ktx2-encode-source-too-large'
            ? 'reduce source dimensions or set compressionMode to none'
            : 'repair the source image or compression settings and retry the import'
          : 'repair the source image bytes and retry the import',
      ),
    };
  }
  const { texture, encoded } = cooked.value;

  const out: ImportedAsset[] = [];
  for (const sub of ctx.subAssets) {
    // Only flat 2D image sub-assets are folded here; cube-texture sub-assets
    // ride the runtime IBL multi-face cook and are intentionally not produced.
    if (sub.kind !== 'texture') continue;
    out.push({
      guid: sub.guid,
      kind: 'texture',
      payload: texture,
      refs: [],
      artifacts: {
        body: {
          mediaType: encoded === null ? 'application/x-forgeax-rgba8' : 'image/ktx2',
          assetCodec:
            encoded === null
              ? { name: 'rgba8', version: '1' }
              : {
                  name: 'basis',
                  container: 'ktx2',
                  profile: encoded.mode,
                },
          bytes: texture.data,
        },
      },
    });
  }
  return { ok: true, value: { assets: out, sourceDependencies: [] } };
}

/** Bind the image producer to the generic importer runner's decode seam. */
export const decodeImageForImport: ImportContext['decodeImage'] = async (
  bytes,
  mimeType,
  importSettings,
) => {
  const cooked = await cookLdrImage(
    bytes,
    mimeType,
    importSettings,
    importSettings.mipmap === true,
  );
  if (!cooked.ok) {
    if ('mode' in cooked.error) {
      throw new Error(
        `embedded texture compression failed (${cooked.error.code} / ${cooked.error.mode}): ${cooked.error.reason}`,
      );
    }
    return { ok: false as const, error: cooked.error };
  }
  const { texture, encoded } = cooked.value;
  return {
    ok: true as const,
    value: {
      texture,
      bytes: texture.data,
      mediaType: encoded === null ? mimeType : 'image/ktx2',
      assetCodec:
        encoded === null
          ? { name: 'rgba8', version: '1' }
          : { name: 'basis', profile: encoded.mode },
    },
  };
};

/**
 * The image {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'image'` sidecars here and can
 * offer the same producer's decoder to importers with embedded images.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { imageImporter } from '@forgeax/engine-image/image-importer';
 * const importers = new ImporterRegistry();
 * importers.register(imageImporter);
 * ```
 */
export const imageImporter: Importer = {
  key: 'image',
  import: importImage,
  capabilities: { decodeImage: decodeImageForImport },
};

export { cubeLutBytes, parseCubeLut } from './lut/cube-parser.js';
export { importCubeSource, produceCubeTexture } from './lut/cube-producer.js';
