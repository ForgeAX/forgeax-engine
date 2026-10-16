import { imageImporter } from '@forgeax/engine/image/image-importer';
import type { ImportContext, TextureAsset } from '@forgeax/engine/types';
import { encodeHdr, encodePng } from '../../../features/asset-formats/fixtures/image-files';
import { checker, errorCode, guid } from '../../../features/asset-formats/fixtures/memory-pack';

export type SubAsset = ImportContext['subAssets'][number];

export function imageContext(
  source: string,
  bytes: Uint8Array,
  subAssets: readonly SubAsset[],
  importSettings: Readonly<Record<string, unknown>> = {},
): ImportContext {
  return {
    source,
    readSource: async () => ({ ok: true, value: bytes }),
    readSibling: async () => ({ ok: false, error: undefined as never }),
    decodeImage: imageImporter.capabilities?.decodeImage as ImportContext['decodeImage'],
    subAssets,
    importSettings,
  };
}

export const TEXTURE_SUB: readonly SubAsset[] = [
  { guid: guid(0x101), sourceIndex: 0, kind: 'texture' },
];
export const EQUIRECT_SUB: readonly SubAsset[] = [
  { guid: guid(0x102), sourceIndex: 0, kind: 'equirect' },
];

export const CHECKER_PNG = encodePng(16, 16, checker());
/** RGBE (128, 64, 32, 129) decodes to linear (1.0, 0.5, 0.25). */
export const WARM_HDR = encodeHdr(16, 8, [128, 64, 32, 129]);

export interface ImportedAssetView {
  readonly guid: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly artifacts?: Readonly<
    Record<
      string,
      {
        readonly mediaType: string;
        readonly assetCodec?: Readonly<Record<string, unknown>>;
        readonly bytes: Uint8Array;
      }
    >
  >;
}

export async function importImage(
  source: string,
  bytes: Uint8Array,
  subAssets: readonly SubAsset[],
  importSettings: Readonly<Record<string, unknown>> = {},
): Promise<
  | { readonly ok: true; readonly assets: readonly ImportedAssetView[] }
  | { readonly ok: false; readonly code: string; readonly error: unknown }
> {
  const result = await imageImporter.import(imageContext(source, bytes, subAssets, importSettings));
  if (!result.ok) return { ok: false, code: errorCode(result.error), error: result.error };
  return { ok: true, assets: result.value.assets as unknown as readonly ImportedAssetView[] };
}

export function texturePayload(asset: ImportedAssetView | undefined): TextureAsset | undefined {
  return asset?.payload as TextureAsset | undefined;
}
