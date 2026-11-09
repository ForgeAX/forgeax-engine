// Content-identified textures: with `importSettings.textureIdentity: 'content'`
// each image's texture GUID is derived from its bytes and decode settings, so
// glTF files that embed or reference the same image for the same use share one
// texture asset instead of each publishing a copy.

import { textureContentIdentity } from '@forgeax/engine-pack/guid';

/** `importSettings.textureIdentity` value that opts a glTF into content-identified textures. */
export const TEXTURE_IDENTITY_CONTENT = 'content';

/** Import settings `decodeImage` reads besides colour space and mipmap. */
const DECODE_SETTING_KEYS = ['compressionMode', 'downscaleMaxDimension'] as const;

/** Whether the meta opts its textures into content identity. */
export function usesTextureContentIdentity(
  importSettings: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return importSettings?.textureIdentity === TEXTURE_IDENTITY_CONTENT;
}

/**
 * Identity of one image as the importer decodes it: bytes, media type, the
 * colour space its material slots assign, and every decode setting. The same
 * bytes used as an sRGB colour map and as a linear data map get different
 * identities; samplers are separate assets and do not participate.
 */
export function gltfTextureContentIdentity(
  bytes: Uint8Array,
  mimeType: string,
  colorSpace: string,
  importSettings: Readonly<Record<string, unknown>>,
): { readonly sourceKey: string; readonly guid: string } {
  const settings: Record<string, string | number | boolean> = {
    mimeType,
    colorSpace,
    mipmap: (importSettings.mipmap ?? true) === true,
  };
  for (const key of DECODE_SETTING_KEYS) {
    const value = importSettings[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      settings[key] = value;
  }
  return textureContentIdentity(bytes, settings);
}
