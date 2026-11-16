import {
  initBasisTranscoder,
  ktx2ColorSpace,
  ktx2IsNative,
  parseKtx2,
} from '@forgeax/engine-codec';
import type { TextureAsset } from '@forgeax/engine-types';
import type { AssetOutputProduct } from './scriptable-pack.js';

/** Container metadata must agree with the authored source before opening a codec handle. */
function portableMetadata(texture: TextureAsset) {
  if (texture.shape.viewDimension !== '2d' || texture.mips.kind === 'generate')
    throw new TypeError('Basis KTX2 requires a 2D source with an authored mip chain');
  const parsed = parseKtx2(texture.data);
  if (!parsed.ok) throw new TypeError(`Invalid Basis KTX2 container: ${parsed.error.code}`);
  const { header, dfd } = parsed.value;
  const levels = texture.mips.kind === 'packed' ? texture.mips.levelCount : 1;
  const { width, height } = texture.shape.extent;
  if (
    ktx2IsNative(parsed.value) ||
    header.pixelDepth !== 0 ||
    header.layerCount > 1 ||
    header.faceCount !== 1 ||
    header.pixelWidth !== width ||
    header.pixelHeight !== height ||
    Math.max(1, header.levelCount) !== levels ||
    ktx2ColorSpace(parsed.value) !== texture.colorSpace
  )
    throw new TypeError(
      'Basis KTX2 shape, mip count and transfer function must match source metadata',
    );
  return { width, height, levels, colorModel: dfd?.colorModel };
}

/** Preserve portable source bytes; inspect the container without transcoding or encoding. */
export async function portableKtx2Product(texture: TextureAsset): Promise<AssetOutputProduct> {
  const { width, height, levels, colorModel } = portableMetadata(texture);
  const module = await initBasisTranscoder();
  const file = new module.KTX2File(texture.data);
  try {
    if (
      !file.isValid() ||
      file.getWidth() !== width ||
      file.getHeight() !== height ||
      file.getLevels() !== levels
    )
      throw new TypeError('Basis KTX2 source failed transcoder inspection');
    const profile = file.isETC1S()
      ? 'etc1s'
      : file.isHDR() || file.isHDR4x4()
        ? 'uastc-hdr'
        : file.isUASTC_LDR_4x4()
          ? 'uastc-ldr'
          : undefined;
    const model =
      profile === 'etc1s'
        ? 163
        : profile === 'uastc-ldr'
          ? 166
          : profile === 'uastc-hdr'
            ? 167
            : undefined;
    if (profile === undefined || colorModel !== model)
      throw new TypeError('Basis KTX2 profile must match its DFD color model');
    const format =
      profile === 'uastc-hdr'
        ? 'rgba16float'
        : texture.colorSpace === 'srgb'
          ? 'rgba8unorm-srgb'
          : 'rgba8unorm';
    if (texture.format !== format || (profile === 'uastc-hdr' && texture.colorSpace !== 'linear'))
      throw new TypeError(
        'Basis KTX2 profile and color space must match the declared source format',
      );
    return {
      payload: texture,
      refs: [],
      artifacts: {
        body: {
          mediaType: 'image/ktx2',
          assetCodec: { name: 'basis', container: 'ktx2', profile, version: '1' },
          bytes: Uint8Array.from(texture.data),
        },
      },
    };
  } finally {
    file.close();
    file.delete();
  }
}
