import { parseKtx2, transcodeBasis, transcodeKtx2 } from '@forgeax/engine-codec';
import {
  type AssetDecoderContribution,
  type AssetDecoderInput,
  type AssetDecoderResult,
  type AssetKind,
  type AssetLoadError,
  type EquirectAsset,
  err,
  ok,
  type TextureAsset,
} from '@forgeax/engine-types';

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

function compressedImageTarget(colorSpace: TextureAsset['colorSpace']): TextureAsset['format'] {
  return colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

function validTextureSurface(
  value: unknown,
): value is Pick<TextureAsset, 'shape' | 'format' | 'data' | 'colorSpace' | 'mips'> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<TextureAsset>;
  const shape = candidate.shape;
  const extent = shape?.viewDimension === '2d' ? shape.extent : undefined;
  const mips = candidate.mips;
  return (
    extent !== undefined &&
    validDimensions(extent.width, extent.height) &&
    mips !== undefined &&
    (mips.kind === 'none' ||
      mips.kind === 'generate' ||
      (mips.kind === 'packed' && Number.isSafeInteger(mips.levelCount) && mips.levelCount > 0)) &&
    typeof candidate.format === 'string' &&
    imageBytes(candidate.data) !== undefined &&
    (candidate.colorSpace === 'srgb' || candidate.colorSpace === 'linear')
  );
}

function validEquirectSurface(
  value: unknown,
): value is Pick<EquirectAsset, 'width' | 'height' | 'format' | 'data' | 'colorSpace'> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<EquirectAsset>;
  return (
    validDimensions(candidate.width ?? 0, candidate.height ?? 0) &&
    typeof candidate.format === 'string' &&
    imageBytes(candidate.data) !== undefined &&
    (candidate.colorSpace === 'srgb' || candidate.colorSpace === 'linear')
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

    // Pack v2 keeps the authored TextureAsset format device-neutral while the
    // artifact may carry a Basis KTX2/raw-Basis delivery codec. The new
    // AssetDecoder seam has no device-capability input, so its safe baseline is
    // an uncompressed RGBA target; the renderer can upload that POD on every
    // backend without interpreting container bytes as pixels.
    if (body.assetCodec?.name === 'basis' && body.assetCodec.container !== undefined) {
      const candidate = payload as Partial<TextureAsset>;
      if (candidate.colorSpace !== 'srgb' && candidate.colorSpace !== 'linear') {
        return invalid(envelope.guid, expected, `${kind} color space is invalid`);
      }
      const target = compressedImageTarget(candidate.colorSpace);
      const transcoded =
        body.assetCodec.container === 'ktx2'
          ? await parseKtx2(bytes).then((parsed) =>
              parsed.ok ? transcodeKtx2(parsed.value, target) : parsed,
            )
          : await transcodeBasis(bytes, target);
      if (!transcoded.ok) {
        return invalid(envelope.guid, expected, `codec:${transcoded.error.code}`);
      }
      const mip = transcoded.value.mips[0];
      if (mip === undefined) return invalid(envelope.guid, expected, 'codec:base-mip-missing');
      data = mip.data;
      return readDecodedSurface(
        envelope.guid,
        expected,
        kind,
        kind === 'texture'
          ? {
              ...payload,
              shape: { viewDimension: '2d', extent: { width: mip.width, height: mip.height } },
              format: target,
              data,
              mips: { kind: 'none' },
            }
          : { ...payload, width: mip.width, height: mip.height, format: target, data },
      );
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
  if (kind === 'texture' ? !validTextureSurface(candidate) : !validEquirectSurface(candidate)) {
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
    async decode(input) {
      return readImageSurface(
        input,
        'equirect',
        'an equirect payload with dimensions, format, color space, and bytes',
      );
    },
  },
};
