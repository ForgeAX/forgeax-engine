import { basisEncode } from '@forgeax/engine-codec/encode';
import { ok, type TextureAsset } from '@forgeax/engine-types';
import { textureContribution } from '../../../image/src/runtime/asset-decoders';

export async function encodedTexture(color = 127, srgb = false): Promise<TextureAsset> {
  const bytes = await basisEncode(new Uint8Array(16 * 16 * 4).fill(color), {
    mode: 'uastc-ldr',
    width: 16,
    height: 16,
    srgb,
    perceptual: false,
    uastcSupercompression: true,
    mipGen: true,
  });
  if (!bytes.ok) throw bytes.error;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes.value)));
  const hash = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return (
    await textureContribution.decoder.decode({
      envelope: {
        guid: 'encoded-texture',
        kind: 'texture',
        refs: [],
        payload: { kind: 'texture', colorSpace: srgb ? 'srgb' : 'linear' } as TextureAsset,
        artifacts: {
          body: {
            path: 'image.ktx2',
            mediaType: 'image/ktx2',
            contentEncoding: 'identity',
            byteLength: bytes.value.byteLength,
            integrity: { algorithm: 'sha256', digest: hash },
            assetCodec: { name: 'basis', container: 'ktx2', profile: 'uastc-ldr' },
          },
        },
      },
      signal: new AbortController().signal,
      artifacts: { read: async () => ok(bytes.value) },
    })
  ).unwrap();
}
