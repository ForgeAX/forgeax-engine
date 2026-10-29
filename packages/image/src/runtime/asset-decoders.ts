import {
  initBasisTranscoder,
  ktx2ColorSpace,
  parseKtx2,
  transcodeBasis,
  transcodeKtx2,
} from '@forgeax/engine-codec';
import {
  type ArtifactDescriptor,
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

type BasisModule = Awaited<ReturnType<typeof initBasisTranscoder>>;
type EncodedFile =
  | InstanceType<BasisModule['KTX2File']>
  | InstanceType<NonNullable<BasisModule['BasisFile']>>;
type Ktx2Source = Extract<ReturnType<typeof parseKtx2>, { ok: true }>['value'];
type AssetCodec = NonNullable<ArtifactDescriptor['assetCodec']>;
type EncodedContainer = NonNullable<AssetCodec['container']>;
type BasisProfile = 'etc1s' | 'uastc-ldr' | 'uastc-hdr';

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
  if (body !== undefined) {
    const read = await artifacts.read(body);
    if (!read.ok) return err(read.error);
    return readArtifactSurface(envelope.guid, expected, kind, payload, body, read.value);
  }
  const data = imageBytes((payload as { data?: unknown }).data);
  return readDecodedSurface(envelope.guid, expected, kind, {
    ...payload,
    ...(data === undefined ? {} : { data }),
  });
}

function basisCodec(body: ArtifactDescriptor): AssetCodec | undefined {
  return body.assetCodec?.name === 'basis' ? body.assetCodec : undefined;
}

function encodedContainer(body: ArtifactDescriptor): EncodedContainer | undefined {
  const codec = basisCodec(body);
  if (codec?.container !== undefined) return codec.container;
  if (body.mediaType === 'image/ktx2') return 'ktx2';
  return body.mediaType === 'image/basis' ? 'basis' : undefined;
}

function hdrProfileRejected(
  profile: string | undefined,
  container: EncodedContainer,
  colorSpace: TextureAsset['colorSpace'],
): boolean {
  return profile === 'uastc-hdr' && (container !== 'ktx2' || colorSpace !== 'linear');
}

function declaredProfileRejected(
  codec: AssetCodec | undefined,
  container: EncodedContainer,
  colorSpace: TextureAsset['colorSpace'],
): boolean {
  const profile = codec?.profile;
  return (
    (container !== 'basis' && container !== 'ktx2') ||
    (codec !== undefined &&
      profile !== 'etc1s' &&
      profile !== 'uastc' &&
      profile !== 'uastc-ldr' &&
      profile !== 'uastc-hdr') ||
    hdrProfileRejected(profile, container, colorSpace)
  );
}

function codecDecodeFailure(
  guid: string,
  kind: string,
  container: EncodedContainer,
  profile: string | undefined,
  cause: { code: string; expected: string; hint: string; detail?: unknown },
) {
  return err<AssetLoadError>({
    code: 'asset-decode-failed',
    expected: cause.expected,
    hint: cause.hint,
    detail: {
      guid,
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
}

function openEncodedFile(
  module: BasisModule,
  container: EncodedContainer,
  bytes: Uint8Array,
): EncodedFile | undefined {
  if (container === 'ktx2') return new module.KTX2File(bytes);
  return module.BasisFile === undefined ? undefined : new module.BasisFile(bytes);
}

function encodedFileShapeSupported(file: EncodedFile): boolean {
  if ('getWidth' in file) return file.isValid() && file.getFaces() === 1 && file.getLayers() <= 1;
  return file.getNumImages() === 1;
}

function encodedFileProfile(module: BasisModule, file: EncodedFile): BasisProfile | undefined {
  const actual = file.getBasisTexFormat();
  if (actual === module.basis_tex_format.cETC1S.value) return 'etc1s';
  if (actual === module.basis_tex_format.cUASTC_LDR_4x4.value) return 'uastc-ldr';
  return actual === module.basis_tex_format.cUASTC_HDR_4x4.value ? 'uastc-hdr' : undefined;
}

function actualProfileMatchesDeclared(actual: BasisProfile, declared: string | undefined): boolean {
  return declared === undefined || actual === (declared === 'uastc' ? 'uastc-ldr' : declared);
}

function transcodeEncodedSource(
  parsed: Ktx2Source | undefined,
  bytes: Uint8Array,
  target: ReturnType<typeof encodedTargetFormat>,
): ReturnType<typeof transcodeBasis> {
  return parsed === undefined ? transcodeBasis(bytes, target) : transcodeKtx2(parsed, target);
}

function encodedTargetFormat(
  profile: BasisProfile,
  colorSpace: TextureAsset['colorSpace'],
): 'rgba16float' | 'rgba8unorm-srgb' | 'rgba8unorm' {
  if (profile === 'uastc-hdr') return 'rgba16float';
  return colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

function encodedTextureLayout(file: EncodedFile): {
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
} {
  if ('getWidth' in file) {
    return { width: file.getWidth(), height: file.getHeight(), levelCount: file.getLevels() };
  }
  return {
    width: file.getImageWidth(0, 0),
    height: file.getImageHeight(0, 0),
    levelCount: file.getNumLevels(0),
  };
}

// Source admission validates the container but retains its single immutable
// encoded byte source. Device capabilities belong to Renderer derivation.
async function readArtifactSurface<P extends TextureAsset | EquirectAsset>(
  guid: string,
  expected: string,
  kind: P['kind'],
  payload: object,
  body: ArtifactDescriptor,
  bytes: Uint8Array,
): Promise<AssetDecoderResult<P>> {
  const container = encodedContainer(body);
  if (container === undefined)
    return readDecodedSurface(guid, expected, kind, { ...payload, data: bytes });
  const candidate = payload as Partial<TextureAsset>;
  const colorSpace = candidate.colorSpace;
  if (colorSpace !== 'srgb' && colorSpace !== 'linear')
    return invalid(guid, expected, `${kind} color space is invalid`);
  const codec = basisCodec(body);
  if (declaredProfileRejected(codec, container, colorSpace))
    return invalid(guid, expected, 'basis-profile-unsupported');
  const profile = codec?.profile;
  const parsed = container === 'ktx2' ? await parseKtx2(bytes) : undefined;
  if (parsed !== undefined && !parsed.ok)
    return codecDecodeFailure(guid, kind, container, profile, parsed.error);
  if (parsed !== undefined && ktx2ColorSpace(parsed.value) !== colorSpace)
    return invalid(guid, expected, 'ktx2-color-space-mismatch');
  try {
    const module = await initBasisTranscoder();
    const file = openEncodedFile(module, container, bytes);
    if (file === undefined) return invalid(guid, expected, 'basis-file-unavailable');
    try {
      if (!encodedFileShapeSupported(file))
        return invalid(guid, expected, 'basis-image-shape-unsupported');
      const actualProfile = encodedFileProfile(module, file);
      if (actualProfile === undefined || hdrProfileRejected(actualProfile, container, colorSpace))
        return invalid(guid, expected, 'basis-profile-unsupported');
      if (!actualProfileMatchesDeclared(actualProfile, profile))
        return invalid(guid, expected, 'basis-profile-mismatch');
      const target = encodedTargetFormat(actualProfile, colorSpace);
      // Equirect drives renderable IBL products and intentionally uses decoded
      // pixels. Ordinary sampled textures keep the compressed source.
      if (kind === 'equirect') {
        const transcoded = await transcodeEncodedSource(parsed?.value, bytes, target);
        if (!transcoded.ok)
          return codecDecodeFailure(guid, kind, container, profile, transcoded.error);
        const mip = transcoded.value.mips[0];
        if (mip === undefined) return invalid(guid, expected, 'codec:base-mip-missing');
        return readDecodedSurface(guid, expected, kind, {
          ...payload,
          width: mip.width,
          height: mip.height,
          format: target,
          data: mip.data,
        });
      }
      const { width, height, levelCount } = encodedTextureLayout(file);
      return readDecodedSurface(guid, expected, kind, {
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
      guid,
      expected,
      cause instanceof Error ? cause.message : 'basis-inspection-failed',
    );
  }
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
