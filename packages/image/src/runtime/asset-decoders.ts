import {
  initBasisTranscoder,
  ktx2ColorSpace,
  parseKtx2,
  transcodeBasis,
  transcodeKtx2,
} from '@forgeax/engine-codec';
import {
  type AssetDecoderContribution,
  type AssetDecoderInput,
  type AssetDecoderResult,
  AssetError,
  type AssetKind,
  type AssetLoadError,
  type EquirectAsset,
  err,
  ok,
  type Result,
  type TextureAsset,
  validateTextureLayout,
} from '@forgeax/engine-types';
import { parseTextureMipPolicy, parseTextureShape } from '../texture/parse-layout';

function invalid(guid: string, expected: string, reason: string) {
  return err<AssetLoadError>({
    code: 'asset-package-invalid',
    expected,
    hint: 'recook the image asset and publish its complete device-neutral payload',
    detail: { guid, reason },
  });
}

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;
}

function imageBytes(value: unknown): Uint8Array | Uint8ClampedArray | undefined {
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return value;
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return undefined;
  }
  return Uint8Array.from(value);
}

/** Validates runtime source structure without copying pixels or initializing a codec. */
export function prepareRuntimeTexture(value: TextureAsset): Result<TextureAsset, AssetError> {
  const fail = (expected: string) =>
    err(
      new AssetError({
        code: 'asset-invalid-value',
        expected,
        hint: 'supply a complete native texture or replace its complete Basis/KTX2 source',
      }),
    );
  if (
    value === null ||
    typeof value !== 'object' ||
    value.kind !== 'texture' ||
    !(value.data instanceof Uint8Array) ||
    (value.colorSpace !== 'linear' && value.colorSpace !== 'srgb')
  )
    return fail('a TextureAsset with Uint8Array data and an explicit color space');
  const shape = parseTextureShape(value.shape),
    mips = parseTextureMipPolicy(value.mips);
  if (shape === undefined || mips === undefined || typeof value.format !== 'string')
    return fail('a complete texture shape, format and mip policy');
  if (value.encoding !== undefined) {
    if (value.encoding !== 'basis' && value.encoding !== 'ktx2')
      return fail('Basis or KTX2 source encoding');
    if (shape.viewDimension !== '2d' || mips.kind === 'generate')
      return fail('encoded 2D images with an authored mip chain');
    if (
      value.format !== (value.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm') &&
      !(
        value.format === 'rgba16float' &&
        value.colorSpace === 'linear' &&
        value.encoding === 'ktx2'
      )
    )
      return fail('RGBA8 LDR or linear KTX2 RGBA16 HDR source texels');
    const magic =
      value.encoding === 'basis'
        ? [0x73, 0x42]
        : [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      value.data.length < (value.encoding === 'basis' ? 77 : 80) ||
      magic.some((byte, i) => value.data[i] !== byte)
    )
      return fail('a complete encoded source with the declared container signature');
    if (value.encoding === 'ktx2') {
      const parsed = parseKtx2(value.data);
      if (!parsed.ok) return fail(parsed.error.expected);
      const { header, dfd } = parsed.value;
      const levels = mips.kind === 'packed' ? mips.levelCount : 1;
      if (
        header.pixelWidth !== shape.extent.width ||
        header.pixelHeight !== shape.extent.height ||
        header.pixelDepth > 1 ||
        header.layerCount > 1 ||
        header.faceCount !== 1 ||
        Math.max(1, header.levelCount) !== levels ||
        ktx2ColorSpace(parsed.value) !== value.colorSpace ||
        ![163, 166, 167].includes(dfd?.colorModel ?? 0) ||
        (dfd?.colorModel === 167) !== (value.format === 'rgba16float')
      )
        return fail(
          'encoded KTX2 shape, complete mip count, transfer function and HDR model match its source metadata',
        );
    }
  }
  const layout = validateTextureLayout({
    shape,
    format: value.format,
    mips,
    ...(value.encoding === undefined ? { actualByteLength: value.data.byteLength } : {}),
  });
  if (!layout.ok) return fail(layout.error.expected);
  return ok(value);
}

function validTextureSurface(
  value: unknown,
): value is Pick<TextureAsset, 'shape' | 'format' | 'data' | 'colorSpace' | 'mips'> {
  if (value === null || typeof value !== 'object') return false;
  return prepareRuntimeTexture(value as TextureAsset).ok;
}

/** The image owner shares complete equirect admission across decode and runtime edits. */
export function prepareRuntimeEquirect(value: EquirectAsset): Result<EquirectAsset, AssetError> {
  const valid =
    value !== null &&
    typeof value === 'object' &&
    value.kind === 'equirect' &&
    validDimensions(value.width, value.height) &&
    typeof value.format === 'string' &&
    (value.data instanceof Uint8Array || value.data instanceof Uint8ClampedArray) &&
    (value.colorSpace === 'srgb' || value.colorSpace === 'linear') &&
    validateTextureLayout({
      shape: { viewDimension: '2d', extent: { width: value.width, height: value.height } },
      format: value.format,
      mips: { kind: 'none' },
      actualByteLength: value.data.byteLength,
    }).ok;
  return valid
    ? ok(value)
    : err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'complete equirect dimensions, format, color space and matching pixel bytes',
          hint: 'replace the equirect with a complete image surface',
        }),
      );
}

async function readImageSurface<P extends TextureAsset | EquirectAsset>(
  input: AssetDecoderInput<P>,
  kind: P['kind'],
  expected: string,
): Promise<AssetDecoderResult<P>> {
  const { envelope, artifacts } = input;
  const payload = envelope.payload as unknown;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    (payload as { kind?: unknown }).kind !== kind
  ) {
    return invalid(envelope.guid, expected, `${kind} owner validation failed`);
  }

  const body = envelope.artifacts.body ?? envelope.artifacts.atlas;
  let data = imageBytes((payload as { data?: unknown }).data);
  if (body !== undefined) {
    const read = await artifacts.read(body);
    if (!read.ok) return err(read.error);
    const bytes = read.value;
    data = bytes;

    // Source admission validates the container but retains its single immutable
    // encoded byte source. Device capabilities belong to Renderer derivation.
    const codec = body.assetCodec?.name === 'basis' ? body.assetCodec : undefined;
    const container =
      codec?.container ??
      (body.mediaType === 'image/ktx2'
        ? 'ktx2'
        : body.mediaType === 'image/basis'
          ? 'basis'
          : undefined);
    if (container !== undefined) {
      const candidate = payload as Partial<TextureAsset>;
      if (candidate.colorSpace !== 'srgb' && candidate.colorSpace !== 'linear')
        return invalid(envelope.guid, expected, `${kind} color space is invalid`);
      const profile = codec?.profile;
      if (
        (container !== 'basis' && container !== 'ktx2') ||
        (codec !== undefined &&
          profile !== 'etc1s' &&
          profile !== 'uastc' &&
          profile !== 'uastc-ldr' &&
          profile !== 'uastc-hdr') ||
        (profile === 'uastc-hdr' && (container !== 'ktx2' || candidate.colorSpace !== 'linear'))
      )
        return invalid(envelope.guid, expected, 'basis-profile-unsupported');
      const codecFailure = (cause: {
        code: string;
        expected: string;
        hint: string;
        detail?: unknown;
      }) =>
        err<AssetLoadError>({
          code: 'asset-decode-failed',
          expected: cause.expected,
          hint: cause.hint,
          detail: {
            guid: envelope.guid,
            kind,
            cause: {
              ...cause,
              detail: {
                container,
                profile,
                ...(typeof cause.detail === 'object' && cause.detail !== null ? cause.detail : {}),
              },
            },
          },
        });
      const parsed = container === 'ktx2' ? await parseKtx2(bytes) : undefined;
      if (parsed !== undefined && !parsed.ok) return codecFailure(parsed.error);
      if (parsed?.ok && ktx2ColorSpace(parsed.value) !== candidate.colorSpace)
        return invalid(envelope.guid, expected, 'ktx2-color-space-mismatch');
      try {
        const module = await initBasisTranscoder();
        const file =
          container === 'ktx2'
            ? new module.KTX2File(bytes)
            : module.BasisFile === undefined
              ? undefined
              : new module.BasisFile(bytes);
        if (file === undefined) return invalid(envelope.guid, expected, 'basis-file-unavailable');
        try {
          const ktx = 'getWidth' in file ? file : undefined;
          const raw = 'getNumImages' in file ? file : undefined;
          if (
            (ktx !== undefined &&
              (!ktx.isValid() || ktx.getFaces() !== 1 || ktx.getLayers() > 1)) ||
            (raw !== undefined && raw.getNumImages() !== 1)
          )
            return invalid(envelope.guid, expected, 'basis-image-shape-unsupported');
          const actual = file.getBasisTexFormat();
          const actualProfile =
            actual === module.basis_tex_format.cETC1S.value
              ? 'etc1s'
              : actual === module.basis_tex_format.cUASTC_LDR_4x4.value
                ? 'uastc-ldr'
                : actual === module.basis_tex_format.cUASTC_HDR_4x4.value
                  ? 'uastc-hdr'
                  : undefined;
          if (
            actualProfile === undefined ||
            (actualProfile === 'uastc-hdr' &&
              (container !== 'ktx2' || candidate.colorSpace !== 'linear'))
          )
            return invalid(envelope.guid, expected, 'basis-profile-unsupported');
          if (
            profile !== undefined &&
            actualProfile !== (profile === 'uastc' ? 'uastc-ldr' : profile)
          )
            return invalid(envelope.guid, expected, 'basis-profile-mismatch');
          const target =
            actualProfile === 'uastc-hdr'
              ? 'rgba16float'
              : candidate.colorSpace === 'srgb'
                ? 'rgba8unorm-srgb'
                : 'rgba8unorm';
          // Equirect drives renderable IBL products and intentionally uses decoded
          // pixels. Ordinary sampled textures keep the compressed source.
          if (kind === 'equirect') {
            const transcoded = parsed?.ok
              ? await transcodeKtx2(parsed.value, target)
              : await transcodeBasis(bytes, target);
            if (!transcoded.ok) return codecFailure(transcoded.error);
            const mip = transcoded.value.mips[0];
            if (mip === undefined)
              return invalid(envelope.guid, expected, 'codec:base-mip-missing');
            return readDecodedSurface(envelope.guid, expected, kind, {
              ...payload,
              width: mip.width,
              height: mip.height,
              format: target,
              data: mip.data,
            });
          }
          const width = ktx?.getWidth() ?? raw?.getImageWidth(0, 0) ?? 0;
          const height = ktx?.getHeight() ?? raw?.getImageHeight(0, 0) ?? 0;
          const levelCount = ktx?.getLevels() ?? raw?.getNumLevels(0) ?? 0;
          return readDecodedSurface(envelope.guid, expected, kind, {
            ...payload,
            shape: { viewDimension: '2d', extent: { width, height } },
            format: target,
            data: bytes,
            encoding: container,
            mips: { kind: 'packed', levelCount },
          });
        } finally {
          file.close();
        }
      } catch (cause) {
        return invalid(
          envelope.guid,
          expected,
          cause instanceof Error ? cause.message : 'basis-inspection-failed',
        );
      }
    }
  }

  return readDecodedSurface(envelope.guid, expected, kind, {
    ...payload,
    ...(data === undefined ? {} : { data }),
  });
}

function readDecodedSurface<P extends TextureAsset | EquirectAsset>(
  guid: string,
  expected: string,
  kind: P['kind'],
  candidate: unknown,
): ReturnType<typeof ok<P>> | ReturnType<typeof err<AssetLoadError>> {
  if (
    kind === 'texture'
      ? !validTextureSurface(candidate)
      : !prepareRuntimeEquirect(candidate as EquirectAsset).ok
  ) {
    return invalid(guid, expected, 'image owner validation failed');
  }
  return ok(candidate as P);
}

export const textureContribution: AssetDecoderContribution<TextureAsset, 'texture'> = {
  kind: { kind: 'texture' } as AssetKind<TextureAsset, 'texture'>,
  consumer: 'Image/Render DeviceScope',
  decoder: {
    async decode(input) {
      return readImageSurface(
        input,
        'texture',
        'a texture payload with dimensions, format, color space, and bytes',
      );
    },
  },
};

export const equirectContribution: AssetDecoderContribution<EquirectAsset, 'equirect'> = {
  kind: { kind: 'equirect' } as AssetKind<EquirectAsset, 'equirect'>,
  consumer: 'Image/Render DeviceScope',
  decoder: {
    prepare: prepareRuntimeEquirect,
    async decode(input) {
      return readImageSurface(
        input,
        'equirect',
        'an equirect payload with dimensions, format, color space, and bytes',
      );
    },
  },
};
